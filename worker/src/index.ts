interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  RECONCILIATION_KEY?: string;
}

const ALLOWED_ORIGINS = [
  "https://napasawardvote.name.ng",
  "https://napas-award.com",
  "https://www.napas-award.com",
  "https://softie2001.github.io",
  "http://localhost:8787",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const DEFAULT_VOTE_PRICE = 100;
const MAX_VOTES_PER_PAYMENT = 1000;

/*
 * IMPORTANT
 *
 * Keep this deliberately small.
 *
 * A Paystack page can contain many transactions and each transaction
 * may require Firebase requests. Processing only 10 at a time keeps
 * the Worker safely below Cloudflare's subrequest limit.
 */
const RECONCILIATION_PAGE_SIZE = 10;

/*
 * Firebase access token is cached for the lifetime of one Worker
 * invocation so we don't request a new Google token for every
 * Firestore operation.
 */
let firebaseTokenCache:
  | {
      token: string;
      expiresAt: number;
    }
  | null = null;

/* =========================================================
   BASIC HELPERS
========================================================= */

function getOrigin(request: Request) {
  return request.headers.get("Origin");
}

function corsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Paystack-Signature, X-Reconciliation-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  data: unknown,
  status = 200,
  origin: string | null = null,
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

/* =========================================================
   BASE64 / FIREBASE AUTH
========================================================= */

function base64UrlEncode(input: ArrayBuffer | string) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  if (!cleaned) {
    throw new Error("FIREBASE_PRIVATE_KEY is empty.");
  }

  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createFirebaseAccessToken(env: Env): Promise<string> {
  /*
   * Reuse token during the current Worker invocation.
   */
  if (
    firebaseTokenCache &&
    firebaseTokenCache.expiresAt > Date.now() + 60_000
  ) {
    return firebaseTokenCache.token;
  }

  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const privateKey = env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail) {
    throw new Error("FIREBASE_CLIENT_EMAIL is not configured.");
  }

  if (!projectId) {
    throw new Error("FIREBASE_PROJECT_ID is not configured.");
  }

  if (!privateKey) {
    throw new Error("FIREBASE_PRIVATE_KEY is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: clientEmail,
    scope:
      "https://www.googleapis.com/auth/datastore",
    aud:
      "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken =
    `${base64UrlEncode(JSON.stringify(header))}.` +
    base64UrlEncode(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  const jwt =
    `${unsignedToken}.${base64UrlEncode(signature)}`;

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    },
  );

  const data: any = await response.json();

  if (!response.ok || !data.access_token) {
    console.error(
      "Firebase token error:",
      data,
    );

    throw new Error(
      data.error_description ||
        data.error ||
        "Unable to authenticate with Firebase.",
    );
  }

  firebaseTokenCache = {
    token: data.access_token,
    expiresAt:
      Date.now() +
      Number(data.expires_in || 3600) * 1000,
  };

  return data.access_token;
}

/* =========================================================
   FIRESTORE VALUE HELPERS
========================================================= */

function firestoreString(value: unknown) {
  return {
    stringValue: String(value ?? ""),
  };
}

function firestoreInteger(value: number) {
  return {
    integerValue: String(
      Math.trunc(value),
    ),
  };
}

function firestoreDouble(value: number) {
  return {
    doubleValue: Number(value),
  };
}

function firestoreBoolean(value: boolean) {
  return {
    booleanValue: value,
  };
}

function firestoreTimestamp(
  date = new Date(),
) {
  return {
    timestampValue:
      date.toISOString(),
  };
}

function extractFirestoreValue(
  field: any,
): any {
  if (!field) return null;

  if ("stringValue" in field) {
    return field.stringValue;
  }

  if ("integerValue" in field) {
    return Number(field.integerValue);
  }

  if ("doubleValue" in field) {
    return Number(field.doubleValue);
  }

  if ("booleanValue" in field) {
    return field.booleanValue;
  }

  if ("timestampValue" in field) {
    return field.timestampValue;
  }

  return null;
}

/* =========================================================
   FIRESTORE REQUEST
========================================================= */

async function firestoreRequest(
  env: Env,
  path: string,
  options: RequestInit = {},
) {
  const token =
    await createFirebaseAccessToken(env);

  const projectId =
    encodeURIComponent(
      env.FIREBASE_PROJECT_ID.trim(),
    );

  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/${path}`;

  return fetch(url, {
    ...options,
    headers: {
      Authorization:
        `Bearer ${token}`,
      "Content-Type":
        "application/json",
      ...(options.headers || {}),
    },
  });
}

/* =========================================================
   VOTING SETTINGS
========================================================= */

let votingSettingsCache:
  | {
      votingOpen: boolean;
      votePrice: number;
    }
  | null = null;

async function getVotingSettings(
  env: Env,
) {
  if (votingSettingsCache) {
    return votingSettingsCache;
  }

  try {
    const response =
      await firestoreRequest(
        env,
        "settings/voting",
      );

    if (!response.ok) {
      console.warn(
        "Voting settings unavailable. Using defaults.",
        response.status,
      );

      votingSettingsCache = {
        votingOpen: true,
        votePrice:
          DEFAULT_VOTE_PRICE,
      };

      return votingSettingsCache;
    }

    const document: any =
      await response.json();

    const votingOpen =
      extractFirestoreValue(
        document.fields?.votingOpen,
      ) ?? true;

    const rawPrice =
      extractFirestoreValue(
        document.fields?.votePrice,
      );

    const votePrice =
      Number.isFinite(
        Number(rawPrice),
      ) &&
      Number(rawPrice) > 0
        ? Number(rawPrice)
        : DEFAULT_VOTE_PRICE;

    votingSettingsCache = {
      votingOpen:
        Boolean(votingOpen),
      votePrice,
    };

    return votingSettingsCache;
  } catch (error) {
    console.error(
      "Voting settings error:",
      error,
    );

    votingSettingsCache = {
      votingOpen: true,
      votePrice:
        DEFAULT_VOTE_PRICE,
    };

    return votingSettingsCache;
  }
}

/* =========================================================
   CONTESTANT LOOKUP
========================================================= */

async function getContestantByDocumentId(
  env: Env,
  contestantId: string,
) {
  const cleanId =
    String(
      contestantId || "",
    ).trim();

  if (!cleanId) {
    return null;
  }

  const response =
    await firestoreRequest(
      env,
      `contestants/${encodeURIComponent(cleanId)}`,
    );

  if (!response.ok) {
    return null;
  }

  const document: any =
    await response.json();

  return {
    ...document,
    documentName:
      document.name,
    documentId:
      document.name
        ?.split("/")
        .pop() ||
      cleanId,
  };
}

/*
 * Normal contestant lookup.
 *
 * Direct document ID is tried first.
 * Only if that fails do we perform a query.
 */
async function getContestant(
  env: Env,
  contestantId: string,
) {
  const direct =
    await getContestantByDocumentId(
      env,
      contestantId,
    );

  if (direct) {
    return direct;
  }

  const cleanId =
    String(
      contestantId || "",
    ).trim();

  if (!cleanId) {
    return null;
  }

  const token =
    await createFirebaseAccessToken(env);

  const projectId =
    encodeURIComponent(
      env.FIREBASE_PROJECT_ID.trim(),
    );

  const queryUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents:runQuery`;

  for (const field of [
    "id",
    "contestantId",
    "code",
    "contestantCode",
    "slug",
  ]) {
    const response =
      await fetch(queryUrl, {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [
              {
                collectionId:
                  "contestants",
              },
            ],
            where: {
              fieldFilter: {
                field: {
                  fieldPath: field,
                },
                op: "EQUAL",
                value: {
                  stringValue:
                    cleanId,
                },
              },
            },
            limit: 1,
          },
        }),
      });

    if (!response.ok) {
      continue;
    }

    const rows: any[] =
      await response.json();

    const document =
      rows.find(
        (row) =>
          row?.document,
      )?.document;

    if (document) {
      return {
        ...document,
        documentName:
          document.name,
        documentId:
          document.name
            ?.split("/")
            .pop() ||
          cleanId,
      };
    }
  }

  return null;
}

/* =========================================================
   PAYMENT LOOKUP
========================================================= */

async function getPayment(
  env: Env,
  reference: string,
) {
  const response =
    await firestoreRequest(
      env,
      `payments/${encodeURIComponent(reference)}`,
    );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

/* =========================================================
   PAYSTACK
========================================================= */

async function paystackRequest(
  env: Env,
  path: string,
  options: RequestInit = {},
) {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured.",
    );
  }

  return fetch(
    `https://api.paystack.co${path}`,
    {
      ...options,
      headers: {
        Authorization:
          `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type":
          "application/json",
        ...(options.headers || {}),
      },
    },
  );
}

/* =========================================================
   PAYSTACK TRANSACTION
========================================================= */

async function getPaystackTransaction(
  env: Env,
  reference: string,
) {
  const response =
    await paystackRequest(
      env,
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

  const data: any =
    await response.json();

  if (
    !response.ok ||
    !data.status ||
    !data.data
  ) {
    throw new Error(
      data.message ||
        "Unable to verify Paystack transaction.",
    );
  }

  return data.data;
}

/* =========================================================
   PAYSTACK PAGE
========================================================= */

async function getPaystackPage(
  env: Env,
  page: number,
) {
  const response =
    await paystackRequest(
      env,
      `/transaction?perPage=${RECONCILIATION_PAGE_SIZE}&page=${page}&status=success`,
    );

  const data: any =
    await response.json();

  if (
    !response.ok ||
    !data.status
  ) {
    throw new Error(
      data.message ||
        `Unable to load Paystack page ${page}.`,
    );
  }

  return {
    transactions:
      Array.isArray(data.data)
        ? data.data
        : [],
    meta:
      data.meta || {},
  };
}

/* =========================================================
   PAYMENT METADATA
========================================================= */

function getPaymentMetadata(
  transaction: any,
) {
  return (
    transaction?.metadata ||
    {}
  );
}

function getContestantIdFromTransaction(
  transaction: any,
) {
  const metadata =
    getPaymentMetadata(
      transaction,
    );

  return String(
    metadata.contestantId ||
      metadata.firestoreContestantId ||
      metadata.contestantCode ||
      "",
  ).trim();
}

function getFirestoreContestantId(
  transaction: any,
) {
  const metadata =
    getPaymentMetadata(
      transaction,
    );

  return String(
    metadata.firestoreContestantId ||
      "",
  ).trim();
}

function getVotesFromTransaction(
  transaction: any,
) {
  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const votes =
    Math.floor(
      Number(
        metadata.votes || 0,
      ),
    );

  return Number.isInteger(votes)
    ? votes
    : 0;
}

function getHistoricalVotePrice(
  transaction: any,
  fallbackPrice: number,
) {
  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const stored =
    Number(
      metadata.votePrice,
    );

  return Number.isFinite(stored) &&
    stored > 0
    ? stored
    : fallbackPrice;
}

function isNapasTransaction(
  transaction: any,
) {
  const reference =
    String(
      transaction?.reference ||
        "",
    ).toUpperCase();

  const source =
    String(
      getPaymentMetadata(
        transaction,
      )?.source || "",
    ).toUpperCase();

  return (
    reference.startsWith(
      "NAPAS-",
    ) ||
    source ===
      "NAPAS_AWARD_VOTING"
  );
}

/* =========================================================
   CREDIT VOTES
========================================================= */

async function creditVotes(
  env: Env,
  payment: {
    reference: string;
    contestantId: string;
    votes: number;
    amount: number;
    email: string;
    voterName?: string;
    phone?: string;
    paystackTransactionId?: string;
    source?: string;
    historicalVotePrice?: number;
    firestoreContestantId?: string;
  },
) {
  const contestantLookupId =
    payment.firestoreContestantId ||
    payment.contestantId;

  const contestant =
    await getContestant(
      env,
      contestantLookupId,
    );

  if (
    !contestant?.documentName
  ) {
    throw new Error(
      `Contestant could not be resolved for payment ${payment.reference}.`,
    );
  }

  const token =
    await createFirebaseAccessToken(
      env,
    );

  const projectId =
    env.FIREBASE_PROJECT_ID.trim();

  const commitUrl =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/(default)/documents:commit`;

  const paymentDocument =
    `projects/${projectId}/databases/(default)/documents/payments/${payment.reference}`;

  const contestantDocument =
    contestant.documentName;

  const paymentFields: Record<
    string,
    any
  > = {
    reference:
      firestoreString(
        payment.reference,
      ),

    contestantId:
      firestoreString(
        payment.contestantId,
      ),

    firestoreContestantId:
      firestoreString(
        contestant.documentId,
      ),

    votes:
      firestoreInteger(
        payment.votes,
      ),

    amount:
      firestoreDouble(
        payment.amount,
      ),

    email:
      firestoreString(
        payment.email,
      ),

    voterName:
      firestoreString(
        payment.voterName || "",
      ),

    phone:
      firestoreString(
        payment.phone || "",
      ),

    paystackTransactionId:
      firestoreString(
        payment.paystackTransactionId ||
          "",
      ),

    status:
      firestoreString(
        "success",
      ),

    source:
      firestoreString(
        payment.source ||
          "PAYSTACK",
      ),

    votesCredited:
      firestoreBoolean(
        true,
      ),

    creditedAt:
      firestoreTimestamp(),

    createdAt:
      firestoreTimestamp(),
  };

  if (
    payment.historicalVotePrice
  ) {
    paymentFields.votePrice =
      firestoreDouble(
        payment.historicalVotePrice,
      );
  }

  /*
   * CRITICAL:
   *
   * Creating the payment document and incrementing
   * the contestant votes happen in ONE atomic Firestore
   * commit.
   *
   * If the payment document already exists,
   * currentDocument.exists=false causes the whole
   * transaction to fail with ALREADY_EXISTS.
   *
   * This protects against double-crediting.
   */
  const commitResponse =
    await fetch(
      commitUrl,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name:
                  paymentDocument,
                fields:
                  paymentFields,
              },

              currentDocument: {
                exists: false,
              },
            },

            {
              transform: {
                document:
                  contestantDocument,

                fieldTransforms: [
                  {
                    fieldPath:
                      "votes",

                    increment: {
                      integerValue:
                        String(
                          payment.votes,
                        ),
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    );

  if (
    !commitResponse.ok
  ) {
    const errorText =
      await commitResponse.text();

    console.error(
      "Firestore vote credit failed:",
      errorText,
    );

    if (
      errorText.includes(
        "ALREADY_EXISTS",
      )
    ) {
      return {
        alreadyCredited:
          true,
      };
    }

    throw new Error(
      "Unable to record payment and increment contestant votes.",
    );
  }

  return {
    alreadyCredited:
      false,
  };
}

/* =========================================================
   INITIALIZE PAYMENT
========================================================= */

async function initializePayment(
  request: Request,
  env: Env,
) {
  const origin =
    getOrigin(request);

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        success: false,
        error:
          "Invalid request body.",
      },
      400,
      origin,
    );
  }

  const contestantId =
    String(
      body?.contestantId ||
        body?.contestantCode ||
        body?.id ||
        "",
    ).trim();

  const votes =
    Math.floor(
      Number(
        body?.votes || 0,
      ),
    );

  const email =
    String(
      body?.email || "",
    )
      .trim()
      .toLowerCase();

  const voterName =
    String(
      body?.voterName || "",
    ).trim();

  const phone =
    String(
      body?.phone || "",
    ).trim();

  if (!contestantId) {
    return json(
      {
        success: false,
        error:
          "Contestant is required.",
      },
      400,
      origin,
    );
  }

  if (
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes >
      MAX_VOTES_PER_PAYMENT
  ) {
    return json(
      {
        success: false,
        error:
          "Choose between 1 and 1,000 votes.",
      },
      400,
      origin,
    );
  }

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email,
    )
  ) {
    return json(
      {
        success: false,
        error:
          "A valid email address is required.",
      },
      400,
      origin,
    );
  }

  const settings =
    await getVotingSettings(
      env,
    );

  if (!settings.votingOpen) {
    return json(
      {
        success: false,
        error:
          "Voting is currently closed.",
      },
      403,
      origin,
    );
  }

  if (
    !Number.isFinite(
      settings.votePrice,
    ) ||
    settings.votePrice <= 0
  ) {
    return json(
      {
        success: false,
        error:
          "Voting price is not configured.",
      },
      500,
      origin,
    );
  }

  const contestant =
    await getContestant(
      env,
      contestantId,
    );

  if (!contestant) {
    return json(
      {
        success: false,
        error:
          "Contestant not found. Please refresh the voting page and try again.",
      },
      404,
      origin,
    );
  }

  const published =
    extractFirestoreValue(
      contestant.fields
        ?.published,
    );

  if (published === false) {
    return json(
      {
        success: false,
        error:
          "This contestant is not available for voting.",
      },
      403,
      origin,
    );
  }

  const amountNaira =
    votes *
    settings.votePrice;

  const reference =
    `NAPAS-${Date.now()}-${crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase()}`;

  const paystackResponse =
    await paystackRequest(
      env,
      "/transaction/initialize",
      {
        method: "POST",

        body: JSON.stringify({
          email,

          amount:
            Math.round(
              amountNaira * 100,
            ),

          currency: "NGN",

          reference,

          callback_url:
            "https://napasawardvote.name.ng/?payment=return",

          metadata: {
            contestantId,

            firestoreContestantId:
              contestant.documentId,

            votes,

            votePrice:
              settings.votePrice,

            voterName,

            phone,

            source:
              "NAPAS_AWARD_VOTING",
          },
        }),
      },
    );

  const paystackData: any =
    await paystackResponse.json();

  if (
    !paystackResponse.ok ||
    !paystackData.status ||
    !paystackData.data
      ?.authorization_url
  ) {
    console.error(
      "Paystack initialization failed:",
      paystackData,
    );

    return json(
      {
        success: false,
        error:
          paystackData.message ||
          "Unable to initialize payment.",
      },
      502,
      origin,
    );
  }

  return json(
    {
      success: true,
      reference,

      amount:
        amountNaira,

      votes,

      contestantId,

      firestoreContestantId:
        contestant.documentId,

      authorization_url:
        paystackData.data
          .authorization_url,

      access_code:
        paystackData.data
          .access_code,
    },
    200,
    origin,
  );
}

/* =========================================================
   VERIFY PAYMENT
========================================================= */

async function verifyPayment(
  request: Request,
  env: Env,
) {
  const origin =
    getOrigin(request);

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        success: false,
        error:
          "Invalid verification request.",
      },
      400,
      origin,
    );
  }

  const reference =
    String(
      body?.reference || "",
    ).trim();

  if (!reference) {
    return json(
      {
        success: false,
        error:
          "Payment reference is required.",
      },
      400,
      origin,
    );
  }

  const existing =
    await getPayment(
      env,
      reference,
    );

  if (existing) {
    const credited =
      extractFirestoreValue(
        existing.fields
          ?.votesCredited,
      );

    if (credited === true) {
      return json(
        {
          success: true,
          alreadyCredited:
            true,
          reference,
        },
        200,
        origin,
      );
    }
  }

  const transaction =
    await getPaystackTransaction(
      env,
      reference,
    );

  if (
    transaction.status !==
    "success"
  ) {
    return json(
      {
        success: false,
        error:
          "Payment has not been completed successfully.",
      },
      400,
      origin,
    );
  }

  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const contestantId =
    getContestantIdFromTransaction(
      transaction,
    );

  const firestoreContestantId =
    getFirestoreContestantId(
      transaction,
    );

  const votes =
    getVotesFromTransaction(
      transaction,
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes >
      MAX_VOTES_PER_PAYMENT
  ) {
    return json(
      {
        success: false,
        error:
          "Payment metadata is incomplete.",
      },
      400,
      origin,
    );
  }

  const settings =
    await getVotingSettings(
      env,
    );

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      settings.votePrice,
    );

  const expectedAmount =
    votes *
    historicalPrice *
    100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    return json(
      {
        success: false,
        error:
          "Payment amount does not match the selected votes.",
      },
      400,
      origin,
    );
  }

  const email =
    String(
      transaction.customer
        ?.email || "",
    )
      .trim()
      .toLowerCase();

  try {
    const result =
      await creditVotes(
        env,
        {
          reference,

          contestantId,

          firestoreContestantId,

          votes,

          amount:
            Number(
              transaction.amount,
            ) / 100,

          email,

          voterName:
            String(
              metadata.voterName ||
                "",
            ),

          phone:
            String(
              metadata.phone ||
                "",
            ),

          paystackTransactionId:
            String(
              transaction.id ||
                "",
            ),

          source:
            "PAYSTACK_VERIFY",

          historicalVotePrice:
            historicalPrice,
        },
      );

    return json(
      {
        success: true,
        reference,
        contestantId,
        votes,

        amount:
          Number(
            transaction.amount,
          ) / 100,

        alreadyCredited:
          result.alreadyCredited,
      },
      200,
      origin,
    );
  } catch (error) {
    console.error(
      "Verify credit failed:",
      error,
    );

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
      origin,
    );
  }
}

/* =========================================================
   PAYSTACK SIGNATURE
========================================================= */

function timingSafeEqual(
  a: Uint8Array,
  b: Uint8Array,
) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    result |=
      a[i] ^ b[i];
  }

  return result === 0;
}

function hexToBytes(
  hex: string,
) {
  if (
    !/^[0-9a-fA-F]+$/.test(
      hex,
    ) ||
    hex.length % 2 !== 0
  ) {
    return null;
  }

  const bytes =
    new Uint8Array(
      hex.length / 2,
    );

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    bytes[i] =
      parseInt(
        hex.slice(
          i * 2,
          i * 2 + 2,
        ),
        16,
      );
  }

  return bytes;
}

async function verifyPaystackSignature(
  rawBody: string,
  signature: string,
  secret: string,
) {
  if (
    !signature ||
    !secret
  ) {
    return false;
  }

  const expected =
    hexToBytes(signature);

  if (!expected) {
    return false;
  }

  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        secret,
      ),
      {
        name: "HMAC",
        hash: "SHA-512",
      },
      false,
      ["sign"],
    );

  const generated =
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          rawBody,
        ),
      ),
    );

  return timingSafeEqual(
    generated,
    expected,
  );
}

/* =========================================================
   PAYSTACK WEBHOOK
========================================================= */

async function handlePaystackWebhook(
  request: Request,
  env: Env,
) {
  const rawBody =
    await request.text();

  const signature =
    request.headers.get(
      "x-paystack-signature",
    ) || "";

  const valid =
    await verifyPaystackSignature(
      rawBody,
      signature,
      env.PAYSTACK_SECRET_KEY,
    );

  if (!valid) {
    return json(
      {
        success: false,
        error:
          "Invalid webhook signature.",
      },
      401,
    );
  }

  let event: any;

  try {
    event =
      JSON.parse(rawBody);
  } catch {
    return json(
      {
        success: false,
        error:
          "Invalid webhook payload.",
      },
      400,
    );
  }

  if (
    event?.event !==
    "charge.success"
  ) {
    return json(
      {
        success: true,
        ignored: true,
      },
      200,
    );
  }

  const transaction =
    event?.data;

  if (
    !transaction?.reference ||
    transaction?.status !==
      "success"
  ) {
    return json(
      {
        success: true,
        ignored: true,
      },
      200,
    );
  }

  if (
    !isNapasTransaction(
      transaction,
    )
  ) {
    return json(
      {
        success: true,
        ignored: true,
        reason:
          "Not a NAPAS transaction.",
      },
      200,
    );
  }

  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const contestantId =
    getContestantIdFromTransaction(
      transaction,
    );

  const firestoreContestantId =
    getFirestoreContestantId(
      transaction,
    );

  const votes =
    getVotesFromTransaction(
      transaction,
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes >
      MAX_VOTES_PER_PAYMENT
  ) {
    return json(
      {
        success: false,
        error:
          "Webhook payment metadata is incomplete.",
      },
      400,
    );
  }

  const settings =
    await getVotingSettings(
      env,
    );

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      settings.votePrice,
    );

  const expectedAmount =
    votes *
    historicalPrice *
    100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    return json(
      {
        success: false,
        error:
          "Webhook payment amount does not match.",
      },
      400,
    );
  }

  try {
    const result =
      await creditVotes(
        env,
        {
          reference:
            String(
              transaction.reference,
            ),

          contestantId,

          firestoreContestantId,

          votes,

          amount:
            Number(
              transaction.amount,
            ) / 100,

          email:
            String(
              transaction.customer
                ?.email || "",
            )
              .trim()
              .toLowerCase(),

          voterName:
            String(
              metadata.voterName ||
                "",
            ),

          phone:
            String(
              metadata.phone ||
                "",
            ),

          paystackTransactionId:
            String(
              transaction.id ||
                "",
            ),

          source:
            "PAYSTACK_WEBHOOK",

          historicalVotePrice:
            historicalPrice,
        },
      );

    return json(
      {
        success: true,
        alreadyCredited:
          result.alreadyCredited,
        reference:
          transaction.reference,
      },
      200,
    );
  } catch (error) {
    console.error(
      "Webhook credit failed:",
      error,
    );

    return json(
      {
        success: false,
        error:
          "Webhook processing failed.",
      },
      500,
    );
  }
}

/* =========================================================
   RECONCILIATION AUTH
========================================================= */

function isReconciliationAuthorized(
  request: Request,
  env: Env,
) {
  if (
    !env.RECONCILIATION_KEY
  ) {
    return false;
  }

  const headerKey =
    request.headers.get(
      "X-Reconciliation-Key",
    ) || "";

  const authorization =
    request.headers.get(
      "Authorization",
    ) || "";

  const bearerKey =
    authorization.startsWith(
      "Bearer ",
    )
      ? authorization
          .slice(7)
          .trim()
      : "";

  return (
    headerKey ===
      env.RECONCILIATION_KEY ||
    bearerKey ===
      env.RECONCILIATION_KEY
  );
}

/* =========================================================
   RECONCILE ONE TRANSACTION
========================================================= */

async function reconcileOneTransaction(
  env: Env,
  transaction: any,
  dryRun: boolean,
) {
  const reference =
    String(
      transaction?.reference ||
        "",
    ).trim();

  if (!reference) {
    return {
      action: "skipped",
      reason:
        "Missing transaction reference.",
    };
  }

  if (
    transaction.status !==
    "success"
  ) {
    return {
      action: "skipped",
      reason:
        "Transaction is not successful.",
    };
  }

  if (
    !isNapasTransaction(
      transaction,
    )
  ) {
    return {
      action: "skipped",
      reason:
        "Not a NAPAS transaction.",
    };
  }

  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const contestantId =
    getContestantIdFromTransaction(
      transaction,
    );

  const firestoreContestantId =
    getFirestoreContestantId(
      transaction,
    );

  const votes =
    getVotesFromTransaction(
      transaction,
    );

  if (
    !contestantId ||
    votes < 1 ||
    votes >
      MAX_VOTES_PER_PAYMENT
  ) {
    return {
      action: "skipped",
      reason:
        "Incomplete payment metadata.",
    };
  }

  const settings =
    await getVotingSettings(
      env,
    );

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      settings.votePrice,
    );

  const expectedAmount =
    votes *
    historicalPrice *
    100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    return {
      action: "skipped",
      reason:
        "Payment amount does not match vote metadata.",
    };
  }

  /*
   * Prefer the exact Firestore contestant ID stored
   * inside Paystack metadata.
   */
  const lookupId =
    firestoreContestantId ||
    contestantId;

  const contestant =
    await getContestant(
      env,
      lookupId,
    );

  if (!contestant) {
    return {
      action: "failed",
      reason:
        `Contestant not found: ${lookupId}`,
    };
  }

  /*
   * Check existing payment.
   *
   * This is one Firebase request.
   */
  const existing =
    await getPayment(
      env,
      reference,
    );

  if (existing) {
    const credited =
      extractFirestoreValue(
        existing.fields
          ?.votesCredited,
      );

    if (credited === true) {
      return {
        action:
          "alreadyCredited",

        contestantId,
        votes,
      };
    }

    /*
     * We deliberately do not guess whether an old
     * payment was already counted.
     */
    return {
      action:
        "manualReview",

      contestantId,
      votes,

      reason:
        "Payment exists in Firestore but has no votesCredited=true marker.",
    };
  }

  if (dryRun) {
    return {
      action:
        "wouldCredit",

      contestantId,

      firestoreContestantId:
        contestant.documentId,

      votes,

      amount:
        Number(
          transaction.amount,
        ) / 100,
    };
  }

  const email =
    String(
      transaction.customer
        ?.email || "",
    )
      .trim()
      .toLowerCase();

  const result =
    await creditVotes(
      env,
      {
        reference,

        contestantId,

        firestoreContestantId:
          contestant.documentId,

        votes,

        amount:
          Number(
            transaction.amount,
          ) / 100,

        email,

        voterName:
          String(
            metadata.voterName ||
              "",
          ),

        phone:
          String(
            metadata.phone ||
              "",
          ),

        paystackTransactionId:
          String(
            transaction.id ||
              "",
          ),

        source:
          "RECONCILIATION",

        historicalVotePrice:
          historicalPrice,
      },
    );

  if (
    result.alreadyCredited
  ) {
    return {
      action:
        "alreadyCredited",

      contestantId,
      votes,
    };
  }

  return {
    action: "credited",

    contestantId,

    firestoreContestantId:
      contestant.documentId,

    votes,

    amount:
      Number(
        transaction.amount,
      ) / 100,
  };
}

/* =========================================================
   RECONCILIATION
========================================================= */

async function reconcilePayments(
  request: Request,
  env: Env,
) {
  const origin =
    getOrigin(request);

  if (
    !isReconciliationAuthorized(
      request,
      env,
    )
  ) {
    return json(
      {
        success: false,
        error:
          "Unauthorized reconciliation request.",
      },
      401,
      origin,
    );
  }

  let body: any = {};

  try {
    body =
      await request.json();
  } catch {
    body = {};
  }

  const reference =
    String(
      body?.reference || "",
    ).trim();

  const dryRun =
    body?.dryRun === true;

  /*
   * =======================================================
   * MODE 1 — ONE EXACT REFERENCE
   * =======================================================
   */

  if (reference) {
    try {
      const transaction =
        await getPaystackTransaction(
          env,
          reference,
        );

      const result =
        await reconcileOneTransaction(
          env,
          transaction,
          dryRun,
        );

      return json(
        {
          success: true,

          mode:
            "reference",

          reference,

          dryRun,

          result,
        },
        200,
        origin,
      );
    } catch (error) {
      return json(
        {
          success: false,

          mode:
            "reference",

          reference,

          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500,
        origin,
      );
    }
  }

  /*
   * =======================================================
   * MODE 2 — ONE SMALL PAYSTACK PAGE
   * =======================================================
   */

  const page =
    Math.max(
      1,
      Math.floor(
        Number(
          body?.page || 1,
        ),
      ),
    );

  try {
    const pageData =
      await getPaystackPage(
        env,
        page,
      );

    const transactions =
      pageData.transactions;

    const result = {
      success: true,

      mode: "page",

      page,

      pageSize:
        RECONCILIATION_PAGE_SIZE,

      dryRun,

      scanned: 0,

      credited: 0,

      wouldCredit: 0,

      alreadyCredited: 0,

      manualReview: 0,

      skipped: 0,

      failed: 0,

      details:
        [] as any[],

      nextPage:
        transactions.length >=
        RECONCILIATION_PAGE_SIZE
          ? page + 1
          : null,
    };

    for (
      const transaction of
        transactions
    ) {
      result.scanned++;

      try {
        const item =
          await reconcileOneTransaction(
            env,
            transaction,
            dryRun,
          );

        result.details.push({
          reference:
            transaction.reference,

          ...item,
        });

        switch (
          item.action
        ) {
          case "credited":
            result.credited++;
            break;

          case "wouldCredit":
            result.wouldCredit++;
            break;

          case "alreadyCredited":
            result.alreadyCredited++;
            break;

          case "manualReview":
            result.manualReview++;
            break;

          case "failed":
            result.failed++;
            break;

          default:
            result.skipped++;
        }
      } catch (error) {
        result.failed++;

        result.details.push({
          reference:
            transaction.reference,

          action:
            "failed",

          reason:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    return json(
      result,
      200,
      origin,
    );
  } catch (error) {
    return json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
      origin,
    );
  }
}

/* =========================================================
   WORKER
========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    /*
     * Reset per-invocation caches.
     */
    firebaseTokenCache =
      null;

    votingSettingsCache =
      null;

    const origin =
      getOrigin(request);

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers:
            corsHeaders(
              origin,
            ),
        },
      );
    }

    const url =
      new URL(
        request.url,
      );

    try {
      /*
       * HEALTH CHECK
       */
      if (
        request.method ===
          "GET" &&
        url.pathname === "/"
      ) {
        return json(
          {
            service:
              "NAPAS Secure Voting Payment API",

            status:
              "ok",

            firebase:
              Boolean(
                env.FIREBASE_CLIENT_EMAIL &&
                  env.FIREBASE_PRIVATE_KEY &&
                  env.FIREBASE_PROJECT_ID,
              ),

            paystack:
              Boolean(
                env.PAYSTACK_SECRET_KEY,
              ),

            reconciliation:
              Boolean(
                env.RECONCILIATION_KEY,
              ),

            reconciliationPageSize:
              RECONCILIATION_PAGE_SIZE,

            endpoints: [
              "/initialize",
              "/verify",
              "/paystack-webhook",
              "/reconcile-payments",
            ],
          },

          200,

          origin,
        );
      }

      /*
       * INITIALIZE
       */
      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/initialize"
      ) {
        return await initializePayment(
          request,
          env,
        );
      }

      /*
       * VERIFY
       */
      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/verify"
      ) {
        return await verifyPayment(
          request,
          env,
        );
      }

      /*
       * PAYSTACK WEBHOOK
       */
      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/paystack-webhook"
      ) {
        return await handlePaystackWebhook(
          request,
          env,
        );
      }

      /*
       * RECONCILIATION
       */
      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/reconcile-payments"
      ) {
        return await reconcilePayments(
          request,
          env,
        );
      }

      return json(
        {
          success: false,
          error:
            "Not found.",
        },
        404,
        origin,
      );
    } catch (error) {
      console.error(
        "NAPAS Worker error:",
        error,
      );

      return json(
        {
          success: false,

          error:
            "An unexpected payment server error occurred.",

          details:
            error instanceof Error
              ? error.message
              : String(error),
        },

        500,

        origin,
      );
    }
  },
} satisfies ExportedHandler<Env>;

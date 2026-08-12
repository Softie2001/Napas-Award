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
const MAX_RECONCILIATION_REFERENCES = 2;

/* =========================================================
   FIREBASE TOKEN CACHE
   ========================================================= */

let cachedFirebaseToken = "";
let cachedFirebaseTokenExpiresAt = 0;

/* =========================================================
   CORS / RESPONSE
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

async function createFirebaseAccessToken(
  env: Env,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (
    cachedFirebaseToken &&
    cachedFirebaseTokenExpiresAt > now + 60
  ) {
    return cachedFirebaseToken;
  }

  const clientEmail =
    env.FIREBASE_CLIENT_EMAIL?.trim();

  const projectId =
    env.FIREBASE_PROJECT_ID?.trim();

  const privateKey =
    env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail) {
    throw new Error(
      "FIREBASE_CLIENT_EMAIL is not configured.",
    );
  }

  if (!projectId) {
    throw new Error(
      "FIREBASE_PROJECT_ID is not configured.",
    );
  }

  if (!privateKey) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY is not configured.",
    );
  }

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
    `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
      JSON.stringify(payload),
    )}`;

  const key =
    await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(privateKey),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );

  const signature =
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(
        unsignedToken,
      ),
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

  const data: any =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
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

  cachedFirebaseToken =
    data.access_token;

  cachedFirebaseTokenExpiresAt =
    now + Number(
      data.expires_in || 3600,
    );

  return cachedFirebaseToken;
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

async function getVotingSettings(
  env: Env,
) {
  try {
    const response =
      await firestoreRequest(
        env,
        "settings/voting",
      );

    if (!response.ok) {
      return {
        votingOpen: true,
        votePrice:
          DEFAULT_VOTE_PRICE,
      };
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

    return {
      votingOpen:
        Boolean(votingOpen),
      votePrice,
    };
  } catch (error) {
    console.error(
      "Voting settings error:",
      error,
    );

    return {
      votingOpen: true,
      votePrice:
        DEFAULT_VOTE_PRICE,
    };
  }
}

/* =========================================================
   CONTESTANT
   ========================================================= */

async function getContestant(
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
      `contestants/${encodeURIComponent(
        cleanId,
      )}`,
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

/* =========================================================
   PAYMENT DOCUMENT
   ========================================================= */

async function getPayment(
  env: Env,
  reference: string,
) {
  const response =
    await firestoreRequest(
      env,
      `payments/${encodeURIComponent(
        reference,
      )}`,
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
   PAYMENT METADATA
   ========================================================= */

function getPaymentMetadata(
  transaction: any,
) {
  return transaction?.metadata || {};
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

  return Number.isFinite(
    stored,
  ) && stored > 0
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
    votes > MAX_VOTES_PER_PAYMENT
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
    await getVotingSettings(env);

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
      contestant.fields?.published,
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
    votes * settings.votePrice;

  const reference =
    `NAPAS-${Date.now()}-${crypto
      .randomUUID()
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
      amount: amountNaira,
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
   CREDIT VOTES - IDEMPOTENT
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
  },
) {
  const existing =
    await getPayment(
      env,
      payment.reference,
    );

  /*
   * If the payment is already marked as credited,
   * NEVER increment the contestant again.
   */

  if (existing) {
    const credited =
      extractFirestoreValue(
        existing.fields?.votesCredited,
      );

    if (credited === true) {
      return {
        alreadyCredited: true,
        repaired: false,
      };
    }
  }

  const contestant =
    await getContestant(
      env,
      payment.contestantId,
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
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId,
    )}/databases/(default)/documents:commit`;

  const paymentDocument =
    `projects/${projectId}/databases/(default)/documents/payments/${payment.reference}`;

  const contestantDocument =
    contestant.documentName;

  const paymentFields: Record<string, any> = {
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
      firestoreBoolean(true),

    creditedAt:
      firestoreTimestamp(),

    createdAt:
      existing?.fields?.createdAt ||
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

  const write: any = {
    update: {
      name:
        paymentDocument,
      fields:
        paymentFields,
    },
  };

  /*
   * CRITICAL IDEMPOTENCY PROTECTION
   *
   * First-ever payment:
   *     document must NOT already exist.
   *
   * Existing uncredited payment:
   *     update only the exact document version
   *     that we just read.
   *
   * If another webhook/verify request modifies
   * that document first, Firestore rejects this
   * write instead of allowing a second vote credit.
   */

  if (!existing) {
    write.currentDocument = {
      exists: false,
    };
  } else if (existing.updateTime) {
    write.currentDocument = {
      updateTime:
        existing.updateTime,
    };
  }

  const commitBody = {
    writes: [
      write,

      {
        transform: {
          document:
            contestantDocument,

          fieldTransforms: [
            {
              fieldPath: "votes",
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
  };

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
        body:
          JSON.stringify(
            commitBody,
          ),
      },
    );

  if (!commitResponse.ok) {
    const errorText =
      await commitResponse.text();

    console.error(
      "Firestore vote credit failed:",
      errorText,
    );

    /*
     * Another request already won the race.
     *
     * Do NOT increment again.
     */

    if (
      errorText.includes(
        "ALREADY_EXISTS",
      ) ||
      errorText.includes(
        "FAILED_PRECONDITION",
      )
    ) {
      return {
        alreadyCredited: true,
        repaired: false,
      };
    }

    throw new Error(
      "Unable to record the payment and increment contestant votes.",
    );
  }

  return {
    alreadyCredited: false,
    repaired:
      Boolean(existing),
  };
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

  /*
   * Fast idempotency check.
   */

  const existing =
    await getPayment(
      env,
      reference,
    );

  if (existing) {
    const credited =
      extractFirestoreValue(
        existing.fields?.votesCredited,
      );

    if (credited === true) {
      return json(
        {
          success: true,
          alreadyCredited: true,
          reference,
        },
        200,
        origin,
      );
    }
  }

  /*
   * Ask Paystack directly.
   */

  const paystackResponse =
    await paystackRequest(
      env,
      `/transaction/verify/${encodeURIComponent(
        reference,
      )}`,
    );

  const paystackData: any =
    await paystackResponse.json();

  if (
    !paystackResponse.ok ||
    !paystackData.status ||
    paystackData.data
      ?.status !== "success"
  ) {
    return json(
      {
        success: false,
        error:
          "Payment verification failed. If you were charged, keep your Paystack reference and contact NAPAS.",
      },
      400,
      origin,
    );
  }

  const transaction =
    paystackData.data;

  if (
    !isNapasTransaction(
      transaction,
    )
  ) {
    return json(
      {
        success: false,
        error:
          "This is not a NAPAS payment.",
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

  const votes =
    getVotesFromTransaction(
      transaction,
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_PAYMENT
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

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      DEFAULT_VOTE_PRICE,
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
          "Contestant no longer exists.",
      },
      404,
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
          votes,
          amount:
            Number(
              transaction.amount,
            ) / 100,
          email,
          paystackTransactionId:
            String(
              transaction.id || "",
            ),
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
        firestoreContestantId:
          contestant.documentId,
        votes,
        amount:
          Number(
            transaction.amount,
          ) / 100,
        alreadyCredited:
          result.alreadyCredited,
        repaired:
          result.repaired,
      },
      200,
      origin,
    );
  } catch (error) {
    console.error(
      "Payment verification credit failed:",
      error,
    );

    return json(
      {
        success: false,
        error:
          "Payment was successful but vote processing is temporarily pending. Please keep your payment reference.",
        reference,
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
    !/^[0-9a-fA-F]+$/.test(hex) ||
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
    return json({
      success: true,
      ignored: true,
    });
  }

  const transaction =
    event?.data;

  if (
    !transaction?.reference ||
    transaction?.status !==
      "success"
  ) {
    return json({
      success: true,
      ignored: true,
    });
  }

  if (
    !isNapasTransaction(
      transaction,
    )
  ) {
    return json({
      success: true,
      ignored: true,
      reason:
        "Not a NAPAS transaction.",
    });
  }

  const metadata =
    getPaymentMetadata(
      transaction,
    );

  const contestantId =
    getContestantIdFromTransaction(
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
    votes > MAX_VOTES_PER_PAYMENT
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

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      DEFAULT_VOTE_PRICE,
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
          reference:
            String(
              transaction.reference,
            ),
          contestantId,
          votes,
          amount:
            Number(
              transaction.amount,
            ) / 100,
          email,
          paystackTransactionId:
            String(
              transaction.id || "",
            ),
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
          source:
            "PAYSTACK_WEBHOOK",
          historicalVotePrice:
            historicalPrice,
        },
      );

    return json({
      success: true,
      alreadyCredited:
        result.alreadyCredited,
      repaired:
        result.repaired,
      reference:
        transaction.reference,
    });
  } catch (error) {
    console.error(
      "Webhook credit failed:",
      error,
    );

    /*
     * Return 500 so Paystack can retry
     * the webhook.
     */

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
   GET PAYSTACK TRANSACTION
   ========================================================= */

async function getPaystackTransaction(
  env: Env,
  reference: string,
) {
  const response =
    await paystackRequest(
      env,
      `/transaction/verify/${encodeURIComponent(
        reference,
      )}`,
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
   RECONCILE ONE REFERENCE
   ========================================================= */

async function reconcileOneReference(
  env: Env,
  reference: string,
  dryRun: boolean,
) {
  const cleanReference =
    String(
      reference || "",
    ).trim();

  if (!cleanReference) {
    return {
      action: "skipped",
      reason:
        "Empty transaction reference.",
    };
  }

  if (
    !cleanReference
      .toUpperCase()
      .startsWith("NAPAS-")
  ) {
    return {
      action: "skipped",
      reason:
        "Reference is not a NAPAS reference.",
    };
  }

  const transaction =
    await getPaystackTransaction(
      env,
      cleanReference,
    );

  if (
    transaction.status !==
    "success"
  ) {
    return {
      action: "skipped",
      reason:
        `Paystack status is ${transaction.status}.`,
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

  const votes =
    getVotesFromTransaction(
      transaction,
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_PAYMENT
  ) {
    return {
      action: "skipped",
      reason:
        "Incomplete payment metadata.",
    };
  }

  const historicalPrice =
    getHistoricalVotePrice(
      transaction,
      DEFAULT_VOTE_PRICE,
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

  const existing =
    await getPayment(
      env,
      cleanReference,
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
     * Existing payment without
     * votesCredited=true is now
     * repairable.
     */

    if (dryRun) {
      return {
        action:
          "wouldRepair",
        contestantId,
        votes,
      };
    }
  }

  if (dryRun) {
    return {
      action:
        "wouldCredit",
      contestantId,
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
        reference:
          cleanReference,
        contestantId,
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
            transaction.id || "",
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
    action:
      existing
        ? "repaired"
        : "credited",
    contestantId,
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

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        success: false,
        error:
          "Request body must be JSON.",
      },
      400,
      origin,
    );
  }

  let references: string[] = [];

  if (
    typeof body?.reference ===
      "string" &&
    body.reference.trim()
  ) {
    references.push(
      body.reference.trim(),
    );
  }

  if (
    Array.isArray(
      body?.references,
    )
  ) {
    references =
      references.concat(
        body.references
          .filter(
            (value: any) =>
              typeof value ===
                "string" &&
              value.trim(),
          )
          .map(
            (value: string) =>
              value.trim(),
          ),
      );
  }

  references = [
    ...new Set(
      references.map(
        (value) =>
          value.trim(),
      ),
    ),
  ];

  if (
    references.length === 0
  ) {
    return json(
      {
        success: false,
        error:
          "Provide at least one Paystack transaction reference.",
      },
      400,
      origin,
    );
  }

  if (
    references.length >
    MAX_RECONCILIATION_REFERENCES
  ) {
    return json(
      {
        success: false,
        error:
          "Maximum 5 transaction references can be reconciled at once.",
        maximum:
          MAX_RECONCILIATION_REFERENCES,
        received:
          references.length,
      },
      400,
      origin,
    );
  }

  const dryRun =
    body?.dryRun === true;

  const result = {
    success: true,
    dryRun,
    processed:
      references.length,
    credited: 0,
    repaired: 0,
    wouldCredit: 0,
    wouldRepair: 0,
    alreadyCredited: 0,
    skipped: 0,
    failed: 0,
    details: [] as any[],
  };

  for (
    const reference of references
  ) {
    try {
      const item =
        await reconcileOneReference(
          env,
          reference,
          dryRun,
        );

      result.details.push({
        reference,
        ...item,
      });

      switch (
        item.action
      ) {
        case "credited":
          result.credited++;
          break;

        case "repaired":
          result.repaired++;
          break;

        case "wouldCredit":
          result.wouldCredit++;
          break;

        case "wouldRepair":
          result.wouldRepair++;
          break;

        case "alreadyCredited":
          result.alreadyCredited++;
          break;

        default:
          result.skipped++;
          break;
      }
    } catch (error) {
      result.failed++;

      result.details.push({
        reference,
        action: "failed",
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
}

/* =========================================================
   WORKER
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
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
      if (
        request.method ===
          "GET" &&
        url.pathname === "/"
      ) {
        return json(
          {
            service:
              "NAPAS Secure Voting Payment API",
            status: "ok",
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
            endpoints: [
              "/initialize",
              "/verify",
              "/paystack-webhook",
              "/reconcile-payments",
            ],
            idempotency:
              "payment-reference",
            maxReferencesPerRequest:
              MAX_RECONCILIATION_REFERENCES,
          },
          200,
          origin,
        );
      }

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

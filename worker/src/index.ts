interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
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

/* =========================================================
   RESPONSE / CORS
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
      "Content-Type, Authorization, X-Paystack-Signature",
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

function base64UrlEncode(
  input: ArrayBuffer | string,
): string {
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

function pemToArrayBuffer(
  pem: string,
): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace(
      /-----BEGIN PRIVATE KEY-----/g,
      "",
    )
    .replace(
      /-----END PRIVATE KEY-----/g,
      "",
    )
    .replace(/\s/g, "");

  if (!cleaned) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY is empty.",
    );
  }

  const binary = atob(cleaned);

  const bytes = new Uint8Array(
    binary.length,
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createFirebaseAccessToken(
  env: Env,
): Promise<string> {
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

  const now = Math.floor(
    Date.now() / 1000,
  );

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

  const encodedHeader =
    base64UrlEncode(
      JSON.stringify(header),
    );

  const encodedPayload =
    base64UrlEncode(
      JSON.stringify(payload),
    );

  const unsignedToken =
    `${encodedHeader}.${encodedPayload}`;

  const privateKeyBuffer =
    pemToArrayBuffer(privateKey);

  const cryptoKey =
    await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBuffer,
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
      cryptoKey,
      new TextEncoder().encode(
        unsignedToken,
      ),
    );

  const jwt =
    `${unsignedToken}.${base64UrlEncode(
      signature,
    )}`;

  const tokenResponse =
    await fetch(
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

  const responseText =
    await tokenResponse.text();

  let tokenData: any;

  try {
    tokenData =
      JSON.parse(responseText);
  } catch {
    throw new Error(
      "Firebase authentication returned invalid JSON.",
    );
  }

  if (!tokenResponse.ok) {
    console.error(
      "Firebase token error:",
      tokenData,
    );

    throw new Error(
      tokenData.error_description ||
        tokenData.error ||
        "Unable to authenticate with Firebase.",
    );
  }

  if (!tokenData.access_token) {
    throw new Error(
      "Firebase access token was not returned.",
    );
  }

  return tokenData.access_token;
}

/* =========================================================
   FIRESTORE
   ========================================================= */

async function firestoreRequest(
  env: Env,
  path: string,
  options: RequestInit = {},
) {
  const accessToken =
    await createFirebaseAccessToken(env);

  const projectId =
    encodeURIComponent(
      env.FIREBASE_PROJECT_ID.trim(),
    );

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${projectId}` +
    `/databases/(default)/documents/` +
    path;

  return fetch(url, {
    ...options,
    headers: {
      Authorization:
        `Bearer ${accessToken}`,
      "Content-Type":
        "application/json",
      ...(options.headers || {}),
    },
  });
}

/* =========================================================
   FIRESTORE VALUE HELPERS
   ========================================================= */

function firestoreString(
  value: unknown,
) {
  return {
    stringValue: String(
      value ?? "",
    ),
  };
}

function firestoreInteger(
  value: number,
) {
  return {
    integerValue: String(
      Math.trunc(value),
    ),
  };
}

function firestoreDouble(
  value: number,
) {
  return {
    doubleValue: Number(value),
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
  if (!field) {
    return null;
  }

  if ("stringValue" in field) {
    return field.stringValue;
  }

  if ("integerValue" in field) {
    return Number(
      field.integerValue,
    );
  }

  if ("doubleValue" in field) {
    return Number(
      field.doubleValue,
    );
  }

  if ("booleanValue" in field) {
    return field.booleanValue;
  }

  if ("timestampValue" in field) {
    return field.timestampValue;
  }

  if ("referenceValue" in field) {
    return field.referenceValue;
  }

  return null;
}

function getNumberField(
  fields: any,
  name: string,
  fallback = 0,
) {
  const value =
    extractFirestoreValue(
      fields?.[name],
    );

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
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
      console.warn(
        "Voting settings could not be loaded. Using defaults.",
        response.status,
      );

      return {
        votingOpen: true,
        votePrice:
          DEFAULT_VOTE_PRICE,
      };
    }

    const document =
      await response.json<any>();

    return {
      votingOpen:
        extractFirestoreValue(
          document.fields?.votingOpen,
        ) ?? true,

      votePrice:
        getNumberField(
          document.fields,
          "votePrice",
          DEFAULT_VOTE_PRICE,
        ),
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
   CONTESTANT LOOKUP
   ========================================================= */

/*
   IMPORTANT FIX

   The frontend may send a contestant ID that does not exactly
   match the Firestore document ID.

   We therefore try:

   1. contestants/{contestantId}

   2. Search contestants where contestantId matches

   3. Search contestants where id matches

   4. Search contestants where uid matches

   This makes the Worker much more tolerant of the existing
   contestant data structure.
*/

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

  /* -------------------------------------------------------
     FIRST: direct Firestore document ID
     ------------------------------------------------------- */

  try {
    const response =
      await firestoreRequest(
        env,
        `contestants/${encodeURIComponent(
          cleanId,
        )}`,
      );

    if (response.ok) {
      const document =
        await response.json<any>();

      return {
        ...document,
        __documentId:
          cleanId,
      };
    }
  } catch (error) {
    console.error(
      "Direct contestant lookup failed:",
      error,
    );
  }

  /* -------------------------------------------------------
     FALLBACK: query contestants collection
     ------------------------------------------------------- */

  const possibleFields = [
    "contestantId",
    "id",
    "uid",
  ];

  for (const field of possibleFields) {
    try {
      const queryResponse =
        await firestoreRequest(
          env,
          "contestants:runQuery",
          {
            method: "POST",
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

                    value:
                      firestoreString(
                        cleanId,
                      ),
                  },
                },

                limit: 1,
              },
            }),
          },
        );

      if (!queryResponse.ok) {
        continue;
      }

      const results =
        await queryResponse.json<any[]>();

      for (const result of results) {
        if (
          result?.document
        ) {
          const document =
            result.document;

          const name =
            String(
              document.name || "",
            );

          const parts =
            name.split("/");

          const documentId =
            parts[
              parts.length - 1
            ];

          return {
            ...document,
            __documentId:
              documentId,
          };
        }
      }
    } catch (error) {
      console.error(
        `Contestant fallback lookup failed for ${field}:`,
        error,
      );
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
  try {
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

    return await response.json<any>();
  } catch {
    return null;
  }
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
      body?.email ||
        "",
    )
      .trim()
      .toLowerCase();

  const voterName =
    String(
      body?.voterName ||
        "",
    ).trim();

  const phone =
    String(
      body?.phone ||
        "",
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
    votes > 1000
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

  /* -------------------------------------------------------
     FIND CONTESTANT
     ------------------------------------------------------- */

  const contestant =
    await getContestant(
      env,
      contestantId,
    );

  if (!contestant) {
    console.error(
      "Contestant not found during initialization:",
      contestantId,
    );

    return json(
      {
        success: false,
        error:
          "Contestant not found.",
        contestantId,
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
    votes *
    settings.votePrice;

  const reference =
    `NAPAS-${Date.now()}-${crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase()}`;

  const callbackUrl =
    "https://napasawardvote.name.ng/?payment=return";

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
            callbackUrl,

          metadata: {
            contestantId,

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

  const paystackText =
    await paystackResponse.text();

  let paystackData: any;

  try {
    paystackData =
      JSON.parse(
        paystackText,
      );
  } catch {
    console.error(
      "Invalid Paystack initialization response:",
      paystackText,
    );

    return json(
      {
        success: false,
        error:
          "Paystack returned an invalid response.",
      },
      502,
      origin,
    );
  }

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
  },
) {
  /*
     IMPORTANT:

     The payment document uses the Paystack reference as its
     Firestore document ID.

     currentDocument.exists:false makes the write atomic.

     Therefore if webhook and /verify both arrive for the same
     payment, only ONE can create the payment document and
     increment the contestant vote count.
  */

  const serviceAccountProject =
    env.FIREBASE_PROJECT_ID.trim();

  const accessToken =
    await createFirebaseAccessToken(
      env,
    );

  const projectId =
    encodeURIComponent(
      serviceAccountProject,
    );

  const commitUrl =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents:commit`;

  /*
     Re-resolve the contestant to get the actual Firestore
     document ID.

     This is important when contestantId is a custom ID rather
     than the Firestore document ID.
  */

  const contestant =
    await getContestant(
      env,
      payment.contestantId,
    );

  if (!contestant) {
    throw new Error(
      `Contestant not found while crediting votes: ${payment.contestantId}`,
    );
  }

  const contestantDocumentId =
    String(
      contestant.__documentId ||
        "",
    ).trim();

  if (!contestantDocumentId) {
    throw new Error(
      "Contestant document ID could not be determined.",
    );
  }

  const paymentDocument =
    `projects/${serviceAccountProject}` +
    `/databases/(default)/documents/payments/` +
    payment.reference;

  const contestantDocument =
    `projects/${serviceAccountProject}` +
    `/databases/(default)/documents/contestants/` +
    contestantDocumentId;

  const commitResponse =
    await fetch(
      commitUrl,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          writes: [
            {
              update: {
                name:
                  paymentDocument,

                fields: {
                  reference:
                    firestoreString(
                      payment.reference,
                    ),

                  contestantId:
                    firestoreString(
                      payment.contestantId,
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
                      payment.voterName ||
                        "",
                    ),

                  phone:
                    firestoreString(
                      payment.phone ||
                        "",
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

                  createdAt:
                    firestoreTimestamp(),
                },
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

  if (!commitResponse.ok) {
    const errorText =
      await commitResponse.text();

    console.error(
      "Firestore vote commit failed:",
      errorText,
    );

    /*
       If the payment document already exists, the payment was
       already processed.

       Because the payment creation and vote increment are in
       ONE Firestore commit, the same payment cannot safely
       increment twice.
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
      };
    }

    throw new Error(
      "Unable to record the payment in Firebase.",
    );
  }

  return {
    alreadyCredited: false,
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
      body?.reference ||
        "",
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
     First check whether this payment has already been credited.
  */

  const existing =
    await getPayment(
      env,
      reference,
    );

  if (existing) {
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

  /*
     Ask Paystack for the authoritative transaction status.
  */

  const paystackResponse =
    await paystackRequest(
      env,
      `/transaction/verify/${encodeURIComponent(
        reference,
      )}`,
    );

  const paystackText =
    await paystackResponse.text();

  let paystackData: any;

  try {
    paystackData =
      JSON.parse(
        paystackText,
      );
  } catch {
    return json(
      {
        success: false,
        error:
          "Paystack returned an invalid verification response.",
      },
      502,
      origin,
    );
  }

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

  const metadata =
    transaction.metadata ||
    {};

  const contestantId =
    String(
      metadata.contestantId ||
        "",
    ).trim();

  const votes =
    Math.floor(
      Number(
        metadata.votes ||
          0,
      ),
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > 1000
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

  const expectedAmount =
    votes *
    settings.votePrice *
    100;

  if (
    Number(
      transaction.amount,
    ) !== expectedAmount
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

  /*
     IMPORTANT:

     Use the improved contestant lookup.
  */

  const contestant =
    await getContestant(
      env,
      contestantId,
    );

  if (!contestant) {
    console.error(
      "Contestant no longer exists:",
      contestantId,
    );

    return json(
      {
        success: false,

        error:
          "Contestant no longer exists.",

        contestantId,
      },
      404,
      origin,
    );
  }

  const email =
    String(
      transaction.customer
        ?.email ||
        "",
    )
      .trim()
      .toLowerCase();

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
            transaction.id ||
              "",
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
}

/* =========================================================
   PAYSTACK WEBHOOK SIGNATURE
   ========================================================= */

function timingSafeEqual(
  a: Uint8Array,
  b: Uint8Array,
) {
  if (
    a.length !==
    b.length
  ) {
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

  /*
     We only process successful charges.
  */

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

  const metadata =
    transaction.metadata ||
    {};

  const contestantId =
    String(
      metadata.contestantId ||
        "",
    ).trim();

  const votes =
    Math.floor(
      Number(
        metadata.votes ||
          0,
      ),
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > 1000
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

  const expectedAmount =
    votes *
    settings.votePrice *
    100;

  if (
    Number(
      transaction.amount,
    ) !== expectedAmount
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

  /*
     Confirm contestant before attempting the vote credit.
  */

  const contestant =
    await getContestant(
      env,
      contestantId,
    );

  if (!contestant) {
    console.error(
      "Webhook contestant not found:",
      contestantId,
    );

    /*
       Return 500 so Paystack can retry the webhook rather than
       treating this payment as successfully processed.
    */

    return json(
      {
        success: false,
        error:
          "Contestant could not be found.",
        contestantId,
      },
      500,
    );
  }

  const email =
    String(
      transaction.customer
        ?.email ||
        "",
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
              transaction.id ||
                "",
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
   WORKER
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const origin =
      getOrigin(request);

    /*
       CORS preflight
    */

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
      new URL(request.url);

    try {
      /*
         HEALTH CHECK
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
          },
          200,
          origin,
        );
      }

      /*
         INITIALIZE PAYMENT
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
         VERIFY PAYMENT
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
         PAYSTACK WEBHOOK
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
};

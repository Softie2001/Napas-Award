interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  FIREBASE_PROJECT_ID: string;
}

interface FirebaseTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

const ALLOWED_ORIGINS = [
  "https://softie2001.github.io",
  "https://napas-award.com",
  "http://localhost:8787",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const DEFAULT_VOTE_PRICE = 100;

function getOrigin(request: Request): string | null {
  return request.headers.get("Origin");
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  data: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

/* =========================================================
   BASE64URL
========================================================= */

function base64UrlEncode(input: string | ArrayBuffer): string {
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

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  return base64UrlDecode(cleaned).buffer;
}

/* =========================================================
   ENVIRONMENT VALIDATION
========================================================= */

function validateEnv(env: Env): void {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  }

  if (!env.FIREBASE_CLIENT_EMAIL) {
    throw new Error("FIREBASE_CLIENT_EMAIL is not configured.");
  }

  if (!env.FIREBASE_PRIVATE_KEY) {
    throw new Error("FIREBASE_PRIVATE_KEY is not configured.");
  }

  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID is not configured.");
  }
}

/* =========================================================
   FIREBASE ACCESS TOKEN
========================================================= */

async function createGoogleAccessToken(env: Env): Promise<string> {
  validateEnv(env);

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(
    JSON.stringify(header),
  );

  const encodedPayload = base64UrlEncode(
    JSON.stringify(payload),
  );

  const unsignedToken =
    `${encodedHeader}.${encodedPayload}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.FIREBASE_PRIVATE_KEY),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken),
  );

  const jwt =
    `${unsignedToken}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch(
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

  const tokenData =
    (await tokenResponse.json()) as FirebaseTokenResponse;

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    console.error(
      "Firebase authentication failed:",
      tokenData.error,
      tokenData.error_description,
    );

    throw new Error(
      "Unable to authenticate with Firebase.",
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
): Promise<Response> {
  validateEnv(env);

  const accessToken =
    await createGoogleAccessToken(env);

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(env.FIREBASE_PROJECT_ID)}` +
    `/databases/(default)/documents/${path}`;

  return fetch(url, {
    ...options,
    headers: {
      Authorization:
        `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

function firestoreString(value: string) {
  return {
    stringValue: value,
  };
}

function firestoreInteger(value: number) {
  return {
    integerValue: String(Math.trunc(value)),
  };
}

function firestoreTimestamp(date = new Date()) {
  return {
    timestampValue: date.toISOString(),
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

function getFirestoreNumber(
  fields: any,
  name: string,
  fallback = 0,
): number {
  return Number(
    fields?.[name]?.integerValue ??
      fields?.[name]?.doubleValue ??
      fallback,
  );
}

/* =========================================================
   VOTING SETTINGS
========================================================= */

async function getVotingSettings(env: Env) {
  try {
    const response =
      await firestoreRequest(
        env,
        "settings/voting",
      );

    if (!response.ok) {
      console.error(
        "Unable to load voting settings:",
        response.status,
      );

      return {
        votingOpen: true,
        votePrice: DEFAULT_VOTE_PRICE,
      };
    }

    const document =
      (await response.json()) as any;

    const fields =
      document.fields || {};

    return {
      votingOpen:
        fields.votingOpen?.booleanValue ??
        true,

      votePrice:
        getFirestoreNumber(
          fields,
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
      votePrice: DEFAULT_VOTE_PRICE,
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
  const response =
    await firestoreRequest(
      env,
      `contestants/${encodeURIComponent(
        contestantId,
      )}`,
    );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as any;
}

/* =========================================================
   PAYSTACK
========================================================= */

async function paystackRequest(
  env: Env,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
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
  const body =
    (await request.json()) as {
      contestantId?: string;
      votes?: number;
      email?: string;
    };

  const contestantId =
    String(
      body.contestantId || "",
    ).trim();

  const votes =
    Number(body.votes);

  const email =
    String(
      body.email || "",
    )
      .trim()
      .toLowerCase();

  if (!contestantId) {
    return json(
      {
        success: false,
        error:
          "Contestant is required.",
      },
      400,
      getOrigin(request),
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
          "Invalid vote quantity.",
      },
      400,
      getOrigin(request),
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
      getOrigin(request),
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
      getOrigin(request),
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
      getOrigin(request),
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
          "Contestant not found.",
      },
      404,
      getOrigin(request),
    );
  }

  const published =
    extractFirestoreValue(
      contestant.fields?.published,
    );

  if (published !== true) {
    return json(
      {
        success: false,
        error:
          "This contestant is not available for voting.",
      },
      403,
      getOrigin(request),
    );
  }

  const amountNaira =
    votes * settings.votePrice;

  const reference =
    `NAPAS-${Date.now()}-` +
    crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 12);

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
            "https://napas-award.com/?payment=return",

          metadata: {
            contestantId,
            votes,
            votePrice:
              settings.votePrice,
            source:
              "NAPAS_AWARD_VOTING",
          },
        }),
      },
    );

  const paystackData =
    (await paystackResponse.json()) as any;

  if (
    !paystackResponse.ok ||
    !paystackData.status ||
    !paystackData.data
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
      getOrigin(request),
    );
  }

  return json(
    {
      success: true,
      reference,
      amount: amountNaira,
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
    getOrigin(request),
  );
}

/* =========================================================
   FIRESTORE COMMIT
========================================================= */

async function firestoreCommit(
  env: Env,
  writes: any[],
) {
  const accessToken =
    await createGoogleAccessToken(env);

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(
      env.FIREBASE_PROJECT_ID,
    )}` +
    `/databases/(default)/documents:commit`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${accessToken}`,
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        writes,
      }),
    });

  const data =
    (await response.json()) as any;

  if (!response.ok) {
    const error =
      new Error(
        data?.error?.message ||
          "Firestore write failed.",
      );

    (error as any).firebase =
      data?.error;

    throw error;
  }

  return data;
}

/* =========================================================
   CREDIT PAYMENT
========================================================= */

async function creditVerifiedPayment(
  env: Env,
  transaction: any,
) {
  const reference =
    String(
      transaction?.reference ||
        "",
    ).trim();

  const metadata =
    transaction?.metadata || {};

  const contestantId =
    String(
      metadata.contestantId ||
        "",
    ).trim();

  const votes =
    Math.floor(
      Number(
        metadata.votes || 0,
      ),
    );

  if (
    !reference ||
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > 1000
  ) {
    throw new Error(
      "Verified payment metadata is incomplete.",
    );
  }

  /* Prevent duplicate credit */

  const existing =
    await firestoreRequest(
      env,
      `payments/${encodeURIComponent(
        reference,
      )}`,
    );

  if (
    existing.ok
  ) {
    const existingData =
      (await existing.json()) as any;

    if (existingData.fields) {
      return {
        alreadyCredited: true,
        reference,
        contestantId:
          extractFirestoreValue(
            existingData.fields
              .contestantId,
          ),
        votes:
          extractFirestoreValue(
            existingData.fields
              .votes,
          ),
        newTotalVotes:
          getFirestoreNumber(
            existingData.fields,
            "newTotalVotes",
          ),
      };
    }
  }

  const contestant =
    await getContestant(
      env,
      contestantId,
    );

  if (!contestant) {
    throw new Error(
      "Contestant no longer exists.",
    );
  }

  const currentVotes =
    getFirestoreNumber(
      contestant.fields,
      "votes",
      0,
    );

  const projectedTotal =
    currentVotes + votes;

  const paymentDocument =
    `projects/${env.FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/payments/` +
    reference;

  const contestantDocument =
    `projects/${env.FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/contestants/` +
    contestantId;

  try {
    await firestoreCommit(
      env,
      [
        {
          update: {
            name:
              paymentDocument,

            fields: {
              reference:
                firestoreString(
                  reference,
                ),

              contestantId:
                firestoreString(
                  contestantId,
                ),

              votes:
                firestoreInteger(
                  votes,
                ),

              amount:
                firestoreInteger(
                  Number(
                    transaction.amount ||
                      0,
                  ) / 100,
                ),

              email:
                firestoreString(
                  String(
                    transaction
                      .customer
                      ?.email ||
                      "",
                  ),
                ),

              voterName:
                firestoreString(
                  String(
                    metadata
                      .voterName ||
                      "",
                  ),
                ),

              phone:
                firestoreString(
                  String(
                    metadata.phone ||
                      "",
                  ),
                ),

              paystackTransactionId:
                firestoreString(
                  String(
                    transaction.id ||
                      "",
                  ),
                ),

              newTotalVotes:
                firestoreInteger(
                  projectedTotal,
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
                    String(votes),
                },
              },
            ],
          },
        },
      ],
    );
  } catch (error: any) {
    console.error(
      "Firestore payment commit failed:",
      error,
    );

    if (
      String(
        error?.message || "",
      ).includes(
        "ALREADY_EXISTS",
      )
    ) {
      return {
        alreadyCredited: true,
        reference,
        contestantId,
        votes,
      };
    }

    throw error;
  }

  const refreshed =
    await getContestant(
      env,
      contestantId,
    );

  const newTotalVotes =
    refreshed
      ? getFirestoreNumber(
          refreshed.fields,
          "votes",
          projectedTotal,
        )
      : projectedTotal;

  return {
    alreadyCredited: false,
    reference,
    contestantId,
    votes,
    newTotalVotes,
  };
}

/* =========================================================
   VERIFY PAYMENT
========================================================= */

async function verifyPayment(
  request: Request,
  env: Env,
) {
  const body =
    (await request.json()) as {
      reference?: string;
    };

  const reference =
    String(
      body.reference || "",
    ).trim();

  if (!reference) {
    return json(
      {
        success: false,
        error:
          "Payment reference is required.",
      },
      400,
      getOrigin(request),
    );
  }

  const paystackResponse =
    await paystackRequest(
      env,
      `/transaction/verify/${encodeURIComponent(
        reference,
      )}`,
    );

  const paystackData =
    (await paystackResponse.json()) as any;

  if (
    !paystackResponse.ok ||
    !paystackData.status ||
    paystackData.data?.status !==
      "success"
  ) {
    return json(
      {
        success: false,
        error:
          "Payment verification failed.",
      },
      400,
      getOrigin(request),
    );
  }

  const transaction =
    paystackData.data;

  const metadata =
    transaction.metadata || {};

  const contestantId =
    String(
      metadata.contestantId ||
        "",
    ).trim();

  const votes =
    Number(
      metadata.votes,
    );

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1
  ) {
    return json(
      {
        success: false,
        error:
          "Payment metadata is incomplete.",
      },
      400,
      getOrigin(request),
    );
  }

  const settings =
    await getVotingSettings(env);

  const expectedAmount =
    votes *
    settings.votePrice *
    100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    return json(
      {
        success: false,
        error:
          "Payment amount does not match the vote quantity.",
      },
      400,
      getOrigin(request),
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
      getOrigin(request),
    );
  }

  const credited =
    await creditVerifiedPayment(
      env,
      transaction,
    );

  return json(
    {
      success: true,
      reference,
      ...credited,
    },
    200,
    getOrigin(request),
  );
}

/* =========================================================
   PAYSTACK WEBHOOK SIGNATURE
========================================================= */

function hexToBytes(
  hex: string,
): Uint8Array | null {
  if (
    !/^[0-9a-fA-F]{128}$/.test(
      hex,
    )
  ) {
    return null;
  }

  const bytes =
    new Uint8Array(64);

  for (
    let i = 0;
    i < 64;
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
): Promise<boolean> {
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
      ["verify"],
    );

  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(
      rawBody,
    ),
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

  if (
    !signature ||
    !(await verifyPaystackSignature(
      rawBody,
      signature,
      env.PAYSTACK_SECRET_KEY,
    ))
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid webhook signature.",
      },
      401,
      getOrigin(request),
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
      getOrigin(request),
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
      getOrigin(request),
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
      getOrigin(request),
    );
  }

  try {
    const credited =
      await creditVerifiedPayment(
        env,
        transaction,
      );

    return json(
      {
        success: true,
        ...credited,
      },
      200,
      getOrigin(request),
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
      getOrigin(request),
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

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders(origin),
        },
      );
    }

    const url =
      new URL(request.url);

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
            status: "online",
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

      return json(
        {
          success: false,
          error: "Not found.",
        },
        404,
        origin,
      );
    } catch (error: any) {
      console.error(
        "NAPAS Worker Error:",
        error,
      );

      return json(
        {
          success: false,
          error:
            error?.message ||
            "An unexpected payment server error occurred.",
        },
        500,
        origin,
      );
    }
  },
} satisfies ExportedHandler<Env>;

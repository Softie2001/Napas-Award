interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const ALLOWED_ORIGINS = [
  "https://napasawardvote.name.ng",
  "https://softie2001.github.io",
  "https://napas-award.com",
  "http://localhost:8787",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const DEFAULT_VOTE_PRICE = 100;

function corsHeaders(origin: string | null) {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
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

function getOrigin(request: Request) {
  return request.headers.get("Origin");
}

/* =========================================================
   FIREBASE SERVICE ACCOUNT
   ========================================================= */

function getFirebaseServiceAccount(env: Env): ServiceAccount {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error(
      "FIREBASE_PROJECT_ID is not configured.",
    );
  }

  if (!env.FIREBASE_CLIENT_EMAIL) {
    throw new Error(
      "FIREBASE_CLIENT_EMAIL is not configured.",
    );
  }

  if (!env.FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "FIREBASE_PRIVATE_KEY is not configured.",
    );
  }

  return {
    project_id: env.FIREBASE_PROJECT_ID,
    client_email: env.FIREBASE_CLIENT_EMAIL,
    private_key: env.FIREBASE_PRIVATE_KEY.replace(
      /\\n/g,
      "\n",
    ),
  };
}

/* =========================================================
   BASE64 URL HELPERS
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

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(
      Math.ceil(input.length / 4) * 4,
      "=",
    );

  const binary = atob(normalized);

  const bytes = new Uint8Array(
    binary.length,
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function pemToArrayBuffer(
  pem: string,
): ArrayBuffer {
  const base64 = pem
    .replace(
      "-----BEGIN PRIVATE KEY-----",
      "",
    )
    .replace(
      "-----END PRIVATE KEY-----",
      "",
    )
    .replace(/\s/g, "");

  return base64UrlDecode(base64).buffer;
}

/* =========================================================
   FIREBASE ACCESS TOKEN
   ========================================================= */

async function createGoogleAccessToken(
  serviceAccount: ServiceAccount,
): Promise<string> {
  const now = Math.floor(
    Date.now() / 1000,
  );

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: serviceAccount.client_email,
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

  const key =
    await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(
        serviceAccount.private_key,
      ),
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
    `${unsignedToken}.${base64UrlEncode(
      signature,
    )}`;

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body:
        `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer` +
        `&assertion=${encodeURIComponent(jwt)}`,
    },
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Google token error:",
      responseText,
    );

    throw new Error(
      "Unable to authenticate with Firebase.",
    );
  }

  let data: {
    access_token?: string;
    error?: string;
  };

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Firebase authentication returned invalid JSON.",
    );
  }

  if (!data.access_token) {
    throw new Error(
      data.error ||
        "Firebase access token was not returned.",
    );
  }

  return data.access_token;
}

/* =========================================================
   FIRESTORE
   ========================================================= */

async function firestoreRequest(
  env: Env,
  path: string,
  options: RequestInit = {},
) {
  const serviceAccount =
    getFirebaseServiceAccount(env);

  const accessToken =
    await createGoogleAccessToken(
      serviceAccount,
    );

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(
      serviceAccount.project_id,
    )}` +
    `/databases/(default)/documents/${path}`;

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

  return null;
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

    const document =
      await response.json<any>();

    return {
      votingOpen:
        extractFirestoreValue(
          document.fields
            ?.votingOpen,
        ) ?? true,

      votePrice:
        Number(
          extractFirestoreValue(
            document.fields
              ?.votePrice,
          ) ??
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

  return response.json<any>();
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
  let body: any;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        success: false,
        error:
          "Invalid payment request.",
      },
      400,
      getOrigin(request),
    );
  }

  const contestantId =
    String(
      body?.contestantId ||
        "",
    ).trim();

  const votes =
    Number(body?.votes);

  const email =
    String(
      body?.email ||
        "",
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
      contestant.fields
        ?.published,
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
    votes *
    settings.votePrice;

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
            votes,
            votePrice:
              settings.votePrice,
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
      "Invalid Paystack response:",
      paystackText,
    );

    return json(
      {
        success: false,
        error:
          "Paystack returned an invalid response.",
      },
      502,
      getOrigin(request),
    );
  }

  if (
    !paystackResponse.ok ||
    !paystackData.status ||
    !paystackData.data
  ) {
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
    getOrigin(request),
  );
}

/* =========================================================
   CREDIT PAYMENT
   ========================================================= */

async function creditVotes(
  env: Env,
  payment: {
    reference: string;
    contestantId: string;
    votes: number;
    amount: number;
    email: string;
  },
) {
  const serviceAccount =
    getFirebaseServiceAccount(env);

  const accessToken =
    await createGoogleAccessToken(
      serviceAccount,
    );

  const project =
    encodeURIComponent(
      serviceAccount.project_id,
    );

  const commitUrl =
    `https://firestore.googleapis.com/v1/projects/${project}` +
    `/databases/(default)/documents:commit`;

  const paymentDocument =
    `projects/${serviceAccount.project_id}` +
    `/databases/(default)/documents/payments/` +
    payment.reference;

  const contestantDocument =
    `projects/${serviceAccount.project_id}` +
    `/databases/(default)/documents/contestants/` +
    payment.contestantId;

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
                    firestoreInteger(
                      payment.amount,
                    ),

                  email:
                    firestoreString(
                      payment.email,
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
      "Firestore commit error:",
      errorText,
    );

    if (
      errorText.includes(
        "ALREADY_EXISTS",
      ) ||
      errorText.includes(
        "FAILED_PRECONDITION",
      )
    ) {
      throw new Error(
        "This payment has already been credited.",
      );
    }

    throw new Error(
      "Unable to record the payment.",
    );
  }

  return true;
}

/* =========================================================
   VERIFY PAYMENT
   ========================================================= */

async function verifyPayment(
  request: Request,
  env: Env,
) {
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
      getOrigin(request),
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
      "Invalid Paystack verification response:",
      paystackText,
    );

    return json(
      {
        success: false,
        error:
          "Paystack returned an invalid verification response.",
      },
      502,
      getOrigin(request),
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
          "Payment verification failed.",
      },
      400,
      getOrigin(request),
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
    Number(
      metadata.votes,
    );

  const email =
    String(
      transaction.customer
        ?.email ||
        "",
    )
      .trim()
      .toLowerCase();

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
    Number(
      transaction.amount,
    ) !== expectedAmount
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

  try {
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
      },
    );
  } catch (error: any) {
    if (
      error?.message?.includes(
        "already been credited",
      )
    ) {
      return json(
        {
          success: true,
          alreadyCredited:
            true,
          reference,
        },
        200,
        getOrigin(request),
      );
    }

    throw error;
  }

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
    },
    200,
    getOrigin(request),
  );
}

/* =========================================================
   PAYSTACK WEBHOOK SIGNATURE
   ========================================================= */

async function verifyPaystackSignature(
  body: string,
  signature: string,
  secret: string,
) {
  if (!signature) {
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

  const expected =
    new Uint8Array(
      signature
        .match(/.{1,2}/g)
        ?.map(
          (byte) =>
            parseInt(
              byte,
              16,
            ),
        ) || [],
    );

  if (
    expected.length !== 64
  ) {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(
      body,
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

  const metadata =
    transaction.metadata ||
    {};

  const contestantId =
    String(
      metadata.contestantId ||
        "",
    ).trim();

  const votes =
    Number(
      metadata.votes,
    );

  const email =
    String(
      transaction.customer
        ?.email ||
        "",
    )
      .trim()
      .toLowerCase();

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1
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
    await getVotingSettings(env);

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
          "Webhook payment amount is invalid.",
      },
      400,
    );
  }

  try {
    const credited =
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
        },
      );

    return json({
      success: true,
      ...credited,
    });
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
          error:
            "Not found.",
        },
        404,
        origin,
      );
    } catch (error) {
      console.error(
        "NAPAS Worker Error:",
        error,
      );

      return json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "An unexpected payment server error occurred.",
        },
        500,
        origin,
      );
    }
  },
} satisfies ExportedHandler<Env>;

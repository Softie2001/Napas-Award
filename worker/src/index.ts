interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

const ALLOWED_ORIGINS = [
  "https://softie2001.github.io",
  "https://napas-award.com",
  "https://www.napas-award.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const DEFAULT_VOTE_PRICE = 100;

function getOrigin(request: Request): string | null {
  return request.headers.get("Origin");
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  body: unknown,
  status = 200,
  origin: string | null = null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

/* =========================================================
   FIREBASE JWT HELPERS
========================================================= */

function base64UrlEncode(input: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
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

function privateKeyToArrayBuffer(privateKey: string): ArrayBuffer {
  const cleaned = privateKey
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const bytes = base64UrlDecode(cleaned);

  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
}

function validateFirebaseConfig(env: Env): void {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID is not configured.");
  }

  if (!env.FIREBASE_CLIENT_EMAIL) {
    throw new Error("FIREBASE_CLIENT_EMAIL is not configured.");
  }

  if (!env.FIREBASE_PRIVATE_KEY) {
    throw new Error("FIREBASE_PRIVATE_KEY is not configured.");
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  }
}

/* =========================================================
   FIREBASE ACCESS TOKEN
========================================================= */

async function firebaseAccessToken(
  env: Env
): Promise<{
  token: string;
  projectId: string;
}> {
  validateFirebaseConfig(env);

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const unsignedToken =
    `${encodedHeader}.${encodedPayload}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyToArrayBuffer(env.FIREBASE_PRIVATE_KEY),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
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
    }
  );

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Unable to authenticate with Firebase."
    );
  }

  return {
    token: data.access_token,
    projectId: env.FIREBASE_PROJECT_ID,
  };
}

/* =========================================================
   FIRESTORE
========================================================= */

async function firestoreGet(
  env: Env,
  path: string
): Promise<{
  res: Response;
  data: any;
}> {
  const auth = await firebaseAccessToken(env);

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(auth.projectId)}` +
    `/databases/(default)/documents/${path}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });

  const text = await res.text();

  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  return {
    res,
    data,
  };
}

function firestoreValue(value: unknown): any {
  if (value === null) {
    return {
      nullValue: null,
    };
  }

  if (typeof value === "string") {
    return {
      stringValue: value,
    };
  }

  if (typeof value === "boolean") {
    return {
      booleanValue: value,
    };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return {
        integerValue: String(value),
      };
    }

    return {
      doubleValue: value,
    };
  }

  return {
    stringValue: String(value),
  };
}

function getNumberField(
  fields: any,
  name: string,
  fallback = 0
): number {
  return Number(
    fields?.[name]?.integerValue ??
      fields?.[name]?.doubleValue ??
      fallback
  );
}

async function firestoreCommit(
  env: Env,
  writes: any[]
): Promise<any> {
  const auth = await firebaseAccessToken(env);

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(auth.projectId)}` +
    `/databases/(default)/documents:commit`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      writes,
    }),
  });

  const text = await response.text();

  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
        "Firebase write failed."
    ) as Error & {
      status?: number;
      firebase?: any;
    };

    error.status = response.status;
    error.firebase = data?.error;

    throw error;
  }

  return data;
}

/* =========================================================
   VOTING SETTINGS
========================================================= */

async function getVotingSettings(env: Env): Promise<{
  votingOpen: boolean;
  votePrice: number;
}> {
  try {
    const result = await firestoreGet(
      env,
      "settings/voting"
    );

    if (!result.res.ok) {
      return {
        votingOpen: true,
        votePrice: DEFAULT_VOTE_PRICE,
      };
    }

    const fields = result.data?.fields || {};

    return {
      votingOpen:
        fields.votingOpen?.booleanValue ?? true,

      votePrice:
        getNumberField(
          fields,
          "votePrice",
          DEFAULT_VOTE_PRICE
        ),
    };
  } catch (error) {
    console.error(
      "Unable to load voting settings:",
      error
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
  contestantId: string
) {
  return firestoreGet(
    env,
    `contestants/${encodeURIComponent(contestantId)}`
  );
}

/* =========================================================
   PAYSTACK
========================================================= */

async function paystack(
  path: string,
  env: Env,
  init: RequestInit = {}
): Promise<Response> {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured."
    );
  }

  return fetch(
    `https://api.paystack.co${path}`,
    {
      ...init,
      headers: {
        Authorization:
          `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type":
          "application/json",
        ...(init.headers || {}),
      },
    }
  );
}

/* =========================================================
   INITIALIZE PAYMENT
========================================================= */

async function initializePayment(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = getOrigin(request);

  const body = (await request.json()) as {
    contestantId?: string;
    votes?: number;
    email?: string;
    name?: string;
    phone?: string;
    callbackUrl?: string;
  };

  const contestantId =
    String(body.contestantId || "").trim();

  const votes =
    Math.floor(Number(body.votes || 0));

  const email =
    String(body.email || "")
      .trim()
      .toLowerCase();

  const name =
    String(body.name || "").trim();

  const phone =
    String(body.phone || "").trim();

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
          "Choose a valid contestant and vote quantity from 1 to 1,000.",
      },
      400,
      origin
    );
  }

  if (name.length < 2 || name.length > 120) {
    return json(
      {
        success: false,
        error:
          "Please provide your full name.",
      },
      400,
      origin
    );
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json(
      {
        success: false,
        error:
          "Please provide a valid email address.",
      },
      400,
      origin
    );
  }

  if (phone.length > 40) {
    return json(
      {
        success: false,
        error:
          "Please provide a valid phone number.",
      },
      400,
      origin
    );
  }

  const contestant =
    await getContestant(
      env,
      contestantId
    );

  if (
    !contestant.res.ok ||
    !contestant.data?.fields
  ) {
    return json(
      {
        success: false,
        error:
          "Contestant not found.",
      },
      404,
      origin
    );
  }

  const published =
    contestant.data.fields.published
      ?.booleanValue;

  if (published !== true) {
    return json(
      {
        success: false,
        error:
          "This contestant is not available for voting.",
      },
      403,
      origin
    );
  }

  const {
    votingOpen,
    votePrice,
  } =
    await getVotingSettings(env);

  if (!votingOpen) {
    return json(
      {
        success: false,
        error:
          "Voting is currently closed.",
      },
      403,
      origin
    );
  }

  if (
    !Number.isFinite(votePrice) ||
    votePrice <= 0
  ) {
    return json(
      {
        success: false,
        error:
          "Voting price is not configured.",
      },
      500,
      origin
    );
  }

  const amountNaira =
    votes * votePrice;

  const reference =
    `NAPAS-${Date.now()}-` +
    crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase();

  const fallbackCallback =
    "https://napas-award.com/?payment=return";

  let callbackUrl =
    fallbackCallback;

  if (body.callbackUrl) {
    try {
      const parsed =
        new URL(body.callbackUrl);

      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password
      ) {
        parsed.searchParams.set(
          "payment",
          "return"
        );

        callbackUrl =
          parsed.toString();
      }
    } catch {
      callbackUrl =
        fallbackCallback;
    }
  }

  const paystackResponse =
    await paystack(
      "/transaction/initialize",
      env,
      {
        method: "POST",
        body: JSON.stringify({
          email,

          amount:
            Math.round(
              amountNaira * 100
            ),

          currency: "NGN",

          reference,

          callback_url:
            callbackUrl,

          metadata: {
            contestantId,
            votes,
            voterName: name,
            phone,
            votePrice,
            amountNaira,
            source:
              "NAPAS_AWARD_VOTING",
          },
        }),
      }
    );

  const result =
    (await paystackResponse.json()) as any;

  if (
    !paystackResponse.ok ||
    !result.status ||
    !result.data?.authorization_url
  ) {
    console.error(
      "Paystack initialization error:",
      result
    );

    return json(
      {
        success: false,
        error:
          result.message ||
          "Paystack initialization failed.",
      },
      502,
      origin
    );
  }

  return json(
    {
      success: true,
      reference,

      authorization_url:
        result.data.authorization_url,

      amount: amountNaira,

      votes,

      contestantId,
    },
    200,
    origin
  );
}

/* =========================================================
   PAYMENT LOOKUP
========================================================= */

async function getPayment(
  env: Env,
  reference: string
) {
  return firestoreGet(
    env,
    `payments/${encodeURIComponent(reference)}`
  );
}

/* =========================================================
   CREDIT VERIFIED PAYMENT
========================================================= */

async function creditVerifiedPayment(
  env: Env,
  transaction: any
) {
  const reference =
    String(
      transaction?.reference || ""
    ).trim();

  const metadata =
    transaction?.metadata || {};

  const contestantId =
    String(
      metadata.contestantId || ""
    ).trim();

  const votes =
    Math.floor(
      Number(metadata.votes || 0)
    );

  if (
    !reference ||
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > 1000
  ) {
    throw new Error(
      "Verified payment metadata is incomplete."
    );
  }

  const existing =
    await getPayment(
      env,
      reference
    );

  if (
    existing.res.ok &&
    existing.data?.fields
  ) {
    return {
      alreadyCredited: true,

      newTotalVotes:
        getNumberField(
          existing.data.fields,
          "newTotalVotes",
          0
        ),

      contestantId,

      votes,
    };
  }

  const contestant =
    await getContestant(
      env,
      contestantId
    );

  if (
    !contestant.res.ok ||
    !contestant.data?.fields
  ) {
    throw new Error(
      "Contestant no longer exists."
    );
  }

  const currentVotes =
    getNumberField(
      contestant.data.fields,
      "votes",
      0
    );

  const projectedTotal =
    currentVotes + votes;

  const auth =
    await firebaseAccessToken(env);

  const paymentName =
    `projects/${auth.projectId}` +
    `/databases/(default)/documents/payments/` +
    reference;

  const contestantName =
    `projects/${auth.projectId}` +
    `/databases/(default)/documents/contestants/` +
    contestantId;

  try {
    await firestoreCommit(
      env,
      [
        {
          update: {
            name: paymentName,

            fields: {
              reference:
                firestoreValue(
                  reference
                ),

              contestantId:
                firestoreValue(
                  contestantId
                ),

              votes:
                firestoreValue(
                  votes
                ),

              amount:
                firestoreValue(
                  Number(
                    transaction.amount || 0
                  ) / 100
                ),

              email:
                firestoreValue(
                  String(
                    transaction
                      .customer
                      ?.email || ""
                  )
                ),

              voterName:
                firestoreValue(
                  String(
                    metadata.voterName ||
                      ""
                  )
                ),

              phone:
                firestoreValue(
                  String(
                    metadata.phone ||
                      ""
                  )
                ),

              paystackTransactionId:
                firestoreValue(
                  String(
                    transaction.id ||
                      ""
                  )
                ),

              newTotalVotes:
                firestoreValue(
                  projectedTotal
                ),

              status:
                firestoreValue(
                  "success"
                ),

              createdAt: {
                timestampValue:
                  new Date().toISOString(),
              },
            },
          },

          currentDocument: {
            exists: false,
          },
        },

        {
          transform: {
            document:
              contestantName,

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
      ]
    );
  } catch (error) {
    const firebaseStatus =
      (error as any)?.firebase
        ?.status;

    const message =
      String(
        (error as Error)?.message ||
          ""
      );

    if (
      firebaseStatus ===
        "ALREADY_EXISTS" ||
      message.includes(
        "ALREADY_EXISTS"
      )
    ) {
      const winner =
        await getPayment(
          env,
          reference
        );

      if (
        winner.res.ok &&
        winner.data?.fields
      ) {
        return {
          alreadyCredited: true,

          newTotalVotes:
            getNumberField(
              winner.data.fields,
              "newTotalVotes",
              0
            ),

          contestantId,

          votes,
        };
      }
    }

    throw error;
  }

  const refreshed =
    await getContestant(
      env,
      contestantId
    );

  const newTotalVotes =
    refreshed.res.ok
      ? getNumberField(
          refreshed.data?.fields,
          "votes",
          projectedTotal
        )
      : projectedTotal;

  return {
    alreadyCredited: false,
    newTotalVotes,
    contestantId,
    votes,
  };
}

/* =========================================================
   VERIFY PAYMENT
========================================================= */

async function verifyPayment(
  request: Request,
  env: Env
): Promise<Response> {
  const origin =
    getOrigin(request);

  const body =
    (await request.json()) as {
      reference?: string;
      contestantId?: string;
      votes?: number;
    };

  const reference =
    String(
      body.reference || ""
    ).trim();

  const contestantId =
    String(
      body.contestantId || ""
    ).trim();

  const votes =
    Math.floor(
      Number(body.votes || 0)
    );

  if (
    !reference ||
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > 1000
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid verification request.",
      },
      400,
      origin
    );
  }

  const existing =
    await getPayment(
      env,
      reference
    );

  if (
    existing.res.ok &&
    existing.data?.fields
  ) {
    const storedContestant =
      String(
        existing.data.fields
          .contestantId
          ?.stringValue || ""
      );

    const storedVotes =
      getNumberField(
        existing.data.fields,
        "votes",
        0
      );

    if (
      storedContestant !==
        contestantId ||
      storedVotes !== votes
    ) {
      return json(
        {
          success: false,
          error:
            "Payment reference does not match this vote.",
        },
        409,
        origin
      );
    }

    return json(
      {
        success: true,
        alreadyCredited: true,

        newTotalVotes:
          getNumberField(
            existing.data.fields,
            "newTotalVotes",
            0
          ),

        reference,
      },
      200,
      origin
    );
  }

  const paystackResponse =
    await paystack(
      `/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      env
    );

  const result =
    (await paystackResponse.json()) as any;

  if (
    !paystackResponse.ok ||
    !result.status ||
    result.data?.status !==
      "success"
  ) {
    return json(
      {
        success: false,
        error:
          "Payment verification failed. If you were charged, keep your Paystack reference and contact NAPAS.",
      },
      400,
      origin
    );
  }

  const metadata =
    result.data?.metadata || {};

  const paidContestant =
    String(
      metadata.contestantId || ""
    );

  const paidVotes =
    Math.floor(
      Number(
        metadata.votes || 0
      )
    );

  if (
    paidContestant !==
      contestantId ||
    paidVotes !== votes
  ) {
    return json(
      {
        success: false,
        error:
          "Payment details do not match the selected vote.",
      },
      400,
      origin
    );
  }

  const settings =
    await getVotingSettings(env);

  const expectedAmount =
    votes *
    settings.votePrice *
    100;

  if (
    Number(result.data.amount) !==
    expectedAmount
  ) {
    return json(
      {
        success: false,
        error:
          "Payment amount does not match the vote quantity.",
      },
      400,
      origin
    );
  }

  const credited =
    await creditVerifiedPayment(
      env,
      result.data
    );

  return json(
    {
      success: true,
      reference,

      ...credited,
    },
    200,
    origin
  );
}

/* =========================================================
   PAYSTACK WEBHOOK SIGNATURE
========================================================= */

function hexToBytes(
  hex: string
): Uint8Array | null {
  if (
    !/^[0-9a-fA-F]{128}$/.test(hex)
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
          i * 2 + 2
        ),
        16
      );
  }

  return bytes;
}

async function verifyPaystackSignature(
  body: string,
  signature: string,
  secret: string
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
        secret
      ),
      {
        name: "HMAC",
        hash: "SHA-512",
      },
      false,
      ["verify"]
    );

  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(
      body
    )
  );
}

/* =========================================================
   PAYSTACK WEBHOOK
========================================================= */

async function handlePaystackWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const rawBody =
    await request.text();

  const signature =
    request.headers.get(
      "x-paystack-signature"
    ) || "";

  if (
    !signature ||
    !(
      await verifyPaystackSignature(
        rawBody,
        signature,
        env.PAYSTACK_SECRET_KEY
      )
    )
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid webhook signature.",
      },
      401,
      null
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
      null
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
      }
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
      }
    );
  }

  try {
    const credited =
      await creditVerifiedPayment(
        env,
        transaction
      );

    return json(
      {
        success: true,
        ...credited,
      }
    );
  } catch (error) {
    console.error(
      "Webhook credit failed:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Webhook processing failed.",
      },
      500
    );
  }
}

/* =========================================================
   WORKER
========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env
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
        }
      );
    }

    const url =
      new URL(request.url);

    try {
      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return json(
          {
            service:
              "NAPAS Secure Voting Payment API",
            status: "online",
          },
          200,
          origin
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/initialize"
      ) {
        return await initializePayment(
          request,
          env
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/verify"
      ) {
        return await verifyPayment(
          request,
          env
        );
      }

      if (
        request.method === "POST" &&
        url.pathname ===
          "/paystack-webhook"
      ) {
        return await handlePaystackWebhook(
          request,
          env
        );
      }

      return json(
        {
          success: false,
          error: "Not found.",
        },
        404,
        origin
      );
    } catch (error) {
      console.error(
        "NAPAS Worker Error:",
        error
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
        origin
      );
    }
  },
};

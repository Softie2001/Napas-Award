import { importPKCS8, SignJWT } from "jose";

interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}

interface FirebaseServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
  universe_domain?: string;
}

interface FirestoreResponse {
  res: Response;
  data: any;
}

const ALLOWED_ORIGINS = [
  "https://softie2001.github.io",
  "https://napas-award.com",
  "http://localhost:8787",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

const DEFAULT_VOTE_PRICE = 100;
const MAX_VOTES_PER_TRANSACTION = 1000;

/* =========================================================
   CORS
========================================================= */

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
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

/* =========================================================
   JSON RESPONSE
========================================================= */

function json(
  body: unknown,
  status = 200,
  origin: string | null = null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

/* =========================================================
   FIREBASE SERVICE ACCOUNT
========================================================= */

function parseServiceAccount(
  raw: string
): FirebaseServiceAccount {
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT is not configured."
    );
  }

  let service: FirebaseServiceAccount;

  try {
    service = JSON.parse(raw);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT contains invalid JSON."
    );
  }

  if (
    !service.project_id ||
    !service.client_email ||
    !service.private_key
  ) {
    throw new Error(
      "Firebase service account is missing required fields."
    );
  }

  return service;
}

/* =========================================================
   GOOGLE / FIREBASE ACCESS TOKEN
========================================================= */

async function firebaseAccessToken(
  env: Env
): Promise<{
  token: string;
  projectId: string;
}> {
  const serviceAccount = parseServiceAccount(
    env.FIREBASE_SERVICE_ACCOUNT
  );

  let privateKey = serviceAccount.private_key;

  /*
   * Cloudflare secret should normally contain the escaped
   * newline characters from the original Firebase JSON.
   *
   * This also safely handles a secret where the key has
   * accidentally been stored with literal line breaks.
   */
  privateKey = privateKey.replace(/\\n/g, "\n");

  let key: CryptoKey;

  try {
    key = await importPKCS8(privateKey, "RS256");
  } catch (error) {
    console.error(
      "Firebase private key import failed:",
      error
    );

    throw new Error(
      "Firebase private key is invalid. Generate a new Firebase service-account key and replace the FIREBASE_SERVICE_ACCOUNT secret."
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({
    scope:
      "https://www.googleapis.com/auth/datastore"
  })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT"
    })
    .setIssuer(serviceAccount.client_email)
    .setAudience(
      "https://oauth2.googleapis.com/token"
    )
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const tokenResponse = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    }
  );

  const tokenData =
    (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    console.error(
      "Google token error:",
      tokenData
    );

    throw new Error(
      tokenData.error_description ||
        tokenData.error ||
        "Unable to authenticate with Firebase."
    );
  }

  return {
    token: tokenData.access_token,
    projectId: serviceAccount.project_id
  };
}

/* =========================================================
   FIRESTORE GET
========================================================= */

async function firestoreGet(
  env: Env,
  path: string
): Promise<FirestoreResponse> {
  const auth = await firebaseAccessToken(env);

  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(auth.projectId)}` +
    `/databases/(default)/documents/${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.token}`
    }
  });

  let data: any = null;

  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return {
    res,
    data
  };
}

/* =========================================================
   FIRESTORE VALUE HELPERS
========================================================= */

function firestoreValue(
  value: unknown
): Record<string, unknown> {
  if (value === null) {
    return {
      nullValue: null
    };
  }

  if (typeof value === "string") {
    return {
      stringValue: value
    };
  }

  if (typeof value === "boolean") {
    return {
      booleanValue: value
    };
  }

  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return {
        integerValue: String(value)
      };
    }

    return {
      doubleValue: value
    };
  }

  return {
    stringValue: String(value)
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

/* =========================================================
   FIRESTORE COMMIT
========================================================= */

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
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      writes
    })
  });

  let data: any = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
        "Firebase write failed."
    );

    (error as any).status = response.status;
    (error as any).firebase = data?.error;

    throw error;
  }

  return data;
}

/* =========================================================
   VOTING SETTINGS
========================================================= */

async function getVotingSettings(
  env: Env
): Promise<{
  votingOpen: boolean;
  votePrice: number;
}> {
  try {
    const result = await firestoreGet(
      env,
      "settings/voting"
    );

    if (!result.res.ok) {
      console.warn(
        "Voting settings document unavailable. Using defaults."
      );

      return {
        votingOpen: true,
        votePrice: DEFAULT_VOTE_PRICE
      };
    }

    const fields =
      result.data?.fields || {};

    return {
      votingOpen:
        fields.votingOpen?.booleanValue ??
        true,

      votePrice: getNumberField(
        fields,
        "votePrice",
        DEFAULT_VOTE_PRICE
      )
    };
  } catch (error) {
    console.error(
      "Unable to load voting settings:",
      error
    );

    return {
      votingOpen: true,
      votePrice: DEFAULT_VOTE_PRICE
    };
  }
}

/* =========================================================
   CONTESTANT
========================================================= */

async function getContestant(
  env: Env,
  contestantId: string
): Promise<FirestoreResponse> {
  return firestoreGet(
    env,
    `contestants/${encodeURIComponent(
      contestantId
    )}`
  );
}

/* =========================================================
   PAYSTACK REQUEST
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
        ...(init.headers || {})
      }
    }
  );
}

/* =========================================================
   CALLBACK URL
========================================================= */

function getSafeCallbackUrl(
  suppliedUrl: string
): string {
  const defaultUrl =
    "https://napas-award.com/?payment=return";

  if (!suppliedUrl) {
    return defaultUrl;
  }

  try {
    const parsed =
      new URL(suppliedUrl);

    const allowedHosts = [
      "napas-award.com",
      "www.napas-award.com",
      "softie2001.github.io"
    ];

    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.includes(
        parsed.hostname
      )
    ) {
      return defaultUrl;
    }

    parsed.searchParams.set(
      "payment",
      "return"
    );

    return parsed.toString();
  } catch {
    return defaultUrl;
  }
}

/* =========================================================
   INITIALIZE PAYMENT
========================================================= */

async function initializePayment(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = getOrigin(request);

  let body: any;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "Invalid request body."
      },
      400,
      origin
    );
  }

  const contestantId =
    String(
      body?.contestantId || ""
    ).trim();

  const votes =
    Math.floor(
      Number(body?.votes || 0)
    );

  const email =
    String(
      body?.email || ""
    )
      .trim()
      .toLowerCase();

  const name =
    String(
      body?.name || ""
    ).trim();

  const phone =
    String(
      body?.phone || ""
    ).trim();

  const callbackUrl =
    String(
      body?.callbackUrl || ""
    ).trim();

  /* -------------------------------
     Validate votes
  -------------------------------- */

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_TRANSACTION
  ) {
    return json(
      {
        success: false,
        error:
          "Choose a valid contestant and a vote quantity from 1 to 1,000."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Validate name
  -------------------------------- */

  if (
    name.length < 2 ||
    name.length > 120
  ) {
    return json(
      {
        success: false,
        error:
          "Please provide your full name."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Validate email
  -------------------------------- */

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {
    return json(
      {
        success: false,
        error:
          "Please provide a valid email address."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Validate phone
  -------------------------------- */

  if (phone.length > 40) {
    return json(
      {
        success: false,
        error:
          "Please provide a valid phone number."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Voting settings
  -------------------------------- */

  const settings =
    await getVotingSettings(env);

  if (!settings.votingOpen) {
    return json(
      {
        success: false,
        error:
          "Voting is currently closed."
      },
      403,
      origin
    );
  }

  if (
    !Number.isFinite(
      settings.votePrice
    ) ||
    settings.votePrice <= 0
  ) {
    return json(
      {
        success: false,
        error:
          "Voting price is not configured."
      },
      500,
      origin
    );
  }

  /* -------------------------------
     Check contestant
  -------------------------------- */

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
          "Contestant not found."
      },
      404,
      origin
    );
  }

  const published =
    contestant.data.fields
      ?.published
      ?.booleanValue;

  if (published === false) {
    return json(
      {
        success: false,
        error:
          "This contestant is not available for voting."
      },
      403,
      origin
    );
  }

  /* -------------------------------
     Amount
  -------------------------------- */

  const amountNaira =
    votes *
    settings.votePrice;

  const amountKobo =
    Math.round(
      amountNaira * 100
    );

  if (
    !Number.isSafeInteger(
      amountKobo
    ) ||
    amountKobo <= 0
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid payment amount."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Reference
  -------------------------------- */

  const reference =
    `NAPAS-${Date.now()}-` +
    crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase();

  /* -------------------------------
     Callback
  -------------------------------- */

  const safeCallbackUrl =
    getSafeCallbackUrl(
      callbackUrl
    );

  /* -------------------------------
     Paystack
  -------------------------------- */

  const paystackResponse =
    await paystack(
      "/transaction/initialize",
      env,
      {
        method: "POST",

        body: JSON.stringify({
          email,

          amount:
            amountKobo,

          currency: "NGN",

          reference,

          callback_url:
            safeCallbackUrl,

          metadata: {
            contestantId,
            votes,
            voterName: name,
            phone,
            votePrice:
              settings.votePrice,
            amountNaira,
            source:
              "NAPAS_AWARD_VOTING"
          }
        })
      }
    );

  let result: any;

  try {
    result =
      await paystackResponse.json();
  } catch {
    result = null;
  }

  if (
    !paystackResponse.ok ||
    !result?.status ||
    !result?.data
      ?.authorization_url
  ) {
    console.error(
      "Paystack initialize error:",
      result
    );

    return json(
      {
        success: false,
        error:
          result?.message ||
          "Paystack initialization failed."
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

      access_code:
        result.data.access_code,

      amount:
        amountNaira,

      votes,

      contestantId
    },
    200,
    origin
  );
}

/* =========================================================
   PAYMENT DOCUMENT
========================================================= */

async function getPayment(
  env: Env,
  reference: string
): Promise<FirestoreResponse> {
  return firestoreGet(
    env,
    `payments/${encodeURIComponent(
      reference
    )}`
  );
}

/* =========================================================
   CREDIT VERIFIED PAYMENT
========================================================= */

async function creditVerifiedPayment(
  env: Env,
  transaction: any
): Promise<{
  alreadyCredited: boolean;
  newTotalVotes: number;
  contestantId: string;
  votes: number;
}> {
  const reference =
    String(
      transaction?.reference ||
        ""
    ).trim();

  const metadata =
    transaction?.metadata || {};

  const contestantId =
    String(
      metadata?.contestantId ||
        ""
    ).trim();

  const votes =
    Math.floor(
      Number(
        metadata?.votes || 0
      )
    );

  if (
    !reference ||
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_TRANSACTION
  ) {
    throw new Error(
      "Verified payment metadata is incomplete."
    );
  }

  /* -------------------------------
     Check duplicate payment
  -------------------------------- */

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
      votes
    };
  }

  /* -------------------------------
     Get contestant
  -------------------------------- */

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

  const published =
    contestant.data.fields
      ?.published
      ?.booleanValue;

  if (published === false) {
    throw new Error(
      "Contestant is no longer available for voting."
    );
  }

  /* -------------------------------
     Current votes
  -------------------------------- */

  const currentVotes =
    getNumberField(
      contestant.data.fields,
      "votes",
      0
    );

  const projectedTotal =
    currentVotes + votes;

  /* -------------------------------
     Firebase project
  -------------------------------- */

  const auth =
    await firebaseAccessToken(
      env
    );

  const paymentName =
    `projects/${auth.projectId}` +
    `/databases/(default)` +
    `/documents/payments/` +
    reference;

  const contestantName =
    `projects/${auth.projectId}` +
    `/databases/(default)` +
    `/documents/contestants/` +
    contestantId;

  /* -------------------------------
     Atomic Firestore write
  -------------------------------- */

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
                    transaction.amount ||
                      0
                  ) / 100
                ),

              email:
                firestoreValue(
                  String(
                    transaction
                      ?.customer
                      ?.email || ""
                  )
                ),

              voterName:
                firestoreValue(
                  String(
                    metadata
                      ?.voterName || ""
                  )
                ),

              phone:
                firestoreValue(
                  String(
                    metadata
                      ?.phone || ""
                  )
                ),

              paystackTransactionId:
                firestoreValue(
                  String(
                    transaction?.id ||
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
                  new Date().toISOString()
              }
            }
          },

          currentDocument: {
            exists: false
          }
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
                    String(votes)
                }
              }
            ]
          }
        }
      ]
    );
  } catch (error) {
    /*
     * This can happen when the Paystack webhook and
     * browser verification arrive at almost the same
     * time. The payment document is our idempotency lock.
     */

    const firebaseError =
      (error as any)?.firebase;

    const errorMessage =
      String(
        (error as Error)
          ?.message || ""
      );

    if (
      firebaseError?.status ===
        "ALREADY_EXISTS" ||
      errorMessage.includes(
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
              projectedTotal
            ),

          contestantId,
          votes
        };
      }
    }

    throw error;
  }

  /* -------------------------------
     Get final vote total
  -------------------------------- */

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
    votes
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

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        success: false,
        error:
          "Invalid verification request."
      },
      400,
      origin
    );
  }

  const reference =
    String(
      body?.reference || ""
    ).trim();

  const contestantId =
    String(
      body?.contestantId || ""
    ).trim();

  const votes =
    Math.floor(
      Number(body?.votes || 0)
    );

  if (
    !reference ||
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_TRANSACTION
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid verification request."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Check existing payment first
  -------------------------------- */

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
          ?.contestantId
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
            "Payment reference does not match this vote."
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
        reference
      },
      200,
      origin
    );
  }

  /* -------------------------------
     Ask Paystack
  -------------------------------- */

  const pay =
    await paystack(
      `/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      env
    );

  let result: any;

  try {
    result =
      await pay.json();
  } catch {
    result = null;
  }

  if (
    !pay.ok ||
    !result?.status ||
    result?.data?.status !==
      "success"
  ) {
    return json(
      {
        success: false,
        error:
          "Payment verification failed. If you were charged, keep your Paystack reference and contact NAPAS."
      },
      400,
      origin
    );
  }

  const transaction =
    result.data;

  const metadata =
    transaction?.metadata || {};

  const paidContestant =
    String(
      metadata?.contestantId ||
        ""
    );

  const paidVotes =
    Math.floor(
      Number(
        metadata?.votes || 0
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
          "Payment details do not match the selected vote."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Verify amount
  -------------------------------- */

  const settings =
    await getVotingSettings(
      env
    );

  const expectedAmount =
    votes *
    settings.votePrice *
    100;

  if (
    Number(
      transaction.amount
    ) !== expectedAmount
  ) {
    return json(
      {
        success: false,
        error:
          "Payment amount does not match the vote quantity."
      },
      400,
      origin
    );
  }

  /* -------------------------------
     Credit payment
  -------------------------------- */

  try {
    const credited =
      await creditVerifiedPayment(
        env,
        transaction
      );

    return json(
      {
        success: true,
        reference,
        ...credited
      },
      200,
      origin
    );
  } catch (error) {
    console.error(
      "Payment credit failed:",
      error
    );

    throw error;
  }
}

/* =========================================================
   PAYSTACK WEBHOOK SIGNATURE
========================================================= */

function hexToBytes(
  hex: string
): Uint8Array | null {
  if (
    !/^[0-9a-fA-F]{128}$/.test(
      hex
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
          i * 2 + 2
        ),
        16
      );
  }

  return bytes;
}

/* =========================================================
   VERIFY PAYSTACK WEBHOOK
========================================================= */

async function verifyPaystackSignature(
  rawBody: string,
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
        hash: "SHA-512"
      },
      false,
      ["verify"]
    );

  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(
      rawBody
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
    !env.PAYSTACK_SECRET_KEY
  ) {
    return json(
      {
        success: false,
        error:
          "Invalid webhook configuration."
      },
      401,
      null
    );
  }

  const valid =
    await verifyPaystackSignature(
      rawBody,
      signature,
      env.PAYSTACK_SECRET_KEY
    );

  if (!valid) {
    console.warn(
      "Rejected invalid Paystack webhook signature."
    );

    return json(
      {
        success: false,
        error:
          "Invalid webhook signature."
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
          "Invalid webhook payload."
      },
      400,
      null
    );
  }

  /*
   * We only care about successful charges.
   */

  if (
    event?.event !==
    "charge.success"
  ) {
    return json(
      {
        success: true,
        ignored: true
      },
      200,
      null
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
        ignored: true
      },
      200,
      null
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
        ...credited
      },
      200,
      null
    );
  } catch (error) {
    console.error(
      "Paystack webhook credit failed:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Webhook processing failed."
      },
      500,
      null
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

    /* -------------------------------
       CORS preflight
    -------------------------------- */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders(origin)
        }
      );
    }

    const url =
      new URL(request.url);

    try {
      /* -----------------------------
         Health check
      ------------------------------ */

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return json(
          {
            service:
              "NAPAS Secure Voting Payment API",
            status: "online",
            firebase:
              !!env.FIREBASE_SERVICE_ACCOUNT,
            paystack:
              !!env.PAYSTACK_SECRET_KEY
          },
          200,
          origin
        );
      }

      /* -----------------------------
         Initialize payment
      ------------------------------ */

      if (
        request.method === "POST" &&
        url.pathname ===
          "/initialize"
      ) {
        return await initializePayment(
          request,
          env
        );
      }

      /* -----------------------------
         Verify payment
      ------------------------------ */

      if (
        request.method === "POST" &&
        url.pathname === "/verify"
      ) {
        return await verifyPayment(
          request,
          env
        );
      }

      /* -----------------------------
         Paystack webhook
      ------------------------------ */

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

      /* -----------------------------
         Not found
      ------------------------------ */

      return json(
        {
          success: false,
          error:
            "Endpoint not found."
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
              : "An unexpected payment server error occurred."
        },
        500,
        origin
      );
    }
  }
};

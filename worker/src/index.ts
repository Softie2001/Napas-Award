interface Env {
  DB: D1Database;
  PAYSTACK_SECRET_KEY: string;
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

/* =========================================================
   CORS
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
   D1 HELPERS
========================================================= */

async function getContestant(
  env: Env,
  contestantId: string,
) {
  return await env.DB
    .prepare(
      `
      SELECT id, name, votes
      FROM contestants
      WHERE id = ?
      LIMIT 1
      `,
    )
    .bind(contestantId)
    .first<{
      id: string;
      name: string;
      votes: number;
    }>();
}

async function getPayment(
  env: Env,
  reference: string,
) {
  return await env.DB
    .prepare(
      `
      SELECT *
      FROM payments
      WHERE reference = ?
      LIMIT 1
      `,
    )
    .bind(reference)
    .first<any>();
}

async function getLedgerEntry(
  env: Env,
  reference: string,
) {
  return await env.DB
    .prepare(
      `
      SELECT *
      FROM vote_ledger
      WHERE reference = ?
      LIMIT 1
      `,
    )
    .bind(reference)
    .first<any>();
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
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    },
  );
}

/* =========================================================
   METADATA
========================================================= */

function getMetadata(transaction: any) {
  return transaction?.metadata || {};
}

function getContestantId(
  transaction: any,
) {
  const metadata =
    getMetadata(transaction);

  return String(
    metadata.contestantId ||
      metadata.firestoreContestantId ||
      metadata.contestantCode ||
      "",
  ).trim();
}

function getVotes(
  transaction: any,
) {
  const metadata =
    getMetadata(transaction);

  const votes =
    Math.floor(
      Number(metadata.votes || 0),
    );

  return Number.isInteger(votes)
    ? votes
    : 0;
}

function getVotePrice(
  transaction: any,
) {
  const metadata =
    getMetadata(transaction);

  const price =
    Number(metadata.votePrice);

  return Number.isFinite(price) &&
    price > 0
    ? price
    : DEFAULT_VOTE_PRICE;
}

function isNapasTransaction(
  transaction: any,
) {
  const reference =
    String(
      transaction?.reference || "",
    ).toUpperCase();

  const source =
    String(
      getMetadata(transaction)?.source ||
        "",
    ).toUpperCase();

  return (
    reference.startsWith("NAPAS-") ||
    source === "NAPAS_AWARD_VOTING"
  );
}

/* =========================================================
   ATOMIC D1 VOTE CREDIT
========================================================= */

async function creditVotes(
  env: Env,
  payment: {
    reference: string;
    contestantId: string;
    votes: number;
    amount: number;
    email?: string;
    voterName?: string;
    phone?: string;
    paystackTransactionId?: string;
    source: string;
  },
) {
  const reference =
    String(payment.reference || "").trim();

  if (!reference) {
    throw new Error(
      "Payment reference is required.",
    );
  }

  /*
   * Check payment first.
   */

  const existingPayment =
    await getPayment(
      env,
      reference,
    );

  if (existingPayment) {
    const alreadyApplied =
      Number(
        existingPayment.votes_applied || 0,
      );

    const credited =
      Number(
        existingPayment.votes_credited || 0,
      );

    if (
      alreadyApplied >=
      Number(payment.votes)
    ) {
      return {
        alreadyCredited: true,
        credited: false,
        votes: payment.votes,
      };
    }

    /*
     * Existing payment but votes not applied.
     *
     * We repair it here.
     */

    const contestant =
      await getContestant(
        env,
        payment.contestantId,
      );

    if (!contestant) {
      throw new Error(
        `Contestant ${payment.contestantId} not found.`,
      );
    }

    const ledger =
      await getLedgerEntry(
        env,
        reference,
      );

    if (ledger) {
      await env.DB
        .prepare(
          `
          UPDATE payments
          SET
            votes_credited = ?,
            votes_applied = ?,
            status = 'success'
          WHERE reference = ?
          `,
        )
        .bind(
          Number(payment.votes),
          Number(payment.votes),
          reference,
        )
        .run();

      return {
        alreadyCredited: true,
        credited: false,
        votes: payment.votes,
      };
    }
  }

  /*
   * New payment.
   *
   * We perform the following as one D1 batch:
   *
   * 1. Insert payment.
   * 2. Insert vote ledger entry.
   * 3. Increment contestant votes.
   *
   * The reference is the idempotency key.
   */

  const existingLedger =
    await getLedgerEntry(
      env,
      reference,
    );

  if (existingLedger) {
    return {
      alreadyCredited: true,
      credited: false,
      votes: Number(
        existingLedger.votes || payment.votes,
      ),
    };
  }

  const contestant =
    await getContestant(
      env,
      payment.contestantId,
    );

  if (!contestant) {
    throw new Error(
      `Contestant ${payment.contestantId} not found.`,
    );
  }

  const now =
    new Date().toISOString();

  const paymentInsert =
    env.DB.prepare(
      `
      INSERT INTO payments (
        reference,
        contestant_id,
        amount,
        votes,
        votes_credited,
        votes_applied,
        source,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reference) DO NOTHING
      `,
    ).bind(
      reference,
      payment.contestantId,
      payment.amount,
      payment.votes,
      payment.votes,
      payment.votes,
      payment.source,
      "success",
      now,
    );

  const ledgerInsert =
    env.DB.prepare(
      `
      INSERT INTO vote_ledger (
        reference,
        contestant_id,
        votes,
        created_at,
        source
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(reference) DO NOTHING
      `,
    ).bind(
      reference,
      payment.contestantId,
      payment.votes,
      now,
      payment.source,
    );

  const contestantUpdate =
    env.DB.prepare(
      `
      UPDATE contestants
      SET votes = votes + ?
      WHERE id = ?
      `,
    ).bind(
      payment.votes,
      payment.contestantId,
    );

  /*
   * First determine whether this reference was
   * already processed.
   */

  const check =
    await getPayment(
      env,
      reference,
    );

  if (check) {
    const applied =
      Number(
        check.votes_applied || 0,
      );

    if (
      applied >=
      payment.votes
    ) {
      return {
        alreadyCredited: true,
        credited: false,
        votes: payment.votes,
      };
    }
  }

  /*
   * Execute all three operations together.
   */

  await env.DB.batch([
    paymentInsert,
    ledgerInsert,
    contestantUpdate,
  ]);

  return {
    alreadyCredited: false,
    credited: true,
    votes: payment.votes,
  };
}

/* =========================================================
   INITIALIZE
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
        error: "Invalid request body.",
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
      Number(body?.votes || 0),
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
          "Contestant not found. Please refresh and try again.",
      },
      404,
      origin,
    );
  }

  const amountNaira =
    votes *
    DEFAULT_VOTE_PRICE;

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
              DEFAULT_VOTE_PRICE,
            voterName,
            phone,
            source:
              "NAPAS_AWARD_VOTING",
          },
        }),
      },
    );

  const data: any =
    await paystackResponse.json();

  if (
    !paystackResponse.ok ||
    !data.status ||
    !data.data?.authorization_url
  ) {
    return json(
      {
        success: false,
        error:
          data.message ||
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
      authorization_url:
        data.data.authorization_url,
      access_code:
        data.data.access_code,
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

  /*
   * D1 check.
   */

  const existing =
    await getPayment(
      env,
      reference,
    );

  if (existing) {
    if (
      Number(
        existing.votes_applied || 0,
      ) >=
      Number(
        existing.votes || 0,
      )
    ) {
      return json(
        {
          success: true,
          alreadyCredited: true,
          reference,
          contestantId:
            existing.contestant_id,
          votes:
            Number(existing.votes || 0),
        },
        200,
        origin,
      );
    }
  }

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
    data.data?.status !== "success"
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
    data.data;

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
    getMetadata(transaction);

  const contestantId =
    getContestantId(transaction);

  const votes =
    getVotes(transaction);

  const votePrice =
    getVotePrice(transaction);

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

  const expectedAmount =
    votes *
    votePrice *
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
      transaction.customer?.email ||
        "",
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
            Number(transaction.amount) /
            100,
          email,
          voterName:
            String(
              metadata.voterName || "",
            ),
          phone:
            String(
              metadata.phone || "",
            ),
          paystackTransactionId:
            String(
              transaction.id || "",
            ),
          source:
            "PAYSTACK_VERIFY",
        },
      );

    return json(
      {
        success: true,
        reference,
        contestantId,
        votes,
        amount:
          Number(transaction.amount) /
          100,
        alreadyCredited:
          result.alreadyCredited,
      },
      200,
      origin,
    );
  } catch (error) {
    console.error(
      "D1 verification error:",
      error,
    );

    return json(
      {
        success: false,
        error:
          "Payment was successful but vote crediting is still being processed.",
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

  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

async function verifyPaystackSignature(
  rawBody: string,
  signature: string,
  secret: string,
) {
  if (!signature || !secret) {
    return false;
  }

  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
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

  const supplied =
    new Uint8Array(
      signature.match(/.{1,2}/g)!
        .map(
          byte =>
            parseInt(byte, 16),
        ),
    );

  return timingSafeEqual(
    generated,
    supplied,
  );
}

/* =========================================================
   WEBHOOK
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
    event.data;

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
    });
  }

  const contestantId =
    getContestantId(transaction);

  const votes =
    getVotes(transaction);

  const votePrice =
    getVotePrice(transaction);

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

  const expectedAmount =
    votes *
    votePrice *
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

          votes,

          amount:
            Number(
              transaction.amount,
            ) / 100,

          email:
            String(
              transaction.customer?.email ||
                "",
            )
              .trim()
              .toLowerCase(),

          voterName:
            String(
              getMetadata(transaction)
                .voterName || "",
            ),

          phone:
            String(
              getMetadata(transaction)
                .phone || "",
            ),

          paystackTransactionId:
            String(
              transaction.id || "",
            ),

          source:
            "PAYSTACK_WEBHOOK",
        },
      );

    return json({
      success: true,
      reference:
        transaction.reference,
      alreadyCredited:
        result.alreadyCredited,
      votes,
    });
  } catch (error) {
    console.error(
      "Webhook D1 credit failed:",
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
  if (!env.RECONCILIATION_KEY) {
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

  const bearer =
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
    bearer ===
      env.RECONCILIATION_KEY
  );
}

/* =========================================================
   PAYSTACK VERIFY
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

async function reconcileOne(
  env: Env,
  reference: string,
  dryRun: boolean,
) {
  const cleanReference =
    String(reference || "").trim();

  if (
    !cleanReference
      .toUpperCase()
      .startsWith("NAPAS-")
  ) {
    return {
      action: "skipped",
      reason:
        "Not a NAPAS reference.",
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

  const contestantId =
    getContestantId(transaction);

  const votes =
    getVotes(transaction);

  const votePrice =
    getVotePrice(transaction);

  if (
    !contestantId ||
    !Number.isInteger(votes) ||
    votes < 1 ||
    votes > MAX_VOTES_PER_PAYMENT
  ) {
    return {
      action: "skipped",
      reason:
        "Incomplete metadata.",
    };
  }

  const expectedAmount =
    votes *
    votePrice *
    100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    return {
      action: "skipped",
      reason:
        "Amount does not match vote metadata.",
    };
  }

  const existingPayment =
    await getPayment(
      env,
      cleanReference,
    );

  if (
    existingPayment &&
    Number(
      existingPayment.votes_applied || 0,
    ) >=
      Number(
        existingPayment.votes || votes,
      )
  ) {
    return {
      action: "alreadyCredited",
      contestantId,
      votes,
    };
  }

  const ledger =
    await getLedgerEntry(
      env,
      cleanReference,
    );

  if (ledger) {
    return {
      action: "alreadyCredited",
      contestantId,
      votes,
    };
  }

  if (dryRun) {
    return {
      action: "wouldCredit",
      contestantId,
      votes,
      amount:
        Number(transaction.amount) /
        100,
    };
  }

  const metadata =
    getMetadata(transaction);

  const result =
    await creditVotes(
      env,
      {
        reference:
          cleanReference,

        contestantId,

        votes,

        amount:
          Number(transaction.amount) /
          100,

        email:
          String(
            transaction.customer?.email ||
              "",
          )
            .trim()
            .toLowerCase(),

        voterName:
          String(
            metadata.voterName || "",
          ),

        phone:
          String(
            metadata.phone || "",
          ),

        paystackTransactionId:
          String(
            transaction.id || "",
          ),

        source:
          "RECONCILIATION",
      },
    );

  return {
    action:
      result.alreadyCredited
        ? "alreadyCredited"
        : "credited",
    contestantId,
    votes,
    amount:
      Number(transaction.amount) /
      100,
  };
}

/* =========================================================
   RECONCILE ENDPOINT
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

  const references: string[] = [];

  if (
    typeof body?.reference ===
      "string"
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
    for (
      const reference of body.references
    ) {
      if (
        typeof reference ===
          "string" &&
        reference.trim()
      ) {
        references.push(
          reference.trim(),
        );
      }
    }
  }

  const unique =
    [
      ...new Set(
        references,
      ),
    ];

  if (!unique.length) {
    return json(
      {
        success: false,
        error:
          "Provide at least one reference.",
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
    processed: unique.length,
    credited: 0,
    alreadyCredited: 0,
    wouldCredit: 0,
    skipped: 0,
    failed: 0,
    details: [] as any[],
  };

  for (
    const reference of unique
  ) {
    try {
      const item =
        await reconcileOne(
          env,
          reference,
          dryRun,
        );

      result.details.push({
        reference,
        ...item,
      });

      if (
        item.action ===
        "credited"
      ) {
        result.credited++;
      } else if (
        item.action ===
        "alreadyCredited"
      ) {
        result.alreadyCredited++;
      } else if (
        item.action ===
        "wouldCredit"
      ) {
        result.wouldCredit++;
      } else {
        result.skipped++;
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
   D1 REPAIR EXISTING PAYMENT
========================================================= */

async function repairPayment(
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
          "Unauthorized repair request.",
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

  const reference =
    String(
      body?.reference || "",
    ).trim();

  if (!reference) {
    return json(
      {
        success: false,
        error:
          "Reference is required.",
      },
      400,
      origin,
    );
  }

  const payment =
    await getPayment(
      env,
      reference,
    );

  if (!payment) {
    return json(
      {
        success: false,
        error:
          "Payment not found in D1.",
      },
      404,
      origin,
    );
  }

  const contestantId =
    String(
      payment.contestant_id || "",
    ).trim();

  const votes =
    Number(
      payment.votes || 0,
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
          "Payment has invalid contestant or vote data.",
      },
      400,
      origin,
    );
  }

  const ledger =
    await getLedgerEntry(
      env,
      reference,
    );

  if (ledger) {
    await env.DB
      .prepare(
        `
        UPDATE payments
        SET
          votes_credited = ?,
          votes_applied = ?,
          status = 'success'
        WHERE reference = ?
        `,
      )
      .bind(
        votes,
        votes,
        reference,
      )
      .run();

    return json(
      {
        success: true,
        repaired: false,
        alreadyCredited: true,
        reference,
        contestantId,
        votes,
      },
      200,
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
          "Contestant not found.",
      },
      404,
      origin,
    );
  }

  const now =
    new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `
      INSERT INTO vote_ledger (
        reference,
        contestant_id,
        votes,
        created_at,
        source
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(reference) DO NOTHING
      `,
    ).bind(
      reference,
      contestantId,
      votes,
      now,
      "REPAIR",
    ),

    env.DB.prepare(
      `
      UPDATE contestants
      SET votes = votes + ?
      WHERE id = ?
      `,
    ).bind(
      votes,
      contestantId,
    ),

    env.DB.prepare(
      `
      UPDATE payments
      SET
        votes_credited = ?,
        votes_applied = ?,
        status = 'success'
      WHERE reference = ?
      `,
    ).bind(
      votes,
      votes,
      reference,
    ),
  ]);

  return json(
    {
      success: true,
      repaired: true,
      alreadyCredited: false,
      reference,
      contestantId,
      votes,
    },
    200,
    origin,
  );
}

/* =========================================================
   HEALTH / DASHBOARD
========================================================= */

async function health(
  env: Env,
  origin: string | null,
) {
  const contestants =
    await env.DB
      .prepare(
        `
        SELECT
          COUNT(*) AS contestants,
          COALESCE(SUM(votes), 0) AS votes
        FROM contestants
        `,
      )
      .first<any>();

  const payments =
    await env.DB
      .prepare(
        `
        SELECT
          COUNT(*) AS records,
          COALESCE(SUM(votes), 0) AS votes,
          COALESCE(SUM(amount), 0) AS amount
        FROM payments
        WHERE status = 'success'
        `,
      )
      .first<any>();

  const ledger =
    await env.DB
      .prepare(
        `
        SELECT
          COUNT(*) AS records,
          COALESCE(SUM(votes), 0) AS votes
        FROM vote_ledger
        `,
      )
      .first<any>();

  return json(
    {
      service:
        "NAPAS Secure Voting Payment API",

      status: "ok",

      sourceOfTruth: "D1",

      contestants,

      payments,

      voteLedger: ledger,

      endpoints: [
        "/",
        "/initialize",
        "/verify",
        "/paystack-webhook",
        "/reconcile-payments",
        "/repair-payment",
      ],
    },
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
        return await health(
          env,
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

      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/repair-payment"
      ) {
        return await repairPayment(
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

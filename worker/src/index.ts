import { importPKCS8, SignJWT } from "jose";

interface Env {
  PAYSTACK_SECRET_KEY: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...headers }
  });

function parseServiceAccount(raw: string) {
  const service = JSON.parse(raw);
  if (!service.client_email || !service.private_key || !service.project_id) {
    throw new Error("Invalid Firebase service account.");
  }
  return service;
}

async function firebaseAccessToken(env: Env) {
  const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  const key = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/datastore"
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const token = await tokenRes.json() as { access_token?: string; error?: string };
  if (!token.access_token) {
    throw new Error(token.error || "Unable to authenticate with Firebase.");
  }

  return { token: token.access_token, projectId: sa.project_id };
}

async function firestoreGet(env: Env, path: string) {
  const auth = await firebaseAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.token}` }
  });
  return { res, data: await res.json() as any };
}

function firestoreValue(value: unknown): any {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

async function firestoreCommit(env: Env, writes: any[]) {
  const auth = await firebaseAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/databases/(default)/documents:commit`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ writes })
  });
  const data = await res.json() as any;
  if (!res.ok) {
    const error = new Error(data?.error?.message || "Firebase write failed.");
    (error as any).status = res.status;
    (error as any).firebase = data?.error;
    throw error;
  }
  return data;
}

async function paystack(path: string, env: Env, init: RequestInit = {}) {
  return fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

function getNumberField(fields: any, name: string, fallback = 0) {
  return Number(fields?.[name]?.integerValue ?? fields?.[name]?.doubleValue ?? fallback);
}

async function getVotingSettings(env: Env) {
  const settings = await firestoreGet(env, "settings/voting");
  const fields = settings.data?.fields || {};
  return {
    votingOpen: fields.votingOpen?.booleanValue ?? true,
    votePrice: getNumberField(fields, "votePrice", 100)
  };
}

async function initializePayment(request: Request, env: Env) {
  const body = await request.json() as {
    contestantId?: string;
    votes?: number;
    email?: string;
    name?: string;
    phone?: string;
    callbackUrl?: string;
  };

  const contestantId = String(body.contestantId || "").trim();
  const votes = Math.floor(Number(body.votes || 0));
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const callbackUrl = String(body.callbackUrl || "").trim();

  if (!contestantId || !Number.isInteger(votes) || votes < 1 || votes > 1000) {
    return json({ success: false, error: "Choose a valid contestant and a vote quantity from 1 to 1,000." }, 400);
  }

  if (name.length < 2 || name.length > 120) {
    return json({ success: false, error: "Please provide your full name." }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: "Please provide a valid email address." }, 400);
  }

  if (phone.length > 40) {
    return json({ success: false, error: "Please provide a valid phone number." }, 400);
  }

  const contestant = await firestoreGet(env, `contestants/${encodeURIComponent(contestantId)}`);
  if (!contestant.res.ok || !contestant.data?.fields || contestant.data.fields.published?.booleanValue === false) {
    return json({ success: false, error: "Contestant not found." }, 404);
  }

  const { votingOpen, votePrice } = await getVotingSettings(env);
  if (!votingOpen) return json({ success: false, error: "Voting is currently closed." }, 403);
  if (!Number.isFinite(votePrice) || votePrice <= 0) {
    return json({ success: false, error: "Voting price is not configured." }, 500);
  }

  const amountNaira = votes * votePrice;
  const reference = `NAPAS-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  let safeCallbackUrl = "https://napas-award.com/?payment=return";
  try {
    const parsed = new URL(callbackUrl);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
      parsed.searchParams.set("payment", "return");
      safeCallbackUrl = parsed.toString();
    }
  } catch {
    // Keep the production fallback above.
  }

  const pay = await paystack("/transaction/initialize", env, {
    method: "POST",
    body: JSON.stringify({
      email,
      amount: Math.round(amountNaira * 100),
      currency: "NGN",
      reference,
      callback_url: safeCallbackUrl,
      metadata: {
        contestantId,
        votes,
        voterName: name,
        phone,
        amountNaira
      }
    })
  });

  const result = await pay.json() as any;
  if (!pay.ok || !result.status || !result.data?.authorization_url) {
    return json({ success: false, error: result.message || "Paystack initialization failed." }, 502);
  }

  return json({
    success: true,
    reference,
    authorization_url: result.data.authorization_url,
    amount: amountNaira,
    votes,
    contestantId
  });
}

async function getPayment(env: Env, reference: string) {
  return firestoreGet(env, `payments/${encodeURIComponent(reference)}`);
}

async function creditVerifiedPayment(env: Env, transaction: any) {
  const reference = String(transaction?.reference || "").trim();
  const metadata = transaction?.metadata || {};
  const contestantId = String(metadata.contestantId || "").trim();
  const votes = Math.floor(Number(metadata.votes || 0));

  if (!reference || !contestantId || !Number.isInteger(votes) || votes < 1 || votes > 1000) {
    throw new Error("Verified payment metadata is incomplete.");
  }

  const existing = await getPayment(env, reference);
  if (existing.res.ok && existing.data?.fields) {
    return {
      alreadyCredited: true,
      newTotalVotes: getNumberField(existing.data.fields, "newTotalVotes", 0),
      contestantId,
      votes
    };
  }

  const contestant = await firestoreGet(env, `contestants/${encodeURIComponent(contestantId)}`);
  if (!contestant.res.ok || !contestant.data?.fields) {
    throw new Error("Contestant no longer exists.");
  }

  const currentVotes = getNumberField(contestant.data.fields, "votes", 0);
  const projectedTotal = currentVotes + votes;
  const auth = await firebaseAccessToken(env);

  const paymentName = `projects/${auth.projectId}/databases/(default)/documents/payments/${reference}`;
  const contestantName = `projects/${auth.projectId}/databases/(default)/documents/contestants/${contestantId}`;

  try {
    await firestoreCommit(env, [
      {
        update: {
          name: paymentName,
          fields: {
            reference: firestoreValue(reference),
            contestantId: firestoreValue(contestantId),
            votes: firestoreValue(votes),
            amount: firestoreValue(Number(transaction.amount || 0) / 100),
            email: firestoreValue(String(transaction.customer?.email || "")),
            voterName: firestoreValue(String(metadata.voterName || "")),
            phone: firestoreValue(String(metadata.phone || "")),
            paystackTransactionId: firestoreValue(String(transaction.id || "")),
            newTotalVotes: firestoreValue(projectedTotal),
            status: firestoreValue("success"),
            createdAt: { timestampValue: new Date().toISOString() }
          }
        },
        currentDocument: { exists: false }
      },
      {
        transform: {
          document: contestantName,
          fieldTransforms: [
            { fieldPath: "votes", increment: { integerValue: String(votes) } }
          ]
        }
      }
    ]);
  } catch (error) {
    // A simultaneous callback/webhook may have credited this exact reference first.
    if ((error as any)?.firebase?.status === "ALREADY_EXISTS" || String((error as Error)?.message || "").includes("ALREADY_EXISTS")) {
      const winner = await getPayment(env, reference);
      if (winner.res.ok && winner.data?.fields) {
        return {
          alreadyCredited: true,
          newTotalVotes: getNumberField(winner.data.fields, "newTotalVotes", 0),
          contestantId,
          votes
        };
      }
    }
    throw error;
  }

  const refreshed = await firestoreGet(env, `contestants/${encodeURIComponent(contestantId)}`);
  const newTotalVotes = refreshed.res.ok
    ? getNumberField(refreshed.data?.fields, "votes", projectedTotal)
    : projectedTotal;

  return { alreadyCredited: false, newTotalVotes, contestantId, votes };
}

async function verifyPayment(request: Request, env: Env) {
  const body = await request.json() as {
    reference?: string;
    contestantId?: string;
    votes?: number;
  };

  const reference = String(body.reference || "").trim();
  const contestantId = String(body.contestantId || "").trim();
  const votes = Math.floor(Number(body.votes || 0));

  if (!reference || !contestantId || !Number.isInteger(votes) || votes < 1 || votes > 1000) {
    return json({ success: false, error: "Invalid verification request." }, 400);
  }

  const existing = await getPayment(env, reference);
  if (existing.res.ok && existing.data?.fields) {
    const storedContestant = String(existing.data.fields.contestantId?.stringValue || "");
    const storedVotes = getNumberField(existing.data.fields, "votes", 0);
    if (storedContestant !== contestantId || storedVotes !== votes) {
      return json({ success: false, error: "Payment reference does not match this vote." }, 409);
    }
    return json({
      success: true,
      alreadyCredited: true,
      newTotalVotes: getNumberField(existing.data.fields, "newTotalVotes", 0),
      reference
    });
  }

  const pay = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`, env);
  const result = await pay.json() as any;

  if (!pay.ok || !result.status || result.data?.status !== "success") {
    return json({ success: false, error: "Payment verification failed. If you were charged, keep your Paystack reference and contact NAPAS." }, 400);
  }

  const metadata = result.data?.metadata || {};
  const paidContestant = String(metadata.contestantId || "");
  const paidVotes = Math.floor(Number(metadata.votes || 0));

  if (paidContestant !== contestantId || paidVotes !== votes) {
    return json({ success: false, error: "Payment details do not match the selected vote." }, 400);
  }

  const credited = await creditVerifiedPayment(env, result.data);
  return json({ success: true, reference, ...credited });
}

function hexToBytes(hex: string) {
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return null;
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function verifyPaystackSignature(body: string, signature: string, secret: string) {
  const expected = hexToBytes(signature);
  if (!expected) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    new TextEncoder().encode(body)
  );
}

async function handlePaystackWebhook(request: Request, env: Env) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature") || "";

  if (!signature || !(await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY))) {
    return json({ success: false, error: "Invalid webhook signature." }, 401);
  }

  const event = JSON.parse(rawBody) as any;
  if (event?.event !== "charge.success") {
    return json({ success: true, ignored: true });
  }

  const transaction = event?.data;
  if (!transaction?.reference || transaction?.status !== "success") {
    return json({ success: true, ignored: true });
  }

  try {
    const credited = await creditVerifiedPayment(env, transaction);
    return json({ success: true, ...credited });
  } catch (error) {
    console.error("Webhook credit failed", error);
    return json({ success: false, error: "Webhook processing failed." }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ service: "NAPAS payment worker", status: "ok" });
      }
      if (request.method === "POST" && url.pathname === "/initialize") {
        return await initializePayment(request, env);
      }
      if (request.method === "POST" && url.pathname === "/verify") {
        return await verifyPayment(request, env);
      }
      if (request.method === "POST" && url.pathname === "/paystack-webhook") {
        return await handlePaystackWebhook(request, env);
      }
      return json({ success: false, error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: "Server error. Please try again." }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

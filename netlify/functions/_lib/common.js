/* =====================================================================
   Shared helpers for the discovery functions.
   Nothing in here is specific to one endpoint.
   ===================================================================== */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Verified empirically against the live index (detect_embedding.py, cosine
// 1.0000 on three samples): text-embedding-3-small, input formatted as
// `${title}\n\n${content}`, truncated at 8000 characters.
// ada-002 scores ~0.00 against these vectors — same dimensions, different
// space — so this must not drift.
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
export const EMBED_TRUNCATE = 8000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

const SCHEMA = "content_studio";

/* ---------- Supabase over REST, service key, server-side only ---------- */
function sbHeaders(write = false) {
  const h = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Accept-Profile": SCHEMA,
  };
  if (write) h["Content-Profile"] = SCHEMA;
  return h;
}

export async function sbSelect(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`select ${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** PostgREST caps every response at 1000 rows no matter what `limit` says,
 *  so anything that must be COMPLETE has to be paged. Getting this wrong is
 *  silent: you get a short list and treat it as the whole set. */
export async function sbSelectAll(table, params = {}, page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const batch = await sbSelect(table, {
      ...params, limit: String(page), offset: String(offset),
    });
    out.push(...batch);
    if (batch.length < page) break;
    if (offset > 200000) break;          // hard stop, should never trigger
  }
  return out;
}

export async function sbPatch(table, match, body) {
  const qs = new URLSearchParams(match).toString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: "PATCH", headers: sbHeaders(true), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patch ${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function sbInsert(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: { ...sbHeaders(true), Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`insert ${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: sbHeaders(true), body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`rpc ${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* ---------- Embeddings ---------- */
export async function embed(texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (!r.ok) throw new Error(`embed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d.data.map((x) => x.embedding);
}

/* ---------- Claude ---------- */
export async function claude(system, user, maxTokens = 1400) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`claude: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

/** Claude asked for JSON still sometimes wraps it in a fence — and, more
 *  awkwardly, sometimes writes an unescaped " inside a string value. That is
 *  most common in a pull quote, where the source text quotes someone. Rather
 *  than lose the whole record, fall back to a lenient field extraction. */
export function parseJson(text) {
  const clean = String(text).replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = clean.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found in response");
  const body = clean.slice(start);

  try {
    return JSON.parse(body);
  } catch (e) {
    const repaired = repairJson(body);
    if (repaired) return repaired;
    throw e;
  }
}

/** Pull the fields out by hand when the JSON is malformed. Only handles the
 *  shapes we actually ask for; returns null if it can't manage. */
function repairJson(body) {
  const out = {};

  // string arrays, e.g. "situations": ["a", "b"]
  const arr = body.match(/"situations"\s*:\s*\[([\s\S]*?)\]/);
  if (arr) {
    out.situations = (arr[1].match(/"((?:[^"\\]|\\.)*)"/g) || [])
      .map((s) => s.slice(1, -1).replace(/\\"/g, '"').trim())
      .filter(Boolean);
  }

  // Scalar strings: take everything between the opening quote and the last
  // quote that precedes a comma-newline or the closing brace. This tolerates
  // unescaped quotation marks in the middle of the value.
  for (const key of ["reader_note", "pull_quote", "name", "blurb"]) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"|\\s*\\})');
    const m = body.match(re);
    if (m) out[key] = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
  }

  return Object.keys(out).length ? out : null;
}

/* ---------- Vector maths (small corpus, so plain JS is fine) ---------- */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function parseVector(v) {
  if (Array.isArray(v)) return v.map(Number);
  return String(v).replace(/^\[|\]$/g, "").split(",").map(Number);
}

/* ---------- HTTP helpers ---------- */
export const CORS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/** The Studio's own endpoints are gated on a real Supabase session. */
export async function requireUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

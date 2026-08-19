/* =====================================================================
   /api/discovery-enrich
   Triggered from the Studio. Requires a signed-in session.

   Three jobs, chosen by the "job" field:
     "pieces"     write situations / pull_quote / reader_note for library
                  items that have none. Batched and resumable.
     "situations" embed the canonical situation prompts (run once, and
                  again whenever you add or reword a situation)
     "chunks"     split unchunked pieces into passages and embed them, so
                  the whole library is searchable at passage level
     "phrases"    lift each situation into its own embedded row — these are
                  what the map clusters, not the pieces themselves
     "clusters"   group the library by embedding, name each group with
                  Claude, store centroids and 2D coordinates

   Nothing here runs while a visitor is on the page.
   ===================================================================== */
import {
  sbSelect, sbSelectAll, sbPatch, sbInsert, sbRpc, embed, claude, parseJson,
  cosine, parseVector, json, requireUser,
} from "./_lib/common.js";

const PIECE_BATCH = 6;          // run in PARALLEL — in series this exceeds the 10s limit
const CONTENT_LIMIT = 14000;    // characters of a piece sent to Claude

const SYSTEM = `You write the connective tissue for a content discovery tool at Permanent Equity, a firm that buys and holds small companies.

The library is fifteen years of essays, newsletters and guides about buying, running and selling small businesses. Readers arrive with a predicament, not a topic. Your job is to describe what a piece is FOR, not what it is ABOUT.

Rules:
- Write in the firm's voice: plain, direct, unsentimental, occasionally dry. No marketing language. Never "dive into", "unlock", "leverage", "game-changer", "must-read".
- Situations are phrased from the reader's side and start mid-thought, e.g. "you need to raise prices and expect pushback", "you already know someone has to go".
- The reader note is one sentence saying who should read this and why now.
- The pull quote must be copied VERBATIM from the text provided. Do not paraphrase or improve it. If nothing is quotable, return an empty string.
- CRITICAL: your output must be parseable JSON. If a value contains a double quotation mark, write it as a single quotation mark instead. Never leave an unescaped " inside a string.
- Return JSON only. No preamble, no code fences.`;

async function enrichPieces() {
  const rows = await sbSelect("pieces", {
    select: "id,title,category,content",
    enriched_at: "is.null",
    order: "char_count.desc",
    limit: String(PIECE_BATCH),
  });
  if (!rows.length) return { done: true, processed: 0, remaining: 0 };

  const failures = [];

  // Parallel, not serial: six sequential Claude calls is 20-30s and Netlify
  // kills a synchronous function at 10s (26s if you raise it on Pro).
  const settled = await Promise.allSettled(rows.map(async (p) => {
    {
      const user = `Piece title: ${p.title}
Category: ${p.category}

---
${(p.content || "").slice(0, CONTENT_LIMIT)}
---

Return exactly this JSON shape:
{
  "situations": ["...", "...", "..."],
  "reader_note": "...",
  "pull_quote": "..."
}

Three or four situations. Each under 90 characters. The reader note under 180 characters.`;

      const out = parseJson(await claude(SYSTEM, user, 900));

      // Guard: the pull quote has to actually be in the piece.
      let quote = (out.pull_quote || "").trim();
      if (quote) {
        const hay = (p.content || "").replace(/\s+/g, " ");
        if (!hay.includes(quote.replace(/\s+/g, " ").slice(0, 60))) quote = "";
      }

      await sbPatch("pieces", { id: `eq.${p.id}` }, {
        situations: (out.situations || []).slice(0, 4),
        reader_note: (out.reader_note || "").slice(0, 400),
        pull_quote: quote.slice(0, 400),
        enriched_at: new Date().toISOString(),
      });
      return p.id;
    }
  }));

  let ok = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok++;
    else failures.push({ id: rows[i].id, title: rows[i].title, error: String(r.reason).slice(0, 160) });
  });

  const left = await sbSelectAll("pieces", { select: "id", enriched_at: "is.null" });
  return { done: left.length === 0, processed: ok, remaining: left.length, failures };
}


/* ---------------------------------------------------------------------
   "chunks" — backfill passage-level embeddings for pieces that have none.

   Only ~133 of 689 pieces were ever chunked (roughly, the ones over 6k
   characters — though some long ones were missed too). That left 450 of
   452 Unqualified Opinions searchable only as whole-document averages,
   which blurs exactly the specificity that makes them useful.

   Splits on paragraph boundaries, embeds in one batch call, inserts.
   Never touches pieces that already have chunks.
   --------------------------------------------------------------------- */
const CHUNK_TARGET = 1200;   // characters
const CHUNK_MIN    = 320;
const EMBED_TRUNC  = 8000;   // matches how the existing index was built
const CHUNK_BATCH  = 5;      // parallel, sized to stay inside the 10s limit

function splitIntoChunks(text) {
  const paras = String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > CHUNK_TARGET) { chunks.push(buf); buf = p; }
    else buf = buf ? buf + "\n\n" + p : p;
    // A single very long paragraph still has to be broken up.
    while (buf.length > CHUNK_TARGET * 1.8) {
      let cut = buf.lastIndexOf(". ", CHUNK_TARGET);
      if (cut < CHUNK_MIN) cut = CHUNK_TARGET;
      chunks.push(buf.slice(0, cut + 1).trim());
      buf = buf.slice(cut + 1).trim();
    }
  }
  if (buf) chunks.push(buf);
  // Fold a runt tail into its predecessor rather than embedding a fragment.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < CHUNK_MIN) {
    chunks[chunks.length - 2] += "\n\n" + chunks.pop();
  }
  return chunks.filter((c) => c.length >= 40);
}

async function backfillChunks(userId) {
  // Deliberately light queries first. Pulling every piece WITH its content
  // is ~3.6M characters and blows the function timeout before any work
  // starts, so ids come first and content only for the chosen batch.
  // MUST be paged: 1454+ chunk rows, and PostgREST returns at most 1000.
  // Reading a partial set here makes already-chunked pieces look unchunked,
  // which then fails on the (piece_id, chunk_index) unique constraint.
  const have = await sbSelectAll("piece_chunks", { select: "piece_id" });
  const done = new Set(have.map((r) => r.piece_id));

  const ids = await sbSelectAll("pieces", { select: "id,char_count", order: "char_count.desc" });
  const pending = ids.filter((p) => !done.has(p.id));

  if (!pending.length) {
    return { done: true, processed: 0, remaining: 0,
             total_chunks: have.length, pieces_with_chunks: done.size };
  }

  const batchIds = pending.slice(0, CHUNK_BATCH).map((p) => p.id);
  const rows = await sbSelect("pieces", {
    select: "id,title,content,user_id",
    id: `in.(${batchIds.join(",")})`,
  });

  let made = 0;
  const failures = [];

  // Parallel: sequential OpenAI calls are what pushed this past the limit.
  const settled = await Promise.allSettled(rows.map(async (p) => {
    const parts = splitIntoChunks(p.content);
    if (!parts.length) return 0;
    const vecs = await embed(parts.map((t) => `${p.title}\n\n${t}`.slice(0, EMBED_TRUNC)));
    await sbInsert("piece_chunks", parts.map((t, i) => ({
      piece_id: p.id,
      user_id: p.user_id || userId,
      chunk_index: i,
      chunk_text: t,
      embedding: vecs[i],
    })));
    return parts.length;
  }));

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") made += r.value;
    else failures.push({ id: rows[i].id, title: rows[i].title, error: String(r.reason).slice(0, 160) });
  });

  // If every piece in a batch failed, stop rather than retrying the same
  // five forever — that means something systemic, not a transient error.
  const allFailed = failures.length === rows.length && rows.length > 0;

  return {
    done: allFailed || (pending.length - rows.length <= 0),
    processed: rows.length - failures.length,
    chunks_created: made,
    remaining: pending.length - rows.length,
    failures,
    ...(allFailed ? { error: "Every piece in this batch failed — stopping." } : {}),
  };
}


/* ---------------------------------------------------------------------
   "phrases" — lift every situation into its own row and embed it.
   These become the units of clustering. ~2,400 of them across the
   library, at roughly a cent to embed the lot.
   --------------------------------------------------------------------- */
const PHRASE_BATCH = 180;

async function buildPhrases() {
  const existing = await sbSelectAll("discovery_phrases", { select: "piece_id,phrase" });
  const seen = new Set(existing.map((r) => r.piece_id + "\u0000" + r.phrase));

  const pieces = await sbSelectAll("pieces", {
    select: "id,user_id,situations", situations: "not.is.null",
  });

  const wanted = [];
  for (const p of pieces) {
    for (const raw of (p.situations || [])) {
      const phrase = String(raw || "").trim();
      if (!phrase || phrase.length < 12) continue;
      if (seen.has(p.id + "\u0000" + phrase)) continue;
      wanted.push({ piece_id: p.id, user_id: p.user_id, phrase });
    }
  }

  if (!wanted.length) {
    const unembedded = await sbSelectAll("discovery_phrases", {
      select: "id,phrase", embedding: "is.null",
    });
    if (!unembedded.length) {
      return { done: true, processed: 0, remaining: 0, total_phrases: existing.length };
    }
    const slice = unembedded.slice(0, PHRASE_BATCH);
    const vecs = await embed(slice.map((r) => r.phrase));
    for (let i = 0; i < slice.length; i++) {
      await sbPatch("discovery_phrases", { id: `eq.${slice[i].id}` }, { embedding: vecs[i] });
    }
    return { done: unembedded.length <= slice.length, processed: slice.length,
             remaining: unembedded.length - slice.length, phase: "embedding" };
  }

  const slice = wanted.slice(0, PHRASE_BATCH);
  const vecs = await embed(slice.map((r) => r.phrase));
  await sbInsert("discovery_phrases", slice.map((r, i) => ({
    piece_id: r.piece_id, phrase: r.phrase, embedding: vecs[i],
  })));

  return { done: wanted.length <= slice.length, processed: slice.length,
           remaining: wanted.length - slice.length, phase: "extracting" };
}

async function embedSituations() {
  const sits = await sbSelect("discovery_situations", { select: "id,slug,prompt_text", active: "is.true" });
  if (!sits.length) return { embedded: 0 };
  const vecs = await embed(sits.map((s) => s.prompt_text));
  for (let i = 0; i < sits.length; i++) {
    await sbPatch("discovery_situations", { id: `eq.${sits[i].id}` }, { embedding: vecs[i] });
  }
  return { embedded: sits.length };
}

/* ---------------------------------------------------------------------
   "clusters" — k-means over SITUATION PHRASES, not pieces.

   Clustering pieces grouped them by register: the Unqualified Opinions
   archive formed one cluster because those pieces sound alike, not
   because they are about the same thing. Phrases have no voice to
   detect, so what survives is subject and circumstance.

   Centroids are found on a deterministic sample so the payload stays
   small; every phrase is then assigned by Postgres via pgvector, which
   keeps 2,400 x 1536 floats out of this function entirely.
   --------------------------------------------------------------------- */
const CLUSTER_SAMPLE = 900;

function toUnitVectors(list) {
  const dim = list[0].length;
  const flat = new Float32Array(list.length * dim);
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) flat[i * dim + j] = v[j] / norm;
  }
  return { flat, dim, n: list.length };
}

function dot(flat, dim, i, centroid) {
  let acc = 0;
  const off = i * dim;
  for (let j = 0; j < dim; j++) acc += flat[off + j] * centroid[j];
  return acc;
}

async function buildClusters(k = 18) {
  const sample = await sbRpc("discovery_phrase_sample", { sample_size: CLUSTER_SAMPLE });
  if (!sample || sample.length < k * 8) {
    throw new Error(`only ${sample ? sample.length : 0} embedded phrases — run the phrases job first`);
  }

  const { flat, dim, n } = toUnitVectors(sample.map((r) => parseVector(r.embedding)));

  // k-means++ seeding, deterministic
  let seed = 20260819;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const centroids = [];
  const first = Math.floor(rnd() * n);
  centroids.push(Float32Array.from(flat.subarray(first * dim, first * dim + dim)));
  while (centroids.length < k) {
    let best = 0, bestD = -1;
    for (let i = 0; i < n; i++) {
      let nearest = -2;
      for (const c of centroids) { const d = dot(flat, dim, i, c); if (d > nearest) nearest = d; }
      const dist = (1 - nearest) * (0.5 + rnd());
      if (dist > bestD) { bestD = dist; best = i; }
    }
    centroids.push(Float32Array.from(flat.subarray(best * dim, best * dim + dim)));
  }

  const assign = new Int16Array(n).fill(-1);
  for (let iter = 0; iter < 18; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bestSim = -2;
      for (let c = 0; c < k; c++) {
        const sim = dot(flat, dim, i, centroids[c]);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved++; }
    }
    for (let c = 0; c < k; c++) {
      const mean = new Float32Array(dim);
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (assign[i] !== c) continue;
        count++;
        const off = i * dim;
        for (let j = 0; j < dim; j++) mean[j] += flat[off + j];
      }
      if (!count) continue;
      let norm = 0;
      for (let j = 0; j < dim; j++) { mean[j] /= count; norm += mean[j] * mean[j]; }
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < dim; j++) mean[j] /= norm;
      centroids[c] = mean;
    }
    if (!moved) break;
  }

  // Representative phrases per cluster, for naming
  const byCluster = [];
  for (let c = 0; c < k; c++) byCluster.push([]);
  for (let i = 0; i < n; i++) {
    byCluster[assign[i]].push({ id: sample[i].id, sim: dot(flat, dim, i, centroids[assign[i]]) });
  }

  const ids = byCluster.flatMap((rows) =>
    rows.sort((a, b) => b.sim - a.sim).slice(0, 26).map((r) => r.id));
  const textRows = ids.length
    ? await sbSelect("discovery_phrases", { select: "id,phrase", id: `in.(${ids.join(",")})` })
    : [];
  const textById = {};
  for (const r of textRows) textById[r.id] = r.phrase;

  const NAME_SYSTEM = `You label regions of a library so a reader can tell, at a glance, whether what they are dealing with lives there.

You will be shown SITUATIONS — short phrases describing what a reader is going through. They all belong to one region.

A label names the moment or the doubt these readers share. It is not a subject heading.

WRONG, because they are department names any firm could use:
  "Hiring and managing your team"   "Buying or selling a business"
  "How you price what you sell"     "Running and growing the business"
WRONG, because they are aphorisms that sound good and say nothing:
  "Risk before the bet"   "Courage over comfort"
WRONG, because they describe the writing rather than the reader:
  "What I actually think"   "What it's like from inside"

RIGHT:
  "The financial call you're sitting on"
  "When things get weird at work"
  "Who takes over when you're gone"

Test before answering: could this be a nav item on any consulting firm's website? If yes, rewrite it as the moment the reader is in.

Rules:
- 4-7 words, plain speech, addressed to or about the reader.
- Name the moment, decision or doubt. Never the domain, never the tone.
- No abstractions: clarity, courage, discipline, alignment, trust.
- Blurb: one sentence to the reader naming what they're trying to work out.
- Return JSON only.`;

  const named = await Promise.all(byCluster.map(async (rows, c) => {
    if (rows.length < 3) return null;
    const phrases = rows.slice(0, 26).map((r) => textById[r.id]).filter(Boolean);
    if (phrases.length < 3) return null;
    const out = parseJson(await claude(NAME_SYSTEM,
      `Situations in this region:\n\n${phrases.map((p) => "- " + p).join("\n")}\n\n` +
      `Return: {"name": "...", "blurb": "..."}`, 300));
    return { c, name: out.name, blurb: out.blurb, sample: phrases.slice(0, 3) };
  }));

  const live = named.filter(Boolean);

  // 2D layout: push dissimilar regions apart
  const pts = live.map((_, i) => ({
    x: 0.5 + 0.34 * Math.cos((i / live.length) * Math.PI * 2),
    y: 0.5 + 0.32 * Math.sin((i / live.length) * Math.PI * 2),
  }));
  for (let step = 0; step < 600; step++) {
    for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
      let sim = 0;
      const ca = centroids[live[a].c], cb = centroids[live[b].c];
      for (let j = 0; j < dim; j++) sim += ca[j] * cb[j];
      const want = Math.max(0.24, 1 - sim);
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const push = (want * 0.58 - dist) * 0.04;
      pts[a].x -= (dx / dist) * push; pts[a].y -= (dy / dist) * push;
      pts[b].x += (dx / dist) * push; pts[b].y += (dy / dist) * push;
    }
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const nx = (v) => 0.10 + 0.80 * (v - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1);
  const ny = (v) => 0.14 + 0.72 * (v - Math.min(...ys)) / ((Math.max(...ys) - Math.min(...ys)) || 1);

  const PALETTE = ["#CCA33E","#4E7A9B","#8A6BA8","#5B8C6E","#B5713F","#A0526D","#3F7C77",
                   "#7A6A3F","#5C6BA8","#9B5B4E","#4E8C9B","#8C7A3F","#6E5B8C","#3F7C5B",
                   "#A8794E","#5B7C8C","#8C5B6E","#6E8C5B"];

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/discovery_clusters?id=gt.0`, {
    method: "DELETE",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
               "Content-Profile": "content_studio" },
  });

  const inserted = await sbInsert("discovery_clusters", live.map((r, i) => ({
    name: r.name, blurb: r.blurb,
    centroid: Array.from(centroids[r.c]),
    x: nx(pts[i].x), y: ny(pts[i].y),
    colour: PALETTE[i % PALETTE.length], piece_count: 0,
  })));

  // Assignment happens in its own request. Netlify's gateway gives a
  // synchronous function 30 seconds; sampling + k-means + 18 Claude calls
  // already uses most of that, so writing 2,673 assignments on top of it
  // does not fit. The panel chains the next call.
  await sbRpc("discovery_clear_assignments", {});

  return {
    stage: "named",
    clusters: inserted.map((row, i) => ({ name: row.name, sample: live[i].sample })),
    sampled: n,
    next: "assign",
  };
}

/* Assign phrases to the regions just created. Batched; call until done. */
async function assignPhrases() {
  const res = await sbRpc("discovery_assign_phrases", { batch_size: 700 });
  const row = Array.isArray(res) ? res[0] : res;
  const remaining = (row && row.remaining) || 0;

  if (remaining > 0) {
    return { stage: "assigning", assigned: (row && row.assigned) || 0,
             remaining, done: false, next: "assign" };
  }

  // Everything placed — write the real counts onto each region.
  const counts = await sbSelectAll("discovery_phrases", { select: "cluster_id" });
  const tally = {};
  for (const r of counts) if (r.cluster_id) tally[r.cluster_id] = (tally[r.cluster_id] || 0) + 1;

  const clusters = await sbSelect("discovery_clusters", { select: "id,name" });
  for (const c of clusters) {
    await sbPatch("discovery_clusters", { id: `eq.${c.id}` }, { piece_count: tally[c.id] || 0 });
  }

  return {
    stage: "done",
    done: true,
    assigned: (row && row.assigned) || 0,
    remaining: 0,
    clusters: clusters.map((c) => ({ name: c.name, count: tally[c.id] || 0 }))
                      .sort((a, b) => b.count - a.count),
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await requireUser(req);
  if (!user) return json({ error: "Sign in first." }, 401);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const job = body.job || "pieces";

  try {
    if (job === "pieces")     return json(await enrichPieces());
    if (job === "chunks")     return json(await backfillChunks(user.id));
    if (job === "phrases")    return json(await buildPhrases());
    if (job === "situations") return json(await embedSituations());
    if (job === "clusters")   return json(await buildClusters(Math.min(30, Math.max(4, body.k || 18))));
    if (job === "assign")     return json(await assignPhrases());
    return json({ error: `unknown job: ${job}` }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
};

export const config = { path: "/api/discovery-enrich" };

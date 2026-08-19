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
     "clusters"   group the library by embedding, name each group with
                  Claude, store centroids and 2D coordinates

   Nothing here runs while a visitor is on the page.
   ===================================================================== */
import {
  sbSelect, sbPatch, sbInsert, embed, claude, parseJson,
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

  const left = await sbSelect("pieces", { select: "id", enriched_at: "is.null", limit: "1000" });
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
const CHUNK_BATCH  = 12;     // pieces per invocation

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
  const have = await sbSelect("piece_chunks", { select: "piece_id", limit: "100000" });
  const done = new Set(have.map((r) => r.piece_id));

  const all = await sbSelect("pieces", {
    select: "id,title,content,user_id", order: "char_count.desc", limit: "2000",
  });
  const todo = all.filter((p) => !done.has(p.id) && (p.content || "").length > 40)
                  .slice(0, CHUNK_BATCH);

  if (!todo.length) {
    return { done: true, processed: 0, remaining: 0,
             total_chunks: have.length, pieces_with_chunks: done.size };
  }

  let made = 0;
  const failures = [];
  for (const p of todo) {
    try {
      const parts = splitIntoChunks(p.content);
      if (!parts.length) continue;
      // Verified against the live index: title + blank line + content,
      // truncated at 8000 characters. Reconstructs stored vectors at 1.0000
      // cosine. Do not change without re-running detect_embedding.py.
      const vecs = await embed(parts.map((t) => `${p.title}\n\n${t}`.slice(0, EMBED_TRUNC)));
      await sbInsert("piece_chunks", parts.map((t, i) => ({
        piece_id: p.id,
        user_id: p.user_id || userId,
        chunk_index: i,
        chunk_text: t,
        embedding: vecs[i],
      })));
      made += parts.length;
    } catch (e) {
      failures.push({ id: p.id, title: p.title, error: String(e).slice(0, 160) });
    }
  }

  const remaining = all.filter((p) => !done.has(p.id) && (p.content || "").length > 40).length - todo.length;
  return { done: remaining <= 0, processed: todo.length, chunks_created: made,
           remaining, failures };
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

/* k-means over the library embeddings, then Claude names the groups. */
async function buildClusters(k = 5) {
  // Paged: 689 x 1536 floats is a large response to pull in one go.
  const rows = [];
  for (let off = 0; ; off += 250) {
    const page = await sbSelect("pieces", {
      select: "id,title,category,reader_note,embedding",
      embedding: "not.is.null",
      order: "id.asc", offset: String(off), limit: "250",
    });
    rows.push(...page);
    if (page.length < 250) break;
  }
  if (rows.length < k * 4) throw new Error(`only ${rows.length} embedded pieces — too few to cluster`);

  const vecs = rows.map((r) => parseVector(r.embedding));
  const dim = vecs[0].length;

  // Deterministic seeding so the map doesn't reshuffle on every run.
  let seed = 20260818;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let centroids = [];
  centroids.push(vecs[Math.floor(rnd() * vecs.length)]);
  while (centroids.length < k) {
    const d = vecs.map((v) => Math.min(...centroids.map((c) => 1 - cosine(v, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let t = rnd() * total, idx = 0;
    while (t > 0 && idx < d.length - 1) { t -= d[idx]; idx++; }
    centroids.push(vecs[idx]);
  }

  let assign = new Array(vecs.length).fill(-1);
  for (let iter = 0; iter < 25; iter++) {
    let moved = 0;
    vecs.forEach((v, i) => {
      let best = 0, bestSim = -2;
      centroids.forEach((c, ci) => { const s = cosine(v, c); if (s > bestSim) { bestSim = s; best = ci; } });
      if (assign[i] !== best) { assign[i] = best; moved++; }
    });
    centroids = centroids.map((_, ci) => {
      const members = vecs.filter((_, i) => assign[i] === ci);
      if (!members.length) return centroids[ci];
      const mean = new Array(dim).fill(0);
      members.forEach((m) => { for (let j = 0; j < dim; j++) mean[j] += m[j]; });
      return mean.map((x) => x / members.length);
    });
    if (!moved) break;
  }

  // Name each group from its most central members. In parallel.
  const groups = [];
  for (let ci = 0; ci < k; ci++) {
    const members = rows
      .map((r, i) => ({ r, i }))
      .filter(({ i }) => assign[i] === ci)
      .map(({ r, i }) => ({ ...r, sim: cosine(vecs[i], centroids[ci]) }))
      .sort((a, b) => b.sim - a.sim);
    groups.push({ ci, members });
  }

  const named = await Promise.all(groups.map(async (g) => {
    const sample = g.members.slice(0, 14)
      .map((m) => `- ${m.title}${m.reader_note ? ` — ${m.reader_note}` : ""}`).join("\n");
    const out = parseJson(await claude(
      `You name thematic regions of a business writing library. Names are 2-4 words, concrete, and describe the ARGUMENT the writing makes, not its topic. "Deciding late" not "Decision making". "Price and worth" not "Pricing". Return JSON only.`,
      `These pieces cluster together:\n\n${sample}\n\nReturn: {"name": "...", "blurb": "one sentence on what this group of writing keeps arguing"}`,
      300
    ));
    return { ci: g.ci, name: out.name, blurb: out.blurb, count: g.members.length };
  }));

  // Lay the centroids out in 2D by pushing dissimilar ones apart.
  const pts = centroids.map((_, i) => ({
    x: 0.5 + 0.32 * Math.cos((i / k) * Math.PI * 2),
    y: 0.5 + 0.30 * Math.sin((i / k) * Math.PI * 2),
  }));
  for (let step = 0; step < 240; step++) {
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
      const want = 1 - cosine(centroids[a], centroids[b]);   // dissimilar -> far apart
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const push = (want * 0.62 - dist) * 0.05;
      pts[a].x -= (dx / dist) * push; pts[a].y -= (dy / dist) * push;
      pts[b].x += (dx / dist) * push; pts[b].y += (dy / dist) * push;
    }
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const nx = (v) => 0.14 + 0.72 * (v - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1);
  const ny = (v) => 0.16 + 0.68 * (v - Math.min(...ys)) / ((Math.max(...ys) - Math.min(...ys)) || 1);

  const PALETTE = ["#CCA33E", "#4E7A9B", "#8A6BA8", "#5B8C6E", "#B5713F", "#A0526D", "#3F7C77"];

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/discovery_clusters?id=gt.0`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Profile": "content_studio",
    },
  });

  const inserted = await sbInsert("discovery_clusters", named.map((n, i) => ({
    name: n.name, blurb: n.blurb, centroid: centroids[n.ci],
    x: nx(pts[n.ci].x), y: ny(pts[n.ci].y),
    colour: PALETTE[i % PALETTE.length], piece_count: n.count,
  })));

  // One PATCH per cluster, not one per piece. 689 sequential writes would
  // take ~35 seconds on its own and time out before it finished.
  for (let ci = 0; ci < k; ci++) {
    const clusterRow = inserted[ci];
    if (!clusterRow) continue;
    const ids = rows.filter((_, i) => assign[i] === ci).map((r) => r.id);
    for (let j = 0; j < ids.length; j += 150) {
      const slice = ids.slice(j, j + 150);
      await sbPatch("pieces", { id: `in.(${slice.join(",")})` }, { cluster_id: clusterRow.id });
    }
  }

  return { clusters: named.map((n) => ({ name: n.name, count: n.count })) };
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
    if (job === "situations") return json(await embedSituations());
    if (job === "clusters")   return json(await buildClusters(body.k || 5));
    return json({ error: `unknown job: ${job}` }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
};

export const config = { path: "/api/discovery-enrich" };

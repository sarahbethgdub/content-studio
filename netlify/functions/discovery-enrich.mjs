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
  sbSelect, sbSelectAll, sbPatch, sbInsert, embed, claude, parseJson,
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

async function embedSituations() {
  const sits = await sbSelect("discovery_situations", { select: "id,slug,prompt_text", active: "is.true" });
  if (!sits.length) return { embedded: 0 };
  const vecs = await embed(sits.map((s) => s.prompt_text));
  for (let i = 0; i < sits.length; i++) {
    await sbPatch("discovery_situations", { id: `eq.${sits[i].id}` }, { embedding: vecs[i] });
  }
  return { embedded: sits.length };
}

/* k-means over the library embeddings, then Claude names each group from the
   SITUATIONS of its members — not from titles or arguments. Naming from the
   argument produced aphorisms ("Risk before the bet") that read well and told
   a visitor nothing. Situations are already phrased as predicaments, which is
   what a region label has to be: recognisable before you click.

   Navigation and index pages are excluded. Left in, they formed their own
   cluster of About/Team/Contact pages that Claude gamely named "Trust before
   contact" — a real cluster of nothing. */
const MIN_CLUSTER_CHARS = 1200;
const EXCLUDE_CATEGORIES = ["Site page", "Media", "Content Library", "Resources & Tools"];

async function buildClusters(k = 14) {
  const rows = [];
  for (let off = 0; ; off += 250) {
    const page = await sbSelect("pieces", {
      select: "id,title,category,reader_note,situations,char_count,embedding",
      embedding: "not.is.null",
      order: "id.asc", offset: String(off), limit: "250",
    });
    rows.push(...page);
    if (page.length < 250) break;
  }

  const eligible = rows.filter((r) =>
    (r.char_count || 0) >= MIN_CLUSTER_CHARS &&
    !EXCLUDE_CATEGORIES.includes(r.category));

  if (eligible.length < k * 4) throw new Error(`only ${eligible.length} eligible pieces for k=${k}`);

  const vecs = eligible.map((r) => parseVector(r.embedding));
  const dim = vecs[0].length;

  let seed = 20260818;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let centroids = [vecs[Math.floor(rnd() * vecs.length)]];
  while (centroids.length < k) {
    const d = vecs.map((v) => Math.min(...centroids.map((c) => 1 - cosine(v, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let t = rnd() * total, idx = 0;
    while (t > 0 && idx < d.length - 1) { t -= d[idx]; idx++; }
    centroids.push(vecs[idx]);
  }

  let assign = new Array(vecs.length).fill(-1);
  for (let iter = 0; iter < 30; iter++) {
    let moved = 0;
    vecs.forEach((v, i) => {
      let best = 0, bestSim = -2;
      centroids.forEach((c, ci) => { const sim = cosine(v, c); if (sim > bestSim) { bestSim = sim; best = ci; } });
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

  const groups = [];
  for (let ci = 0; ci < k; ci++) {
    const members = eligible
      .map((r, i) => ({ r, i }))
      .filter(({ i }) => assign[i] === ci)
      .map(({ r, i }) => ({ ...r, sim: cosine(vecs[i], centroids[ci]) }))
      .sort((a, b) => b.sim - a.sim);
    groups.push({ ci, members });
  }

  const NAME_SYSTEM = `You label regions of a content library so a visitor can tell, at a glance, whether the thing they are dealing with lives in that region.

You will be shown the SITUATIONS that the pieces in one region address — phrases describing what a reader is going through.

The label must be RECOGNISABLE, not clever. A small business owner scanning fourteen labels should know within a second which one is theirs.

Good: "Before you sign something", "The conversation you're avoiding", "When what worked stops working", "Hiring people you'll rely on"
Bad: "Risk before the bet", "Courage over comfort", "Trust before contact" — these are aphorisms. They sound good and communicate nothing.

Rules:
- 3-6 words. Plain. Second person or a plain noun phrase.
- Name the SITUATION or the DECISION, never the lesson or the virtue.
- No abstractions: not "clarity", "courage", "discipline", "alignment", "trust".
- The blurb is one sentence naming who this region is for and what they are trying to work out. Address them directly.
- Return JSON only.`;

  const named = await Promise.all(groups.map(async (g) => {
    if (!g.members.length) return null;
    const sample = g.members.slice(0, 18).map((m) => {
      const sits = (m.situations || []).slice(0, 2).join("; ");
      return `- ${m.title}${sits ? `\n    situations: ${sits}` : ""}`;
    }).join("\n");

    const out = parseJson(await claude(NAME_SYSTEM,
      `Pieces in this region:\n\n${sample}\n\nReturn: {"name": "...", "blurb": "..."}`, 300));
    return { ci: g.ci, name: out.name, blurb: out.blurb, count: g.members.length,
             samples: g.members.slice(0, 3).map((m) => m.title) };
  }));

  const live = named.filter(Boolean);

  // Lay centroids out in 2D, pushing dissimilar regions apart. More regions
  // need more relaxation passes to stop labels piling up.
  const pts = live.map((_, i) => ({
    x: 0.5 + 0.34 * Math.cos((i / live.length) * Math.PI * 2),
    y: 0.5 + 0.32 * Math.sin((i / live.length) * Math.PI * 2),
  }));
  for (let step = 0; step < 600; step++) {
    for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
      const want = Math.max(0.22, 1 - cosine(centroids[live[a].ci], centroids[live[b].ci]));
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const push = (want * 0.55 - dist) * 0.04;
      pts[a].x -= (dx / dist) * push; pts[a].y -= (dy / dist) * push;
      pts[b].x += (dx / dist) * push; pts[b].y += (dy / dist) * push;
    }
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const nx = (v) => 0.10 + 0.80 * (v - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1);
  const ny = (v) => 0.13 + 0.74 * (v - Math.min(...ys)) / ((Math.max(...ys) - Math.min(...ys)) || 1);

  const PALETTE = ["#CCA33E","#4E7A9B","#8A6BA8","#5B8C6E","#B5713F","#A0526D","#3F7C77",
                   "#7A6A3F","#5C6BA8","#9B5B4E","#4E8C9B","#8C7A3F","#6E5B8C","#3F7C5B"];

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/discovery_clusters?id=gt.0`, {
    method: "DELETE",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
               "Content-Profile": "content_studio" },
  });

  const inserted = await sbInsert("discovery_clusters", live.map((n, i) => ({
    name: n.name, blurb: n.blurb, centroid: centroids[n.ci],
    x: nx(pts[i].x), y: ny(pts[i].y),
    colour: PALETTE[i % PALETTE.length], piece_count: n.count,
  })));

  // Clear old assignments, then assign in bulk — one write per region.
  await sbPatch("pieces", { cluster_id: "not.is.null" }, { cluster_id: null });
  for (let i = 0; i < live.length; i++) {
    const clusterRow = inserted[i];
    if (!clusterRow) continue;
    const ids = eligible.filter((_, j) => assign[j] === live[i].ci).map((r) => r.id);
    for (let j = 0; j < ids.length; j += 150) {
      await sbPatch("pieces", { id: `in.(${ids.slice(j, j + 150).join(",")})` },
                    { cluster_id: clusterRow.id });
    }
  }

  return { clusters: live.map((n) => ({ name: n.name, count: n.count, samples: n.samples })),
           eligible: eligible.length, excluded: rows.length - eligible.length };
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
    if (job === "clusters")   return json(await buildClusters(body.k || 14));
    return json({ error: `unknown job: ${job}` }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
};

export const config = { path: "/api/discovery-enrich" };

/* =====================================================================
   /api/discovery-search   — PUBLIC. Anonymous visitors hit this.

   Cost shape, which is the whole design:
     - embedding the query      ~$0.000002
     - vector search            free (Postgres)
     - relevance lines          usually FREE, reusing precomputed text
                                when the question lands near a canonical
                                situation. One Claude call otherwise.

   So the common path costs a rounding error and the uncommon path costs
   about half a cent. Rate limited regardless.
   ===================================================================== */
import { sbSelect, sbRpc, sbInsert, embed, claude, parseJson,
         cosine, parseVector, json, corsFor, sha256 } from "./_lib/common.js";

const RESULTS = 5;
const RATE_WINDOW_MIN = 10;
const RATE_MAX = 25;                // searches per IP per window
const SITUATION_HIT = 0.80;         // above this, reuse precomputed text
const MAX_QUERY = 400;

async function rateLimited(req) {
  const ip = req.headers.get("x-nf-client-connection-ip")
          || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          || "unknown";
  const hash = (await sha256(ip + (process.env.RATE_SALT || "pe"))).slice(0, 32);
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60000).toISOString();
  const recent = await sbSelect("discovery_hits", {
    select: "id", ip_hash: `eq.${hash}`, created_at: `gte.${since}`, limit: String(RATE_MAX + 1),
  });
  if (recent.length >= RATE_MAX) return true;
  sbInsert("discovery_hits", [{ ip_hash: hash }]).catch(() => {});
  return false;
}

export default async (req) => {
  const CORS = corsFor(req);
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, CORS);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const query = String(body.query || "").trim().slice(0, MAX_QUERY);
  const slug  = body.situation ? String(body.situation).slice(0, 60) : null;
  const steer = ["tactical", "contrarian", "short", "people"].includes(body.steer) ? body.steer : null;
  const region = body.region ? parseInt(body.region, 10) : null;

  if (!query && !slug && !region) return json({ error: "Say what you're dealing with." }, 400, CORS);

  // Browsing a region: return its pieces directly. No embedding, no Claude,
  // no rate limit — this is the index working, not a search.
  if (region) {
    try {
      const cluster = (await sbSelect("discovery_clusters", {
        select: "id,name,blurb", id: `eq.${region}` }))[0];
      if (!cluster) return json({ error: "Unknown region." }, 400, CORS);

      const rows = await sbSelect("pieces", {
        select: "title,url,category,char_count,reader_note,pull_quote,excerpt,situations",
        cluster_id: `eq.${region}`,
        order: "char_count.desc",
        limit: "12",
      });

      return json({
        results: rows.map((r) => ({
          title: r.title, url: r.url, category: r.category, char_count: r.char_count,
          why: (r.reader_note || r.excerpt || "").slice(0, 320),
          pull_quote: r.pull_quote || "",
          situations: r.situations || [],
          similarity: null,
        })),
        matched_situation: cluster.name,
        region: { id: cluster.id, name: cluster.name, blurb: cluster.blurb },
        relevance: "region",
      }, 200, { ...CORS, "Cache-Control": "public, max-age=300" });
    } catch (e) {
      return json({ error: String(e).slice(0, 300) }, 500, CORS);
    }
  }

  try {
    if (await rateLimited(req)) {
      return json({ error: "That's a lot of searching. Try again in a few minutes." }, 429, CORS);
    }

    /* ---- 1. Get a query vector, and work out if it's a known situation ---- */
    const situations = await sbSelect("discovery_situations", {
      select: "slug,label,prompt_text,embedding", active: "is.true", embedding: "not.is.null",
    });

    let qvec, matchedSlug = null, matchedLabel = null;

    if (slug) {
      const s = situations.find((x) => x.slug === slug);
      if (!s) return json({ error: "Unknown situation." }, 400, CORS);
      qvec = parseVector(s.embedding);
      matchedSlug = s.slug; matchedLabel = s.label;
    } else {
      qvec = (await embed(query))[0];
      let best = null, bestSim = 0;
      for (const s of situations) {
        const sim = cosine(qvec, parseVector(s.embedding));
        if (sim > bestSim) { bestSim = sim; best = s; }
      }
      if (best && bestSim >= SITUATION_HIT) { matchedSlug = best.slug; matchedLabel = best.label; }
    }

    /* ---- 2. Chunk-level search, rolled up per piece ---- */
    let hits = await sbRpc("discovery_match", {
      query_embedding: qvec,
      match_count: RESULTS + 3,
      min_similarity: 0.12,
    });

    if (!hits.length) {
      return json({ results: [], matched_situation: matchedLabel,
                    message: "Nothing in the library speaks to that directly." }, 200, CORS);
    }

    /* ---- 3. Steering: reorder rather than filter, so nothing disappears ---- */
    if (steer === "short")   hits.sort((a, b) => (a.char_count || 0) - (b.char_count || 0));
    if (steer === "people")  hits.sort((a, b) =>
      (b.category === "Unqualified Opinions" ? 1 : 0) - (a.category === "Unqualified Opinions" ? 1 : 0));
    if (steer === "tactical") hits.sort((a, b) =>
      (/how|guide|checklist|practice|steps/i.test(b.title) ? 1 : 0)
      - (/how|guide|checklist|practice|steps/i.test(a.title) ? 1 : 0));
    if (steer === "contrarian") hits.reverse();

    hits = hits.slice(0, RESULTS);

    /* ---- 4. Relevance lines ---- */
    // Precomputed reader_note is enough when the question is a known
    // situation. Otherwise one Claude call writes lines for all five at once.
    let lines = {};
    let generated = false;

    if (!matchedSlug && query) {
      try {
        const payload = hits.map((h, i) => `[${i}] ${h.title} (${h.category})
Passage: ${(h.best_passage || h.excerpt || "").slice(0, 700)}`).join("\n\n");

        const out = parseJson(await claude(
          `You explain why a specific piece of writing is relevant to the specific situation someone described. One sentence each, addressed to them, concrete about their circumstance. Plain and direct — this is Permanent Equity, not a content marketing blog. Never "dive into", "explore", "unlock". If a piece is only loosely relevant, say so honestly rather than overselling it. Return JSON only.`,
          `Someone wrote: "${query}"

${payload}

Return: {"0": "why piece 0 is relevant to them", "1": "...", ...} for every index shown.`,
          800
        ));
        lines = out; generated = true;
      } catch (e) {
        lines = {};   // fall back to the precomputed note
      }
    }

    const results = hits.map((h, i) => ({
      title: h.title,
      url: h.url,
      category: h.category,
      char_count: h.char_count,
      why: (lines[String(i)] || h.reader_note || h.excerpt || "").slice(0, 320),
      pull_quote: h.pull_quote || "",
      situations: h.situations || [],
      similarity: Math.round((h.similarity || 0) * 100) / 100,
    }));

    return json({
      results,
      matched_situation: matchedLabel,
      relevance: generated ? "written for your question" : "precomputed",
    }, 200, { ...CORS, "Cache-Control": "public, max-age=60" });

  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500, CORS);
  }
};

export const config = { path: "/api/discovery-search" };

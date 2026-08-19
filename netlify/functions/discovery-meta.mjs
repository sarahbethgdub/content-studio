/* =====================================================================
   /api/discovery-meta  — PUBLIC, cacheable.
   Everything the widget needs to render before anyone searches:
   the situation chips and the cluster map. No embeddings leave the server.
   ===================================================================== */
import { sbSelect, sbSelectAll, json, CORS } from "./_lib/common.js";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  try {
    const [situations, clusters, pieces] = await Promise.all([
      sbSelect("discovery_situations", {
        select: "slug,label", active: "is.true", order: "sort_order.asc",
      }),
      sbSelect("discovery_clusters", {
        select: "id,name,blurb,x,y,colour,piece_count", order: "piece_count.desc",
      }),
      sbSelectAll("pieces", {
        select: "id,title,url",
        cluster_id: "not.is.null",
        order: "id.asc",
      }),
    ]);

    // Points for the map are SITUATIONS, not pieces. Each dot is a
    // predicament someone might be in; hovering shows it, clicking opens
    // the piece that addresses it. A piece with four situations appears
    // four times, which is honest — it genuinely speaks to four things.
    // Paged: PostgREST caps a response at 1000 rows whatever `limit` says,
    // and there are ~1,480 placed situations. Asking for 1,400 silently
    // returned 1,000, dropping the highest ids — which skews to the most
    // recently added pieces.
    const phrases = await sbSelectAll("discovery_phrases", {
      select: "id,phrase,piece_id,cluster_id",
      cluster_id: "not.is.null",
      order: "id.asc",
    });

    const pieceById = {};
    for (const p of pieces) pieceById[p.id] = p;

    const byCluster = {};
    for (const c of clusters) byCluster[c.id] = c;

    const points = phrases.map((ph) => {
      const c = byCluster[ph.cluster_id];
      const piece = pieceById[ph.piece_id];
      if (!c || !piece) return null;
      let h = 0;
      const key = String(ph.id);
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      const a = ((h % 1000) / 1000) * Math.PI * 2;
      const r = Math.pow(((h >> 10) % 1000) / 1000, 0.6) * 0.105;
      return {
        t: ph.phrase,
        pt: piece.title,
        u: piece.url,
        c: ph.cluster_id,
        x: +(c.x + Math.cos(a) * r).toFixed(4),
        y: +(c.y + Math.sin(a) * r * 0.8).toFixed(4),
        big: false,
      };
    }).filter(Boolean);

    // Three representative situations per region — far more explanatory
    // than three titles, because they say what the region is FOR.
    const samples = {};
    for (const ph of phrases) {
      (samples[ph.cluster_id] = samples[ph.cluster_id] || []);
      if (samples[ph.cluster_id].length < 3) samples[ph.cluster_id].push(ph.phrase);
    }
    const withSamples = clusters.map((c) => ({ ...c, samples: samples[c.id] || [] }));

    return json({ situations, clusters: withSamples, points, total: pieces.length,
                  situation_count: phrases.length },
      200, { ...CORS, "Cache-Control": "public, max-age=600" });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500, CORS);
  }
};

export const config = { path: "/api/discovery-meta" };

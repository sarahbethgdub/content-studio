/* =====================================================================
   /api/discovery-meta  — PUBLIC, cacheable.
   Everything the widget needs to render before anyone searches:
   the situation chips and the cluster map. No embeddings leave the server.
   ===================================================================== */
import { sbSelect, json, CORS } from "./_lib/common.js";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  try {
    const [situations, clusters, counts] = await Promise.all([
      sbSelect("discovery_situations", {
        select: "slug,label", active: "is.true", order: "sort_order.asc",
      }),
      sbSelect("discovery_clusters", {
        select: "id,name,blurb,x,y,colour,piece_count", order: "piece_count.desc",
      }),
      sbSelect("pieces", { select: "id", limit: "1" }),
    ]);

    // Points for the map: cluster + a deterministic offset per piece, so the
    // layout is stable between loads without shipping any vectors.
    const pieces = await sbSelect("pieces", {
      select: "id,title,category,url,cluster_id,char_count",
      cluster_id: "not.is.null", order: "char_count.desc", limit: "1000",
    });

    const byCluster = {};
    for (const c of clusters) byCluster[c.id] = c;

    const points = pieces.map((p) => {
      const c = byCluster[p.cluster_id];
      if (!c) return null;
      let h = 0;
      for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0;
      const a = ((h % 1000) / 1000) * Math.PI * 2;
      const r = Math.pow(((h >> 10) % 1000) / 1000, 0.62) * 0.115;
      return {
        t: p.title, u: p.url, c: p.cluster_id,
        x: +(c.x + Math.cos(a) * r).toFixed(4),
        y: +(c.y + Math.sin(a) * r * 0.82).toFixed(4),
        big: p.char_count > 12000,
      };
    }).filter(Boolean);

    const samples = {};
    for (const p of pieces) {
      if (!p.cluster_id) continue;
      (samples[p.cluster_id] = samples[p.cluster_id] || []);
      if (samples[p.cluster_id].length < 3) samples[p.cluster_id].push(p.title);
    }
    const withSamples = clusters.map((c) => ({ ...c, samples: samples[c.id] || [] }));

    return json({ situations, clusters: withSamples, points, total: pieces.length },
      200, { ...CORS, "Cache-Control": "public, max-age=600" });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500, CORS);
  }
};

export const config = { path: "/api/discovery-meta" };

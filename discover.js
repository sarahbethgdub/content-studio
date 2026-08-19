/* =====================================================================
   discover.js — Permanent Equity content discovery
   Served from Netlify, loaded by a four-line Squarespace code block:

     <div id="pe-discover"></div>
     <script src="https://pe-content-studio.netlify.app/discover.js"><\/script>

   Renders into a Shadow DOM, so the site's stylesheet cannot reach in and
   this cannot leak out. Fails silently and invisibly if the API is down —
   the content list underneath is the fallback.
   ===================================================================== */
(function () {
  "use strict";

  var API = (document.currentScript && document.currentScript.src || "")
    .replace(/\/discover\.js.*$/, "") || "https://pe-content-studio.netlify.app";

  var host = document.getElementById("pe-discover");
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = "1";

  var root = host.attachShadow({ mode: "open" });

  var STEERS = [
    { id: "tactical",   label: "More tactical" },
    { id: "contrarian", label: "More contrarian" },
    { id: "short",      label: "Shorter" },
    { id: "people",     label: "About people, not numbers" }
  ];

  var state = {
    view: "ask", meta: null, results: null, matched: null,
    query: "", situation: null, steer: null,
    busy: false, error: null, loadedMeta: false
  };

  /* ---------- analytics: same-origin, so whatever the page loads ---------- */
  function track(action, label) {
    try {
      if (window.gtag) window.gtag("event", action, { event_category: "content_discovery", event_label: label });
      else if (window.dataLayer) window.dataLayer.push({ event: "content_discovery", action: action, label: label });
      else if (window.ga) window.ga("send", "event", "content_discovery", action, label);
    } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var CSS = [
    ':host { all: initial; display: block; }',
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }',
    '.wrap { font-family: "Raleway", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  color: #282E3A; font-size: 15px; line-height: 1.55; letter-spacing: normal;',
    '  text-align: left; padding: 8px 0 4px; }',
    '.eyebrow { font-size: 12px; font-weight: 600; color: #8A8F99; display: flex;',
    '  align-items: center; gap: 10px; margin-bottom: 13px; }',
    '.bar { width: 22px; height: 2px; background: #CCA33E; display: inline-block; flex: none; }',
    '.tabs { display: flex; gap: 22px; border-bottom: 1px solid #DCDCD6; margin-bottom: 24px; }',
    '.tab { font-family: inherit; font-weight: 600; font-size: 13px; padding: 0 0 11px;',
    '  background: none; border: none; border-bottom: 3px solid transparent; margin-bottom: -1px;',
    '  color: #8A8F99; cursor: pointer; }',
    '.tab.on { color: #282E3A; border-bottom-color: #CCA33E; }',
    '.askrow { display: flex; gap: 10px; margin-bottom: 15px; }',
    '.ask { flex: 1; min-width: 0; font-family: inherit; font-size: 17px; color: #282E3A;',
    '  padding: 15px 17px; border: 1px solid #DCDCD6; background: #fff; border-radius: 0; }',
    '.ask::placeholder { color: #A5A9B0; }',
    '.ask:focus { outline: none; border-color: #282E3A; }',
    '.go { font-family: inherit; font-weight: 700; font-size: 14px; padding: 0 26px;',
    '  border: 1px solid #282E3A; background: #282E3A; color: #fff; cursor: pointer; border-radius: 0; }',
    '.go:hover { background: #1C212A; }',
    '.go:disabled { opacity: .5; cursor: default; }',
    '.chips { display: flex; flex-wrap: wrap; gap: 8px; }',
    '.chip { font-family: inherit; font-size: 13px; font-weight: 500; color: #565C68;',
    '  padding: 8px 13px; border: 1px solid #DCDCD6; background: #fff; cursor: pointer; border-radius: 0; }',
    '.chip:hover { border-color: #CCA33E; color: #282E3A; }',
    '.chip.on { background: #282E3A; border-color: #282E3A; color: #fff; }',
    '.status { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;',
    '  color: #8A8F99; margin: 26px 0 14px; }',
    '.res { border-top: 1px solid #DCDCD6; }',
    '.item { padding: 21px 0 23px; border-bottom: 1px solid #E6E6E0; }',
    '.imeta { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: #8A8F99; }',
    '.icat { color: #565C68; }',
    '.ititle { font-weight: 700; font-size: 20px; line-height: 1.25; margin-bottom: 8px; }',
    '.ititle a { color: #282E3A; text-decoration: none; border-bottom: 2px solid #CCA33E; }',
    '.ititle a:hover { color: #CCA33E; }',
    '.iwhy { font-size: 14.5px; color: #565C68; max-width: 74ch; }',
    '.ipull { margin-top: 11px; font-size: 14.5px; color: #282E3A; padding-left: 15px;',
    '  border-left: 3px solid #CCA33E; max-width: 70ch; font-style: italic; }',
    '.steer { margin: 24px 0 6px; }',
    '.steerlab { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;',
    '  color: #8A8F99; margin-bottom: 10px; }',
    '.err { font-size: 14px; color: #A02828; padding: 14px 0; }',
    '.mapwrap { position: relative; background: #F4F4F1; padding: 8px; }',
    'svg { display: block; width: 100%; height: auto; }',
    'svg circle { cursor: pointer; }',
    'svg circle:hover { opacity: 1 !important; }',
    '.cl { font-weight: 700; font-size: 10.5px; fill: #282E3A; letter-spacing: .01em;',
    '  font-family: "Raleway", sans-serif; paint-order: stroke; stroke: #F4F4F1;',
    '  stroke-width: 3px; stroke-linejoin: round; }',
    '.cl-count { font-weight: 500; font-size: 9.5px; fill: #8A8F99;',
    '  font-family: ui-monospace, monospace; paint-order: stroke; stroke: #F4F4F1;',
    '  stroke-width: 3px; }',
    '.tip strong { display:block; font-family:"Raleway",sans-serif; font-size:12px; margin-bottom:4px; }',
    '.tip em { display:block; font-style:normal; opacity:.75; }',
    '.tip { position: absolute; pointer-events: none; background: #282E3A; color: #fff;',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;',
    '  line-height: 1.5; padding: 9px 12px; opacity: 0; transition: opacity 120ms;',
    '  z-index: 5; max-width: 330px; }',
    '.tip.on { opacity: 1; }',
    '.maphint { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;',
    '  color: #8A8F99; margin-top: 12px; max-width: 70ch; line-height: 1.6; }',
    '@media (max-width: 640px) { .askrow { flex-direction: column; } .go { padding: 14px; }',
    '  .ititle { font-size: 18px; } }'
  ].join("\n");

  function api(path, body) {
    return fetch(API + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || ("HTTP " + r.status)); });
      return r.json();
    });
  }

  function resultsHTML() {
    if (state.busy) return '<div class="status">Reading the library…</div>';
    if (state.error) return '<div class="err">' + esc(state.error) + "</div>";
    if (!state.results) return "";
    if (!state.results.length) {
      return '<div class="status">Nothing in the library speaks to that directly. Try describing it differently.</div>';
    }
    return '<div class="status">' + state.results.length + " pieces" +
      (state.matched ? " · " + esc(state.matched) : "") + "</div>" +
      '<div class="res">' + state.results.map(function (r) {
        return '<div class="item">' +
          '<div class="imeta"><span class="icat">' + esc(r.category) + "</span>" +
          "<span>" + Math.round((r.char_count || 0) / 1000) + "k chars</span></div>" +
          '<div class="ititle"><a href="' + esc(r.url) + '" data-piece="' + esc(r.title) + '">' + esc(r.title) + "</a></div>" +
          '<div class="iwhy">' + esc(r.why) + "</div>" +
          (r.pull_quote ? '<div class="ipull">' + esc(r.pull_quote) + "</div>" : "") +
          "</div>";
      }).join("") + "</div>" +
      '<div class="steer"><div class="steerlab">Not quite? Steer it.</div><div class="chips">' +
      STEERS.map(function (s) {
        return '<button class="chip ' + (state.steer === s.id ? "on" : "") + '" data-steer="' + s.id + '">' + esc(s.label) + "</button>";
      }).join("") + "</div></div>";
  }


  /* Labels sit at region centres, which on real data means they collide and
     run off the edges. Estimate each label's box, then nudge them apart
     vertically until they stop overlapping, and flip the anchor near the
     edges so nothing gets clipped. */
  function placeLabels(clusters, W, H) {
    var CHAR = 5.6, LINE = 26, PAD = 3;
    var items = clusters.map(function (c) {
      var w = Math.max(String(c.name).length * CHAR, 46);
      return { id: c.id, name: c.name, piece_count: c.piece_count,
               w: w, lx: c.x * W, ly: c.y * H - 46, anchor: "middle" };
    });

    for (var pass = 0; pass < 90; pass++) {
      var moved = false;
      for (var a = 0; a < items.length; a++) {
        for (var b = a + 1; b < items.length; b++) {
          var A = items[a], B = items[b];
          var dx = Math.abs(A.lx - B.lx), dy = Math.abs(A.ly - B.ly);
          var needX = (A.w + B.w) / 2 + 10, needY = LINE;
          if (dx < needX && dy < needY) {
            var shift = (needY - dy) / 2 + PAD;
            if (A.ly <= B.ly) { A.ly -= shift; B.ly += shift; }
            else              { A.ly += shift; B.ly -= shift; }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }

    items.forEach(function (it) {
      it.ly = Math.max(14, Math.min(H - 10, it.ly));
      if (it.lx - it.w / 2 < 6)      { it.anchor = "start"; it.lx = 6; }
      else if (it.lx + it.w / 2 > W - 6) { it.anchor = "end";   it.lx = W - 6; }
      it.lx = Math.round(it.lx); it.ly = Math.round(it.ly);
    });
    return items;
  }

  function mapHTML() {
    var m = state.meta;
    if (!m || !m.clusters || !m.clusters.length) {
      return '<div class="status">The map hasn\'t been built yet.</div>';
    }
    var W = 900, H = 520;
    return '<div class="mapwrap"><svg viewBox="0 0 ' + W + " " + H + '">' +
      m.points.map(function (p) {
        var c = m.clusters.filter(function (x) { return x.id === p.c; })[0];
        if (!c) return "";
        return '<circle cx="' + (p.x * W).toFixed(1) + '" cy="' + (p.y * H).toFixed(1) +
          '" r="' + (p.big ? 5 : 3.2) + '" fill="' + esc(c.colour || "#CCA33E") +
          '" opacity="' + (p.big ? .85 : .5) + '" data-t="' + esc(p.t) + '" data-pt="' + esc(p.pt || "") + '" data-u="' + esc(p.u) + '"></circle>';
      }).join("") +
      placeLabels(m.clusters, W, H).map(function (c) {
        return '<text class="cl" x="' + c.lx + '" y="' + c.ly + '" text-anchor="' + c.anchor + '"' +
               ' data-cl="' + c.id + '">' + esc(c.name) + "</text>" +
               '<text class="cl-count" x="' + c.lx + '" y="' + (c.ly + 13) +
               '" text-anchor="' + c.anchor + '">' + c.piece_count + " pieces</text>";
      }).join("") +
      '</svg><div class="tip" id="tip"></div></div>' +
      '<div class="maphint">' + (m.situation_count || m.points.length) + " situations drawn from " +
      m.total + " pieces, grouped into " + m.clusters.length + " regions. " +
      "Every dot is something someone might be dealing with. Hover to read it, click to open the piece.</div>";
  }

  function paint() {
    var m = state.meta;
    root.innerHTML = "<style>" + CSS + "</style><div class=\"wrap\">" +
      '<div class="tabs">' +
      '<button class="tab ' + (state.view === "ask" ? "on" : "") + '" data-view="ask">Start from a situation</button>' +
      '<button class="tab ' + (state.view === "map" ? "on" : "") + '" data-view="map">See the whole library</button>' +
      "</div>" +
      (state.view === "ask"
        ? '<div class="eyebrow"><span class="bar"></span>Describe it in your own words</div>' +
          '<div class="askrow"><input class="ask" id="q" placeholder="We need to raise prices but I\'m worried about our three biggest customers" value="' + esc(state.query) + '">' +
          '<button class="go" id="go"' + (state.busy ? " disabled" : "") + ">Find</button></div>" +
          '<div class="chips">' + ((m && m.situations) || []).map(function (s) {
            return '<button class="chip ' + (state.situation === s.slug ? "on" : "") + '" data-sit="' + esc(s.slug) + '">' + esc(s.label) + "</button>";
          }).join("") + "</div>" + resultsHTML()
        : mapHTML()) +
      "</div>";

    root.querySelectorAll("[data-view]").forEach(function (b) {
      b.onclick = function () { state.view = b.dataset.view; track("view", b.dataset.view); paint(); };
    });
    root.querySelectorAll("[data-sit]").forEach(function (b) {
      b.onclick = function () { search({ situation: b.dataset.sit }); };
    });
    root.querySelectorAll("[data-steer]").forEach(function (b) {
      b.onclick = function () {
        state.steer = state.steer === b.dataset.steer ? null : b.dataset.steer;
        track("steer", b.dataset.steer);
        search({ query: state.query, situation: state.situation, keepSteer: true });
      };
    });
    root.querySelectorAll("[data-piece]").forEach(function (a) {
      a.onclick = function () { track("open_piece", a.dataset.piece); };
    });

    var go = root.getElementById("go"), q = root.getElementById("q");
    if (go) go.onclick = function () { search({ query: q.value }); };
    if (q) q.onkeydown = function (e) { if (e.key === "Enter") search({ query: q.value }); };

    var tip = root.getElementById("tip");
    if (tip) {
      root.querySelectorAll("svg text.cl").forEach(function (t) {
        t.onmouseenter = function (e) {
          var c = (state.meta.clusters || []).filter(function (x) { return String(x.id) === t.dataset.cl; })[0];
          if (!c) return;
          tip.innerHTML = "<strong>" + esc(c.name) + "</strong>" +
            (c.blurb ? "<em>" + esc(c.blurb) + "</em>" : "") +
            ((c.samples || []).length ? "<em>e.g. " + esc(c.samples.join(" · ")) + "</em>" : "");
          tip.style.left = (e.offsetX + 14) + "px";
          tip.style.top = (e.offsetY + 8) + "px";
          tip.classList.add("on");
        };
        t.onmouseleave = function () { tip.classList.remove("on"); };
      });

      root.querySelectorAll("svg circle").forEach(function (c) {
        c.onmouseenter = function (e) {
          tip.innerHTML = "<strong>" + esc(c.dataset.t) + "</strong>" +
            (c.dataset.pt ? "<em>" + esc(c.dataset.pt) + "</em>" : "");
          tip.style.left = (e.offsetX + 14) + "px";
          tip.style.top = (e.offsetY + 8) + "px";
          tip.classList.add("on");
        };
        c.onmouseleave = function () { tip.classList.remove("on"); };
        c.onclick = function () { if (c.dataset.u) { track("open_piece", c.dataset.pt || c.dataset.t); window.location.href = c.dataset.u; } };
      });
    }
  }

  function search(opts) {
    opts = opts || {};
    state.query = opts.query != null ? opts.query : state.query;
    state.situation = opts.situation != null ? opts.situation : (opts.query ? null : state.situation);
    if (!opts.keepSteer) state.steer = null;
    if (!state.query && !state.situation) return;

    state.busy = true; state.error = null; paint();
    track("search", state.situation || state.query.slice(0, 80));

    api("/api/discovery-search", {
      query: state.situation ? "" : state.query,
      situation: state.situation,
      steer: state.steer
    }).then(function (d) {
      state.results = d.results || [];
      state.matched = d.matched_situation || null;
    }).catch(function (e) {
      state.error = e.message || "Something went wrong.";
      state.results = null;
    }).then(function () { state.busy = false; paint(); });
  }

  /* boot: if meta fails, remove the widget entirely so the page below is untouched */
  fetch(API + "/api/discovery-meta", { method: "POST" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) throw new Error(d.error);
      state.meta = d; state.loadedMeta = true; paint();
    })
    .catch(function () { host.remove(); });
})();

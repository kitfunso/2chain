// v2 dashboard — JK-hybrid TUI on cream, ink-bordered, K-palette colored.
// Wires /state (initial snapshot) + /events (SSE) + /atlas-stats (driver info).
// Replaces the v1 MongoDB-flavored single-page dashboard. Same exported name
// (DASHBOARD_HTML) so the route handler in dashboard.ts is unchanged.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>2chain · tool registry</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --paper:    #f3eee2;
    --paper-2:  #ece6d4;
    --paper-3:  #e2dcc8;
    --ink:      #1a1a1a;
    --ink-2:    #3d3a32;
    --muted:    #8a8678;
    --orange:    #ff5c1c;
    --red:       #e3231a;
    --yellow:    #ffd400;
    --yellow-fg: #6e5300;
    --green:     #2da94f;
    --green-fg:  #1d7f3a;
    --blue:      #1f5cff;
    --magenta:   #d6258a;
    --mono:     "JetBrains Mono", ui-monospace, "Cascadia Code", "SF Mono", "Consolas", monospace;
    --sans:     "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { background: var(--paper); color: var(--ink);
    font: 14px/1.35 var(--mono); letter-spacing: 0; }
  pre { margin: 0; }
  .green { color: var(--green-fg); }
  .yellow { color: var(--yellow-fg); }
  .red { color: var(--red); }
  .blue { color: var(--blue); }
  .magenta { color: var(--magenta); }
  .orange { color: var(--orange); }
  .muted { color: var(--muted); }
  .ink2 { color: var(--ink-2); }
  .bright { color: var(--ink); font-weight: 700; }

  .tui { display: grid; grid-template-rows: auto 1fr auto; height: 100%; padding: 6px 8px; gap: 6px; }

  .top { border: 2px solid var(--ink); background: var(--paper-2);
    padding: 3px 8px; display: flex; align-items: center; gap: 14px; }
  .top .brand { background: var(--orange); color: var(--paper); padding: 1px 10px;
    font-weight: 800; letter-spacing: 0.5px; border-right: 2px solid var(--ink);
    margin: -3px 8px -3px -8px; height: calc(100% + 6px);
    display: inline-flex; align-items: center; }
  .top .nav .item { padding: 0 6px; }
  .top .nav .active { background: var(--ink); color: var(--paper);
    padding: 1px 8px; font-weight: 700; }
  .top .right { margin-left: auto; }
  .top .pulse { color: var(--green-fg); font-weight: 700; }
  .top .pulse.disc { color: var(--red); }

  .body { display: grid; grid-template-columns: 280px 1fr 380px; gap: 6px; min-height: 0; }
  .pane { border: 2px solid var(--ink); background: var(--paper);
    display: flex; flex-direction: column; min-height: 0; }
  .pane.focused { box-shadow: 4px 4px 0 var(--ink); }
  .pane-head { padding: 3px 10px; border-bottom: 2px solid var(--ink);
    display: flex; align-items: center; justify-content: space-between;
    background: var(--paper-2); font-size: 12px; }
  .pane.focused .pane-head { background: var(--yellow); }
  .pane-head .lab { font-weight: 700; letter-spacing: 0.5px; }
  .pane-head .right { font-size: 10.5px; color: var(--ink-2); }
  .pane-body { padding: 8px 10px; overflow: auto; flex: 1; }

  .sb-row { padding: 1px 4px; cursor: pointer; }
  .sb-row.active { background: var(--ink); color: var(--paper); }
  .sb-row.active .muted { color: rgba(243,238,226,0.55); }
  .sb-row .ico { display: inline-block; width: 14px; }
  .sb-cat { color: var(--muted); margin-top: 8px; padding-left: 2px;
    font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; }

  .domain-pip { display: inline-block; width: 8px; height: 8px;
    border: 1.5px solid var(--ink); margin-right: 6px; vertical-align: middle; }
  .domain-pip.fin { background: var(--orange); }
  .domain-pip.cod { background: var(--blue); }
  .domain-pip.res { background: var(--magenta); }
  .domain-pip.doc { background: var(--red); }
  .domain-pip.geo { background: var(--green); }
  .domain-pip.dat { background: var(--magenta); }
  .domain-pip.com { background: var(--yellow); }

  .tab-strip { display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-bottom: 2px solid var(--ink);
    background: var(--paper-2); overflow-x: auto; flex-wrap: nowrap; white-space: nowrap; }
  .tab-strip .tab { display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 9px; border: 2px solid var(--ink); background: var(--paper);
    font: 700 11.5px/1.3 var(--mono); letter-spacing: 0.5px; text-transform: uppercase;
    cursor: pointer; color: var(--ink); box-shadow: 2px 2px 0 var(--ink);
    transition: transform 0.05s, box-shadow 0.05s; flex-shrink: 0; }
  .tab-strip .tab .ct { font-weight: 600; opacity: 0.7; font-size: 10.5px; }
  .tab-strip .tab:hover { background: var(--paper-3); }
  .tab-strip .tab.active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--ink); }
  .tab-strip .tab.all.active { background: var(--ink); color: var(--paper); }
  .tab-strip .tab.fin.active { background: var(--orange); color: var(--paper); }
  .tab-strip .tab.cod.active { background: var(--blue); color: var(--paper); }
  .tab-strip .tab.res.active { background: var(--magenta); color: var(--paper); }
  .tab-strip .tab.doc.active { background: var(--red); color: var(--paper); }
  .tab-strip .tab.geo.active { background: var(--green); color: var(--paper); }
  .tab-strip .tab.dat.active { background: var(--magenta); color: var(--paper); }
  .tab-strip .tab.com.active { background: var(--yellow); color: var(--ink); }
  .tab-strip .tab .pip { display: inline-block; width: 8px; height: 8px;
    border: 1.5px solid currentColor; vertical-align: middle; }
  .tab-strip .tab.fin .pip { background: var(--orange); }
  .tab-strip .tab.cod .pip { background: var(--blue); }
  .tab-strip .tab.res .pip { background: var(--magenta); }
  .tab-strip .tab.doc .pip { background: var(--red); }
  .tab-strip .tab.geo .pip { background: var(--green); }
  .tab-strip .tab.dat .pip { background: var(--magenta); }
  .tab-strip .tab.com .pip { background: var(--yellow); }
  .tab-strip .tab.all .pip { background: transparent; border-style: dashed; }
  .tab-strip .tab.active .pip { border-color: rgba(255,255,255,0.8); }
  .tab-strip .spacer { flex: 1; }
  .tab-strip .mode-hint { font: 600 10.5px/1.3 var(--mono);
    color: var(--ink-2); letter-spacing: 1px; text-transform: uppercase; padding-right: 4px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.4; }
  th { text-align: left; color: var(--ink-2); padding: 0 8px 4px; font-weight: 700;
    letter-spacing: 0.5px; border-bottom: 2px solid var(--ink);
    background: var(--paper-2); font-size: 11px; text-transform: uppercase; }
  td { padding: 2px 8px; border-bottom: 1px solid var(--paper-3); cursor: pointer; }
  tr.t1 td { background: var(--yellow); color: var(--ink); font-weight: 700; }
  tr.t1 td.first::before { content: "▶ "; color: var(--orange); font-weight: 800; }
  tr.selected td { outline: 2px solid var(--ink); outline-offset: -2px; }
  tr.flash td { animation: flash 1s ease-out; }
  @keyframes flash { 0% { background: var(--orange); color: var(--paper); } 100% {} }
  td.num { text-align: right; }
  td .domain-tag { display: inline-block; padding: 0 5px; border: 1.5px solid var(--ink);
    font-size: 9px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; line-height: 1.4; }
  .domain-tag.fin { background: var(--orange); color: var(--paper); }
  .domain-tag.cod { background: var(--blue); color: var(--paper); }
  .domain-tag.res { background: var(--magenta); color: var(--paper); }
  .domain-tag.doc { background: var(--red); color: var(--paper); }
  .domain-tag.geo { background: var(--green); color: var(--paper); }
  .domain-tag.dat { background: var(--magenta); color: var(--paper); }
  .domain-tag.com { background: var(--yellow); color: var(--ink); }
  .domain-tag.unk { background: var(--paper-3); color: var(--ink-2); }
  td .stat-pill { font-family: var(--mono); font-size: 10px; padding: 0 5px;
    border: 1.5px solid var(--ink); font-weight: 700; }
  .stat-pill.active { background: var(--green); color: var(--paper); }
  .stat-pill.pending { background: var(--yellow); color: var(--ink); }
  .stat-pill.circuit_broken { background: var(--red); color: var(--paper); }

  .ascii-box { color: var(--ink-2); }
  .ascii-box .bar { color: var(--ink); }

  .detail { font-size: 13.5px; }
  .detail h3 { margin: 0 0 4px; font-family: var(--mono);
    font-size: 14.5px; font-weight: 800; letter-spacing: -0.3px; }
  .detail .submeta { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .detail .blurb { font-family: var(--sans); color: var(--ink); margin: 8px 0 12px;
    line-height: 1.5; font-size: 13.5px; letter-spacing: -0.005em; }
  .kv { display: grid; grid-template-columns: 90px 1fr; gap: 1px 8px;
    padding-bottom: 8px; border-bottom: 2px solid var(--ink); margin-bottom: 8px;
    font-size: 13px; font-family: var(--mono); }
  .kv .k { color: var(--ink-2); }
  .reliability-bar { display: inline-flex; align-items: center; gap: 6px; }
  .reliability-bar .meter { display: inline-block; width: 80px; height: 8px;
    background: var(--paper-3); border: 1.5px solid var(--ink);
    position: relative; vertical-align: middle; }
  .reliability-bar .meter > i { display: block; height: 100%; background: var(--green); }
  .reliability-bar .meter > i.gated { background: var(--red); }

  .feed-head { font-size: 11px; color: var(--ink-2); letter-spacing: 1.5px;
    text-transform: uppercase; padding: 6px 0; border-bottom: 2px solid var(--ink);
    margin-top: 4px; font-weight: 800; }
  .feed-row { padding: 2px 0; line-height: 1.4; font-size: 13px; }
  .feed-row.cb { background: rgba(227, 35, 26, 0.08); }
  .feed-row.gate { background: rgba(255, 212, 0, 0.18); }

  .chip { display: inline-block; padding: 0 5px; font-size: 10px; font-weight: 800;
    border: 1.5px solid var(--ink); text-transform: uppercase; letter-spacing: 1px;
    line-height: 1.45; vertical-align: 1px; }
  .chip.dscv { background: var(--blue); color: var(--paper); }
  .chip.call { background: var(--green); color: var(--paper); }
  .chip.cb { background: var(--red); color: var(--paper); }
  .chip.gate { background: var(--yellow); color: var(--ink); }
  .chip.push { background: var(--magenta); color: var(--paper); }
  .chip.eval { background: var(--paper-3); color: var(--ink); }

  .status { border: 2px solid var(--ink); background: var(--paper-2);
    padding: 3px 10px; display: flex; align-items: center; gap: 14px;
    font-size: 12px; flex-wrap: nowrap; white-space: nowrap; }
  .status .keypair { display: inline-flex; align-items: center; gap: 4px; }
  .status .key { display: inline-block; min-width: 18px; padding: 0 6px;
    background: var(--paper-3); color: var(--ink); border: 1.5px solid var(--ink);
    font-weight: 800; text-align: center; box-shadow: 1.5px 1.5px 0 var(--ink); }
  .status .key.g { background: var(--green); color: var(--paper); }
  .status .key.b { background: var(--blue); color: var(--paper); }
  .status .key.r { background: var(--red); color: var(--paper); }
  .status .key.y { background: var(--yellow); color: var(--ink); }
  .status .key.m { background: var(--magenta); color: var(--paper); }
  .status .key.o { background: var(--orange); color: var(--paper); }
  .status .right { margin-left: auto; color: var(--ink-2); font-size: 11px; }

  .empty { padding: 16px 8px; color: var(--muted); font-style: italic; text-align: center; }
</style>
</head>
<body>
<div class="tui">

  <div class="top">
    <span class="brand">2CHAIN v0.2</span>
    <span class="nav">
      <span class="item active">Overview</span>
      <span class="item muted">Discover</span>
      <span class="item muted">Tools</span>
      <span class="item muted">Calls</span>
      <span class="item muted">Evals</span>
    </span>
    <span class="muted">·</span>
    <span><span class="muted">storage:</span> <span class="bright" id="x-driver">…</span> <span class="muted">embed:</span> <span class="bright" id="x-embed">…</span></span>
    <span class="muted">·</span>
    <span class="muted"><span id="x-tools">…</span> tools · <span id="x-mcp">…</span> mcp · <span class="red"><span id="x-vio">0</span> violations</span></span>
    <span class="right"><span class="pulse" id="x-pulse">●</span> <span id="x-conn">connecting…</span> <span class="muted" id="x-clock"></span></span>
  </div>

  <div class="body">

    <div class="pane">
      <div class="pane-head"><span class="lab">1 NAV</span> <span class="right">click to filter</span></div>
      <div class="pane-body">
<pre><span class="muted">┌─ Workspace ─────────┐</span>
<span class="sb-row"><span class="ico">▦</span> Overview</span>
<span class="sb-row active"><span class="ico">⌘</span> Discover</span>
<span class="sb-row"><span class="ico">↗</span> Tools <span class="muted" id="n-tools">0</span></span>
<span class="sb-row"><span class="ico">⚡</span> Calls <span class="muted" id="n-calls">0</span></span>
<span class="sb-row"><span class="ico">⚠</span> Violations <span class="red" id="n-vio">0</span></span>
<span class="sb-row"><span class="ico">✓</span> Evals <span class="muted" id="n-evals">0</span></span>

<span class="sb-cat">Sources</span>
<span class="sb-row"><span class="ico">●</span> MCP <span class="muted" id="n-mcp">0</span></span>
<span class="sb-row"><span class="ico">●</span> Fixtures <span class="muted" id="n-fix">0</span></span>
<span class="sb-row"><span class="ico">●</span> Catalog <span class="muted" id="n-cat">0</span></span>

<span class="sb-cat">Domains</span>
<span class="sb-row" data-dom="finance"><span class="domain-pip fin"></span>finance <span class="muted" id="d-finance">0</span></span>
<span class="sb-row" data-dom="code"><span class="domain-pip cod"></span>code <span class="muted" id="d-code">0</span></span>
<span class="sb-row" data-dom="research"><span class="domain-pip res"></span>research <span class="muted" id="d-research">0</span></span>
<span class="sb-row" data-dom="docs"><span class="domain-pip doc"></span>docs <span class="muted" id="d-docs">0</span></span>
<span class="sb-row" data-dom="geo"><span class="domain-pip geo"></span>geo <span class="muted" id="d-geo">0</span></span>
<span class="sb-row" data-dom="data"><span class="domain-pip dat"></span>data <span class="muted" id="d-data">0</span></span>
<span class="sb-row" data-dom="comms"><span class="domain-pip com"></span>comms <span class="muted" id="d-comms">0</span></span>

<span class="muted"># press / for fuzzy</span>
</pre>
      </div>
    </div>

    <div class="pane focused">
      <div class="pane-head">
        <span><span class="lab">2 RANKING</span> <span class="muted" id="x-query">— (run /discover to populate)</span></span>
        <span class="right"><span class="muted">RRF · vec0.5 / txt0.5 · gate 0.80 · </span><span class="green bright" id="x-latency">—</span></span>
      </div>
      <div class="tab-strip" id="domain-tabs">
        <span class="mode-hint">▌ Domain</span>
        <button class="tab all active" data-domain=""><span class="pip"></span>ALL <span class="ct" id="dt-all">· 0</span></button>
        <button class="tab fin" data-domain="finance"><span class="pip"></span>FIN <span class="ct" id="dt-finance">· 0</span></button>
        <button class="tab cod" data-domain="code"><span class="pip"></span>COD <span class="ct" id="dt-code">· 0</span></button>
        <button class="tab res" data-domain="research"><span class="pip"></span>RES <span class="ct" id="dt-research">· 0</span></button>
        <button class="tab doc" data-domain="docs"><span class="pip"></span>DOC <span class="ct" id="dt-docs">· 0</span></button>
        <button class="tab geo" data-domain="geo"><span class="pip"></span>GEO <span class="ct" id="dt-geo">· 0</span></button>
        <button class="tab dat" data-domain="data"><span class="pip"></span>DAT <span class="ct" id="dt-data">· 0</span></button>
        <button class="tab com" data-domain="comms"><span class="pip"></span>COM <span class="ct" id="dt-comms">· 0</span></button>
        <span class="spacer"></span>
        <span class="mode-hint">⇄&nbsp; click to filter</span>
      </div>
      <div class="pane-body">
        <table id="rank-table">
          <thead>
            <tr><th>#</th><th>tool</th><th>ver</th><th>domain</th><th class="num">rrf</th><th class="num">rel</th><th class="num">vec</th><th class="num">p95</th></tr>
          </thead>
          <tbody><tr><td colspan="8" class="empty">loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="pane">
      <div class="pane-head"><span class="lab">3 DETAIL & FEED</span> <span class="right" id="x-feed-count">0 events</span></div>
      <div class="pane-body">
        <div class="detail" id="detail-view">
          <h3 class="bright" id="d-name">select a tool</h3>
          <div class="submeta" id="d-submeta"></div>
          <p class="blurb" id="d-blurb">Click a row in the ranking table or wait for /discover to populate.</p>
          <div class="kv" id="d-kv"></div>
        </div>
        <div class="feed-head">▌ LIVE FEED ▌ /events</div>
        <div id="feed">
          <div class="feed-row muted">waiting for events…</div>
        </div>
      </div>
    </div>
  </div>

  <div class="status">
    <span class="keypair"><span class="key g">/</span><span class="muted">search</span></span>
    <span class="keypair"><span class="key">⏎</span><span class="muted">call</span></span>
    <span class="keypair"><span class="key">j/k</span><span class="muted">move</span></span>
    <span class="keypair"><span class="key m">tab</span><span class="muted">pane</span></span>
    <span class="keypair"><span class="key o">1-9</span><span class="muted">domain</span></span>
    <span class="keypair"><span class="key b">d</span><span class="muted">discover</span></span>
    <span class="keypair"><span class="key o">p</span><span class="muted">push</span></span>
    <span class="keypair"><span class="key y">e</span><span class="muted">eval</span></span>
    <span class="keypair"><span class="key r">!</span><span class="muted">cb</span></span>
    <span class="keypair"><span class="key">?</span><span class="muted">help</span></span>
    <span class="right" id="x-foot">SSE — · queue 0 · pane 2/3</span>
  </div>

</div>
<script>
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = {
    num: (n) => Number(n ?? 0).toLocaleString('en-GB'),
    rel: (n) => Number(n ?? 0).toFixed(2),
    rrf: (n) => Number(n ?? 0).toFixed(4),
    vec: (n) => Number(n ?? 0).toFixed(2),
    ms:  (n) => Number(n ?? 0).toFixed(0),
    time: (d) => d ? new Date(d).toLocaleTimeString('en-GB', { hour12: false }) : '',
  };
  const DOMAINS = ['finance','code','research','docs','geo','data','comms'];
  const DOMAIN_TAG = {
    finance: 'fin', code: 'cod', research: 'res',
    docs: 'doc', geo: 'geo', data: 'dat', comms: 'com',
  };
  function tagFor(d) { return DOMAIN_TAG[d] || 'unk'; }
  function tagLabel(d) { const m = tagFor(d); return m === 'unk' ? '—' : m.toUpperCase(); }

  const state = {
    tools: [],
    violations: [],
    evals: [],
    activeDomain: '',
    selected: null,
    lastDiscover: null,   // { results, meta, query }
    feed: [],             // recent events, capped 20
  };

  // ---- /atlas-stats : storage driver + collection counts -------------------
  async function loadStats() {
    try {
      const r = await fetch('/atlas-stats');
      if (!r.ok) throw new Error('atlas-stats ' + r.status);
      const s = await r.json();
      const driver = (s.mongo?.modules || ['unknown'])[0];
      $('#x-driver').textContent = driver === 'sqlite' ? 'sqlite-vec' : driver;
      const counts = s.collection_doc_counts || {};
      $('#x-tools').textContent = fmt.num(counts.tools);
      $('#x-vio').textContent = fmt.num(counts.violations);
      $('#x-mcp').textContent = '?'; // we'd need a /sources endpoint to know real MCP count
      $('#n-tools').textContent = fmt.num(counts.tools);
      $('#n-calls').textContent = fmt.num(counts.usage);
      $('#n-vio').textContent = fmt.num(counts.violations);
      $('#n-evals').textContent = fmt.num(counts.eval_runs);
    } catch (e) {
      console.warn('stats load failed', e);
    }
  }

  // ---- /state : initial snapshot -------------------------------------------
  async function loadState() {
    try {
      const r = await fetch('/state');
      const s = await r.json();
      state.tools = s.tools || [];
      state.violations = s.violations || [];
      state.evals = s.evalRuns || [];
      $('#x-embed').textContent = inferEmbed();
      computeDomainCounts();
      computeSourceCounts();
      renderTable();
      // pick top reliability as a default selection until /discover happens
      const top = [...state.tools]
        .filter((t) => t.status === 'active')
        .sort((a, b) => (b.metadata?.reliability_score ?? 0) - (a.metadata?.reliability_score ?? 0))[0];
      if (top) renderDetail(top);
    } catch (e) {
      console.warn('state load failed', e);
    }
  }

  function inferEmbed() {
    const t = state.tools[0];
    if (!t || !t.capability_embedding) return 'nomic-768';
    const dim = Array.isArray(t.capability_embedding)
      ? t.capability_embedding.length
      : (t.metadata?.embedding_dim || 768);
    return dim === 1024 ? 'mxbai-1024' : 'nomic-' + dim;
  }

  function computeSourceCounts() {
    let mcp = 0, fix = 0, cat = 0;
    for (const t of state.tools) {
      if (t.endpoint_stub_name === 'mcp-bridge') mcp++;
      else if (t.endpoint_stub_name === 'catalog-only-stub') cat++;
      else fix++;
    }
    $('#n-mcp').textContent = fmt.num(mcp);
    $('#n-fix').textContent = fmt.num(fix);
    $('#n-cat').textContent = fmt.num(cat);
    $('#x-mcp').textContent = fmt.num(mcp);
  }

  function computeDomainCounts() {
    const counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
    for (const t of state.tools) {
      const d = (t.domain || '').toLowerCase();
      if (d in counts) counts[d]++;
    }
    for (const d of DOMAINS) {
      const el = $('#d-' + d); if (el) el.textContent = fmt.num(counts[d]);
      const ct = $('#dt-' + d); if (ct) ct.textContent = '· ' + fmt.num(counts[d]);
    }
    $('#dt-all').textContent = '· ' + fmt.num(state.tools.length);
  }

  // ---- ranking table -------------------------------------------------------
  function renderTable() {
    const tbody = $('#rank-table tbody');
    let rows;
    if (state.lastDiscover && state.lastDiscover.results.length) {
      // /discover mode — show ranked candidates
      rows = state.lastDiscover.results.map((r, i) => ({
        rank: i + 1,
        name: r.name, version: r.version,
        domain: (state.tools.find((t) => t.name === r.name)?.domain) || 'unk',
        rrf: r.rrf_score ?? r.rank_score ?? 0,
        rel: r.reliability_score ?? 0,
        vec: r.vec_score ?? 0,
        p95: state.tools.find((t) => t.name === r.name)?.metadata?.p95_latency_ms ?? 0,
        top1: i === 0,
      }));
    } else {
      // browse mode — alphabetical, filtered by domain
      let pool = state.tools;
      if (state.activeDomain) pool = pool.filter((t) => (t.domain || '').toLowerCase() === state.activeDomain);
      rows = pool
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 50)
        .map((t, i) => ({
          rank: i + 1, name: t.name, version: t.version,
          domain: (t.domain || 'unk').toLowerCase(),
          rrf: 0, rel: t.metadata?.reliability_score ?? 0,
          vec: 0, p95: t.metadata?.p95_latency_ms ?? 0, top1: false,
        }));
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">no tools match this filter</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const tag = tagFor(r.domain);
      const sel = state.selected && state.selected.name === r.name && state.selected.version === r.version
        ? ' selected' : '';
      return '<tr class="' + (r.top1 ? 't1' : '') + sel + '" data-key="' + r.name + '@' + r.version + '">'
        + '<td' + (r.top1 ? ' class="first"' : '') + '>' + r.rank + '</td>'
        + '<td>' + r.name + '</td>'
        + '<td class="muted">' + r.version + '</td>'
        + '<td><span class="domain-tag ' + tag + '">' + tagLabel(r.domain) + '</span></td>'
        + '<td class="num">' + (r.rrf ? fmt.rrf(r.rrf) : '—') + '</td>'
        + '<td class="num ' + (r.rel >= 1 ? 'green' : '') + '">' + fmt.rel(r.rel) + '</td>'
        + '<td class="num">' + (r.vec ? fmt.vec(r.vec) : '—') + '</td>'
        + '<td class="num">' + fmt.ms(r.p95) + '</td>'
        + '</tr>';
    }).join('');
  }

  // ---- right pane detail ---------------------------------------------------
  function renderDetail(tool) {
    if (!tool) return;
    state.selected = tool;
    const tag = tagFor((tool.domain || '').toLowerCase());
    $('#d-name').innerHTML = tool.name + '@' + tool.version
      + ' <span class="domain-tag ' + tag + '" style="font-size:9px;vertical-align:2px;">' + tagLabel(tool.domain) + '</span>';
    $('#d-submeta').textContent = (tool.author_agent_id ? 'author ' + tool.author_agent_id + ' · ' : '')
      + (tool.endpoint_stub_name ? 'stub ' + tool.endpoint_stub_name : '');
    $('#d-blurb').textContent = tool.capability_text || '';
    const meta = tool.metadata || {};
    const rel = meta.reliability_score ?? 0;
    const gated = rel < 0.80;
    const pct = Math.max(0, Math.min(100, rel * 100));
    $('#d-kv').innerHTML =
        '<span class="k">reliability</span><span><span class="reliability-bar"><span class="meter"><i class="' + (gated ? 'gated' : '') + '" style="width:' + pct.toFixed(0) + '%"></i></span><span class="bright">' + fmt.rel(rel) + '</span></span></span>'
      + '<span class="k">p95 latency</span><span><span class="bright">' + fmt.ms(meta.p95_latency_ms) + '</span> <span class="muted">ms</span></span>'
      + '<span class="k">cost / call</span><span>$' + Number(meta.cost_per_call_usd ?? 0).toFixed(4) + '</span>'
      + '<span class="k">status</span><span class="' + (tool.status === 'active' ? 'green bright' : tool.status === 'circuit_broken' ? 'red bright' : 'yellow bright') + '">' + (tool.status || 'unknown') + '</span>'
      + '<span class="k">stub</span><span>' + (tool.endpoint_stub_name || '—') + '</span>'
      + '<span class="k">last eval</span><span>' + fmt.time(meta.last_eval_run) + '</span>';
    // refresh row outline
    renderTable();
  }

  // ---- live feed -----------------------------------------------------------
  function pushFeed(html, klass) {
    state.feed.unshift({ html, klass: klass || '', t: Date.now() });
    if (state.feed.length > 20) state.feed.length = 20;
    $('#x-feed-count').textContent = state.feed.length + ' event' + (state.feed.length === 1 ? '' : 's');
    $('#feed').innerHTML = state.feed.map((f) =>
      '<div class="feed-row ' + f.klass + '"><span class="muted">'
      + new Date(f.t).toLocaleTimeString('en-GB', { hour12: false })
      + '</span> ' + f.html + '</div>').join('');
  }

  // ---- /events SSE ---------------------------------------------------------
  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => { $('#x-conn').textContent = 'live'; $('#x-pulse').classList.remove('disc'); };
    es.onerror = () => { $('#x-conn').textContent = 'reconnecting…'; $('#x-pulse').classList.add('disc'); };

    es.addEventListener('discover_ran', (e) => {
      const d = JSON.parse(e.data);
      state.lastDiscover = d;
      $('#x-query').textContent = '— "' + (d.query || '').slice(0, 80) + '"';
      const meta = d.meta || {};
      $('#x-latency').textContent = (meta.total_ms || meta.search_ms || 0) + 'ms';
      renderTable();
      // also update detail to top-1 of the ranking
      const top = (d.results || [])[0];
      if (top) {
        const t = state.tools.find((x) => x.name === top.name && x.version === top.version);
        if (t) renderDetail(t);
      }
      pushFeed('<span class="chip dscv">DSCV</span> "' + (d.query || '').slice(0, 50) + '" → ' + (d.results || []).length + ' res ' + (meta.total_ms || 0) + 'ms');
    });

    es.addEventListener('tool_invoked', (e) => {
      const d = JSON.parse(e.data);
      const cls = d.outcome === 'ok' ? '' : (d.outcome === 'circuit_broken' ? 'cb' : (d.outcome === 'gated' ? 'gate' : ''));
      pushFeed('<span class="chip call">CALL</span> ' + d.tool_name + '@' + d.tool_version + ' '
        + '<span class="' + (d.outcome === 'ok' ? 'green bright' : 'red') + '">' + d.outcome + '</span> '
        + (d.latency_ms != null ? '<span class="muted">' + d.latency_ms + 'ms</span>' : ''),
        cls);
      // flash the row in the table
      const row = document.querySelector('tr[data-key="' + d.tool_name + '@' + d.tool_version + '"]');
      if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    });

    es.addEventListener('tool_changed', (e) => {
      const data = JSON.parse(e.data);
      const t = data.tool || data;
      if (!t || !t.name) return;
      const idx = state.tools.findIndex((x) => x.name === t.name && x.version === t.version);
      if (idx >= 0) state.tools[idx] = { ...state.tools[idx], ...t };
      else state.tools.push(t);
      computeDomainCounts();
      computeSourceCounts();
      renderTable();
      pushFeed('<span class="chip push">PUSH</span> ' + t.name + '@' + t.version
        + ' <span class="muted">' + (t.status || '?') + '</span>');
    });

    es.addEventListener('violation_logged', onViolation);
    es.addEventListener('violation_added', onViolation);
    function onViolation(e) {
      const v = JSON.parse(e.data);
      pushFeed('<span class="chip cb">CB!!</span> <span class="bright">' + v.tool_name + '</span> '
        + '<span class="red">' + (v.stage || 'output') + '_violation</span>', 'cb');
      const cur = parseInt($('#n-vio').textContent || '0', 10);
      $('#n-vio').textContent = String(cur + 1);
      $('#x-vio').textContent = String(cur + 1);
    }

    es.addEventListener('eval_completed', (e) => {
      const d = JSON.parse(e.data);
      pushFeed('<span class="chip eval">EVAL</span> ' + (d.tool_name || '?') + '@' + (d.tool_version || '?')
        + ' <span class="muted">' + (d.pass_count || 0) + '/' + (d.total_count || 0) + '</span>');
    });
  }

  // ---- domain tab + sidebar interactivity ----------------------------------
  document.getElementById('domain-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.tab');
    if (!btn) return;
    state.activeDomain = btn.dataset.domain || '';
    state.lastDiscover = null;   // tab switch exits discover mode
    document.querySelectorAll('#domain-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('#x-query').textContent = state.activeDomain ? '— browsing ' + state.activeDomain : '— (run /discover to populate)';
    renderTable();
  });

  document.querySelectorAll('.sb-row[data-dom]').forEach((row) => {
    row.addEventListener('click', () => {
      const d = row.dataset.dom;
      const btn = document.querySelector('#domain-tabs .tab[data-domain="' + d + '"]');
      if (btn) btn.click();
    });
  });

  $('#rank-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const [name, version] = tr.dataset.key.split('@');
    const t = state.tools.find((x) => x.name === name && x.version === version);
    if (t) renderDetail(t);
  });

  // ---- footer clock --------------------------------------------------------
  function tickClock() {
    $('#x-clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }
  setInterval(tickClock, 1000); tickClock();

  // ---- boot ----------------------------------------------------------------
  loadStats().then(() => loadState()).then(() => connect());
  setInterval(loadStats, 15000);
})();
</script>
</body>
</html>`;

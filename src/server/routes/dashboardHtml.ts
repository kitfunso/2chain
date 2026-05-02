export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>2chain · Adaptive Retrieval for AI Agents</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #0b0d12;
    --panel: #11141b;
    --border: #1f242e;
    --fg: #e6e8ef;
    --muted: #7f8696;
    --green: #4ade80;
    --amber: #fbbf24;
    --red: #f87171;
    --blue: #60a5fa;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  }
  header {
    padding: 22px 32px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header .brand {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.2px;
  }
  header .brand span {
    color: var(--muted);
    font-weight: 400;
    margin-left: 8px;
  }
  header .live {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .live .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    margin-right: 6px;
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
  main {
    padding: 24px 32px;
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 18px;
    max-width: 1400px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
  }
  .card h2 {
    margin: 0 0 14px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12.5px; }
  th { text-align: left; padding: 6px 8px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: 0; }
  tr.flash { animation: flash 1s ease-out; }
  @keyframes flash { 0% { background: #1d2533 } 100% { background: transparent } }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .pill.active { color: var(--green); background: rgba(74, 222, 128, 0.12); }
  .pill.pending { color: var(--blue); background: rgba(96, 165, 250, 0.12); }
  .pill.circuit_broken { color: var(--red); background: rgba(248, 113, 113, 0.12); }
  .rel-bar {
    display: inline-block;
    width: 60px;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
  }
  .rel-bar > span { display: block; height: 100%; background: var(--green); }
  .rel-bar > span.gated { background: var(--red); }
  .name { color: var(--fg); }
  .ver { color: var(--muted); }
  .empty { color: var(--muted); padding: 12px 8px; font-style: italic; }
  .vrow .err { color: var(--red); font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
  .vrow td { vertical-align: top; }
  .case { display: inline-block; margin-right: 4px; font-family: var(--mono); font-size: 11px; }
  .case.pass { color: var(--green); }
  .case.fail { color: var(--red); }
  .ts { color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .stat { display: flex; justify-content: space-between; padding: 4px 0; font-family: var(--mono); font-size: 12px; }
  .stat span { color: var(--muted); }
  .stat strong { font-weight: 600; }
  .stat strong.ok { color: var(--green); }
  .stat strong.bad { color: var(--red); }
  .stat strong.warn { color: var(--amber); }
  footer { padding: 16px 32px; color: var(--muted); font-size: 11px; font-family: var(--mono); }
</style>
</head>
<body>
<header>
  <div class="brand">2chain<span>· Adaptive Retrieval for AI Agents</span></div>
  <div class="live"><span class="dot"></span><span id="conn">connecting…</span></div>
</header>
<main>
  <div>
    <section class="card">
      <h2>Tools registry</h2>
      <table id="tools-table">
        <thead><tr><th>Name</th><th>Ver</th><th>Status</th><th>Reliability</th><th>Last eval</th></tr></thead>
        <tbody><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
      </table>
    </section>
    <section class="card" style="margin-top:18px">
      <h2>Eval runs (most recent first)</h2>
      <table id="evals-table">
        <thead><tr><th>Tool</th><th>By</th><th>Pass</th><th>Cases</th><th>Time</th></tr></thead>
        <tbody><tr><td colspan="5" class="empty">loading…</td></tr></tbody>
      </table>
    </section>
  </div>
  <div>
    <section class="card">
      <h2>Contract violations</h2>
      <table id="violations-table">
        <thead><tr><th>Tool</th><th>Stage</th><th>Error</th></tr></thead>
        <tbody><tr><td colspan="3" class="empty">no violations</td></tr></tbody>
      </table>
    </section>
    <section class="card" style="margin-top:18px">
      <h2>Live call feed</h2>
      <div id="usage-stats">
        <div class="stat"><span>ok</span><strong id="u-ok" class="ok">0</strong></div>
        <div class="stat"><span>circuit_broken</span><strong id="u-cb" class="bad">0</strong></div>
        <div class="stat"><span>gated</span><strong id="u-gated" class="warn">0</strong></div>
        <div class="stat"><span>violation</span><strong id="u-vio" class="bad">0</strong></div>
        <div class="stat"><span>timeout</span><strong id="u-to" class="warn">0</strong></div>
      </div>
    </section>
  </div>
</main>
<footer>2chain · MongoDB Agentic Evolution Hackathon · Atlas Vector Search + Change Streams · live re-rank on every push</footer>
<script>
  const fmtTime = (d) => d ? new Date(d).toLocaleTimeString('en-GB', { hour12: false }) : '—';
  const usageCounts = { ok: 0, circuit_broken: 0, gated: 0, violation: 0, timeout: 0 };

  function renderTools(list) {
    const tbody = document.querySelector('#tools-table tbody');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">no tools</td></tr>'; return; }
    tbody.innerHTML = list.map(t => {
      const rel = t.metadata?.reliability_score ?? 0;
      const gated = rel < 0.80;
      const pct = Math.round(rel * 100);
      return \`
        <tr data-key="\${t.name}@\${t.version}">
          <td class="name">\${t.name}</td>
          <td class="ver">\${t.version}</td>
          <td><span class="pill \${t.status}">\${t.status}</span></td>
          <td>
            <span class="rel-bar"><span class="\${gated ? 'gated' : ''}" style="width:\${pct}%"></span></span>
            \${rel.toFixed(2)}
          </td>
          <td class="ts">\${fmtTime(t.metadata?.last_eval_run)}</td>
        </tr>\`;
    }).join('');
  }

  function renderViolations(list) {
    const tbody = document.querySelector('#violations-table tbody');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="3" class="empty">no violations</td></tr>'; return; }
    tbody.innerHTML = list.map(v => \`
      <tr class="vrow">
        <td>\${v.tool_name}@\${v.tool_version}</td>
        <td>\${v.stage}</td>
        <td><div class="err">\${(v.schema_errors?.[0]?.message ?? '—').replace(/</g, '&lt;')}</div></td>
      </tr>\`).join('');
  }

  function renderEvals(list) {
    const tbody = document.querySelector('#evals-table tbody');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">no eval runs</td></tr>'; return; }
    tbody.innerHTML = list.map(r => {
      const cases = (r.cases ?? []).map(c => '<span class="case ' + (c.pass ? 'pass">✓' : 'fail">✗') + '</span>').join('');
      return \`<tr>
        <td>\${r.tool_name}@\${r.tool_version}</td>
        <td class="ts">\${r.triggered_by}</td>
        <td>\${r.pass_count}/\${r.total_count}</td>
        <td>\${cases}</td>
        <td class="ts">\${fmtTime(r.triggered_at)}</td>
      </tr>\`;
    }).join('');
  }

  function flashRow(key) {
    const row = document.querySelector('tr[data-key="' + key + '"]');
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  function updateUsage() {
    document.getElementById('u-ok').textContent = usageCounts.ok;
    document.getElementById('u-cb').textContent = usageCounts.circuit_broken;
    document.getElementById('u-gated').textContent = usageCounts.gated;
    document.getElementById('u-vio').textContent = usageCounts.violation;
    document.getElementById('u-to').textContent = usageCounts.timeout;
  }

  let toolsCache = [];
  let violationsCache = [];
  let evalsCache = [];

  async function loadInitial() {
    const r = await fetch('/state');
    const s = await r.json();
    toolsCache = s.tools;
    violationsCache = s.violations;
    evalsCache = s.evalRuns;
    for (const u of (s.usageStats || [])) {
      if (u._id in usageCounts) usageCounts[u._id] = u.count;
    }
    renderTools(toolsCache);
    renderViolations(violationsCache);
    renderEvals(evalsCache);
    updateUsage();
  }

  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => { document.getElementById('conn').textContent = 'live'; };
    es.onerror = () => { document.getElementById('conn').textContent = 'reconnecting…'; };
    es.addEventListener('tool_changed', (e) => {
      const d = JSON.parse(e.data).tool;
      const key = d.name + '@' + d.version;
      const idx = toolsCache.findIndex(t => t.name === d.name && t.version === d.version);
      const merged = idx >= 0 ? { ...toolsCache[idx], status: d.status, metadata: { ...toolsCache[idx].metadata, reliability_score: d.reliability_score, last_eval_run: d.updated_at } } : { name: d.name, version: d.version, status: d.status, metadata: { reliability_score: d.reliability_score, last_eval_run: d.updated_at } };
      if (idx >= 0) toolsCache[idx] = merged; else toolsCache.push(merged);
      toolsCache.sort((a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version));
      renderTools(toolsCache);
      requestAnimationFrame(() => flashRow(key));
    });
    es.addEventListener('violation_added', (e) => {
      const d = JSON.parse(e.data);
      violationsCache.unshift(d);
      if (violationsCache.length > 20) violationsCache.length = 20;
      renderViolations(violationsCache);
    });
    es.addEventListener('eval_run_added', (e) => {
      const d = JSON.parse(e.data);
      evalsCache.unshift({ ...d, triggered_at: new Date().toISOString() });
      if (evalsCache.length > 20) evalsCache.length = 20;
      renderEvals(evalsCache);
    });
    es.addEventListener('call_logged', (e) => {
      const d = JSON.parse(e.data);
      if (d.outcome in usageCounts) usageCounts[d.outcome]++;
      updateUsage();
    });
  }

  loadInitial().then(connect);
</script>
</body>
</html>`;

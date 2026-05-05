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
    --teal:      #0d9488;
    --purple:    #7c3aed;
    --lime:      #84cc16;
    --crimson:   #9b1c2c;
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

  .tui { display: grid; grid-template-rows: auto auto 1fr auto; height: 100%; padding: 6px 8px; gap: 6px; max-width: 100vw; overflow: hidden; }

  .top { border: 2px solid var(--ink); background: var(--paper-2);
    padding: 3px 8px; display: flex; align-items: center; gap: 14px;
    min-width: 0; }
  .top > .right { flex-shrink: 0; margin-left: auto; }
  .top > .right > #x-clock { font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .top > span:not(.brand):not(.right):not(.nav) {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .top .brand { background: var(--orange); color: var(--paper); padding: 1px 10px;
    font-weight: 800; letter-spacing: 0.5px; border-right: 2px solid var(--ink);
    margin: -3px 8px -3px -8px; height: calc(100% + 6px);
    display: inline-flex; align-items: center; gap: 6px; }
  .top .brand .brand-sub { font-weight: 600; font-size: 10px; opacity: 0.85;
    letter-spacing: 0.3px; text-transform: lowercase; }
  .top .nav .item { padding: 0 6px; }
  .top .nav .active { background: var(--ink); color: var(--paper);
    padding: 1px 8px; font-weight: 700; }
  .top .right { margin-left: auto; }
  .top .pulse { color: var(--green-fg); font-weight: 700; }
  .top .pulse.disc { color: var(--red); }

  .body { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 6px; min-height: 0; min-width: 0; }
  .body > .pane:last-child { max-height: 280px; }
  .pane { border: 2px solid var(--ink); background: var(--paper);
    display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .pane.focused { box-shadow: 4px 4px 0 var(--ink); }
  .pane-head { padding: 2px 10px; border-bottom: 2px solid var(--ink);
    display: flex; align-items: center; justify-content: space-between;
    background: var(--paper-2); font-size: 12px; min-height: 22px; }
  .pane.focused .pane-head { background: var(--yellow); }
  .pane-head .lab { font-weight: 700; letter-spacing: 0.5px; }
  .pane-head .right { font-size: 10.5px; color: var(--ink-2); }
  .pane-body { padding: 8px 10px; overflow: auto; flex: 1; }

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

  .tab-strip { display: flex; align-items: center; gap: 4px;
    padding: 3px 8px; border-bottom: 2px solid var(--ink);
    background: var(--paper-2); overflow-x: auto; flex-wrap: nowrap; white-space: nowrap; }
  /* Domain strip wraps to multi-row instead of horizontal scroll. */
  #domain-tabs { flex-wrap: wrap; overflow-x: visible; row-gap: 4px; }
  .tab-strip .tab-label { font: 800 10px var(--mono); letter-spacing: 1.5px;
    color: var(--ink-2); padding-right: 8px; min-width: 60px; flex-shrink: 0;
    border-right: 2px solid var(--ink); margin-right: 6px; }
  .tab-strip .tab.src-mcp .pip { background: var(--blue); }
  .tab-strip .tab.src-fix .pip { background: var(--green); }
  .tab-strip .tab.src-cat .pip { background: var(--orange); }
  .tab-strip .tab.src-mcp.active { background: var(--blue); color: var(--paper); }
  .tab-strip .tab.src-fix.active { background: var(--green); color: var(--paper); }
  .tab-strip .tab.src-cat.active { background: var(--orange); color: var(--paper); }
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
  /* dat color now defined below near new bucket colors */
  .tab-strip .tab.com.active { background: var(--yellow); color: var(--ink); }
  .tab-strip .tab .pip { display: inline-block; width: 8px; height: 8px;
    border: 1.5px solid currentColor; vertical-align: middle; }
  .tab-strip .tab.fin .pip { background: var(--orange); }
  .tab-strip .tab.cod .pip { background: var(--blue); }
  .tab-strip .tab.res .pip { background: var(--magenta); }
  .tab-strip .tab.doc .pip { background: var(--red); }
  .tab-strip .tab.geo .pip { background: var(--green); }
  .tab-strip .tab.dat .pip { background: var(--teal); }
  .tab-strip .tab.com .pip { background: var(--yellow); }
  .tab-strip .tab.dom-ai .pip    { background: var(--purple); }
  .tab-strip .tab.dom-dev .pip   { background: var(--lime); }
  .tab-strip .tab.dom-sec .pip   { background: var(--crimson); }
  .tab-strip .tab.dom-media .pip { background: #ec4899; }
  .tab-strip .tab.dom-ai.active    { background: var(--purple);  color: var(--paper); }
  .tab-strip .tab.dom-dev.active   { background: var(--lime);    color: var(--ink); }
  .tab-strip .tab.dom-sec.active   { background: var(--crimson); color: var(--paper); }
  .tab-strip .tab.dom-media.active { background: #ec4899;        color: var(--paper); }
  .tab-strip .tab.dat.active       { background: var(--teal);    color: var(--paper); }
  .tab-strip .tab.all .pip { background: transparent; border-style: dashed; }
  .tab-strip .tab.active .pip { border-color: rgba(255,255,255,0.8); }
  /* Kind pips & tabs (tool / skill / subagent / prompt) */
  .tab-strip .tab.kt .pip { background: var(--ink); }
  .tab-strip .tab.ks .pip { background: var(--yellow); }
  .tab-strip .tab.ka .pip { background: var(--blue); }
  .tab-strip .tab.kp .pip { background: var(--magenta); }
  .tab-strip .tab.kt.active { background: var(--ink); color: var(--paper); }
  .tab-strip .tab.ks.active { background: var(--yellow); color: var(--ink); }
  .tab-strip .tab.ka.active { background: var(--blue); color: var(--paper); }
  .tab-strip .tab.kp.active { background: var(--magenta); color: var(--paper); }
  /* Kind chip in the tool name cell (compact 1-letter badge) */
  .kind-chip { display: inline-block; width: 14px; height: 14px; line-height: 14px;
    text-align: center; font: 700 9px/1 var(--mono); border-radius: 2px;
    margin-right: 6px; vertical-align: 1px; color: var(--paper); }
  .kind-chip.kt { background: var(--ink); }
  .kind-chip.ks { background: var(--yellow); color: var(--ink); }
  .kind-chip.ka { background: var(--blue); }
  .kind-chip.kp { background: var(--magenta); }
  .tab-strip .spacer { flex: 1; }
  .tab-strip .mode-hint { font: 600 10.5px/1.3 var(--mono);
    color: var(--ink-2); letter-spacing: 1px; text-transform: uppercase; padding-right: 4px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.4; }
  th { text-align: left; color: var(--ink-2); padding: 0 8px 4px; font-weight: 700;
    letter-spacing: 0.5px; border-bottom: 2px solid var(--ink);
    background: var(--paper-2); font-size: 11px; text-transform: uppercase; }
  th.num { text-align: right; }
  th.sort { cursor: pointer; user-select: none; }
  th.sort:hover { background: var(--paper-3); }
  th.sort .sort-ind { display: inline-block; margin-left: 4px; opacity: 0.6; }
  th.sort.active .sort-ind { opacity: 1; color: var(--orange); }
  th.tip { position: relative; cursor: help; border-bottom: 2px solid var(--ink); }
  th.tip::after { content: attr(data-tip); position: absolute; top: 100%; right: 0;
    background: var(--ink); color: var(--paper); padding: 6px 10px;
    font: 600 10.5px/1.4 var(--mono); letter-spacing: 0.3px; text-transform: none;
    white-space: normal; max-width: 280px; min-width: 180px; z-index: 100;
    border: 2px solid var(--ink); box-shadow: 3px 3px 0 var(--ink);
    opacity: 0; transform: translateY(-4px); pointer-events: none;
    transition: opacity 0.1s, transform 0.1s; margin-top: 4px; }
  th.tip:hover::after { opacity: 1; transform: translateY(0); }
  td { padding: 2px 8px; border-bottom: 1px solid var(--paper-3); cursor: pointer; }
  tr.t1 td { background: var(--yellow); color: var(--ink); font-weight: 700; }
  tr.t1 td.first::before { content: "▶ "; color: var(--orange); font-weight: 800; }
  tr.selected td { outline: 2px solid var(--ink); outline-offset: -2px; }
  tr.flash td { animation: flash 1s ease-out; }
  @keyframes flash { 0% { background: var(--orange); color: var(--paper); } 100% {} }
  td.num { text-align: right; }
  td .domain-tag { display: inline-block; padding: 0 5px; border: 1.5px solid var(--ink);
    font-size: 9px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; line-height: 1.4; }
  .domain-tag.fin   { background: var(--orange);  color: var(--paper); }
  .domain-tag.cod   { background: var(--blue);    color: var(--paper); }
  .domain-tag.res   { background: var(--magenta); color: var(--paper); }
  .domain-tag.doc   { background: var(--red);     color: var(--paper); }
  .domain-tag.geo   { background: var(--green);   color: var(--paper); }
  .domain-tag.dat   { background: var(--teal);    color: var(--paper); }
  .domain-tag.com   { background: var(--yellow);  color: var(--ink); }
  .domain-tag.ai    { background: var(--purple);  color: var(--paper); }
  .domain-tag.dev   { background: var(--lime);    color: var(--ink); }
  .domain-tag.sec   { background: var(--crimson); color: var(--paper); }
  .domain-tag.media { background: #ec4899;        color: var(--paper); }
  .domain-tag.unk   { background: var(--paper-3); color: var(--ink-2); }
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

  /* Help banner. Default collapsed to one slim line. Click (?) to expand. */
  .help-banner { border: 2px solid var(--ink); background: var(--yellow);
    color: var(--ink); padding: 4px 12px; font: 12.5px/1.4 var(--sans);
    box-shadow: 2px 2px 0 var(--ink); }
  .help-banner.hidden { display: none; }
  .help-banner.collapsed .body { display: none; }
  .help-banner .head { display: flex; align-items: center; gap: 12px; }
  .help-banner .head .title { font: 700 12px var(--mono);
    letter-spacing: 0.5px; text-transform: uppercase; }
  .help-banner .head .blurb { color: var(--ink-2); font-size: 12px; }
  .help-banner .body { margin-top: 6px; padding-top: 6px; border-top: 1.5px dashed var(--ink); }
  .help-banner h4 { margin: 0 0 4px; font: 800 12px/1.3 var(--mono);
    letter-spacing: 0.5px; text-transform: uppercase; }
  .help-banner p { margin: 2px 0; font-size: 12.5px; }
  .help-banner .glossary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 2px 16px; margin-top: 4px; font-size: 11.5px; }
  .help-banner .g-term { font: 700 11px var(--mono); display: inline; }
  .help-banner .dismiss, .help-banner .toggle-body { font: 700 10px var(--mono);
    border: 1.5px solid var(--ink); background: var(--paper); padding: 0 6px;
    cursor: pointer; box-shadow: 1.5px 1.5px 0 var(--ink); margin-left: auto; }
  .help-banner .dismiss:hover, .help-banner .toggle-body:hover { background: var(--paper-3); }
  .top .help-link { cursor: pointer; text-decoration: underline; color: var(--blue);
    font-weight: 700; }
  .top .help-link:hover { color: var(--orange); }

  /* Show help cursor only on inline-text things explaining their abbreviation,
     not on every interactive element. Buttons/tabs/cells get their own cursor. */
  .tab-strip .tab-label { cursor: help; }

  /* Search bar above the ranking table. */
  .search-bar { display: flex; gap: 4px; padding: 4px 8px; border-bottom: 2px solid var(--ink);
    background: var(--paper-3); align-items: center; }
  .search-bar input { flex: 1; min-width: 100px; border: 2px solid var(--ink); padding: 3px 8px;
    font: 13px var(--mono); background: var(--paper); color: var(--ink);
    box-shadow: inset 1px 1px 0 rgba(0,0,0,0.05); }
  .search-bar input:focus { outline: none; background: var(--paper-2); }
  .search-bar button { border: 2px solid var(--ink); background: var(--orange);
    color: var(--paper); font: 700 11.5px var(--mono); letter-spacing: 0.5px;
    text-transform: uppercase; padding: 4px 14px; cursor: pointer;
    box-shadow: 2px 2px 0 var(--ink); }
  .search-bar button:hover { transform: translate(1px, 1px); box-shadow: 1px 1px 0 var(--ink); }
  .search-bar button.clear { background: var(--paper); color: var(--ink); padding: 4px 10px; font-size: 14px; }
  .search-bar button#q-trending { background: var(--yellow); color: var(--ink); padding: 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
  .search-bar .hint { font: 11px var(--mono); color: var(--muted); padding-left: 4px; }

  /* === Responsive overrides moved to end of stylesheet ===
   * See the @media blocks at the bottom (just before the close style tag).
   * MUST stay last: equal-specificity mobile rules are silently
   * clobbered by any default rule defined below them.
   * NEW DEFAULT RULES GO ABOVE THIS COMMENT, NOT BELOW THE @media. */

  /* ===== mobile shell ============================================ */
  /* Hidden on desktop, shown only inside @media (max-width: 768px). */
  .mobile-shell { display: none; flex-direction: column; flex: 1;
    min-height: 0; min-width: 0; gap: 0; }
  .mobile-header { position: sticky; top: 0; z-index: 5;
    background: var(--paper); border: 2px solid var(--ink);
    box-shadow: 2px 2px 0 var(--ink); padding: 8px 8px 6px;
    display: flex; flex-direction: column; gap: 6px; }
  .mobile-search-row { display: flex; align-items: stretch; gap: 6px;
    border: 2px solid var(--ink); background: var(--paper); padding: 0; }
  .mobile-search-row input { flex: 1; min-width: 0; border: 0;
    padding: 8px 10px; font: 16px var(--mono); background: transparent;
    color: var(--ink); outline: none; }
  .mobile-search-row input::placeholder { color: var(--muted); }
  .mobile-search-row .m-icon-btn { border: 0; border-left: 2px solid var(--ink);
    background: var(--paper); cursor: pointer; padding: 0 14px;
    font: 700 16px var(--mono); color: var(--ink); }
  .mobile-action-row { display: flex; gap: 6px; }
  .m-btn { flex: 1; border: 2px solid var(--ink); background: var(--paper);
    font: 700 12px var(--mono); letter-spacing: 0.5px; text-transform: uppercase;
    padding: 9px 10px; cursor: pointer; color: var(--ink);
    box-shadow: 2px 2px 0 var(--ink); transition: transform 0.05s, box-shadow 0.05s; }
  .m-btn:active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--ink); }
  .m-btn-filter { background: var(--ink); color: var(--paper); }
  .m-btn-trending { background: var(--yellow); color: var(--ink); }
  .m-btn-primary { background: var(--orange); color: var(--paper); flex: 2; }
  .m-fc { display: none; padding: 0 6px; margin-left: 4px; background: var(--orange);
    color: var(--paper); border-radius: 999px; font-size: 11px; }
  .m-fc.active { display: inline-block; }

  .mobile-results { flex: 1; overflow-y: auto; list-style: none; padding: 8px;
    margin: 0; display: flex; flex-direction: column; gap: 6px;
    -webkit-overflow-scrolling: touch; }
  .m-card { border: 2px solid var(--ink); background: var(--paper);
    box-shadow: 2px 2px 0 var(--ink); padding: 10px 12px; cursor: pointer;
    display: flex; flex-direction: column; gap: 6px;
    transition: transform 0.05s, box-shadow 0.05s; }
  .m-card:active { transform: translate(2px, 2px); box-shadow: 0 0 0 var(--ink); }
  .m-card-name { font: 700 14px var(--mono); color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m-card-blurb { font: 12px/1.4 var(--mono); color: var(--ink-2);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; }
  .m-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font: 11px var(--mono); }
  .m-card-meta .domain-tag { font-size: 10px; padding: 1px 6px; }
  .m-kind { color: var(--muted); text-transform: lowercase; }
  .m-callable { background: var(--green); color: var(--paper); padding: 1px 6px;
    font: 700 10px var(--mono); letter-spacing: 0.5px; }
  .m-rel { display: inline-flex; align-items: center; gap: 4px;
    color: var(--ink-2); margin-left: auto; }
  .m-bar { display: inline-block; width: 40px; height: 6px;
    border: 1px solid var(--ink); background: var(--paper-3); position: relative; }
  .m-bar i { display: block; height: 100%; background: var(--green-fg); }
  .m-empty { padding: 20px; text-align: center; color: var(--muted);
    font: 12px var(--mono); list-style: none; }

  /* ----- bottom sheet ----- */
  .mobile-sheet { display: none; position: fixed; inset: 0; z-index: 100; }
  .mobile-sheet[aria-hidden="false"] { display: block; }
  .mobile-sheet-backdrop { position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.4); }
  .mobile-sheet-panel { position: absolute; left: 0; right: 0; bottom: 0;
    max-height: 80vh; background: var(--paper); border-top: 3px solid var(--ink);
    box-shadow: 0 -6px 0 rgba(0, 0, 0, 0.1);
    display: flex; flex-direction: column; }
  .mobile-sheet-head { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 2px solid var(--ink); background: var(--paper-2); }
  .mobile-sheet-head h2 { margin: 0; font: 800 14px var(--mono);
    letter-spacing: 1px; text-transform: uppercase; }
  .mobile-sheet-head .m-icon-btn { border: 2px solid var(--ink); background: var(--paper);
    width: 32px; height: 32px; padding: 0; font: 700 18px var(--mono); cursor: pointer; }
  .mobile-sheet-body { padding: 12px 16px; overflow-y: auto; flex: 1;
    -webkit-overflow-scrolling: touch; }
  .m-fgroup { margin-bottom: 16px; }
  .m-fgroup h3 { margin: 0 0 6px; font: 700 11px var(--mono);
    letter-spacing: 1.5px; text-transform: uppercase; color: var(--ink-2); }
  .m-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .m-chip { border: 2px solid var(--ink); background: var(--paper);
    font: 700 12px var(--mono); padding: 5px 10px; cursor: pointer;
    color: var(--ink); display: inline-flex; align-items: center; gap: 4px;
    box-shadow: 1px 1px 0 var(--ink); }
  .m-chip:active { transform: translate(1px, 1px); box-shadow: 0 0 0 var(--ink); }
  .m-chip.active { background: var(--ink); color: var(--paper);
    box-shadow: 0 0 0 var(--ink); transform: translate(1px, 1px); }
  .m-chip .pip { display: inline-block; width: 8px; height: 8px;
    border: 1px solid currentColor; }
  .mobile-sheet-foot { display: flex; gap: 8px; padding: 12px 16px;
    border-top: 2px solid var(--ink); background: var(--paper-2); }

  /* ----- detail overlay ----- */
  .mobile-detail { display: none; position: fixed; inset: 0; z-index: 110;
    background: var(--paper); flex-direction: column; }
  .mobile-detail[aria-hidden="false"] { display: flex; }
  .mobile-detail-head { display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-bottom: 2px solid var(--ink);
    background: var(--paper-2); position: sticky; top: 0; z-index: 1; }
  .mobile-detail-head .m-icon-btn { border: 2px solid var(--ink);
    background: var(--paper); width: 36px; height: 36px; padding: 0;
    font: 700 18px var(--mono); cursor: pointer; flex-shrink: 0; }
  .m-detail-name { font: 700 13px var(--mono); color: var(--ink);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0; }
  .mobile-detail-body { flex: 1; overflow-y: auto; padding: 14px 14px 32px;
    -webkit-overflow-scrolling: touch; }
  .m-detail-meta { display: flex; gap: 8px; flex-wrap: wrap;
    margin-bottom: 12px; align-items: center; font: 11px var(--mono); }
  .m-detail-blurb { font: 13px/1.5 var(--mono); color: var(--ink-2);
    margin: 0 0 18px; }
  .m-detail-kv { display: grid; grid-template-columns: 110px 1fr;
    gap: 6px 10px; margin: 0; font: 12px var(--mono); }
  .m-detail-kv dt { color: var(--ink-2); margin: 0; }
  .m-detail-kv dd { margin: 0; color: var(--ink); word-break: break-word;
    display: flex; align-items: center; gap: 6px; }
  .m-detail-kv dd.green { color: var(--green-fg); font-weight: 700; }
  .m-detail-kv dd.red { color: var(--red); font-weight: 700; }

  /* =========================================================================
   * RESPONSIVE OVERRIDES — KEEP AS THE LAST RULES IN THE STYLESHEET.
   *
   * Why: equal-specificity selectors resolve by source order. Anything
   * defined BELOW these @media blocks will silently override mobile rules
   * even though the @media still "matches". This file has burned us 3
   * times — every new addition must go ABOVE this section, never below.
   * ========================================================================= */

  /* Below 1100px (tablet / split-screen): drop the storage/embed labels so
     the clock and help link stay on-screen. */
  @media (max-width: 1100px) {
    .top > span:not(.brand):not(.right):not(.nav) { display: none; }
  }

  /* Phone (<= 768px): replace the desktop dashboard frame with the mobile
     shell. .body / .status / .help-banner all hide; .mobile-shell takes
     over and fills the viewport. */
  @media (max-width: 768px) {
    html, body { font-size: 13px; }

    /* Root container: switch from grid to flex-column so flex:1 children
       (the mobile shell) actually claim remaining vertical space. The
       desktop grid template only had 4 explicit rows — extra children
       collapsed to 0. */
    .tui { padding: 0; gap: 0; display: flex; flex-direction: column;
      height: 100vh; max-height: 100vh; }

    /* Top bar */
    .top { padding: 2px 6px; gap: 6px; flex-wrap: wrap; }
    .top .brand { padding: 1px 6px; font-size: 11px; margin: -2px 4px -2px -6px; }
    .top .nav { display: none; }
    .top > span:not(.brand):not(.right):not(.compact-stats) { display: none; }
    .top .right { font-size: 10px; gap: 4px; flex-shrink: 0; }
    .top .right > #x-conn { display: none; }
    .top .help-link { font-size: 11px; }

    /* Hide the desktop dashboard frame; mobile shell takes over. */
    .body { display: none !important; }
    .status { display: none !important; }
    .help-banner { display: none !important; }
    .mobile-shell { display: flex; }
  }

</style>
</head>
<body>
<div class="tui">

  <div class="top">
    <span class="brand" title="2chain (tool-chain): AI tool registry. Search, rank, and validate tools agents can call.">2CHAIN <span class="brand-sub">(tool-chain)</span></span>
    <span title="Backend storage driver and embedding model. Both swappable via env vars."><span class="muted">storage:</span> <span class="bright" id="x-driver">…</span> <span class="muted">embed:</span> <span class="bright" id="x-embed">…</span></span>
    <span class="muted">·</span>
    <span class="muted compact-stats"><span id="x-tools" title="Total tools in the registry">…</span> tools · <span id="x-mcp" title="Tools sourced from MCP servers (Model Context Protocol)">…</span> mcp · <span class="red"><span id="x-vio" title="Contract violations: tools whose output failed JSON Schema validation in the last call">0</span> violations</span></span>
    <span class="right">
      <span class="help-link" id="help-toggle" title="Toggle the plain-English help banner">(?) help</span>
      <span class="muted">·</span>
      <span class="pulse" id="x-pulse" title="Server status: green = connected, red = offline">●</span> <span id="x-conn">connecting…</span> <span class="muted" id="x-clock"></span>
    </span>
  </div>

  <div class="help-banner collapsed" id="help-banner">
    <div class="head">
      <span class="title">2chain</span>
      <span class="blurb">A search engine for AI tools. Type a query above. Click any name to open its source repo.</span>
      <button class="toggle-body" id="help-expand" title="Show the glossary">show glossary</button>
      <button class="dismiss" id="help-dismiss" title="Hide this banner. (?) help in the top bar brings it back.">x</button>
    </div>
    <div class="body">
      <div class="glossary">
        <div><span class="g-term">KIND</span>: tool, skill, subagent, prompt</div>
        <div><span class="g-term">DOMAIN</span>: finance, code, research, docs, geo, data, comms</div>
        <div><span class="g-term">RRF</span>: combined search score. Higher = better match.</div>
        <div><span class="g-term">REL</span>: reliability 0-1. Below 0.80 = gated out.</div>
        <div><span class="g-term">VEC</span>: semantic similarity (cosine).</div>
        <div><span class="g-term">P95</span>: 95th-percentile response time (ms).</div>
      </div>
    </div>
  </div>

  <div class="body">

    <div class="pane focused">
      <div class="pane-head">
        <span><span class="lab" title="Hybrid retrieval ranking: top tools matching your search, or filtered browse view if no query.">2 RANKING</span> <span class="muted" id="x-query">— (type a query in the search bar to rank by relevance)</span></span>
        <span class="right"><span class="muted" title="Ranking method: Reciprocal Rank Fusion of vector and lexical results, 50/50 weight, with reliability >= 0.80 enforced inside the SQL query.">RRF · vec0.5 / txt0.5 · gate 0.80 · </span><span class="green bright" id="x-latency" title="Total time to run the last query, including embedding the query and SQL execution.">—</span></span>
      </div>
      <div class="search-bar">
        <input id="q-input" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search the registry. e.g. 'extract tables from a pdf', 'send a slack message', 'fetch arxiv papers'" />
        <button id="q-go" title="Run the query">Search</button>
        <button id="q-trending" class="clear" title="Show top tools by /discover hits in the last 7 days">📈 trending</button>
        <button id="q-clear" class="clear" title="Clear search and go back to browse mode">x</button>
        <span class="hint" id="q-hint">Press Enter</span>
      </div>
      <div class="tab-strip" id="source-tabs" title="Click a tab to filter rows by source">
        <span class="tab-label" title="Where the entry comes from">SOURCE</span>
        <button class="tab all active" data-source=""><span class="pip"></span>ALL <span class="ct" id="st-all">· 0</span></button>
        <button class="tab src-mcp" data-source="mcp" title="MCP server bridges (calls forwarded to a remote MCP server)"><span class="pip"></span>MCP <span class="ct" id="n-mcp">· 0</span></button>
        <button class="tab src-fix" data-source="fixture" title="First-party callable stubs (e.g. prompt-template-stub, arxiv-search, sec-edgar)"><span class="pip"></span>CALLABLE <span class="ct" id="n-fix">· 0</span></button>
        <button class="tab src-cat" data-source="catalog" title="Catalog-only specs (discovery, no callable stub yet)"><span class="pip"></span>CATALOG <span class="ct" id="n-cat">· 0</span></button>
      </div>
      <div class="tab-strip" id="kind-tabs" title="Click a tab to filter rows by kind">
        <span class="tab-label" title="Type of unit: tool/skill/subagent/prompt">KIND</span>
        <button class="tab all active" data-kind=""><span class="pip"></span>ALL <span class="ct" id="kt-all">· 0</span></button>
        <button class="tab kt" data-kind="tool" title="Tool: callable. Has input/output JSON Schema and an HTTP stub."><span class="pip"></span>TOOL <span class="ct" id="kt-tool">· 0</span></button>
        <button class="tab ks" data-kind="skill" title="Claude Code skill. Discovery only."><span class="pip"></span>SKILL <span class="ct" id="kt-skill">· 0</span></button>
        <button class="tab ka" data-kind="subagent" title="Specialist agent profile. Discovery only."><span class="pip"></span>AGENT <span class="ct" id="kt-subagent">· 0</span></button>
        <button class="tab kp" data-kind="prompt" title="Parameterized prompt template. Callable."><span class="pip"></span>PROMPT <span class="ct" id="kt-prompt">· 0</span></button>
      </div>
      <div class="tab-strip" id="domain-tabs" title="Click a tab to filter rows by subject area">
        <span class="tab-label" title="Subject area">DOMAIN</span>
        <button class="tab all active" data-domain="" title="Show all domains"><span class="pip"></span>All <span class="ct" id="dt-all">· 0</span></button>
        <button class="tab fin" data-domain="finance" title="Finance: SEC EDGAR, prices, accounting, payments, Stripe, crypto exchanges"><span class="pip"></span>Finance <span class="ct" id="dt-finance">· 0</span></button>
        <button class="tab cod" data-domain="code" title="Code: GitHub, GitLab, code review, linters, sandboxes, SDKs"><span class="pip"></span>Code <span class="ct" id="dt-code">· 0</span></button>
        <button class="tab res" data-domain="research" title="Research: arxiv, PubMed, Semantic Scholar, Wikipedia, academic search"><span class="pip"></span>Research <span class="ct" id="dt-research">· 0</span></button>
        <button class="tab doc" data-domain="docs" title="Docs: PDF / Word / Excel extraction, OCR, document Q&A, Notion, Confluence"><span class="pip"></span>Docs <span class="ct" id="dt-docs">· 0</span></button>
        <button class="tab geo" data-domain="geo" title="Geo: maps, geocoding, OpenStreetMap, weather, navigation, timezones"><span class="pip"></span>Geo <span class="ct" id="dt-geo">· 0</span></button>
        <button class="tab dat" data-domain="data" title="Data: vector DBs, SQL, ETL, scrapers, dataframes, BigQuery, Snowflake"><span class="pip"></span>Data <span class="ct" id="dt-data">· 0</span></button>
        <button class="tab com" data-domain="comms" title="Communications: Slack, Discord, email, Twilio, calendar, Teams, Zoom"><span class="pip"></span>Comms <span class="ct" id="dt-comms">· 0</span></button>
        <button class="tab dom-ai" data-domain="ai" title="AI / ML: LLMs, agents, RAG, embeddings, vector search, fine-tuning"><span class="pip"></span>AI <span class="ct" id="dt-ai">· 0</span></button>
        <button class="tab dom-dev" data-domain="devops" title="DevOps: CI/CD, Docker, Kubernetes, Terraform, monitoring, deployment"><span class="pip"></span>DevOps <span class="ct" id="dt-devops">· 0</span></button>
        <button class="tab dom-sec" data-domain="security" title="Security: auth, OAuth, encryption, vuln scanning, audits, secrets management"><span class="pip"></span>Security <span class="ct" id="dt-security">· 0</span></button>
        <button class="tab dom-media" data-domain="media" title="Media: image / audio / video, generation, editing, OCR, transcription"><span class="pip"></span>Media <span class="ct" id="dt-media">· 0</span></button>
      </div>
      <div class="pane-body">
        <table id="rank-table">
          <thead>
            <tr>
              <th title="Rank: position in the result list. Top 1 is the best match.">#</th>
              <th title="Tool name. Click to open the source repo or homepage in a new tab.">tool</th>
              <th title="Version of this tool spec">ver</th>
              <th title="Subject area">domain</th>
              <th class="num tip" data-tip="RRF (Reciprocal Rank Fusion): combined search score that fuses semantic + keyword rankings 50/50. Higher = better match. Only set when you ran a query.">rrf</th>
              <th class="num tip" data-tip="REL (reliability): rolling pass-rate from continuous rubric evals, 0-1. Tools below 0.80 are auto-gated out of /discover results.">rel</th>
              <th class="num tip" data-tip="VEC (vector similarity): cosine similarity between query embedding and tool embedding, 0-1. Only set during a search.">vec</th>
              <th class="num tip" data-tip="P95 latency: 95th percentile call duration in milliseconds. The slowest 5% of calls take longer than this.">p95</th>
              <th class="num tip sort" id="sort-gh" data-tip="GH: GitHub stars · days since last commit. Updated weekly from api.github.com. Click to sort by stars (browse mode only).">gh<span class="sort-ind" id="sort-gh-ind"></span></th>
            </tr>
          </thead>
          <tbody><tr><td colspan="9" class="empty">loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="pane">
      <div class="pane-head"><span class="lab" title="Top: details on the selected tool. Bottom: live feed of /discover, /call, /push, eval, and violation events as they happen.">3 DETAIL & FEED</span> <span class="right" id="x-feed-count">0 events</span></div>
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

  <!-- ===========================================================
       Mobile shell — hidden on desktop via CSS. Reuses the same JS
       state machine as the desktop layout. Filters live in a bottom
       sheet, results render as cards, detail opens as a full-screen
       push. The desktop frame above stays in the DOM but is hidden
       on phones.
       =========================================================== -->
  <section class="mobile-shell" id="mobile-shell">
    <header class="mobile-header">
      <div class="mobile-search-row">
        <input id="m-q-input" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search the registry" />
        <button class="m-icon-btn" id="m-q-clear" aria-label="Clear search" type="button">x</button>
      </div>
      <div class="mobile-action-row">
        <button class="m-btn m-btn-filter" id="m-filter-open" type="button">
          Filter <span class="m-fc" id="m-filter-count"></span>
        </button>
        <button class="m-btn m-btn-trending" id="m-q-trending-mobile" type="button">Trending</button>
      </div>
    </header>
    <ul class="mobile-results" id="mobile-results">
      <li class="m-empty">loading...</li>
    </ul>
  </section>

  <!-- Filter bottom sheet -->
  <aside class="mobile-sheet" id="m-filter-sheet" aria-hidden="true">
    <div class="mobile-sheet-backdrop" data-close></div>
    <div class="mobile-sheet-panel">
      <header class="mobile-sheet-head">
        <h2>Filter</h2>
        <button class="m-icon-btn" data-close aria-label="Close">x</button>
      </header>
      <div class="mobile-sheet-body">
        <div class="m-fgroup">
          <h3>Source</h3>
          <div class="m-chips" id="m-source-tabs"></div>
        </div>
        <div class="m-fgroup">
          <h3>Kind</h3>
          <div class="m-chips" id="m-kind-tabs"></div>
        </div>
        <div class="m-fgroup">
          <h3>Domain</h3>
          <div class="m-chips" id="m-domain-tabs"></div>
        </div>
      </div>
      <footer class="mobile-sheet-foot">
        <button class="m-btn" id="m-filter-clear" type="button">Clear</button>
        <button class="m-btn m-btn-primary" id="m-filter-apply" type="button">Done</button>
      </footer>
    </div>
  </aside>

  <!-- Detail full-screen overlay -->
  <aside class="mobile-detail" id="m-detail" aria-hidden="true">
    <header class="mobile-detail-head">
      <button class="m-icon-btn" id="m-detail-back" type="button" aria-label="Back">&larr;</button>
      <span class="m-detail-name" id="m-detail-name"></span>
    </header>
    <div class="mobile-detail-body" id="m-detail-body"></div>
  </aside>

  <div class="status" title="Keyboard shortcuts (vim-style). Most are placeholders pending wire-up; the (?) help link in the top bar is the working entry point.">
    <span class="keypair" title="/  open search (placeholder)"><span class="key g">/</span><span class="muted">search</span></span>
    <span class="keypair" title="Enter: call selected tool (placeholder)"><span class="key">⏎</span><span class="muted">call</span></span>
    <span class="keypair" title="j/k: move selection up/down (placeholder)"><span class="key">j/k</span><span class="muted">move</span></span>
    <span class="keypair" title="Tab: cycle focused pane (placeholder)"><span class="key m">tab</span><span class="muted">pane</span></span>
    <span class="keypair" title="1-9: jump to domain tab (placeholder)"><span class="key o">1-9</span><span class="muted">domain</span></span>
    <span class="keypair" title="d: open /discover (placeholder)"><span class="key b">d</span><span class="muted">discover</span></span>
    <span class="keypair" title="p: open /push form (placeholder)"><span class="key o">p</span><span class="muted">push</span></span>
    <span class="keypair" title="e: re-run eval on selected tool (placeholder)"><span class="key y">e</span><span class="muted">eval</span></span>
    <span class="keypair" title="!: simulate circuit-breaker (placeholder)"><span class="key r">!</span><span class="muted">cb</span></span>
    <span class="keypair" title="?: toggle help banner. Click (?) help in the top bar to use this now."><span class="key">?</span><span class="muted">help</span></span>
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
  const DOMAINS = ['finance','code','research','docs','geo','data','comms','ai','devops','security','media'];
  const DOMAIN_TAG = {
    finance: 'fin', code: 'cod', research: 'res',
    docs: 'doc', geo: 'geo', data: 'dat', comms: 'com',
    ai: 'ai', devops: 'dev', security: 'sec', media: 'media',
  };
  function tagFor(d) { return DOMAIN_TAG[d] || 'unk'; }
  function tagLabel(d) { const m = tagFor(d); return m === 'unk' ? '—' : m.toUpperCase(); }

  const state = {
    tools: [],
    violations: [],
    evals: [],
    activeDomain: '',
    activeKind: '',
    activeSource: '',
    fuzzyQuery: '',       // live client-side substring filter
    selected: null,
    lastDiscover: null,
    feed: [],
    sortBy: '',           // '' = name (default), 'gh' = github stars desc
    violationsCount: 0,
  };
  function sourceBucket(t) {
    const s = t.endpoint_stub_name || '';
    if (s === 'mcp-bridge') return 'mcp';
    if (s === 'catalog-only-stub') return 'catalog';
    return 'fixture';
  }

  // ---- /atlas-stats : storage driver + collection counts -------------------
  function setText(sel, val) {
    const el = document.querySelector(sel);
    if (el) el.textContent = val;
  }
  async function loadStats() {
    try {
      const r = await fetch('/atlas-stats');
      if (!r.ok) throw new Error('atlas-stats ' + r.status);
      const s = await r.json();
      const driver = (s.mongo?.modules || ['unknown'])[0];
      setText('#x-driver', driver === 'sqlite' ? 'sqlite-vec' : driver);
      const counts = s.collection_doc_counts || {};
      setText('#x-tools', fmt.num(counts.tools));
      // Cold-start race: if SSE has already pushed in-flight increments before
      // /atlas-stats resolved, do NOT clobber. Use server count as the floor
      // (it already includes events the SSE delivered) — keep the higher value.
      const serverViol = counts.violations ?? 0;
      state.violationsCount = Math.max(serverViol, state.violationsCount || 0);
      setText('#x-vio', fmt.num(state.violationsCount));
      // #x-mcp is computed client-side from state.tools by computeSourceCounts;
      // do NOT write a '?' placeholder here or it flashes every 15s when this
      // interval fires. Same reason we skipped writing to #n-tools (removed).
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
      recomputeAllCounts();
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

  // Faceted counts: each dimension's counts respect the OTHER active filters
  // (and the fuzzy query), but ignore its own filter so users can see what's
  // available in each bucket of THIS dimension under the current context.
  function passesAllExcept(t, except) {
    if (except !== 'source' && state.activeSource && sourceBucket(t) !== state.activeSource) return false;
    if (except !== 'kind' && state.activeKind && (t.tool_kind || 'tool') !== state.activeKind) return false;
    if (except !== 'domain' && state.activeDomain && (t.domain || '').toLowerCase() !== state.activeDomain) return false;
    if (state.fuzzyQuery) {
      const q = state.fuzzyQuery;
      if (!(t.name || '').toLowerCase().includes(q) && !(t.capability_text || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }

  // Single-pass facet counts. Each dimension's count ignores its OWN active
  // filter (so users see what's available in each bucket of the dimension
  // they're choosing from) but respects the OTHER dimensions + fuzzy.
  // Replaces three separate iterations over state.tools.
  function recomputeAllCounts() {
    const src = { mcp: 0, fix: 0, cat: 0, total: 0 };
    const dom = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
    let domTotal = 0;
    const kind = { tool: 0, skill: 0, subagent: 0, prompt: 0, total: 0 };
    let totalMcp = 0;
    const aSrc  = state.activeSource;
    const aKind = state.activeKind;
    const aDom  = state.activeDomain;
    const fz    = state.fuzzyQuery;

    for (const t of state.tools) {
      const sb = sourceBucket(t);
      const tk = t.tool_kind || 'tool';
      const td = (t.domain || '').toLowerCase();
      if (sb === 'mcp') totalMcp++;

      const passSrc  = !aSrc  || sb === aSrc;
      const passKind = !aKind || tk === aKind;
      const passDom  = !aDom  || td === aDom;
      const passFz   = !fz || (t.name || '').toLowerCase().includes(fz)
                            || (t.capability_text || '').toLowerCase().includes(fz);

      // Source dim ignores aSrc.
      if (passKind && passDom && passFz) {
        src.total++;
        if (t.endpoint_stub_name === 'mcp-bridge') src.mcp++;
        else if (t.endpoint_stub_name === 'catalog-only-stub') src.cat++;
        else src.fix++;
      }
      // Kind dim ignores aKind.
      if (passSrc && passDom && passFz) {
        kind.total++;
        if (tk in kind) kind[tk]++;
      }
      // Domain dim ignores aDom.
      if (passSrc && passKind && passFz) {
        domTotal++;
        if (td in dom) dom[td]++;
      }
    }

    setText('#n-mcp', '· ' + fmt.num(src.mcp));
    setText('#n-fix', '· ' + fmt.num(src.fix));
    setText('#n-cat', '· ' + fmt.num(src.cat));
    setText('#st-all', '· ' + fmt.num(src.total));
    setText('#x-mcp', fmt.num(totalMcp));
    $('#kt-tool').textContent     = '· ' + fmt.num(kind.tool);
    $('#kt-skill').textContent    = '· ' + fmt.num(kind.skill);
    $('#kt-subagent').textContent = '· ' + fmt.num(kind.subagent);
    $('#kt-prompt').textContent   = '· ' + fmt.num(kind.prompt);
    $('#kt-all').textContent      = '· ' + fmt.num(kind.total);
    for (const d of DOMAINS) {
      const ct = $('#dt-' + d); if (ct) ct.textContent = '· ' + fmt.num(dom[d]);
    }
    $('#dt-all').textContent = '· ' + fmt.num(domTotal);
  }
  // (Aliases for the old per-dimension functions removed — call sites now
  // call recomputeAllCounts() directly. Old triple-call did 3x identical work.)

  function kindAbbr(k) {
    return k === 'skill' ? 'S' : k === 'subagent' ? 'A' : k === 'prompt' ? 'P' : 'T';
  }
  function kindClass(k) {
    return k === 'skill' ? 'ks' : k === 'subagent' ? 'ka' : k === 'prompt' ? 'kp' : 'kt';
  }

  // Hoisted regex constants — avoid rebuilding on every row render.
  // Earlier code used new RegExp(string-form) with template-literal escapes
  // that double-escaped the backslashes, silently breaking the Source: match.
  // Regex literals don't suffer from template-literal escape rules.
  const RE_SOURCE  = /Source:\\s*(https?:\\/\\/[^\\s)\\]]+)/i;
  const RE_ANY_URL = /https?:\\/\\/[^\\s)\\]"]+/;
  const RE_TRAIL   = /[.,;]+$/;
  const RE_NPM     = /^npm:/i;

  // Pull the canonical source URL out of a tool's capability_text. All scrapers
  // emit "Source: <url>" so we look for that first; real-corpus entries have
  // the URL inline in the description text.
  function sourceUrlOf(t) {
    if (!t) return null;
    const text = t.capability_text || '';
    const mSrc = text.match(RE_SOURCE);
    if (mSrc) return mSrc[1].replace(RE_TRAIL, '');
    const mAny = text.match(RE_ANY_URL);
    if (mAny) return mAny[0].replace(RE_TRAIL, '');
    if (t.author_agent_id === 'npm-scrape' || RE_NPM.test(t.author_agent_id || '')) {
      return 'https://www.npmjs.com/package/' + t.name;
    }
    if ((t.name || '').startsWith('py:')) {
      return 'https://pypi.org/project/' + t.name.slice(3) + '/';
    }
    if ((t.name || '').startsWith('hf:')) {
      return 'https://huggingface.co/' + t.name.slice(3).replace(/-/g, '/');
    }
    // No reliable URL found. Return null so the name renders without a link
    // rather than sending users to a 404 or a noisy GitHub search.
    return null;
  }
  function findTool(name, version) {
    return state.tools.find((t) => t.name === name && t.version === version);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  }
  function nameCellHtml(name, version, kind, url) {
    const chip = '<span class="kind-chip ' + kindClass(kind) + '" title="' + kind + '">' + kindAbbr(kind) + '</span>';
    const safeName = escapeHtml(name);
    if (url) {
      return chip + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" '
        + 'onclick="event.stopPropagation()" title="Open source: ' + escapeHtml(url) + '">'
        + safeName + '</a>';
    }
    return chip + safeName;
  }

  // ---- ranking table -------------------------------------------------------
  function renderTable() {
    const tbody = $('#rank-table tbody');
    let rows;
    if (state.lastDiscover && state.lastDiscover.results.length) {
      // /discover mode — show ranked candidates (kind/domain filters apply post-RRF)
      rows = state.lastDiscover.results.map((r, i) => {
        const tool = state.tools.find((t) => t.name === r.name);
        return {
          rank: i + 1,
          name: r.name, version: r.version,
          domain: (tool?.domain) || 'unk',
          kind: r.tool_kind || tool?.tool_kind || 'tool',
          rrf: r.rrf_score ?? r.rank_score ?? 0,
          rel: r.reliability_score ?? 0,
          vec: r.vec_score ?? 0,
          p95: tool?.metadata?.p95_latency_ms ?? 0,
          top1: i === 0,
        };
      });
      if (state.activeKind) rows = rows.filter((r) => r.kind === state.activeKind);
      if (state.activeDomain) rows = rows.filter((r) => (r.domain || '').toLowerCase() === state.activeDomain);
      // re-rank visible rows so the # column stays sequential after filtering
      rows = rows.map((r, i) => ({ ...r, rank: i + 1, top1: i === 0 && rows.length > 0 }));
    } else {
      // browse mode — alphabetical, filtered by kind + domain + source
      let pool = state.tools;
      if (state.activeKind) pool = pool.filter((t) => (t.tool_kind || 'tool') === state.activeKind);
      if (state.activeDomain) pool = pool.filter((t) => (t.domain || '').toLowerCase() === state.activeDomain);
      if (state.activeSource) pool = pool.filter((t) => sourceBucket(t) === state.activeSource);
      if (state.fuzzyQuery) {
        const q = state.fuzzyQuery;
        pool = pool.filter((t) => (t.name || '').toLowerCase().includes(q)
          || (t.capability_text || '').toLowerCase().includes(q));
      }
      const sorter = state.sortBy === 'gh'
        ? (a, b) => (b.metadata?.github_stars ?? -1) - (a.metadata?.github_stars ?? -1)
        : (a, b) => a.name.localeCompare(b.name);
      rows = pool
        .slice()
        .sort(sorter)
        .slice(0, 50)
        .map((t, i) => ({
          rank: i + 1, name: t.name, version: t.version,
          domain: (t.domain || 'unk').toLowerCase(),
          kind: t.tool_kind || 'tool',
          rrf: 0, rel: t.metadata?.reliability_score ?? 0,
          vec: 0, p95: t.metadata?.p95_latency_ms ?? 0, top1: false,
        }));
    }
    if (!rows.length) {
      const parts = [];
      if (state.activeSource) parts.push('source=' + state.activeSource);
      if (state.activeKind) parts.push('kind=' + state.activeKind);
      if (state.activeDomain) parts.push('domain=' + state.activeDomain);
      if (state.fuzzyQuery) parts.push('fuzzy="' + state.fuzzyQuery + '"');
      const filterDesc = parts.length ? parts.join(' ∩ ') : 'this filter';
      tbody.innerHTML = '<tr><td colspan="9" class="empty">no tools match ' + filterDesc + '. Try widening one of the filters.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const tag = tagFor(r.domain);
      const sel = state.selected && state.selected.name === r.name && state.selected.version === r.version
        ? ' selected' : '';
      const tool = findTool(r.name, r.version);
      const url = sourceUrlOf(tool);
      const stars = tool?.metadata?.github_stars;
      const lastCommit = tool?.metadata?.github_last_commit_at;
      let ghCell = '—';
      if (typeof stars === 'number') {
        const starStr = stars >= 1000 ? (stars / 1000).toFixed(1) + 'k' : String(stars);
        let ageStr = '';
        if (lastCommit) {
          const days = Math.floor((Date.now() - new Date(lastCommit).getTime()) / 86400000);
          ageStr = days < 30 ? days + 'd' : days < 365 ? Math.floor(days / 30) + 'mo' : Math.floor(days / 365) + 'y';
        }
        const fresh = lastCommit && (Date.now() - new Date(lastCommit).getTime()) < 30 * 86400000;
        ghCell = '<span title="' + escapeHtml(stars + ' stars · last commit ' + (lastCommit || 'unknown')) + '">★' + starStr + (ageStr ? '<span class="' + (fresh ? 'green' : 'muted') + '"> ·' + ageStr + '</span>' : '') + '</span>';
      }
      return '<tr class="' + (r.top1 ? 't1' : '') + sel + '" data-key="' + escapeHtml(r.name + '@' + r.version) + '">'
        + '<td' + (r.top1 ? ' class="first"' : '') + '>' + r.rank + '</td>'
        + '<td>' + nameCellHtml(r.name, r.version, r.kind, url) + '</td>'
        + '<td class="muted">' + r.version + '</td>'
        + '<td><span class="domain-tag ' + tag + '">' + tagLabel(r.domain) + '</span></td>'
        + '<td class="num">' + (r.rrf ? fmt.rrf(r.rrf) : '—') + '</td>'
        + '<td class="num ' + (r.rel >= 1 ? 'green' : '') + '">' + fmt.rel(r.rel) + '</td>'
        + '<td class="num">' + (r.vec ? fmt.vec(r.vec) : '—') + '</td>'
        + '<td class="num">' + fmt.ms(r.p95) + '</td>'
        + '<td class="num">' + ghCell + '</td>'
        + '</tr>';
    }).join('');

    // Mobile mirror: same rows, card layout. Runs unconditionally; CSS hides
    // the mobile shell on desktop so this is cheap layout, no visible cost.
    renderMobileCards(rows);
  }

  // ---- mobile cards (mirror of the ranking table) -------------------------
  function renderMobileCards(rows) {
    const ul = document.getElementById('mobile-results');
    if (!ul) return;
    if (!rows || !rows.length) {
      ul.innerHTML = '<li class="m-empty">no results match the current filters</li>';
      return;
    }
    ul.innerHTML = rows.map((r) => {
      const tag = tagFor(r.domain);
      const tool = findTool(r.name, r.version);
      const cap = (tool?.capability_text || '').replace(/\\s+/g, ' ').trim();
      const stub = tool?.endpoint_stub_name || '';
      const callable = stub && stub !== 'catalog-only-stub';
      const pct = Math.max(0, Math.min(100, (r.rel || 0) * 100));
      return '<li class="m-card" data-key="' + escapeHtml(r.name + '@' + r.version) + '">'
        + '<div class="m-card-name">' + escapeHtml(r.name) + '</div>'
        + (cap ? '<div class="m-card-blurb">' + escapeHtml(cap) + '</div>' : '')
        + '<div class="m-card-meta">'
        +   '<span class="domain-tag ' + tag + '">' + tagLabel(r.domain) + '</span>'
        +   '<span class="m-kind">' + escapeHtml(r.kind || 'tool') + '</span>'
        +   (callable ? '<span class="m-callable">callable</span>' : '')
        +   '<span class="m-rel"><span class="m-bar"><i style="width:' + pct.toFixed(0) + '%"></i></span>' + fmt.rel(r.rel) + '</span>'
        + '</div>'
        + '</li>';
    }).join('');
  }

  // ---- right pane detail ---------------------------------------------------
  function renderDetail(tool) {
    if (!tool) return;
    state.selected = tool;
    const tag = tagFor((tool.domain || '').toLowerCase());
    const url = sourceUrlOf(tool);
    const nameHtml = url
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Open source in new tab">' + escapeHtml(tool.name) + '</a>'
      : escapeHtml(tool.name);
    $('#d-name').innerHTML = nameHtml + '@' + escapeHtml(tool.version)
      + ' <span class="domain-tag ' + tag + '" style="font-size:9px;vertical-align:2px;">' + tagLabel(tool.domain) + '</span>';
    $('#d-submeta').textContent = (tool.author_agent_id ? 'author ' + tool.author_agent_id + ' · ' : '')
      + (tool.endpoint_stub_name ? 'stub ' + tool.endpoint_stub_name : '');
    $('#d-blurb').textContent = tool.capability_text || '';
    const meta = tool.metadata || {};
    const rel = meta.reliability_score ?? 0;
    const gated = rel < 0.80;
    const pct = Math.max(0, Math.min(100, rel * 100));
    const sourceRow = url
      ? '<span class="k" title="Authoritative homepage for this tool">source</span>'
        + '<span><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url.replace(new RegExp('^https?://'), '')) + '</a></span>'
      : '';
    $('#d-kv').innerHTML =
        '<span class="k" title="Reliability score 0-1 from continuous evals. >= 0.80 to appear in /discover.">reliability</span><span><span class="reliability-bar"><span class="meter"><i class="' + (gated ? 'gated' : '') + '" style="width:' + pct.toFixed(0) + '%"></i></span><span class="bright">' + fmt.rel(rel) + '</span></span></span>'
      + '<span class="k" title="95th-percentile latency in milliseconds.">p95 latency</span><span><span class="bright">' + fmt.ms(meta.p95_latency_ms) + '</span> <span class="muted">ms</span></span>'
      + '<span class="k" title="Cost per call in USD (when available).">cost / call</span><span>$' + Number(meta.cost_per_call_usd ?? 0).toFixed(4) + '</span>'
      + '<span class="k" title="Lifecycle state: active = callable, circuit_broken = auto-disabled after failures, deprecated = author flagged as obsolete.">status</span><span class="' + (tool.status === 'active' ? 'green bright' : tool.status === 'circuit_broken' ? 'red bright' : 'yellow bright') + '">' + (tool.status || 'unknown') + '</span>'
      + '<span class="k" title="Endpoint stub: which built-in handler implements /call for this tool. catalog-only-stub = discovery only, not callable.">stub</span><span>' + (tool.endpoint_stub_name || '—') + '</span>'
      + '<span class="k" title="Time of last continuous eval run.">last eval</span><span>' + fmt.time(meta.last_eval_run) + '</span>'
      + sourceRow;
    // refresh row outline
    renderTable();
  }

  // ---- live feed -----------------------------------------------------------
  // Klass is interpolated into a class attribute so it MUST be escaped — even
  // though every current caller passes a hardcoded enum, defense-in-depth
  // against a future caller forwarding user data.
  function pushFeed(html, klass) {
    state.feed.unshift({ html, klass: klass || '', t: Date.now() });
    if (state.feed.length > 20) state.feed.length = 20;
    $('#x-feed-count').textContent = state.feed.length + ' event' + (state.feed.length === 1 ? '' : 's');
    $('#feed').innerHTML = state.feed.map((f) =>
      '<div class="feed-row ' + escapeHtml(f.klass) + '"><span class="muted">'
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
      pushFeed('<span class="chip call">CALL</span> ' + escapeHtml(d.tool_name + '@' + d.tool_version) + ' '
        + '<span class="' + (d.outcome === 'ok' ? 'green bright' : 'red') + '">' + escapeHtml(d.outcome) + '</span> '
        + (d.latency_ms != null ? '<span class="muted">' + escapeHtml(String(d.latency_ms)) + 'ms</span>' : ''),
        cls);
      // flash the row in the table — CSS.escape so an attacker name with "]" can't break the selector
      const key = d.tool_name + '@' + d.tool_version;
      const row = document.querySelector('tr[data-key="' + CSS.escape(key) + '"]');
      if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    });

    es.addEventListener('tool_changed', (e) => {
      const data = JSON.parse(e.data);
      const t = data.tool || data;
      if (!t || !t.name) return;
      const idx = state.tools.findIndex((x) => x.name === t.name && x.version === t.version);
      if (idx >= 0) state.tools[idx] = { ...state.tools[idx], ...t };
      else state.tools.push(t);
      recomputeAllCounts();
      renderTable();
      pushFeed('<span class="chip push">PUSH</span> ' + escapeHtml(t.name + '@' + t.version)
        + ' <span class="muted">' + escapeHtml(t.status || '?') + '</span>');
    });

    es.addEventListener('violation_logged', onViolation);
    es.addEventListener('violation_added', onViolation);
    function onViolation(e) {
      const v = JSON.parse(e.data);
      pushFeed('<span class="chip cb">CB!!</span> <span class="bright">' + escapeHtml(v.tool_name || '?') + '</span> '
        + '<span class="red">' + escapeHtml((v.stage || 'output') + '_violation') + '</span>', 'cb');
      // Use state.violationsCount instead of reading from a removed sidebar element.
      state.violationsCount = (state.violationsCount || 0) + 1;
      $('#x-vio').textContent = String(state.violationsCount);
    }

    es.addEventListener('eval_completed', (e) => {
      const d = JSON.parse(e.data);
      pushFeed('<span class="chip eval">EVAL</span> ' + escapeHtml((d.tool_name || '?') + '@' + (d.tool_version || '?'))
        + ' <span class="muted">' + escapeHtml((d.pass_count || 0) + '/' + (d.total_count || 0)) + '</span>');
    });
  }

  // ---- domain + kind tab interactivity -------------------------------------
  document.getElementById('domain-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.tab');
    if (!btn) return;
    state.activeDomain = btn.dataset.domain || '';
    state.lastDiscover = null;   // tab switch exits discover mode
    document.querySelectorAll('#domain-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    syncMobileChips();
    updateBrowseLabel();
    recomputeAllCounts();
    renderTable();
  });

  document.getElementById('kind-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.tab');
    if (!btn) return;
    state.activeKind = btn.dataset.kind || '';
    state.lastDiscover = null;
    document.querySelectorAll('#kind-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    syncMobileChips();
    updateBrowseLabel();
    recomputeAllCounts();
    renderTable();
  });

  document.getElementById('source-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.tab');
    if (!btn) return;
    state.activeSource = btn.dataset.source || '';
    state.lastDiscover = null;
    document.querySelectorAll('#source-tabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    syncMobileChips();
    updateBrowseLabel();
    recomputeAllCounts();
    renderTable();
  });

  // ====================================================================
  // Mobile shell wiring — chips, filter sheet, detail overlay, search
  // mirror. The mobile UI shares the same state machine as the desktop
  // dashboard so /discover, filters, and trending all stay in sync.
  // ====================================================================

  // Build a chip <button> that mirrors a desktop tab's data attributes +
  // visible label. We snapshot the desktop tabs at init time so the chip
  // text and "data-{source,kind,domain}" stay consistent.
  function buildMobileChips() {
    const groups = [
      { src: '#source-tabs', dst: '#m-source-tabs', attr: 'source' },
      { src: '#kind-tabs',   dst: '#m-kind-tabs',   attr: 'kind' },
      { src: '#domain-tabs', dst: '#m-domain-tabs', attr: 'domain' },
    ];
    for (const g of groups) {
      const dst = document.querySelector(g.dst);
      if (!dst) continue;
      const tabs = document.querySelectorAll(g.src + ' button.tab');
      const html = Array.from(tabs).map((tab) => {
        const value = tab.dataset[g.attr] || '';
        const label = (tab.textContent || '').replace(/[\\.·]+\\s*\\d*\\s*$/, '').trim();
        const active = !value || tab.classList.contains('active');
        return '<button class="m-chip ' + (active && !value ? 'active' : '') + '" '
          + 'data-' + g.attr + '="' + escapeHtml(value) + '" type="button">'
          + escapeHtml(label) + '</button>';
      }).join('');
      dst.innerHTML = html;
    }
  }

  // Apply current state.active* to the mobile chips so they reflect the
  // same selection as the desktop tabs after either side toggles.
  function syncMobileChips() {
    const apply = (sel, attr, val) => {
      document.querySelectorAll(sel + ' .m-chip').forEach((c) => {
        c.classList.toggle('active', (c.dataset[attr] || '') === (val || ''));
      });
    };
    apply('#m-source-tabs', 'source', state.activeSource);
    apply('#m-kind-tabs',   'kind',   state.activeKind);
    apply('#m-domain-tabs', 'domain', state.activeDomain);
    // Active filter count on the Filter button.
    const n = (state.activeSource ? 1 : 0) + (state.activeKind ? 1 : 0) + (state.activeDomain ? 1 : 0);
    const fc = document.getElementById('m-filter-count');
    if (fc) {
      fc.textContent = n ? n : '';
      fc.classList.toggle('active', n > 0);
    }
  }

  // Click a mobile chip -> set state, mirror desktop tab class, re-render.
  function wireMobileChipGroup(sel, attr, stateKey, desktopSel) {
    const root = document.querySelector(sel);
    if (!root) return;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.m-chip');
      if (!btn) return;
      const val = btn.dataset[attr] || '';
      state[stateKey] = val;
      state.lastDiscover = null;
      // Mirror the desktop tab state so a later renderTable + recomputeAllCounts
      // sees a consistent active class on both surfaces.
      document.querySelectorAll(desktopSel + ' button.tab').forEach((d) => {
        d.classList.toggle('active', (d.dataset[attr] || '') === val);
      });
      syncMobileChips();
      updateBrowseLabel();
      recomputeAllCounts();
      renderTable();
    });
  }

  // Filter sheet open/close.
  function openSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // Render mobile detail body from a tool object — separate DOM from the
  // desktop right pane so we don't have to fight visibility on overlays.
  function renderMobileDetail(tool) {
    if (!tool) return;
    const body = document.getElementById('m-detail-body');
    const nameEl = document.getElementById('m-detail-name');
    if (!body || !nameEl) return;
    nameEl.textContent = tool.name + '@' + tool.version;
    const tag = tagFor((tool.domain || '').toLowerCase());
    const url = sourceUrlOf(tool);
    const meta = tool.metadata || {};
    const rel = meta.reliability_score ?? 0;
    const pct = Math.max(0, Math.min(100, rel * 100));
    const stub = tool.endpoint_stub_name || '';
    const callable = stub && stub !== 'catalog-only-stub';
    body.innerHTML =
      '<div class="m-detail-meta">'
      +   '<span class="domain-tag ' + tag + '">' + tagLabel(tool.domain) + '</span>'
      +   '<span class="m-kind">' + escapeHtml(tool.tool_kind || 'tool') + '</span>'
      +   (callable ? '<span class="m-callable">callable</span>' : '')
      + '</div>'
      + '<p class="m-detail-blurb">' + escapeHtml(tool.capability_text || '') + '</p>'
      + '<dl class="m-detail-kv">'
      +   '<dt>reliability</dt><dd><span class="m-bar"><i style="width:' + pct.toFixed(0) + '%"></i></span> ' + fmt.rel(rel) + '</dd>'
      +   '<dt>p95 latency</dt><dd>' + fmt.ms(meta.p95_latency_ms) + ' ms</dd>'
      +   '<dt>cost / call</dt><dd>$' + Number(meta.cost_per_call_usd ?? 0).toFixed(4) + '</dd>'
      +   '<dt>status</dt><dd class="' + (tool.status === 'active' ? 'green' : tool.status === 'circuit_broken' ? 'red' : '') + '">' + escapeHtml(tool.status || 'unknown') + '</dd>'
      +   '<dt>stub</dt><dd>' + escapeHtml(stub || '—') + '</dd>'
      +   '<dt>author</dt><dd>' + escapeHtml(tool.author_agent_id || '—') + '</dd>'
      +   (url ? '<dt>source</dt><dd><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url.replace(/^https?:\\/\\//, '')) + '</a></dd>' : '')
      + '</dl>';
  }

  // Initialize the mobile shell after first data load so the chips can
  // mirror the desktop tabs (which include per-domain pip colors etc).
  function initMobileShell() {
    if (document.body.dataset.mobileInit === '1') return;
    document.body.dataset.mobileInit = '1';

    buildMobileChips();
    wireMobileChipGroup('#m-source-tabs', 'source', 'activeSource', '#source-tabs');
    wireMobileChipGroup('#m-kind-tabs',   'kind',   'activeKind',   '#kind-tabs');
    wireMobileChipGroup('#m-domain-tabs', 'domain', 'activeDomain', '#domain-tabs');
    syncMobileChips();

    // Search mirror — keystroke and submit.
    const mq = document.getElementById('m-q-input');
    const dq = document.getElementById('q-input');
    if (mq && dq) {
      mq.addEventListener('input', (e) => { dq.value = e.target.value; dq.dispatchEvent(new Event('input')); });
      mq.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value); });
    }
    const mClear = document.getElementById('m-q-clear');
    if (mClear) mClear.addEventListener('click', () => {
      if (mq) mq.value = '';
      if (dq) { dq.value = ''; dq.dispatchEvent(new Event('input')); }
      state.fuzzyQuery = '';
      runSearch('');
    });

    // Trending button (mobile) -> reuse desktop click handler.
    const mt = document.getElementById('m-q-trending-mobile');
    if (mt) mt.addEventListener('click', () => {
      const dt = document.getElementById('q-trending');
      if (dt) dt.click();
    });

    // Filter sheet open/close.
    const fopen = document.getElementById('m-filter-open');
    if (fopen) fopen.addEventListener('click', () => openSheet('m-filter-sheet'));
    document.querySelectorAll('#m-filter-sheet [data-close]').forEach((el) => {
      el.addEventListener('click', () => closeSheet('m-filter-sheet'));
    });
    const fapply = document.getElementById('m-filter-apply');
    if (fapply) fapply.addEventListener('click', () => closeSheet('m-filter-sheet'));
    const fclear = document.getElementById('m-filter-clear');
    if (fclear) fclear.addEventListener('click', () => {
      state.activeSource = '';
      state.activeKind = '';
      state.activeDomain = '';
      state.lastDiscover = null;
      document.querySelectorAll('#source-tabs .tab, #kind-tabs .tab, #domain-tabs .tab').forEach((t) => {
        t.classList.toggle('active', !t.dataset.source && !t.dataset.kind && !t.dataset.domain);
      });
      syncMobileChips();
      updateBrowseLabel();
      recomputeAllCounts();
      renderTable();
    });

    // Card tap -> open detail overlay.
    const results = document.getElementById('mobile-results');
    if (results) results.addEventListener('click', (e) => {
      const card = e.target.closest('.m-card');
      if (!card) return;
      const key = card.dataset.key || '';
      const at = key.lastIndexOf('@');
      if (at < 0) return;
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const tool = findTool(name, version);
      if (!tool) return;
      renderDetail(tool);          // also populates desktop pane (cheap)
      renderMobileDetail(tool);
      openSheet('m-detail');
    });

    const mback = document.getElementById('m-detail-back');
    if (mback) mback.addEventListener('click', () => closeSheet('m-detail'));
  }

  function updateBrowseLabel() {
    const parts = [];
    if (state.fuzzyQuery) parts.push('fuzzy "' + state.fuzzyQuery + '"');
    if (state.activeKind) parts.push(state.activeKind);
    if (state.activeDomain) parts.push(state.activeDomain);
    if (state.activeSource) parts.push(state.activeSource);
    $('#x-query').textContent = parts.length
      ? '— ' + parts.join(' / ')
      : '— (type to fuzzy-filter, Enter for semantic search)';
  }

  // (Dead nav-pane sb-row handlers removed: the sidebar was deleted earlier in
  // favor of horizontal SOURCE/KIND/DOMAIN tab strips. The handlers referenced
  // .sb-row[data-dom], .sb-row[data-action], .sb-row[data-source] which no
  // longer exist in the DOM. Plus the orphaned resetAllFilters(). All gone.)

  // ---- search bar ---------------------------------------------------------
  const PUBLIC_KEY = 'sk_public_caller_09e45ffbb6781f2f';
  async function runSearch(q) {
    q = (q || '').trim();
    if (!q) {
      state.lastDiscover = null;
      $('#q-hint').textContent = 'Press Enter';
      $('#x-latency').textContent = '—';
      updateBrowseLabel();
      renderTable();
      return;
    }
    $('#q-hint').textContent = 'searching...';
    try {
      const r = await fetch('/discover?q=' + encodeURIComponent(q) + '&limit=20', {
        headers: { 'x-api-key': PUBLIC_KEY },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        $('#q-hint').textContent = 'error: ' + (j.error?.message || r.status);
        return;
      }
      state.lastDiscover = { results: j.results || [], meta: j.meta || {}, query: q };
      // Clear fuzzy filter once a semantic result lands. Otherwise the typed
      // multi-word query stays as a substring filter on the facet counts and
      // strangles them to 0. The text in the input box stays — only the
      // client-side filter resets.
      state.fuzzyQuery = '';
      $('#x-query').textContent = '— "' + q + '" → ' + (j.results || []).length + ' results';
      $('#x-latency').textContent = (j.meta?.total_ms || j.meta?.search_ms || 0) + 'ms';
      $('#q-hint').textContent = (j.results || []).length + ' results';
      const top = (j.results || [])[0];
      if (top) {
        const t = findTool(top.name, top.version);
        if (t) renderDetail(t);
      }
      recomputeAllCounts();
      renderTable();
    } catch (e) {
      $('#q-hint').textContent = 'fetch failed';
    }
  }
  $('#sort-gh').addEventListener('click', () => {
    state.sortBy = state.sortBy === 'gh' ? '' : 'gh';
    state.lastDiscover = null;  // sort applies in browse mode only
    document.getElementById('sort-gh').classList.toggle('active', state.sortBy === 'gh');
    document.getElementById('sort-gh-ind').textContent = state.sortBy === 'gh' ? '↓' : '';
    renderTable();
  });
  $('#q-go').addEventListener('click', () => runSearch($('#q-input').value));
  $('#q-clear').addEventListener('click', () => { $('#q-input').value = ''; state.fuzzyQuery = ''; runSearch(''); $('#q-input').focus(); });
  $('#q-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value); });
  $('#q-trending').addEventListener('click', async () => {
    $('#q-hint').textContent = 'loading trending...';
    try {
      const r = await fetch('/trending?days=7&limit=20');
      const j = await r.json();
      const results = (j.results || []).map((t) => ({
        name: t.name, version: t.version, tool_kind: t.tool_kind || 'tool',
        capability_text: t.capability_text, endpoint_stub_name: t.endpoint_stub_name,
        rrf_score: t.hits, vec_score: 0,
        reliability_score: t.metadata?.reliability_score ?? 0,
        cost_per_call_usd: t.metadata?.cost_per_call_usd ?? 0,
        p95_latency_ms: t.metadata?.p95_latency_ms ?? 0,
      }));
      state.lastDiscover = { results, meta: { total_ms: 0 }, query: 'trending (last ' + j.window_days + 'd)' };
      state.fuzzyQuery = '';  // see runSearch comment — same reasoning
      $('#x-query').textContent = '— trending: top ' + results.length + ' tools by /discover hits in the last ' + j.window_days + 'd' + (results.length === 0 ? ' (no data yet — run some searches to populate)' : '');
      $('#x-latency').textContent = '—';
      $('#q-hint').textContent = results.length ? results.length + ' trending' : 'no trending data yet';
      // Sync DETAIL pane to top-1 trending entry so the right pane reflects
      // what the user is now looking at, matching runSearch behavior.
      const topTrending = results[0];
      if (topTrending) {
        const t = findTool(topTrending.name, topTrending.version);
        if (t) renderDetail(t);
      }
      recomputeAllCounts();
      renderTable();
    } catch (e) {
      $('#q-hint').textContent = 'fetch failed';
    }
  });

  // Live fuzzy filter on every keystroke (client-side substring match,
  // instant). Enter still fires the full semantic /discover. The fuzzy
  // path filters state.tools by name + capability_text containing the query.
  $('#q-input').addEventListener('input', (e) => {
    state.fuzzyQuery = (e.target.value || '').trim().toLowerCase();
    if (!state.fuzzyQuery) {
      $('#q-hint').textContent = 'Press Enter for semantic search';
    } else {
      $('#q-hint').textContent = 'fuzzy: ' + state.fuzzyQuery;
    }
    state.lastDiscover = null;   // exit semantic mode while typing
    recomputeAllCounts();
    renderTable();
  });

  // (Dead setupNavToggle IIFE removed: #nav-toggle button no longer exists.)

  function parseRowKey(key) {
    // data-key is "<name>@<version>" but names can start with "@" (npm scopes
    // like @scope/pkg) so split on the LAST "@" only.
    const lastAt = key.lastIndexOf('@');
    if (lastAt <= 0) return { name: key, version: '1.0' };
    return { name: key.slice(0, lastAt), version: key.slice(lastAt + 1) };
  }
  $('#rank-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const { name, version } = parseRowKey(tr.dataset.key);
    const t = state.tools.find((x) => x.name === name && x.version === version);
    if (t) renderDetail(t);
  });

  // ---- footer clock --------------------------------------------------------
  function tickClock() {
    $('#x-clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }
  setInterval(tickClock, 1000); tickClock();

  // ---- help banner toggle (persisted in localStorage) ----------------------
  (function setupHelpBanner() {
    const banner = document.getElementById('help-banner');
    const toggle = document.getElementById('help-toggle');
    const dismiss = document.getElementById('help-dismiss');
    const expand = document.getElementById('help-expand');
    if (!banner || !toggle || !dismiss) return;
    const HID_KEY = '2chain.help.dismissed';
    const EXP_KEY = '2chain.help.expanded';
    // Default-hidden on phones to avoid the empty-yellow-strip QA finding.
    // User can still tap (?) help to show it. localStorage decision wins so
    // a returning user who explicitly opened it stays opened.
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const stored = localStorage.getItem(HID_KEY);
    if (stored === '1' || (isMobile && stored === null)) banner.classList.add('hidden');
    if (localStorage.getItem(EXP_KEY) === '1') {
      banner.classList.remove('collapsed');
      if (expand) expand.textContent = 'hide glossary';
    }
    toggle.addEventListener('click', () => {
      const isHidden = banner.classList.toggle('hidden');
      localStorage.setItem(HID_KEY, isHidden ? '1' : '0');
    });
    dismiss.addEventListener('click', () => {
      banner.classList.add('hidden');
      localStorage.setItem(HID_KEY, '1');
    });
    if (expand) expand.addEventListener('click', () => {
      const isCollapsed = banner.classList.toggle('collapsed');
      expand.textContent = isCollapsed ? 'show glossary' : 'hide glossary';
      localStorage.setItem(EXP_KEY, isCollapsed ? '0' : '1');
    });
  })();

  // ---- boot ----------------------------------------------------------------
  initMobileShell();
  loadStats().then(() => loadState()).then(() => connect());
  setInterval(loadStats, 15000);
})();
</script>
</body>
</html>`;

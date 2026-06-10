// 2chain MCP shim — discover_tools result formatter (E5).
//
// SIDE-EFFECT-FREE on purpose: bin/2chain-mcp.mjs connects the stdio
// transport at module top level, so importing the shim from a test hangs
// the runner. The shim imports THIS module; tests import this module; the
// shim itself must NEVER be imported by tests.
//
// Header copy reflects the real v2 stack (SQLite RRF 0.5/0.5, Ollama
// nomic-embed-text 768-dim) — the v1 'Atlas $rankFusion' / 'Voyage
// voyage-3' trace text was provably false and the freshness column must
// not sit under it.

// Author-controlled strings (name/version/capability_text) render into
// AGENT-VISIBLE text: a newline inside capability_text could forge extra
// table rows with fake reliability/final scores, and control characters
// could impersonate the trace header (independent-review HIGH). One line
// of neutralization closes row-forging; rendering stays single-line.
function clean(s) {
  // eslint-disable-next-line no-control-regex
  // ALL line-break/control categories (codex P2): C0 + DEL + C1 (incl.
  // U+0085 NEL) + U+2028/U+2029 Unicode separators - many consumers
  // render the separators as hard breaks, re-opening row-forging past a
  // C0-only strip.
  return String(s).replace(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

function pad(s, n) {
  return String(s).padEnd(n);
}

/**
 * Render the discover_tools trace block.
 *
 * Unknown/empty safe: missing meta, missing results, and missing per-result
 * fields all render with zero fallbacks (pre-E5 servers omit final_score —
 * fall back to rrf_score, the same ordering key pre-E5; rank_score would
 * look mis-sorted post-E5).
 *
 * @param {{ query?: string, mode?: string, wallMs?: number,
 *           meta?: Record<string, unknown>,
 *           results?: Array<Record<string, unknown>> }} input
 * @returns {string}
 */
export function formatDiscoverTools({ query = '', mode = 'hybrid', wallMs = 0, meta = {}, results = [] } = {}) {
  const safeResults = Array.isArray(results) ? results : [];
  const lines = [];
  lines.push('=== 2chain.discover_tools ===');
  lines.push(`query:       "${query}"`);
  lines.push(`mode:        ${mode}${mode === 'hybrid' ? '  (SQLite RRF: vector 0.5 + text 0.5)' : '  (pure vector search)'}`);
  lines.push(`embed:       ${meta.embed_ms ?? 0}ms${(meta.embed_ms ?? 0) === 0 ? '  (cached)' : '  (Ollama nomic-embed-text, 768-dim)'}`);
  lines.push(`search:      ${meta.search_ms ?? 0}ms  (SQLite RRF pipeline)`);
  lines.push(`wall:        ${wallMs}ms`);
  lines.push(`returned:    ${safeResults.length} tool(s) passing reliability >= 0.80`);
  lines.push('');
  if (!safeResults.length) {
    lines.push('(no candidates passed the gates)');
  } else {
    lines.push('rank  name              ver   rel    final     fresh');
    lines.push('────  ───────────────── ───   ────   ───────   ─────');
    for (const [i, t] of safeResults.entries()) {
      const finalScore = Number(t.final_score ?? t.rrf_score ?? 0).toFixed(5);
      const freshness = Number(t.freshness ?? 0).toFixed(2);
      lines.push(`  ${i + 1}   ${pad(clean(t.name ?? '?'), 17)} ${pad(clean(t.version ?? '?'), 4)}  ${Number(t.reliability_score ?? 0).toFixed(2)}   ${finalScore}   ${freshness}`);
    }
    lines.push('');
    lines.push('descriptions (for picking the right one):');
    for (const t of safeResults) {
      lines.push(`  • ${clean(t.name ?? '?')}@${clean(t.version ?? '?')}: ${clean(t.capability_text ?? '')}`);
    }
  }
  return lines.join('\n');
}

#!/usr/bin/env node
// 2chain MCP server — exposes the registry to Claude Code (and any
// MCP-compatible agent) as discover_tools + call_tool. Returns rich,
// trace-style output so the agent (and the human watching Claude Code)
// can see MongoDB Atlas + the registry doing real work.
//
// Configure via environment:
//   TWOCHAIN_HOST     — base URL of the 2chain API (default: http://127.0.0.1:3030)
//   TWOCHAIN_API_KEY  — caller agent api key (default: sk_demo_pdf_agent_8f2c4a)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HOST = process.env.TWOCHAIN_HOST || 'http://127.0.0.1:3030';
const API_KEY = process.env.TWOCHAIN_API_KEY || 'sk_demo_pdf_agent_8f2c4a';
const VERBOSE = process.env.TWOCHAIN_VERBOSE !== 'false';  // default ON

const server = new Server(
  { name: '2chain-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'discover_tools',
      description:
        'Search the 2chain tool registry for tools that fulfil a natural-language capability query. ' +
        'Returns a ranked list of tools with reliability scores, plus a trace showing the MongoDB Atlas ' +
        'pipeline used (vector search + text search via $rankFusion), candidate counts, and per-tool scores. ' +
        'ALWAYS use this BEFORE call_tool — it surfaces only tools that pass the 0.80 reliability gate.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language capability query.' },
          mode: { type: 'string', enum: ['vector', 'hybrid'], default: 'hybrid' },
          top: { type: 'integer', default: 5, minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'call_tool',
      description:
        'Invoke a tool from the 2chain registry. Input + output JSON Schemas are enforced at the wire — ' +
        'malformed responses circuit-break the tool. The trace returned shows latency, status, and raw output.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          tool_version: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['tool_name', 'tool_version', 'input'],
      },
    },
  ],
}));

function pad(s, n) { return String(s).padEnd(n); }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'discover_tools') {
    const q = String(args.query ?? '');
    const mode = args.mode === 'vector' ? 'vector' : 'hybrid';
    const top = Math.max(1, Math.min(20, Number(args.top ?? 5)));
    const url = `${HOST}/discover?q=${encodeURIComponent(q)}&mode=${mode}&top=${top}`;
    const t0 = Date.now();
    const r = await fetch(url, { headers: { 'x-api-key': API_KEY } });
    const j = await r.json();
    const wallMs = Date.now() - t0;
    if (!r.ok || !j.ok) {
      return { content: [{ type: 'text', text: `[2chain] discover failed: HTTP ${r.status} ${JSON.stringify(j.error ?? j)}` }], isError: true };
    }

    const lines = [];
    lines.push('=== 2chain.discover_tools ===');
    lines.push(`query:       "${q}"`);
    lines.push(`mode:        ${mode}${mode === 'hybrid' ? '  (Atlas $rankFusion: vector 0.7 + text 0.3)' : '  (pure $vectorSearch)'}`);
    lines.push(`embed:       ${j.meta.embed_ms ?? 0}ms${(j.meta.embed_ms ?? 0) === 0 ? '  (cached)' : '  (Voyage voyage-3, 1024-dim)'}`);
    lines.push(`atlas:       ${j.meta.search_ms ?? 0}ms  (MongoDB pipeline)`);
    lines.push(`wall:        ${wallMs}ms`);
    lines.push(`returned:    ${j.results.length} tool(s) passing reliability >= 0.80`);
    lines.push('');
    if (!j.results.length) {
      lines.push('(no candidates passed the gates)');
    } else {
      lines.push('rank  name              ver   rel    score');
      lines.push('────  ───────────────── ───   ────   ──────');
      for (const [i, t] of j.results.entries()) {
        const score = (t.rank_score ?? t.rrf_score ?? 0).toFixed(4);
        lines.push(`  ${i + 1}   ${pad(t.name, 17)} ${pad(t.version, 4)}  ${t.reliability_score.toFixed(2)}   ${score}`);
      }
      lines.push('');
      lines.push('descriptions (for picking the right one):');
      for (const t of j.results) {
        lines.push(`  • ${t.name}@${t.version}: ${t.capability_text}`);
      }
    }
    if (VERBOSE && mode === 'hybrid' && j.meta.pipeline_json) {
      lines.push('');
      lines.push('--- MongoDB pipeline ---');
      lines.push(j.meta.pipeline_json);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'call_tool') {
    const body = {
      tool_name: String(args.tool_name),
      tool_version: String(args.tool_version),
      input: args.input,
    };
    const t0 = Date.now();
    const r = await fetch(`${HOST}/call`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const wallMs = Date.now() - t0;

    const lines = [];
    lines.push('=== 2chain.call_tool ===');
    lines.push(`tool:    ${body.tool_name}@${body.tool_version}`);
    lines.push(`wall:    ${wallMs}ms${j.latency_ms != null ? '  (server-side: ' + j.latency_ms + 'ms)' : ''}`);

    if (j.ok) {
      lines.push(`status:  ✓ 200 OK  (input + output contracts validated by ajv)`);
      lines.push(`call_id: ${j.call_id}`);
      lines.push('');
      lines.push('result:');
      lines.push(JSON.stringify(j.result, null, 2));
    } else {
      lines.push(`status:  ✗ HTTP ${r.status}  ${j.error?.code}`);
      lines.push(`reason:  ${j.error?.message}`);
      if (j.error?.details?.raw_preview !== undefined) {
        const p = j.error.details.raw_preview;
        const preview = typeof p === 'string' ? '"' + p + '"' : JSON.stringify(p);
        lines.push(`raw:     ${preview}`);
      }
      if (j.error?.details?.schema_errors) {
        lines.push(`schema_errors:`);
        for (const se of j.error.details.schema_errors) {
          lines.push(`  ${se.path || '(root)'}: ${se.message}`);
        }
      }
      if (j.error?.code === 'output_contract_violation_circuit_break') {
        lines.push('');
        lines.push('→ tool flipped to status=circuit_broken in MongoDB');
        lines.push('→ violation logged to violations collection');
        lines.push('→ all future agents are protected from this tool');
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: !j.ok };
  }

  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`2chain-mcp connected to ${HOST} (verbose=${VERBOSE})`);

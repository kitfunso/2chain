#!/usr/bin/env node
// 2chain MCP server: exposes the 2chain registry to Claude Code (and any
// MCP-compatible agent) as two tools: discover_tools + call_tool.
//
// Architecture:
//   Claude Code (local) ⇄ this MCP server (local stdio) ⇄ 2chain API (remote HTTP)
//
// Configure via environment:
//   TWOCHAIN_HOST     — base URL of the 2chain API (default: http://127.0.0.1:3030)
//   TWOCHAIN_API_KEY  — caller agent api key (default: sk_demo_pdf_agent_8f2c4a)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HOST = process.env.TWOCHAIN_HOST || 'http://127.0.0.1:3030';
const API_KEY = process.env.TWOCHAIN_API_KEY || 'sk_demo_pdf_agent_8f2c4a';

const server = new Server(
  { name: '2chain-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'discover_tools',
      description:
        'Search the 2chain tool registry for tools that can fulfil a natural-language capability query. ' +
        'Returns a ranked list of tools, each with name, version, reliability score (0-1), and a description ' +
        'of what it does. Only tools at reliability >= 0.80 are returned. Use this BEFORE call_tool to find ' +
        'the right tool for any task — extracting from PDFs, linting code, summarising text, parsing invoices, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language description of what the user wants done. e.g. "extract tables from a financial PDF" or "lint javascript code for bugs".',
          },
          mode: {
            type: 'string',
            enum: ['vector', 'hybrid'],
            description: 'Retrieval mode. "hybrid" uses Atlas $rankFusion (vector + text). "vector" uses pure semantic search. Default: hybrid.',
            default: 'hybrid',
          },
          top: {
            type: 'integer',
            description: 'Maximum number of tools to return (1-20). Default 5.',
            default: 5,
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'call_tool',
      description:
        'Invoke a tool from the 2chain registry. The tool must have been discovered via discover_tools first; ' +
        'pass its name + version + an input object that conforms to the tool input contract. The contract ' +
        'enforces input + output schemas at the wire — if the tool returns a malformed response, 2chain ' +
        'circuit-breaks it and returns a 503. Use the tool description from discover_tools to decide what ' +
        'shape to send as input.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Name from discover_tools (e.g. "pdf-extractor", "eslint-snitch").' },
          tool_version: { type: 'string', description: 'Version from discover_tools (e.g. "3.0", "7.5").' },
          input: { type: 'object', description: 'Input matching the tool input_contract. Common shapes: {pdf_text}, {text}, {code}.' },
        },
        required: ['tool_name', 'tool_version', 'input'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'discover_tools') {
    const q = String(args.query ?? '');
    const mode = args.mode === 'vector' ? 'vector' : 'hybrid';
    const top = Math.max(1, Math.min(20, Number(args.top ?? 5)));
    const url = `${HOST}/discover?q=${encodeURIComponent(q)}&mode=${mode}&top=${top}`;
    const r = await fetch(url, { headers: { 'x-api-key': API_KEY } });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      return { content: [{ type: 'text', text: `discover failed: ${r.status} ${JSON.stringify(j.error ?? j)}` }], isError: true };
    }
    if (!j.results.length) {
      return { content: [{ type: 'text', text: 'No tools matched. Try a more specific query.' }] };
    }
    const lines = [
      `Found ${j.results.length} tool(s) for "${q}" (mode: ${mode}):`,
      '',
      ...j.results.map((t, i) =>
        `${i + 1}. ${t.name}@${t.version}` +
        `   reliability: ${t.reliability_score}` +
        `   composite_score: ${(t.rank_score ?? t.rrf_score ?? 0).toFixed(4)}` +
        `\n   description: ${t.capability_text}` +
        `\n   cost_per_call_usd: ${t.cost_per_call_usd}, p95_latency_ms: ${t.p95_latency_ms}`
      ),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'call_tool') {
    const body = {
      tool_name: String(args.tool_name),
      tool_version: String(args.tool_version),
      input: args.input,
    };
    const r = await fetch(`${HOST}/call`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) {
      return { content: [{ type: 'text', text: `✓ ${body.tool_name}@${body.tool_version} (${j.latency_ms}ms)\n\n${JSON.stringify(j.result, null, 2)}` }] };
    }
    const detail = j.error?.details?.raw_preview !== undefined
      ? `\n  raw_preview: ${typeof j.error.details.raw_preview === 'string' ? '"' + j.error.details.raw_preview + '"' : JSON.stringify(j.error.details.raw_preview)}`
      : '';
    return {
      content: [{
        type: 'text',
        text: `✗ ${body.tool_name}@${body.tool_version} failed: ${j.error?.code}\n  ${j.error?.message}${detail}`,
      }],
      isError: true,
    };
  }

  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`2chain-mcp connected to ${HOST}`);

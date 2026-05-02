// Lazy verification helper for the MCP importer. Spawns a server briefly,
// calls tools/list, returns the advertised tools. Separate from the main
// importer so unit tests can exercise the dry-run path without ever
// importing child_process.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerEntry } from './mcp-registry.js';

export interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const VERIFY_TIMEOUT_MS = 15_000;

export async function ensureConnectedForVerify(
  server: McpServerEntry,
): Promise<AdvertisedTool[]> {
  // Reject early if required env vars are missing — saves a long npx spawn
  // that will just fail at runtime.
  if (server.envPassthrough) {
    for (const key of server.envPassthrough) {
      if (!process.env[key]) {
        throw new Error(`env var ${key} not set; cannot verify ${server.serverId}`);
      }
    }
  }

  const runtime = server.runtime ?? 'npx';
  const args = runtime === 'npx'
    ? ['-y', server.npmPackage, ...(server.args ?? [])]
    : [server.npmPackage, ...(server.args ?? [])];
  const transport = new StdioClientTransport({
    command: runtime,
    args,
    env: process.env as Record<string, string>,
  });

  const client = new Client(
    { name: '2chain-verify', version: '0.2.0' },
    { capabilities: {} },
  );

  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort();
    try {
      transport.close();
    } catch {
      /* ignore */
    }
  }, VERIFY_TIMEOUT_MS);

  try {
    await client.connect(transport);
    const list = await client.listTools();
    const tools: AdvertisedTool[] = list.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return tools;
  } finally {
    clearTimeout(t);
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

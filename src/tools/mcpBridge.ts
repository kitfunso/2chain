// MCP bridge — runtime forwarder. Spawns external MCP server processes on
// demand via stdio, caches connected clients, forwards /call requests to
// the right server+tool. This is the "runnable code attached" piece —
// 2chain ingests MCP server metadata (mcp-registry.ts) and routes calls
// through this bridge to real subprocess implementations.
//
// Trust boundary (CLAUDE.md rule 12): the MCP server runs in its own
// process, talks to 2chain over stdio JSON-RPC. 2chain's main process
// never evals or imports the foreign code; it only exchanges messages.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  /** Stable slug, e.g. "mcp-filesystem", "mcp-github". */
  serverId: string;
  /** Human label. */
  name: string;
  /** The command used to spawn the server (e.g. "npx"). */
  command: string;
  /** Arguments to the command (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]). */
  args: string[];
  /** Required env vars to be passed through (read from process.env). */
  envPassthrough?: string[];
  /** Optional working directory. */
  cwd?: string;
  /** Override for tools/list — useful when the server needs a one-off arg
   *  to list tools. Defaults to standard listTools(). */
  listToolsOverride?: () => Promise<unknown>;
}

interface ConnectedClient {
  client: Client;
  proc: ChildProcessWithoutNullStreams;
  spawnedAt: number;
  toolNames: Set<string>;
}

const REGISTRY = new Map<string, McpServerConfig>();
const CLIENTS = new Map<string, ConnectedClient>();
const CONNECTING = new Map<string, Promise<ConnectedClient>>();

const SPAWN_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

export function registerMcpServer(cfg: McpServerConfig): void {
  REGISTRY.set(cfg.serverId, cfg);
}

export function getMcpServer(serverId: string): McpServerConfig | undefined {
  return REGISTRY.get(serverId);
}

export function listMcpServers(): McpServerConfig[] {
  return [...REGISTRY.values()];
}

async function ensureConnected(serverId: string): Promise<ConnectedClient> {
  const existing = CLIENTS.get(serverId);
  if (existing && !existing.proc.killed) return existing;
  const inflight = CONNECTING.get(serverId);
  if (inflight) return inflight;

  const cfg = REGISTRY.get(serverId);
  if (!cfg) throw new Error(`unknown MCP server: ${serverId}`);

  const promise = (async () => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (cfg.envPassthrough) {
      for (const key of cfg.envPassthrough) {
        if (process.env[key] === undefined) {
          throw new Error(`MCP server ${serverId} requires env var ${key} but it is not set`);
        }
      }
    }

    // Use the SDK's StdioClientTransport — it handles spawn + framing for us.
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env,
      cwd: cfg.cwd,
    });

    const client = new Client(
      { name: '2chain-bridge', version: '0.2.0' },
      { capabilities: {} },
    );

    const connectP = client.connect(transport);
    const timer = setTimeout(() => {
      try {
        transport.close();
      } catch {
        /* swallow */
      }
    }, SPAWN_TIMEOUT_MS);
    try {
      await connectP;
    } finally {
      clearTimeout(timer);
    }

    // Capture the proc handle for future kill on shutdown
    // The SDK exposes a private _process; we treat it opaquely.
    const proc = (transport as unknown as { _process?: ChildProcessWithoutNullStreams })._process!;

    // Cache the tool name set for fast existence checks.
    const list = await client.listTools();
    const toolNames = new Set(list.tools.map((t) => t.name));

    const conn: ConnectedClient = { client, proc, spawnedAt: Date.now(), toolNames };
    CLIENTS.set(serverId, conn);
    return conn;
  })();

  CONNECTING.set(serverId, promise);
  try {
    return await promise;
  } finally {
    CONNECTING.delete(serverId);
  }
}

export interface BridgeCallInput {
  /** MCP server slug to dispatch to. */
  __mcp_server: string;
  /** Tool name as advertised by the MCP server's tools/list. */
  __mcp_tool: string;
  /** Args forwarded to the server tool. */
  args: Record<string, unknown>;
}

/**
 * Forward a 2chain /call to the right MCP server tool.
 * Returns the raw MCP CallToolResult.content; the contract layer in
 * call.ts validates against the tool's output_contract.
 */
export async function callViaMcp(input: BridgeCallInput): Promise<unknown> {
  const conn = await ensureConnected(input.__mcp_server);
  if (!conn.toolNames.has(input.__mcp_tool)) {
    throw new Error(
      `MCP server ${input.__mcp_server} does not advertise tool ${input.__mcp_tool} (have: ${[...conn.toolNames].slice(0, 10).join(', ')}${conn.toolNames.size > 10 ? '…' : ''})`,
    );
  }
  const result = await Promise.race([
    conn.client.callTool({ name: input.__mcp_tool, arguments: input.args }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`MCP call timeout > ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS),
    ),
  ]);
  return result;
}

export async function shutdownAll(): Promise<void> {
  for (const [, conn] of CLIENTS) {
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
    if (!conn.proc.killed) conn.proc.kill();
  }
  CLIENTS.clear();
}

// For tests/diagnostics:
export function _testInternals() {
  return { REGISTRY, CLIENTS };
}
// Avoid unused-spawn-import warning in case a future change drops the line.
void spawn;

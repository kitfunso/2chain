import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  serverId: string;
  name: string;
  command: string;
  args: string[];
  envPassthrough?: string[];
  cwd?: string;
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
      }
    }, SPAWN_TIMEOUT_MS);
    try {
      await connectP;
    } finally {
      clearTimeout(timer);
    }

    const proc = (transport as unknown as { _process?: ChildProcessWithoutNullStreams })._process!;

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
  __mcp_server: string;
  __mcp_tool: string;
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
    }
    if (!conn.proc.killed) conn.proc.kill();
  }
  CLIENTS.clear();
}

export function _testInternals() {
  return { REGISTRY, CLIENTS };
}
void spawn;

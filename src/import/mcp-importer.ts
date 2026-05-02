// MCP importer — turns MCP server registry entries into 2chain ToolSpecV2
// rows + registers them in the runtime bridge.
//
// Pipeline:
//   read mcp-registry entries
//     -> upsert one ToolSpecV2 per advertised tool
//     -> register the bridge for /call to resolve
//
// Optional --verify mode: spawn each server briefly, call tools/list, and
// fail if the advertised tools differ from the static registry — catches
// drift between the registry file and the actual server version.

import type { Embedder, Storage, ToolSpecV2 } from '../types.js';
import { MCP_SERVERS, type McpServerEntry } from './mcp-registry.js';
import { registerMcpServer, callViaMcp } from '../tools/mcpBridge.js';
import { registerStub } from '../services/stubs.js';

const NAMESPACE = 'default';
const DEFAULT_AUTHOR = 'mcp-import';

let bridgeStubRegistered = false;
function ensureBridgeStub(): void {
  if (bridgeStubRegistered) return;
  // mcp-bridge: derives routing from the parent tool's 2chain name
  // (format: <server-id>__<mcp-tool-name>) so the caller passes the
  // MCP tool's real input schema directly — no envelope wrapping.
  registerStub('mcp-bridge', async (input, _caseId, ctx) => {
    if (!ctx?.tool_name) {
      throw new Error('mcp-bridge: missing tool ctx (call.ts must pass it)');
    }
    const sep = ctx.tool_name.indexOf('__');
    if (sep < 0) {
      throw new Error(`mcp-bridge: tool_name "${ctx.tool_name}" must be "<server>__<tool>"`);
    }
    const serverId = ctx.tool_name.slice(0, sep);
    const mcpToolName = ctx.tool_name.slice(sep + 2);
    return await callViaMcp({ __mcp_server: serverId, __mcp_tool: mcpToolName, args: input });
  });
  bridgeStubRegistered = true;
}

/**
 * Build a 2chain ToolSpecV2 from one MCP-server-tool advertisement.
 * The 2chain tool name is namespaced: <server-id>__<tool-name>
 * to avoid collisions across servers that re-use names like "list".
 */
function specFromMcp(server: McpServerEntry, tool: { name: string; capabilityText: string; inputSchema?: Record<string, unknown> }): ToolSpecV2 {
  const compositeName = `${server.serverId}__${tool.name}`;
  // Input schema: pass the MCP-advertised schema through verbatim. The
  // bridge derives routing from ctx.tool_name (set by call.ts), so the
  // caller never has to wrap args in an envelope.
  // additionalProperties: true on the top-level guards against MCP clients
  // (Claude Code etc.) tacking on metadata fields — see CLAUDE.md
  // common-mistakes "additionalProperties: false breaks MCP clients".
  const baseSchema: Record<string, unknown> = tool.inputSchema ?? {
    type: 'object',
    additionalProperties: true,
  };
  const inputContract: Record<string, unknown> = {
    ...baseSchema,
    additionalProperties: true,
  };

  const enriched = `${tool.capabilityText}  Bridged via MCP server "${server.name}" (${server.npmPackage}).${server.homepage ? ` Source: ${server.homepage}.` : ''}`;

  return {
    name: compositeName,
    version: '1.0',
    author_agent_id: DEFAULT_AUTHOR,
    capability_text: enriched,
    input_contract: inputContract,
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'mcp-bridge',
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 1500,
      reliability_score: 0.95,    // pre-eval; verify mode trims this for unreachable servers
    },
    status: 'active',
    domain: server.domain,
  };
}

export interface ImportOptions {
  /** When true, actually spawn each server and assert tools/list matches. Slower. */
  verify?: boolean;
  /** Restrict import to specific server IDs. Default: all. */
  only?: string[];
  /** Skip embedding (used for dry-run). */
  skipEmbedding?: boolean;
}

export interface ImportResult {
  servers_imported: number;
  servers_skipped: number;
  tools_imported: number;
  tools_failed_verify: number;
  errors: Array<{ serverId: string; error: string }>;
  duration_ms: number;
}

export async function importMcpServers(
  storage: Storage,
  embedder: Embedder,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  ensureBridgeStub();
  const t0 = Date.now();
  const result: ImportResult = {
    servers_imported: 0,
    servers_skipped: 0,
    tools_imported: 0,
    tools_failed_verify: 0,
    errors: [],
    duration_ms: 0,
  };

  const targetServers = opts.only
    ? MCP_SERVERS.filter((s) => opts.only!.includes(s.serverId))
    : MCP_SERVERS;

  for (const server of targetServers) {
    // 1. Register in the runtime bridge so /call can later route to it.
    const runtime = server.runtime ?? 'npx';
    const command = runtime;
    const args = runtime === 'npx'
      ? ['-y', server.npmPackage, ...(server.args ?? [])]
      : runtime === 'uvx'
      ? [server.npmPackage, ...(server.args ?? [])]
      : [server.npmPackage, ...(server.args ?? [])];
    registerMcpServer({
      serverId: server.serverId,
      name: server.name,
      command,
      args,
      envPassthrough: server.envPassthrough,
    });

    let tools = server.tools;
    let verifyOk = true;

    // 2. Optional verification: spawn the server, ask it for its real tool list.
    if (opts.verify) {
      try {
        // Lazy import so unit tests don't pull child_process unless needed.
        const { ensureConnectedForVerify } = await import('./mcp-verify.js');
        const advertised = await ensureConnectedForVerify(server);
        const declared = new Set(server.tools.map((t) => t.name));
        const actual = new Set(advertised.map((t) => t.name));

        // Server advertised a different set: trust the server.
        // We log + count drift but don't fail the whole import.
        const missingFromRegistry = [...actual].filter((n) => !declared.has(n));
        const missingFromServer = [...declared].filter((n) => !actual.has(n));
        if (missingFromRegistry.length > 0 || missingFromServer.length > 0) {
          result.tools_failed_verify += missingFromRegistry.length + missingFromServer.length;
          // Replace static stubs with what the server actually advertises,
          // copying the registry capabilityText where names overlap.
          const declaredByName = new Map(server.tools.map((t) => [t.name, t]));
          tools = advertised.map((a) => ({
            name: a.name,
            capabilityText: declaredByName.get(a.name)?.capabilityText ?? a.description ?? a.name,
            inputSchema: a.inputSchema as Record<string, unknown> | undefined,
          }));
        }
      } catch (err) {
        verifyOk = false;
        result.errors.push({ serverId: server.serverId, error: (err as Error).message });
      }
    }

    if (!verifyOk && opts.verify) {
      result.servers_skipped++;
      continue;
    }

    // 3. Embed + upsert each tool spec.
    const specs = tools.map((t) => specFromMcp(server, t));
    const embeddings = opts.skipEmbedding
      ? specs.map(() => new Float32Array(768))
      : await embedder.embedBatch(
          specs.map((s) => s.capability_text),
          'document',
        );
    for (let i = 0; i < specs.length; i++) {
      try {
        await storage.upsertTool(specs[i], embeddings[i], NAMESPACE);
        result.tools_imported++;
      } catch (err) {
        result.errors.push({
          serverId: server.serverId,
          error: `${specs[i].name}: ${(err as Error).message}`,
        });
      }
    }

    result.servers_imported++;
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

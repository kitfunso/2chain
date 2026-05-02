import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Storage } from '../types.js';

const SALT = '2chain-demo-salt-v1';

function hashKey(rawKey: string): string {
  return createHash('sha256').update(SALT + rawKey).digest('hex');
}

export interface AuthContext {
  agent_id: string;
  role: 'caller' | 'tool_author' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export async function requireAuth(
  storage: Storage,
  req: FastifyRequest,
  reply: FastifyReply,
  allowedRoles?: Array<'caller' | 'tool_author' | 'admin'>,
): Promise<AuthContext | null> {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey !== 'string' || !headerKey) {
    reply.code(401).send({ ok: false, error: { code: 'auth_missing', message: 'x-api-key header required' } });
    return null;
  }
  const hash = hashKey(headerKey);
  const agent = await storage.getAgentByKeyHash(hash);
  if (!agent) {
    reply.code(401).send({ ok: false, error: { code: 'auth_invalid', message: 'unknown api key' } });
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(agent.role)) {
    reply.code(403).send({ ok: false, error: { code: 'auth_forbidden', message: `role ${agent.role} not allowed for this endpoint` } });
    return null;
  }
  const ctx: AuthContext = { agent_id: agent.id, role: agent.role };
  req.auth = ctx;
  return ctx;
}

export { hashKey };

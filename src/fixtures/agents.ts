import { createHash } from 'node:crypto';

export interface AgentFixture {
  _id: string;
  name: string;
  api_key: string;
  role: 'caller' | 'tool_author' | 'admin';
}

const SALT = '2chain-demo-salt-v1';

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(SALT + rawKey).digest('hex');
}

export const FIXTURE_AGENTS: AgentFixture[] = [
  {
    _id: 'demo-pdf-agent',
    name: 'Demo PDF Agent (caller for Beat 1-3)',
    api_key: 'sk_demo_pdf_agent_8f2c4a',
    role: 'caller',
  },
  {
    _id: 'demo-coder-agent',
    name: 'Demo Coder Agent (caller for Beat 4)',
    api_key: 'sk_demo_coder_agent_1d9b3e',
    role: 'caller',
  },
  {
    _id: 'demo-tool-author',
    name: 'Demo Tool Author (push + admin for on-stage commands)',
    api_key: 'sk_demo_tool_author_7e5f1c',
    role: 'admin',
  },
];

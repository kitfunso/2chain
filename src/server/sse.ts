import type { FastifyReply } from 'fastify';

interface Subscriber {
  id: string;
  reply: FastifyReply;
}

const subscribers = new Map<string, Subscriber>();

export function addSubscriber(id: string, reply: FastifyReply): void {
  subscribers.set(id, { id, reply });
  // SSE handshake comment
  reply.raw.write(`: connected\n\n`);
  reply.raw.on('close', () => subscribers.delete(id));
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of subscribers.values()) {
    try {
      s.reply.raw.write(payload);
    } catch {
      subscribers.delete(s.id);
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}

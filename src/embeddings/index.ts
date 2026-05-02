// Embedder factory. Reads EMBEDDER env, returns the concrete impl.
// Implementations land in subsequent steps:
//   ollama          -> Step 5 (Phase 1)
//   transformersjs  -> Phase 3
//   voyage          -> already exists (legacy v1 path), wrapped here in Phase 3
//   openai          -> Phase 3

import type { Embedder } from '../types.js';

export type EmbedderDriver = 'ollama' | 'transformersjs' | 'voyage' | 'openai';

export function getEmbedderDriver(): EmbedderDriver {
  const v = (process.env.EMBEDDER ?? 'voyage').toLowerCase();
  if (v === 'ollama' || v === 'transformersjs' || v === 'voyage' || v === 'openai') return v;
  throw new Error(`EMBEDDER must be ollama|transformersjs|voyage|openai, got: ${v}`);
}

export async function createEmbedder(): Promise<Embedder> {
  const driver = getEmbedderDriver();
  switch (driver) {
    case 'ollama': {
      const { OllamaEmbedder } = await import('./ollama.js');
      return new OllamaEmbedder();
    }
    case 'transformersjs':
      throw new Error('TransformersJsEmbedder not yet implemented (Phase 3).');
    case 'voyage':
      throw new Error(
        'VoyageEmbedder wrapper not yet implemented (Phase 3). Legacy v1 code uses src/embeddings/voyage.ts directly.',
      );
    case 'openai':
      throw new Error('OpenAIEmbedder not yet implemented (Phase 3).');
  }
}

export type { Embedder, EmbedResult } from '../types.js';

import { VOYAGE_EMBEDDING_DIM } from '../types.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';

async function callVoyage(input: string | string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set');
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: Array.isArray(input) ? input : [input],
      model: MODEL,
      input_type: inputType,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`voyage ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const vecs = json.data.map((d) => d.embedding);
  for (const vec of vecs) {
    if (vec.length !== VOYAGE_EMBEDDING_DIM) {
      throw new Error(`voyage returned dim=${vec.length}, expected ${VOYAGE_EMBEDDING_DIM}`);
    }
  }
  return vecs;
}

export async function embedOne(text: string, inputType: 'document' | 'query' = 'document'): Promise<number[]> {
  const [vec] = await callVoyage(text, inputType);
  return vec;
}

export async function embedMany(texts: string[], inputType: 'document' | 'query' = 'document'): Promise<number[][]> {
  return callVoyage(texts, inputType);
}

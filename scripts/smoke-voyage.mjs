import 'dotenv/config';

const apiKey = process.env.VOYAGE_API_KEY;
if (!apiKey) { console.error('VOYAGE_API_KEY missing'); process.exit(1); }

const t0 = Date.now();
try {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      input: ['Extract tables from this financial report PDF'],
      model: 'voyage-3',
      input_type: 'query',
    }),
  });
  if (!res.ok) {
    console.error(`VOYAGE ${res.status}:`, await res.text());
    process.exit(1);
  }
  const json = await res.json();
  const vec = json.data?.[0]?.embedding ?? [];
  console.log('model:    voyage-3');
  console.log('dim:     ', vec.length);
  console.log('first 4: ', vec.slice(0, 4).map((x) => x.toFixed(4)).join(', '));
  console.log('latency: ', `${Date.now() - t0}ms`);
  if (vec.length !== 1024) { console.error(`expected 1024, got ${vec.length}`); process.exit(1); }
  console.log('voyage smoke OK');
} catch (err) {
  console.error('VOYAGE FAIL:', err.message);
  process.exit(1);
}

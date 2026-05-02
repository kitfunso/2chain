import { fetchIncomeStatement } from '../src/services/secEdgar.js';

const ticker = process.argv[2] ?? 'NVDA';
const t0 = Date.now();
try {
  const result = await fetchIncomeStatement(ticker);
  const elapsed = Date.now() - t0;
  console.log(`fetched ${ticker} in ${elapsed}ms\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`FAILED in ${Date.now() - t0}ms:`, (e as Error).message);
  process.exit(1);
}

import { REAL_CORPUS, REAL_CORPUS_BY_DOMAIN } from '../src/fixtures/real-corpus.js';
console.log('total:', REAL_CORPUS.length);
for (const [d, arr] of Object.entries(REAL_CORPUS_BY_DOMAIN)) {
  console.log(' ', d.padEnd(12), arr.length);
}

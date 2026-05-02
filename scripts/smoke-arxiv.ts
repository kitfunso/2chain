import { searchArxiv } from '../src/services/arxivSearch.js';
const r = await searchArxiv(process.argv[2] ?? 'mamba state space', 3);
console.log(`fetched ${r.results.length}/${r.total_results} results`);
for (const p of r.results) {
  console.log(`\n  [${p.arxiv_id}] ${p.title}`);
  console.log(`  authors: ${p.authors.slice(0,3).join(', ')}${p.authors.length>3?'...':''}`);
  console.log(`  published: ${p.published}`);
  console.log(`  abstract: ${p.abstract.slice(0,200)}...`);
}

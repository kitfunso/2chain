// Real-fetch helpers for the github-search, npm-search, and wikipedia-search
// callable stubs. All three use unauthenticated public APIs; GitHub uses the
// optional GITHUB_TOKEN secret if present (lifts rate limit 60 -> 5000/hr).

const FETCH_TIMEOUT_MS = 6000;
const USER_AGENT = '2chain-web-search/1.0';

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json', ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ---------- GitHub repo search ----------

export interface GithubRepoHit {
  full_name: string;
  description: string;
  stargazers_count: number;
  html_url: string;
  pushed_at: string;
  language: string | null;
}

interface GhSearchResp { total_count: number; items: GithubRepoHit[] }

export async function searchGithubRepos(query: string, limit = 10): Promise<{ query: string; total_count: number; results: GithubRepoHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${cap}`;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (tok) headers.authorization = `Bearer ${tok}`;
  const j = await fetchJson<GhSearchResp>(url, headers);
  const results = (j.items || []).map((r) => ({
    full_name: r.full_name,
    description: (r.description || '').trim(),
    stargazers_count: r.stargazers_count,
    html_url: r.html_url,
    pushed_at: r.pushed_at,
    language: r.language,
  }));
  return { query, total_count: j.total_count, results };
}

// ---------- npm package search ----------

export interface NpmHit {
  name: string;
  version: string;
  description: string;
  links: { npm?: string; homepage?: string; repository?: string };
  publisher?: { username: string };
}

interface NpmSearchResp { total: number; objects: Array<{ package: NpmHit; score: { final: number } }> }

export async function searchNpm(query: string, limit = 10): Promise<{ query: string; total: number; results: Array<NpmHit & { score: number }> }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${cap}`;
  const j = await fetchJson<NpmSearchResp>(url);
  return {
    query,
    total: j.total,
    results: j.objects.map((o) => ({ ...o.package, score: o.score.final })),
  };
}

// ---------- Wikipedia opensearch + extract ----------

export interface WikiHit { title: string; description: string; url: string }

export async function searchWikipedia(query: string, limit = 10): Promise<{ query: string; results: WikiHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 20);
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${cap}&namespace=0&format=json&origin=*`;
  // opensearch returns a fixed 4-tuple: [query, [titles], [descriptions], [urls]]
  const arr = await fetchJson<[string, string[], string[], string[]]>(url);
  const titles = arr[1] || [];
  const descs = arr[2] || [];
  const urls = arr[3] || [];
  const results: WikiHit[] = titles.map((title, i) => ({
    title,
    description: descs[i] || '',
    url: urls[i] || '',
  }));
  return { query, results };
}

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

// ---------- Hacker News (Algolia) search ----------

export interface HNHit {
  title: string;
  points: number;
  url: string;
  story_id: string;
}

interface HNAlgoliaResp {
  hits: Array<{
    title?: string;
    story_title?: string;
    points?: number;
    url?: string;
    story_url?: string;
    objectID: string;
  }>;
  nbHits: number;
}

export async function searchHackerNews(query: string, limit = 10): Promise<{ query: string; total: number; results: HNHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${cap}&tags=story`;
  const j = await fetchJson<HNAlgoliaResp>(url);
  const results = (j.hits || []).map((h) => ({
    title: (h.title || h.story_title || '').trim(),
    points: typeof h.points === 'number' ? h.points : 0,
    url: h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    story_id: h.objectID,
  }));
  return { query, total: j.nbHits, results };
}

// ---------- Stack Overflow search ----------

export interface SOHit {
  title: string;
  score: number;
  link: string;
  is_answered: boolean;
}

interface SOResp {
  items: Array<{
    title: string;
    score: number;
    link: string;
    is_answered: boolean;
  }>;
  total?: number;
}

export async function searchStackOverflow(query: string, limit = 10): Promise<{ query: string; results: SOHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${cap}`;
  const j = await fetchJson<SOResp>(url);
  const results = (j.items || []).map((q) => ({
    title: q.title,
    score: q.score,
    link: q.link,
    is_answered: !!q.is_answered,
  }));
  return { query, results };
}

// ---------- Reddit search ----------

export interface RedditHit {
  title: string;
  score: number;
  permalink: string;
  subreddit: string;
}

interface RedditResp {
  data?: {
    children?: Array<{
      data: {
        title: string;
        score: number;
        permalink: string;
        subreddit: string;
      };
    }>;
  };
}

export async function searchReddit(query: string, limit = 10): Promise<{ query: string; results: RedditHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${cap}&sort=relevance`;
  // Reddit blocks blank User-Agent — set explicit per spec.
  const j = await fetchJson<RedditResp>(url, { 'User-Agent': '2chain/0.1' });
  const children = j.data?.children ?? [];
  const results = children.map((c) => ({
    title: c.data.title,
    score: c.data.score,
    permalink: `https://www.reddit.com${c.data.permalink}`,
    subreddit: c.data.subreddit,
  }));
  return { query, results };
}

// ---------- PyPI exact-match package lookup ----------

export interface PyPIHit {
  name: string;
  version: string;
  summary: string;
  project_urls: Record<string, string>;
}

interface PyPIResp {
  info?: {
    name: string;
    version: string;
    summary: string | null;
    project_urls: Record<string, string> | null;
  };
}

export async function searchPyPIPackage(name: string): Promise<{ query: string; results: PyPIHit[] }> {
  const trimmed = name.trim();
  const url = `https://pypi.org/pypi/${encodeURIComponent(trimmed)}/json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (res.status === 404) {
      return { query: trimmed, results: [] };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const j = (await res.json()) as PyPIResp;
    const info = j.info;
    if (!info) return { query: trimmed, results: [] };
    return {
      query: trimmed,
      results: [{
        name: info.name,
        version: info.version,
        summary: info.summary ?? '',
        project_urls: info.project_urls ?? {},
      }],
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------- crates.io search ----------

export interface CratesHit {
  name: string;
  max_version: string;
  description: string;
  downloads: number;
}

interface CratesResp {
  crates: Array<{
    name: string;
    max_version: string;
    description: string | null;
    downloads: number;
  }>;
  meta?: { total?: number };
}

export async function searchCratesIO(query: string, limit = 10): Promise<{ query: string; total: number; results: CratesHit[] }> {
  const cap = Math.min(Math.max(limit, 1), 25);
  const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${cap}`;
  // crates.io blocks blank User-Agent — set explicit per spec.
  const j = await fetchJson<CratesResp>(url, { 'User-Agent': '2chain/0.1' });
  const results = (j.crates || []).map((c) => ({
    name: c.name,
    max_version: c.max_version,
    description: (c.description || '').trim(),
    downloads: c.downloads,
  }));
  return { query, total: j.meta?.total ?? results.length, results };
}

// Real arxiv.org API client. No baked content.
// Hits https://export.arxiv.org/api/query — returns Atom XML, we parse the
// <entry> blocks for title, abstract, authors, id, published date.
// Free, no API key, used by hundreds of papers-related tools.

const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';
const FETCH_TIMEOUT_MS = 4000;
const USER_AGENT = '2chain hackathon demo (skfskf27@gmail.com)';

export interface ArxivPaper {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  url: string;
  pdf_url: string;
}

export interface ArxivSearchResult {
  query: string;
  results: ArxivPaper[];
  total_results: number;
  fetched_at: string;
  source_url: string;
}

export class ArxivFetchError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export async function searchArxiv(query: string, limit = 3): Promise<ArxivSearchResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new ArxivFetchError('query is required', 'bad_input');
  }
  const cappedLimit = Math.min(Math.max(limit, 1), 10);

  // arxiv search query syntax: all:term1+AND+all:term2 — keeps it simple by
  // joining query tokens with AND so multi-word queries narrow results.
  const tokens = cleanQuery.split(/\s+/).filter((t) => t.length > 1);
  const searchQuery = tokens.length > 1
    ? tokens.map((t) => `all:${encodeURIComponent(t)}`).join('+AND+')
    : `all:${encodeURIComponent(cleanQuery)}`;
  const url = `${ARXIV_ENDPOINT}?search_query=${searchQuery}&start=0&max_results=${cappedLimit}&sortBy=relevance`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/atom+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(t);
    throw new ArxivFetchError(`arxiv fetch failed: ${(e as Error).message}`, 'fetch_failed');
  }
  clearTimeout(t);

  if (!res.ok) {
    throw new ArxivFetchError(`arxiv returned HTTP ${res.status}`, 'http_error');
  }

  const xml = await res.text();
  const totalMatch = xml.match(/<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/);
  const totalResults = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const papers: ArxivPaper[] = entries.map((m) => parseEntry(m[1]));

  return {
    query: cleanQuery,
    results: papers,
    total_results: totalResults,
    fetched_at: new Date().toISOString(),
    source_url: url,
  };
}

function parseEntry(entryXml: string): ArxivPaper {
  const idMatch = entryXml.match(/<id>([^<]+)<\/id>/);
  const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
  const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
  const publishedMatch = entryXml.match(/<published>([^<]+)<\/published>/);
  const authorMatches = [...entryXml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)];
  const pdfLinkMatch = entryXml.match(/<link[^>]*href="([^"]+)"[^>]*type="application\/pdf"/);

  const fullId = idMatch?.[1] ?? '';
  const arxivId = fullId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();

  return {
    arxiv_id: arxivId,
    title: collapseWhitespace(titleMatch?.[1] ?? ''),
    authors: authorMatches.map((a) => a[1].trim()),
    abstract: collapseWhitespace(summaryMatch?.[1] ?? ''),
    published: publishedMatch?.[1] ?? '',
    url: fullId,
    pdf_url: pdfLinkMatch?.[1] ?? '',
  };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

import { asString, type ToolContext, type ToolDescriptor } from './types';

// Web tools — both read-only, both free.

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_CHARS = 8000;
const MAX_RESULTS = 8;

function timeoutSignal(ctx: ToolContext): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function unwrapDdgLink(href: string): string {
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href);
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

const webSearchTool: ToolDescriptor = {
  spec: {
    name: 'web_search',
    description:
      'Search the web and return the top results (title, URL, snippet). ' +
      'Use web_fetch afterwards to read a specific page.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query'],
    },
  },
  async execute(input, ctx) {
    const query = asString(input['query']);
    if (!query) return 'Error: `query` is required.';
    try {
      const res = await fetch(SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal: timeoutSignal(ctx),
      });
      if (!res.ok) return `Search failed: HTTP ${res.status}.`;
      const html = await res.text();
      const anchorRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRe =
        /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetRe.exec(html)) !== null) {
        snippets.push(stripTags(sm[1] ?? ''));
      }
      const results: string[] = [];
      let am: RegExpExecArray | null;
      let i = 0;
      while ((am = anchorRe.exec(html)) !== null && results.length < MAX_RESULTS) {
        const url = unwrapDdgLink(am[1] ?? '');
        const title = stripTags(am[2] ?? '');
        const snippet = snippets[i] ?? '';
        i += 1;
        if (!title) continue;
        results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippet}`);
      }
      if (results.length === 0) return `No results for "${query}".`;
      return `Search results for "${query}":\n\n${results.join('\n\n')}`;
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      return aborted
        ? 'Search was cancelled or timed out.'
        : `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const webFetchTool: ToolDescriptor = {
  spec: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text content (HTML is stripped to text).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['url'],
    },
  },
  async execute(input, ctx) {
    const url = asString(input['url']);
    if (!url) return 'Error: `url` is required.';
    if (!/^https?:\/\//i.test(url)) return 'Error: `url` must be an http(s) URL.';
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: timeoutSignal(ctx),
      });
      if (!res.ok) return `Fetch failed: HTTP ${res.status} for ${url}.`;
      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const text = /html/i.test(contentType) ? stripTags(raw) : raw.trim();
      const clipped =
        text.length > MAX_FETCH_CHARS
          ? `${text.slice(0, MAX_FETCH_CHARS)}\n… (${text.length - MAX_FETCH_CHARS} more chars truncated)`
          : text;
      return `Fetched ${url}\n\n${clipped}`;
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      return aborted
        ? 'Fetch was cancelled or timed out.'
        : `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const webToolDescriptors: ToolDescriptor[] = [webSearchTool, webFetchTool];

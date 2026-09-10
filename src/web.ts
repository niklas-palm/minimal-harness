// The two web tools.
//
//  - web_fetch: fetch a page and hand the model readable text instead of raw
//    HTML. Plain code, no infrastructure, always on.
//  - web_search: AWS's managed AgentCore Web Search connector, reached through
//    an AgentCore Gateway. The gateway speaks MCP, but calling one tool is a
//    single HTTP POST (a JSON-RPC `tools/call`), so we make that call directly
//    instead of pulling in an MCP client. Keyless: the request is SigV4-signed
//    with the runtime role, which the stack grants InvokeGateway on the gateway.
//    Wired only when WEB_SEARCH_GATEWAY_URL is set (see agent.ts); the stack
//    sets it when webSearch is true in config.json.

import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { z } from 'zod';

import { REGION, WEB_SEARCH_GATEWAY_URL } from './config.js';
import { tool } from './tools.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_FETCH_CHARS = 50_000; // what the model gets, after HTML is stripped
const TEXT_TYPES = ['text/', 'application/json', 'application/xhtml+xml', 'application/xml'];

const SEARCH_TIMEOUT_MS = 30_000;
// Gateway tools are named `<target>___<tool>`; the target is created in cdk/.
const GATEWAY_TOOL = 'web-search___WebSearch';

// --- web_fetch --------------------------------------------------------------

// Good-enough HTML to text: drop scripts and styles, turn block ends into
// newlines, strip the rest of the tags, decode the common entities, collapse
// whitespace. Keeps the <title> as a heading so the model knows what it read.
function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return title ? `# ${title}\n\n${text}` : text;
}

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'harness/0.2 (+https://github.com/niklas-palm/minimal-harness)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!TEXT_TYPES.some((t) => type.startsWith(t))) {
    throw new Error(`unsupported content type: ${type || 'unknown'}`);
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_FETCH_BYTES) throw new Error(`page too large (${bytes.byteLength} bytes)`);
  const raw = new TextDecoder().decode(bytes);
  const text = type.includes('html') ? htmlToText(raw) : raw;
  return { url: res.url, content: text.slice(0, MAX_FETCH_CHARS), truncated: text.length > MAX_FETCH_CHARS };
}

export const webFetch = tool({
  name: 'web_fetch',
  description: `Fetch a public web page and return its readable text: HTML is stripped to
text, scripts and styles are dropped. Use it to read a web_search result or
any url you're given. Follows redirects. Returns at most ${MAX_FETCH_CHARS}
characters and sets truncated when the page was longer. Text, HTML and JSON
only, no binaries.`,
  inputSchema: z.object({
    url: z.string().describe('The http(s) url to fetch.'),
  }),
  callback: async ({ url }) => {
    try {
      return await fetchText(url);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), hint: 'check the url; some sites block automated fetches' };
    }
  },
});

// --- web_search -------------------------------------------------------------

const signer = new SignatureV4({
  service: 'bedrock-agentcore',
  region: REGION,
  credentials: defaultProvider(),
  sha256: Sha256,
});

interface SearchResult {
  title?: string;
  url?: string;
  text: string;
  publishedDate?: string;
}

async function search(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = new URL(WEB_SEARCH_GATEWAY_URL);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'web_search',
    method: 'tools/call',
    params: { name: GATEWAY_TOOL, arguments: { query, maxResults } },
  });
  const signed = await signer.sign({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: { host: url.host, 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const rpc = (await res.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (rpc.error) throw new Error(rpc.error.message ?? 'gateway error');
  const text = rpc.result?.content?.[0]?.text ?? '';
  if (rpc.result?.isError) throw new Error(text || 'search failed');
  return (JSON.parse(text) as { results?: SearchResult[] }).results ?? [];
}

export const webSearch = tool({
  name: 'web_search',
  description: `Search the web. Returns results with title, url, a text snippet and
publication date. Use short, specific queries. To read a result in full,
web_fetch its url.`,
  inputSchema: z.object({
    query: z.string().max(200).describe('Search query (200 chars max).'),
    max_results: z.number().int().min(1).max(25).optional().describe('How many results to return (default 5).'),
  }),
  callback: async ({ query, max_results = 5 }) => {
    try {
      return { results: await search(query, max_results) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), hint: 'retry, or try a different query' };
    }
  },
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Reads a response body, aborting as soon as it exceeds maxBytes (chunked bodies have no length header). */
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > maxBytes) throw new HttpError('response too large');
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError('response too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * HTTP client used by every source.
 *  - Only https URLs on an explicit host allowlist can be fetched, so a tampered
 *    feed cannot make the runner request arbitrary internal or third-party URLs.
 *  - Conditional requests (ETag / Last-Modified) avoid re-downloading unchanged feeds.
 *  - Responses are size-capped and time-limited.
 *  - In fixture mode, URLs are mapped to local files for deterministic tests.
 */
export function createHttpClient({ allowedHosts, userAgent, cache = {}, fixturesDir = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));

  function checkUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(`invalid URL: ${String(raw).slice(0, 120)}`);
    }
    if (url.protocol !== 'https:') throw new HttpError(`blocked non-https URL: ${url.origin}`);
    if (!hosts.has(url.hostname.toLowerCase())) throw new HttpError(`blocked host not on allowlist: ${url.hostname}`);
    return url;
  }

  async function fromFixture(url) {
    const key = `${url.hostname}${url.pathname}${url.search}`.replace(/[^A-Za-z0-9._-]+/g, '_');
    const candidates = [key, `${url.hostname}${url.pathname}`.replace(/[^A-Za-z0-9._-]+/g, '_')];
    for (const name of candidates) {
      try {
        return await readFile(path.join(fixturesDir, name), 'utf8');
      } catch {
        /* try next candidate */
      }
    }
    throw new HttpError(`no fixture for ${url.href} (looked for ${candidates.join(', ')})`, 404);
  }

  /**
   * Returns { text, notModified, hash }. When the server answers 304, text is null
   * and the caller should reuse its previous result.
   */
  async function getText(rawUrl, { conditional = false, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    const url = checkUrl(rawUrl);
    if (fixturesDir) {
      const text = await fromFixture(url);
      return { text, notModified: false, hash: sha256(text) };
    }

    const headers = { 'User-Agent': userAgent, Accept: '*/*' };
    const prior = conditional ? cache[url.href] : null;
    if (prior?.etag) headers['If-None-Match'] = prior.etag;
    if (prior?.lastModified) headers['If-Modified-Since'] = prior.lastModified;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    let res;
    try {
      res = await fetchImpl(url.href, { headers, signal: ctrl.signal, redirect: 'follow' });
    } catch (err) {
      throw new HttpError(err.name === 'AbortError' ? `timeout after ${requestTimeoutMs / 1000}s` : `network error: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.url) checkUrl(res.url);
    if (res.status === 304 && prior) return { text: null, notModified: true, hash: prior.hash };
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new HttpError(`response too large (${declared} bytes)`);
    const text = await readCapped(res, MAX_RESPONSE_BYTES);

    const hash = sha256(text);
    if (conditional) {
      cache[url.href] = {
        etag: res.headers.get('etag') || undefined,
        lastModified: res.headers.get('last-modified') || undefined,
        hash
      };
    }
    return { text, notModified: false, hash };
  }

  async function getJson(rawUrl, opts) {
    const r = await getText(rawUrl, opts);
    if (r.notModified) return { ...r, json: null };
    try {
      return { ...r, json: JSON.parse(r.text) };
    } catch {
      throw new HttpError('invalid JSON response');
    }
  }

  return { getText, getJson };
}

/** Runs async tasks with a concurrency cap. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

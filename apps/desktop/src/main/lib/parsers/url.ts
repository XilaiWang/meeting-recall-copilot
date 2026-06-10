import { BrowserWindow } from 'electron';
import { truncate } from './common.js';
import type { ParseOptions } from './github.js';
import { isBlockedHostname } from './url-guard.js';

// Why: minimum meaningful text length from a static fetch. Pages below this
// threshold are likely SPAs that render content via client-side JS and need
// the Electron BrowserWindow fallback to get actual content.
const STATIC_MIN_CHARS = 500;

// Why: SPA hydration (React/Next/Vue) typically completes within 3s. 4s gives
// a comfortable margin without making the UX feel stuck.
const SPA_SETTLE_MS = 4000;
const SPA_TIMEOUT_MS = 30_000;

// Why: only http(s) is a valid source for fetched material. Blocking other
// schemes (file:, data:, javascript:) stops a crafted URL from making the fetch
// path or the BrowserWindow SPA fallback read local files or execute non-web
// content. Cheap defence-in-depth even though URLs are user-entered.
function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('无效的网址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 网址');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('不支持访问本机或内网地址');
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Why: prefer article/main body content when present (basic Readability heuristic).
    .replace(/[\s\S]*?(<(?:article|main)[^>]*>[\s\S]*<\/(?:article|main)>)[\s\S]*/i, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim();
}

// Why: SPA fallback uses an Electron BrowserWindow to fully render the page
// with its JavaScript runtime. After did-finish-load + a settle delay, we
// execute document.body.innerText in the renderer context — no JSDOM or
// Puppeteer needed, Electron IS the browser engine.
async function fetchViaSpa(url: string, signal?: AbortSignal): Promise<string> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { reject(new Error('已取消')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      const timeout = setTimeout(() => { cleanup(); reject(new Error('SPA 页面加载超时')); }, SPA_TIMEOUT_MS);

      win.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timeout); cleanup(); reject(new Error(`页面加载失败 (${code}): ${desc}`));
      });
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeout); cleanup(); resolve();
      });

      win.loadURL(url).catch((err: unknown) => {
        clearTimeout(timeout); cleanup(); reject(err);
      });
    });

    // Allow SPA JavaScript to hydrate before extracting content.
    await new Promise<void>((r) => setTimeout(r, SPA_SETTLE_MS));

    const text = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""',
    ) as string;
    return typeof text === 'string' ? text.replace(/\n{3,}/g, '\n\n').trim() : '';
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Why: tries metadata sources in priority order before falling back to title parsing,
// because og:site_name is the most accurate signal for company identity.
function extractCompanyName(html: string, url: string): string {
  const attr = (re: RegExp) => re.exec(html)?.[1]?.trim() ?? '';

  const ogSite = attr(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,80})["']/i)
    || attr(/<meta[^>]+content=["']([^"']{1,80})["'][^>]+property=["']og:site_name["']/i);
  if (ogSite) return ogSite;

  const appName = attr(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']{1,80})["']/i)
    || attr(/<meta[^>]+content=["']([^"']{1,80})["'][^>]+name=["']application-name["']/i);
  if (appName) return appName;

  const title = attr(/<title[^>]*>([^<]{1,120})<\/title>/i);
  if (title) {
    const parts = title.split(/\s*[-|–—·]\s*/);
    const candidate = (parts[0]) ?? '';
    if (candidate.length > 1) return candidate.trim().slice(0, 60);
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname.split('.')[0]?.slice(0, 40) ?? hostname;
  } catch {
    return '';
  }
}

export async function parseCompanyUrl(url: string, opts: ParseOptions = {}): Promise<{ companyName: string; content: string }> {
  assertHttpUrl(url);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);

  let companyName = '';
  let staticText = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qa-matching-bot/1.0)' },
      signal: combinedSignal,
    });
    if (res.ok) {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/html') || contentType === '') {
        const html = await res.text();
        companyName = extractCompanyName(html, url);
        staticText = stripHtml(html);
      }
    }
  } catch { /* SPA fallback below */ }

  let content = staticText.length >= STATIC_MIN_CHARS ? truncate(staticText) : '';
  if (!content) {
    const spaText = await fetchViaSpa(url, opts.signal);
    if (spaText.length < 50) throw new Error('页面内容太少，无法解析');
    content = truncate(spaText);
    if (!companyName) {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        companyName = hostname.split('.')[0]?.slice(0, 40) ?? hostname;
      } catch { companyName = ''; }
    }
  }

  return { companyName: companyName || new URL(url).hostname.replace(/^www\./, ''), content };
}

export async function parseWebUrl(url: string, opts: ParseOptions = {}): Promise<string> {
  assertHttpUrl(url);
  // --- Static fetch (fast path) ---
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let staticText = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qa-matching-bot/1.0)' },
      signal: combinedSignal,
    });
    if (res.ok) {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/html') || contentType === '') {
        staticText = stripHtml(await res.text());
      }
    }
  } catch {
    // Swallow fetch errors here; SPA path will retry loading via Electron.
  }

  if (staticText.length >= STATIC_MIN_CHARS) {
    return truncate(staticText);
  }

  // --- SPA fallback (Electron BrowserWindow) ---
  const spaText = await fetchViaSpa(url, opts.signal);
  if (spaText.length < 50) throw new Error('页面内容太少，无法解析');
  return truncate(spaText);
}

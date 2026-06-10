// Why: SSRF guard kept in a dependency-free module (no electron import) so it stays
// unit-testable in a plain node env — url.ts itself imports electron's BrowserWindow
// for the SPA fallback, which can't load under vitest. See url.test.ts.
//
// URL material is user-entered and gets fetched — and, for the SPA fallback, rendered
// + innerText-read — by the main process. Block hosts pointing at the local machine /
// private network / cloud metadata so a crafted URL can't make us read internal
// services (e.g. http://169.254.169.254/, http://127.0.0.1/, http://192.168.x.x/).
// This blocks literal addresses + obvious local names; it does NOT resolve DNS, so a
// public hostname resolving to a private IP (DNS rebinding) is a known follow-up
// beyond this layer.

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                            // 0.0.0.0/8 "this host"
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // private
  if (a === 172 && b >= 16 && b <= 31) return true;    // private
  if (a === 192 && b === 168) return true;             // private
  if (a === 169 && b === 254) return true;             // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) { // IPv6 (URL.hostname strips the [] brackets)
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;                 // loopback / unspecified
    if (h.startsWith('fc') || h.startsWith('fd')) return true;  // unique local fc00::/7
    if (h.startsWith('fe80')) return true;                      // link-local
    const mapped = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped ::ffff:a.b.c.d
    if (mapped) return isBlockedIpv4(mapped[1]!);
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host); // IPv4 literal
  return false;
}

import { describe, it, expect } from 'vitest';
import { isBlockedHostname } from './url-guard.js';

describe('isBlockedHostname (SSRF guard)', () => {
  it('blocks localhost and local/internal suffixes', () => {
    for (const h of ['localhost', 'foo.localhost', 'router.local', 'svc.internal']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });

  it('blocks loopback / private / link-local IPv4 (incl. cloud metadata)', () => {
    for (const h of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });

  it('blocks loopback / ULA / link-local IPv6 and IPv4-mapped', () => {
    for (const h of ['::1', '::', 'fc00::1', 'fd12::34', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });

  it('allows ordinary public hosts and public IPs', () => {
    for (const h of ['example.com', 'github.com', 'api.openai.com', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedHostname(h)).toBe(false);
    }
  });
});

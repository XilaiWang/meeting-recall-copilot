import { describe, it, expect } from 'vitest';
import {
  zhBigrams, tokenize, injectBigrams, buildFtsMatchQuery, countMatchedTokens,
  rrfFuse, passesGate, cardContentHash, buildPassageText,
  GATE_HIGH_COSINE,
} from './hybrid-retrieval.js';

describe('tokenization', () => {
  it('zhBigrams emits adjacent CJK bigrams, ignores Latin', () => {
    expect(zhBigrams('缓存层')).toBe('缓存 存层');
    expect(zhBigrams('redis cache')).toBe('');
  });

  it('tokenize keeps Latin ≥3 + CJK single/bigram, drops 1-char', () => {
    const t = tokenize('Redis 缓存');
    expect(t).toContain('redis');
    expect(t).toContain('缓存'); // bigram
    expect(t.every((x) => x.length >= 2)).toBe(true);
  });

  it('injectBigrams appends bigrams so FTS can match 2-char Chinese', () => {
    expect(injectBigrams('Redis缓存层')).toBe('Redis缓存层 缓存 存层');
    expect(injectBigrams('plain english')).toBe('plain english'); // no CJK → unchanged
  });

  it('buildFtsMatchQuery quotes + ORs tokens, escapes inner quotes, empty when no tokens', () => {
    expect(buildFtsMatchQuery('缓存 模型')).toContain('"缓存"');
    expect(buildFtsMatchQuery('缓存 模型')).toContain(' OR ');
    expect(buildFtsMatchQuery('   ')).toBe('');
    expect(buildFtsMatchQuery('a"b cache')).toContain('"cache"'); // safe quote
    expect(buildFtsMatchQuery('a"b cache')).not.toMatch(/[^"]"[^"]/); // no stray unescaped quote
  });

  it('countMatchedTokens counts distinct query tokens present in card text', () => {
    expect(countMatchedTokens('Redis 缓存层 命中率', ['redis', '缓存', '其他'])).toBe(2);
    expect(countMatchedTokens('无关文本', ['redis'])).toBe(0);
  });
});

describe('rrfFuse', () => {
  it('merges two ranked lists, item in both ranks above items in one', () => {
    const fused = rrfFuse(['a', 'b', 'c'], ['b', 'd']);
    // b appears in both lists → highest RRF
    expect(fused[0]!.cardId).toBe('b');
    expect(fused[0]!.vecRank).toBe(1);
    expect(fused[0]!.ftsRank).toBe(0);
    expect(fused.map((h) => h.cardId).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('uses 1-based rank in 1/(k+rank): rank-0 item scores 1/(k+1)', () => {
    const fused = rrfFuse(['x'], [], 60);
    expect(fused[0]!.rrf).toBeCloseTo(1 / 61, 10);
  });

  it('higher rank (earlier) contributes more than lower rank', () => {
    const fused = rrfFuse(['top', 'bottom'], []);
    expect(fused[0]!.cardId).toBe('top');
    expect(fused[0]!.rrf).toBeGreaterThan(fused[1]!.rrf);
  });
});

describe('passesGate (hybrid lexical-OR-high-cosine)', () => {
  it('passes when lexical overlap meets the floor (≥2 of a multi-token query)', () => {
    expect(passesGate({ topMatchedTokens: 2, queryTokenCount: 5, topCosine: 0.1 })).toBe(true);
  });

  it('passes a pure-paraphrase (0 lexical overlap) only via high cosine', () => {
    expect(passesGate({ topMatchedTokens: 0, queryTokenCount: 5, topCosine: GATE_HIGH_COSINE })).toBe(true);
    expect(passesGate({ topMatchedTokens: 0, queryTokenCount: 5, topCosine: 0.88 })).toBe(false);
  });

  it('a single-token query only needs its one token (not over-suppressed)', () => {
    expect(passesGate({ topMatchedTokens: 1, queryTokenCount: 1, topCosine: 0.1 })).toBe(true);
  });

  it('rejects weak matches: low lexical AND low cosine', () => {
    expect(passesGate({ topMatchedTokens: 1, queryTokenCount: 5, topCosine: 0.8 })).toBe(false);
  });

  it('handles no vector hit (cosine null) by relying on lexical', () => {
    expect(passesGate({ topMatchedTokens: 2, queryTokenCount: 3, topCosine: null })).toBe(true);
    expect(passesGate({ topMatchedTokens: 0, queryTokenCount: 3, topCosine: null })).toBe(false);
  });

  it('empty query never passes', () => {
    expect(passesGate({ topMatchedTokens: 0, queryTokenCount: 0, topCosine: 0.99 })).toBe(false);
  });
});

describe('cardContentHash + buildPassageText', () => {
  it('hash is stable for same content, changes when an embedded field changes', () => {
    const a = { title: 'T', summary: 'S', details: 'D', tags: ['x', 'y'] };
    const b = { title: 'T', summary: 'S', details: 'D', tags: ['x', 'y'] };
    const c = { title: 'T2', summary: 'S', details: 'D', tags: ['x', 'y'] };
    expect(cardContentHash(a)).toBe(cardContentHash(b));
    expect(cardContentHash(a)).not.toBe(cardContentHash(c));
  });

  it('buildPassageText joins title+summary+details and caps length', () => {
    expect(buildPassageText({ title: 'T', summary: 'S', details: 'D' })).toBe('T。S。D');
    const long = buildPassageText({ title: 'T', summary: 'S', details: 'x'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(1800);
  });
});

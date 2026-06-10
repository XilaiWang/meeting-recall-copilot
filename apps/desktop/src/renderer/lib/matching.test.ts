import { describe, it, expect } from 'vitest';
import { detectAsrLocale, extractContextWords, type ScoredCard } from './matching.js';

// Why: the lexical retrieval helpers (matchCards/scoreCard/tokenize/zhBigrams/…) moved
// to the main-process hybrid-retrieval engine (tested in main/lib/hybrid-retrieval.test.ts).
// Only these two renderer-side helpers remain here.

function card(over: Partial<ScoredCard> = {}): ScoredCard {
  return {
    id: 'c1', projectId: 'p1', sourceMaterialId: null, type: 'tech_principle',
    title: '', summary: '', details: '', tags: [], language: 'zh', confidence: 0.5,
    userVerified: false, isImportant: false,
    createdAt: new Date(), updatedAt: new Date(),
    fsrsDue: null, fsrsStability: null, fsrsDifficulty: null, fsrsElapsedDays: null,
    fsrsScheduledDays: null, fsrsReps: null, fsrsLapses: null, fsrsLearningSteps: null, fsrsState: null,
    score: 1,
    ...over,
  };
}

describe('extractContextWords', () => {
  it('collects tags + ≥2-char title words from the top 3 cards', () => {
    const words = extractContextWords([
      card({ title: '深度学习 模型', tags: ['ai', 'pytorch'] }),
      card({ title: 'Redis 缓存', tags: ['db'] }),
    ]);
    expect(words).toContain('ai');
    expect(words).toContain('pytorch');
    expect(words).toContain('深度学习');
    expect(words).toContain('Redis');
  });

  it('only considers the first 3 cards and caps at 50 words', () => {
    const many = Array.from({ length: 10 }, (_, i) => card({ title: `卡片${i}`, tags: [`tag${i}`] }));
    const words = extractContextWords(many);
    expect(words).not.toContain('tag5'); // beyond the top 3
    expect(words.length).toBeLessThanOrEqual(50);
  });
});

describe('detectAsrLocale', () => {
  it('returns zh-CN when Chinese chars are ≥30%', () => {
    // 8 Chinese / (8 + 7 English) ≈ 53% → zh-CN
    expect(detectAsrLocale('这是一个中文测试 english')).toBe('zh-CN');
  });
  it('returns en-US when English dominates', () => {
    expect(detectAsrLocale('this is mostly english with 一 char')).toBe('en-US');
  });
  it('defaults to zh-CN on too-short samples', () => {
    expect(detectAsrLocale('hi')).toBe('zh-CN');
  });
});

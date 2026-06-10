import { describe, it, expect } from 'vitest';
import { applyCorrectionRules, parseCorrectionRules, type CorrectionRule } from './correction.js';

const rule = (pattern: string, replacement: string, enabled = true): CorrectionRule => ({ pattern, replacement, enabled });

describe('applyCorrectionRules', () => {
  it('does a literal substring replacement', () => {
    expect(applyCorrectionRules('jizzle is great', [rule('jizzle', 'Drizzle')])).toBe('Drizzle is great');
  });
  it('replaces every occurrence', () => {
    expect(applyCorrectionRules('cube net and cube net', [rule('cube net', 'Kubernetes')]))
      .toBe('Kubernetes and Kubernetes');
  });
  it('skips disabled rules', () => {
    expect(applyCorrectionRules('jizzle', [rule('jizzle', 'Drizzle', false)])).toBe('jizzle');
  });
  it('applies rules in order', () => {
    expect(applyCorrectionRules('a', [rule('a', 'b'), rule('b', 'c')])).toBe('c');
  });
  it('an empty replacement deletes the matched text', () => {
    expect(applyCorrectionRules('foobarbaz', [rule('bar', '')])).toBe('foobaz');
  });

  describe('{num} wildcard', () => {
    it('captures an ASCII number and substitutes it', () => {
      expect(applyCorrectionRules('第3版', [rule('第{num}版', 'v{num}')])).toBe('v3');
    });
    it('captures a Chinese numeral', () => {
      expect(applyCorrectionRules('第三版', [rule('第{num}版', 'v{num}')])).toBe('v三');
    });
    it('is a no-op when the pattern has more than one {num}', () => {
      expect(applyCorrectionRules('a1b2c', [rule('a{num}b{num}c', 'x')])).toBe('a1b2c');
    });
    it('is a no-op when the replacement uses {num} but the pattern does not', () => {
      expect(applyCorrectionRules('foo', [rule('foo', 'bar{num}')])).toBe('foo');
    });
  });

  it('treats regex-special chars in the pattern as literals', () => {
    expect(applyCorrectionRules('a.b', [rule('a.b', 'X')])).toBe('X');
    expect(applyCorrectionRules('axb', [rule('a.b', 'X')])).toBe('axb'); // '.' is literal, not "any char"
  });
  it('returns text unchanged for an empty pattern', () => {
    expect(applyCorrectionRules('hello', [rule('', 'X')])).toBe('hello');
  });
});

describe('parseCorrectionRules', () => {
  it('parses "听错 => 正确" lines (trimmed, enabled)', () => {
    expect(parseCorrectionRules('jizzle => Drizzle')).toEqual([rule('jizzle', 'Drizzle')]);
  });
  it('ignores blank lines and # comments', () => {
    expect(parseCorrectionRules('# a comment\n\njizzle => Drizzle\n')).toHaveLength(1);
  });
  it('skips lines without => or with an empty left side', () => {
    expect(parseCorrectionRules('no arrow here\n=> only right')).toEqual([]);
  });
  it('allows an empty replacement (deletion rule)', () => {
    expect(parseCorrectionRules('um =>')).toEqual([rule('um', '')]);
  });
});

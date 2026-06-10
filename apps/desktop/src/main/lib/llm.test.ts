import { describe, it, expect } from 'vitest';
import { stripThinkingBlocks, hasUnclosedThink } from './llm.js';

describe('stripThinkingBlocks', () => {
  it('removes a closed <think> block and keeps the rest', () => {
    expect(stripThinkingBlocks('<think>let me reason {a:1}</think>[{"x":1}]')).toBe('[{"x":1}]');
  });
  it('is case-insensitive and handles attributes', () => {
    expect(stripThinkingBlocks('<Think foo="bar">noise</Think>ok')).toBe('ok');
  });
  it('removes multiple blocks', () => {
    expect(stripThinkingBlocks('<think>a</think>X<think>b</think>Y')).toBe('XY');
  });
  it('leaves text without a block untouched', () => {
    expect(stripThinkingBlocks('[{"x":1}]')).toBe('[{"x":1}]');
  });
  it('does NOT remove an unclosed block (so the stream caller can wait)', () => {
    expect(stripThinkingBlocks('<think>still thinking {')).toBe('<think>still thinking {');
  });
});

describe('hasUnclosedThink', () => {
  it('is true when an open <think> has no matching close', () => {
    expect(hasUnclosedThink('<think>reasoning {a:1} not done yet')).toBe(true);
  });
  it('is false once the block is closed', () => {
    expect(hasUnclosedThink('<think>done</think>[{"x":1}]')).toBe(false);
  });
  it('is false when there is no think block at all', () => {
    expect(hasUnclosedThink('[{"x":1}]')).toBe(false);
  });
});

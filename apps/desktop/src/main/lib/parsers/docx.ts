import { readFileSync } from 'node:fs';
import mammoth from 'mammoth';
import { truncate } from './common.js';

export async function parseDocx(filePath: string): Promise<string> {
  const buffer = readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  if (text.length < 10) throw new Error('Word 文档内容为空');
  return truncate(text);
}

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { isAllowed, truncate, extOf } from './common.js';
import { parsePdf } from './pdf.js';
import { parseDocx } from './docx.js';
import { parsePptx } from './pptx.js';

async function parseOne(filePath: string): Promise<string> {
  const ext = extOf(basename(filePath));
  if (ext === 'pdf') return parsePdf(filePath);
  if (ext === 'docx' || ext === 'doc') return parseDocx(filePath);
  if (ext === 'pptx' || ext === 'ppt') return parsePptx(filePath);
  return truncate(readFileSync(filePath, 'utf8'));
}

function collectFiles(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, depth + 1));
    } else if (entry.isFile() && isAllowed(entry.name)) {
      const stat = statSync(full);
      if (stat.size < 50 * 1024 * 1024) results.push(full); // 50 MB per file
    }
  }
  return results.slice(0, 30);
}

export async function parseFilePath(filePath: string): Promise<string> {
  const stat = statSync(filePath);
  const files = stat.isDirectory() ? collectFiles(filePath) : [filePath];
  if (files.length === 0) throw new Error('没有找到支持的文件格式');

  const parts: string[] = [];
  for (const fp of files) {
    const content = await parseOne(fp);
    parts.push(`### ${basename(fp)}`, content, '');
  }
  return parts.join('\n');
}

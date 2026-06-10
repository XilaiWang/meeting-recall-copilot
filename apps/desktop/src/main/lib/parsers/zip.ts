import AdmZip from 'adm-zip';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAllowed, truncate, extOf } from './common.js';
import { parsePdf } from './pdf.js';
import { parseDocx } from './docx.js';
import { parsePptx } from './pptx.js';
import type { ParseOptions } from './github.js';

export async function parseZip(filePath: string, opts: ParseOptions = {}): Promise<string> {
  const { signal, onProgress } = opts;

  onProgress?.('正在读取 ZIP 文件…');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries()
    .filter((e) => !e.isDirectory && isAllowed(e.name) && e.header.size < 50 * 1024 * 1024)
    .slice(0, 30);

  if (entries.length === 0) throw new Error('ZIP 内没有找到支持的文件格式（代码、文档、PDF 等）');

  const parts: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const entry = entries[i]!;
    onProgress?.(`正在解压 ${i + 1}/${entries.length}：${entry.name}`);

    const ext = extOf(entry.name);
    let content: string;

    if (ext === 'pdf' || ext === 'docx' || ext === 'doc' || ext === 'pptx' || ext === 'ppt') {
      // Write to temp file, parse, then clean up
      const tmp = join(tmpdir(), `qa-${randomUUID()}.${ext}`);
      try {
        writeFileSync(tmp, entry.getData());
        if (ext === 'pdf') content = await parsePdf(tmp);
        else if (ext === 'docx' || ext === 'doc') content = await parseDocx(tmp);
        else content = parsePptx(tmp);
      } finally {
        unlinkSync(tmp);
      }
    } else {
      content = entry.getData().toString('utf8');
    }
    parts.push(`### ${entry.entryName}`, content, '');
  }
  return truncate(parts.join('\n'));
}

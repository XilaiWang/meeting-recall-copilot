import AdmZip from 'adm-zip';
import { truncate } from './common.js';

// Why: PPTX is a ZIP containing XML slides. We extract text nodes from each
// slide XML without a heavy dependency — sufficient for meeting prep use cases.
export function parsePptx(filePath: string): string {
  const zip = new AdmZip(filePath);
  const slides = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));

  if (slides.length === 0) throw new Error('无法解析 PPT 文件');

  const parts: string[] = [];
  for (const slide of slides) {
    const xml = slide.getData().toString('utf8');
    // Extract text from <a:t> tags (DrawingML text runs)
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)]
      .map((m) => m[1]?.trim())
      .filter(Boolean);
    if (texts.length > 0) parts.push(texts.join(' '));
  }

  const text = parts.join('\n');
  if (text.length < 10) throw new Error('PPT 内容为空');
  return truncate(text);
}

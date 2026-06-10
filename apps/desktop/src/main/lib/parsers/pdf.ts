import { readFileSync } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import { truncate } from './common.js';

export async function parsePdf(filePath: string): Promise<string> {
  // Why: pdf-parse v2 class API; passing data buffer works for local files since
  // the `url` option only supports http/https in Node.js worker context.
  const data = readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  const result = await parser.getText();
  const text = result.text?.trim() ?? '';
  if (text.length < 10) throw new Error('PDF 内容为空或无法解析（可能是扫描版图片 PDF）');
  return truncate(text);
}

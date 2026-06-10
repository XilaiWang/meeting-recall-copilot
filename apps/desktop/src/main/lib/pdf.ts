import { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import type { CardRow } from '../db/schema.js';


export type PdfTemplate = 'simple' | 'modern';

const TYPE_LABEL: Record<string, string> = {
  result_impact: '结果影响',
  data_metric: '数据指标',
  difficulty_solution: '难点解法',
  decision_tradeoff: '决策权衡',
  tech_principle: '技术原理',
  process_method: '流程方法',
  domain_fact: '领域知识',
};

const TYPE_COLOR: Record<string, string> = {
  result_impact: '#16a34a',
  data_metric: '#2563eb',
  difficulty_solution: '#dc2626',
  decision_tradeoff: '#d97706',
  tech_principle: '#7c3aed',
  process_method: '#0891b2',
  domain_fact: '#6b7280',
};

const TYPE_ORDER = ['result_impact', 'data_metric', 'difficulty_solution', 'decision_tradeoff', 'tech_principle', 'process_method', 'domain_fact'];

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function groupByType(cards: CardRow[]): Record<string, CardRow[]> {
  const result: Record<string, CardRow[]> = {};
  for (const card of cards) {
    const arr = result[card.type] ?? [];
    arr.push(card);
    result[card.type] = arr;
  }
  return result;
}

function cardHtmlSimple(c: CardRow): string {
  const star = c.isImportant ? '★ ' : '';
  const tags = Array.isArray(c.tags) && c.tags.length
    ? `<div class="tags">${(c.tags as string[]).map(esc).join(' · ')}</div>` : '';
  return `<div class="card">
    <div class="title">${star}${esc(c.title)}</div>
    <div class="summary">${esc(c.summary)}</div>
    <div class="details">${esc(c.details)}</div>
    ${tags}
  </div>`;
}

function cardHtmlModern(c: CardRow): string {
  const color = TYPE_COLOR[c.type] ?? '#6b7280';
  const star = c.isImportant ? '★ ' : '';
  const tags = Array.isArray(c.tags) && c.tags.length
    ? `<div class="tags">${(c.tags as string[]).map(esc).join(' · ')}</div>` : '';
  return `<div class="card" style="border-left-color:${color}">
    <div class="type-label" style="color:${color}">${TYPE_LABEL[c.type] ?? c.type}</div>
    <div class="title">${star}${esc(c.title)}</div>
    <div class="summary">${esc(c.summary)}</div>
    <div class="details">${esc(c.details)}</div>
    ${tags}
  </div>`;
}

function buildSimpleHtml(name: string, role: string, cards: CardRow[], date: string): string {
  const grouped = groupByType(cards);
  let body = '';
  for (const type of TYPE_ORDER) {
    const group = grouped[type];
    if (!group?.length) continue;
    body += `<div class="section">
      <div class="section-header">${TYPE_LABEL[type] ?? type}</div>
      <div class="grid">${group.map(cardHtmlSimple).join('')}</div>
    </div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Georgia,'PingFang SC','Noto Serif SC',serif;font-size:10.5pt;color:#1a1a1a;background:#fff;padding:28pt 32pt}
.header{padding-bottom:12pt;margin-bottom:18pt;border-bottom:2px solid #1a1a1a}
.project{font-size:19pt;font-weight:bold;margin-bottom:3pt}
.meta{font-size:8.5pt;color:#666}
.section{margin-bottom:18pt}
.section-header{font-size:8.5pt;text-transform:uppercase;letter-spacing:1.8px;color:#999;margin-bottom:7pt;padding-bottom:4pt;border-bottom:1px solid #e0e0e0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8pt}
.card{padding:9pt;border:1px solid #e8e8e8;border-radius:3pt;page-break-inside:avoid}
.title{font-size:9.5pt;font-weight:bold;margin-bottom:3pt;line-height:1.35}
.summary{font-size:8pt;color:#777;font-style:italic;margin-bottom:5pt;line-height:1.4}
.details{font-size:8pt;line-height:1.6;color:#333}
.tags{margin-top:5pt;font-size:7.5pt;color:#aaa}
.footer{margin-top:16pt;padding-top:8pt;border-top:1px solid #e0e0e0;font-size:7.5pt;color:#ccc;text-align:center}
</style></head><body>
<div class="header">
  <div class="project">${esc(name)} · 会议速记</div>
  <div class="meta">会议主题：${esc(role)}    ${date}    共 ${cards.length} 张</div>
</div>
${body}
<div class="footer">由 QA Matching 生成</div>
</body></html>`;
}

function buildModernHtml(name: string, role: string, cards: CardRow[], date: string): string {
  const grouped = groupByType(cards);
  let body = '';
  for (const type of TYPE_ORDER) {
    const group = grouped[type];
    if (!group?.length) continue;
    body += `<div class="section">
      <div class="section-title">${TYPE_LABEL[type] ?? type}</div>
      ${group.map(cardHtmlModern).join('')}
    </div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'PingFang SC','Noto Sans SC',Arial,sans-serif;font-size:10pt;color:#1a1a1a;background:#fff}
.header{background:#0f172a;color:#fff;padding:18pt 26pt 16pt}
.project{font-size:17pt;font-weight:700;margin-bottom:3pt}
.meta{font-size:8pt;color:#94a3b8}
.content{padding:14pt 26pt}
.section{margin-bottom:4pt}
.section-title{font-size:9.5pt;font-weight:700;color:#0f172a;margin:13pt 0 6pt;padding-bottom:3pt;border-bottom:2px solid #e2e8f0}
.card{margin-bottom:7pt;padding:9pt 11pt;background:#f8fafc;border-radius:4pt;border-left:4pt solid #999;page-break-inside:avoid}
.type-label{font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:3pt}
.title{font-size:10pt;font-weight:700;margin-bottom:3pt;line-height:1.35}
.summary{font-size:8.5pt;color:#64748b;margin-bottom:5pt;line-height:1.4}
.details{font-size:8.5pt;line-height:1.6;color:#374151}
.tags{margin-top:5pt;font-size:7.5pt;color:#94a3b8}
.footer{margin-top:12pt;font-size:7.5pt;color:#94a3b8;text-align:center;padding:8pt 0 10pt;border-top:1px solid #e2e8f0}
</style></head><body>
<div class="header">
  <div class="project">${esc(name)} · 会议速记</div>
  <div class="meta">会议主题：${esc(role)}    ${date}    共 ${cards.length} 张</div>
</div>
<div class="content">
${body}
<div class="footer">由 QA Matching 生成</div>
</div>
</body></html>`;
}

export function buildPdfHtml(template: PdfTemplate, name: string, role: string, cards: CardRow[]): string {
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return template === 'modern'
    ? buildModernHtml(name, role, cards, date)
    : buildSimpleHtml(name, role, cards, date);
}

// Why: hidden BrowserWindow is the only way to call printToPDF without affecting the main window.
// Created on demand and destroyed after each export — PDF is low-frequency enough that the
// ~2s startup cost per export is acceptable.
export async function printHtmlToPdf(html: string, filePath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  try {
    // Why: wrap loadURL in an explicit did-finish-load listener instead of relying
    // on the loadURL promise alone. For data: URLs Electron may resolve the promise
    // before subresource layout (system fonts, CSS calc) completes, producing
    // partially-rendered PDFs. did-finish-load fires after the document is fully
    // parsed and painted, then we add a 300ms buffer for font rasterisation.
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_: unknown, code: number, desc: string) => {
        reject(new Error(`PDF page load failed (${code}): ${desc}`));
      });
      win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64')).catch(reject);
    });
    // Additional buffer for font rasterisation / layout reflow.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Why: 'custom' margins create vertical space for the header/footer bands.
    // marginType:'none' with displayHeaderFooter clips the bands at the page edge.
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.45, bottom: 0.45, left: 0, right: 0 },
      displayHeaderFooter: true,
      headerTemplate: '<div style="width:100%;font-size:8px;font-family:sans-serif;text-align:right;color:#ccc;padding-right:20px">QA Matching</div>',
      footerTemplate: '<div style="width:100%;font-size:8px;font-family:sans-serif;text-align:center;color:#ccc"><span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span></div>',
    });
    writeFileSync(filePath, pdfBuffer);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

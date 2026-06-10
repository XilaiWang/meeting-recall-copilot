// Why: whitelist prevents binary/media files from being ingested as garbage text.
// Includes document formats (pdf/docx/pptx) because real users upload documents, slides,
// and project reports in these formats — just as common as code files.
export const CODE_EXTENSIONS = new Set([
  // Documents
  'pdf', 'docx', 'doc', 'pptx', 'ppt',
  // Text / markup
  'md', 'txt', 'rst', 'adoc', 'html', 'htm',
  // Code
  'py', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'java', 'kt', 'scala',
  'cpp', 'c', 'cc', 'h', 'hpp',
  'go', 'rs', 'swift',
  'rb', 'php', 'cs',
  'sql', 'sh', 'bash', 'zsh',
  'yaml', 'yml', 'toml', 'json',
  'ipynb', 'r',
]);

export function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export function isAllowed(filename: string): boolean {
  return CODE_EXTENSIONS.has(extOf(filename));
}

// Why: cap raw content so SQLite rows don't balloon; 5 MB per material is generous.
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CONTENT_BYTES) return text;
  return text.slice(0, MAX_CONTENT_BYTES) + '\n\n[内容过长，已截断]';
}

// Why: the on-device ASR (SFSpeechRecognizer) consistently mishears some proper
// nouns / tech terms (e.g. "Drizzle" → "jizzle", "Kubernetes" → "cube net").
// contextualStrings biases recognition but can't fix every case, so this is a
// deterministic post-ASR find/replace layer applied BEFORE question detection and
// BM25 matching — it cleans the query terms so mis-heard names don't poison both.
// A single conservative {num} wildcard is supported; arbitrary regex is
// intentionally NOT exposed so a non-technical user can't break their transcript.

export interface CorrectionRule {
  pattern: string;
  replacement: string;
  enabled: boolean;
}

const NUM_TOKEN = '{num}';
// ASCII + fullwidth + common Chinese numerals, so one {num} matches "3"/"３"/"三".
const NUM_CLASS = '[0-9０-９〇零一二三四五六七八九十百千万亿]+';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Apply one rule. Literal substring replace, or — if the pattern contains exactly
// one {num} — a number-wildcard replace. Malformed rules are no-ops (text returned
// unchanged) so a bad rule can never corrupt the transcript.
function applyRule(text: string, pattern: string, replacement: string): string {
  const p = pattern.trim();
  if (!p) return text;
  const numCount = p.split(NUM_TOKEN).length - 1;
  if (numCount === 0) {
    // A replacement referencing {num} with no {num} in the pattern is malformed.
    if (replacement.includes(NUM_TOKEN)) return text;
    return text.split(p).join(replacement);
  }
  if (numCount > 1) return text; // only a single {num} is supported
  const [head, tail] = p.split(NUM_TOKEN);
  const re = new RegExp(escapeRegExp(head ?? '') + '(' + NUM_CLASS + ')' + escapeRegExp(tail ?? ''), 'g');
  return text.replace(re, (_m, num: string) => replacement.split(NUM_TOKEN).join(num));
}

// Apply all enabled rules in order. Pure — same input always yields same output.
export function applyCorrectionRules(text: string, rules: CorrectionRule[]): string {
  let current = text;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    current = applyRule(current, rule.pattern, rule.replacement);
  }
  return current;
}

// Parse the settings textarea (one rule per line "听错 => 正确"). Blank lines and
// lines starting with '#' are ignored; lines without '=>' or with an empty left
// side are skipped. The replacement may be empty (deletes the matched text).
export function parseCorrectionRules(text: string): CorrectionRule[] {
  const rules: CorrectionRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=>');
    if (idx === -1) continue;
    const pattern = line.slice(0, idx).trim();
    const replacement = line.slice(idx + 2).trim();
    if (!pattern) continue;
    rules.push({ pattern, replacement, enabled: true });
  }
  return rules;
}

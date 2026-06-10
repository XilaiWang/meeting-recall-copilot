// Pure, dependency-free meeting-question classifier. Runs in the Electron main
// process (ipc/meeting.ts) and is unit-tested in isolation (no Electron/LLM).
//
// Classifies an ASR transcript segment as one of three things you
// must respond to, or null (filler / the speaker's own statement / chatter):
//   - 'interrogative' 疑问句 — a question: wh-word, yes/no inversion, A-not-A
//     (是不是/有没有), sentence-final particle (吗/呢), tag question, or "?".
//   - 'imperative'    命令句 — a directive to explain: "讲讲X" / "tell me about Y".
//   - 'follow_up'     追问句 — a short/anaphoric continuation of the previous
//     question ("那这个呢" / "再展开说说"); only meaningful with prior context.
//
// Why lexical, not punctuation: ASR output usually drops "?" and "。", so trailing
// punctuation is unreliable — detection leans on word cues in both languages.

export type QuestionType = 'interrogative' | 'imperative' | 'follow_up';
export interface Classification {
  type: QuestionType;
  text: string;
}

// ── English cues ──────────────────────────────────────────────────────────────
const EN_WH = /\b(what'?s?|why|how|where|when|which|who|whom|whose)\b/i;
// Subject–auxiliary inversion → yes/no question ("is it…", "do you…", "should we…").
const EN_YESNO =
  /\b(is|are|was|were|am|do|does|did|can|could|would|will|shall|should|have|has|had|may|might)\s+(you|your|i|we|it|they|he|she|that|this|there|the)\b/i;
// Tag question: "…, right?" / "…, correct?".
const EN_TAG = /,\s*(right|correct|yeah|no)\s*\??$/i;
// Directive verbs anywhere → "explain something".
const EN_IMPERATIVE =
  /\b(tell\s+me|describe|explain|walk\s+me\s+through|take\s+me\s+through|talk\s+about|share|give\s+me|discuss|elaborate|go\s+over|i'?d\s+like\s+to\s+hear|i\s+want\s+to\s+(?:hear|understand|know)|i'?m\s+curious|help\s+me\s+understand|let'?s\s+(?:talk|discuss|dive))\b/i;
// Directive verb leading the sentence → strong imperative ("Describe the…").
const EN_IMPERATIVE_LEAD =
  /^\s*(?:please\s+|so\s+|now\s+|ok(?:ay)?\s+|and\s+)?(tell|describe|explain|walk|take|talk|share|give|discuss|elaborate|run|go\s+over)\b/i;
const EN_FOLLOW_LEAD = /^\s*(and|so|then|what\s+about|how\s+about|and\s+you|ok(?:ay)?\s+so)\b/i;

// ── Chinese cues ──────────────────────────────────────────────────────────────
const ZH_WH = ['什么', '为什么', '为何', '为啥', '怎么', '怎样', '咋', '如何', '哪', '谁', '多少', '多大', '多长', '多久', '多高', '多远', '多频繁', '几', '啥', '干嘛', '干吗', '何时', '何地'];
const ZH_OPINION = ['你觉得', '你认为', '你怎么看', '你怎么看待', '你如何看', '你如何看待', '你如何理解', '你怎么理解', '你是怎么理解的', '在你看来', '你的看法', '你的理解是', '你的观点是', '你怎么评价', '你怎么想的', '你打算怎么', '你怎么权衡', '你会怎么', '你倾向', '依你看', '以你的经验', '你有什么想法'];
// A-not-A and yes/no markers that need no final particle.
const ZH_ANOTA = ['是不是', '是否', '有没有', '能不能', '可不可以', '对不对', '对吧', '行不行', '会不会', '要不要', '能否', '可否', '有无', '好不好', '用没用过', '做没做过', '了解不了解', '知不知道', '懂不懂', '清不清楚', '熟不熟悉', '想不想', '考没考虑过', '愿不愿意', '认不认同', '该不该', '够不够'];
// 情景/假设/压力题 — 设定一个情景让你作答, 常缺显式疑问词。这些是会议追问的常见说法,
// 很少出现在普通陈述里, 误判风险低(且只对对方声道分类)。
const ZH_SCENARIO = ['换做你', '换作你', '换成你', '换做是你', '换作是你', '如果是你', '给你一个场景', '给你一个', '现在让你', '假设让你', '假如让你', '假设你是', '假如你是', '设想一下', '想象一下', '站在'];
// Sentence-final question particle (ASR sometimes renders 吗→么).
const ZH_TAIL_Q = /(吗|呢|么)[?？]?$/;
const ZH_IMPERATIVE = ['讲讲', '讲一讲', '讲一下', '说说', '说一说', '说一下', '谈谈', '谈一谈', '谈一下', '介绍一下', '介绍下', '介绍介绍', '请介绍', '聊聊', '聊一下', '举例', '举个例子', '展开讲', '展开说', '具体说说', '具体讲讲', '具体说', '解释一下', '解释下', '描述', '分享一下', '分享下', '给我讲', '给我说', '告诉我', '列举', '比较一下', '对比一下', '说明一下', '详细说', '详细讲', '演示一下', '复盘一下', '科普一下', '了解一下', '想了解', '想听听', '想听', '想知道', '补充一下', '补充', '总结一下', '总结', '回顾一下', '回顾', '阐述一下', '阐述', '概括一下', '评价一下', '提一下', '展示一下', '梳理一下', '复述一下', '估算一下', '推导一下', '拆解一下', '剖析一下', '罗列一下', '归纳一下', '简述一下', '详述一下', '阐释一下', '点评一下', '扩展一下', '模拟一下', '手撕', '手写', '实现一个', '设计一个', '画一下', '回想一下', '说来听听', '说说看', '讲讲看', '自我介绍', '做个自我介绍', '多说点'];
// Directive verb leading the sentence (optionally after 请/你/那…) → imperative.
// Allow a run of polite/pronoun prefixes before the directive verb so "请你讲一讲"
// (请 + 你 + 讲) is recognised as a directive even though it embeds a wh-word later.
const ZH_IMPERATIVE_LEAD = /^(?:请|您|你|麻烦|帮我|帮忙|那|来|就|可以|能不能|[\s，,])*(讲|说说|说一|说明|介绍|谈|聊|描述|解释|分享|举|展开|列举|比较|对比|演示|科普|复盘|告诉我|详细|补充|总结|回顾|阐述|概括|评价|提一|展示|讲述|梳理|复述|估算|推导|拆解|剖析|罗列|归纳|简述|详述|阐释|点评|扩展|模拟|手撕|手写|回想|自我介绍)/;

// ── Follow-up cues ────────────────────────────────────────────────────────────
const ZH_FOLLOW_LEAD = /^[\s，,]*(那么|那个|这个|那|这|刚才|刚刚|再|还有|另外|其他|它|接着|然后|继续)/;
const FOLLOW_BARE = ['为什么', '为啥', '怎么讲', '怎么说', '还有呢', '那呢', '继续', '展开', '具体一点', '详细点', '然后呢', '后来呢', '具体呢', '比如呢', '接着呢', '还有吗', '还有别的吗', '还有其他吗', '还有别的方案吗', '还有补充吗', '具体说说', '具体讲讲', '再具体', '展开说说', '深入讲讲', '深入说说', '底层呢', '源码呢', '细节呢', '结果呢', '结果怎么样', '真的吗', '你确定吗', '你的意思是', '也就是说', '除此之外', '那为什么', '那如果', '那要是', '那怎么', '能展开吗', '能具体说说吗', '原理是什么', '底层原理是什么'];
// Anaphoric refs + particles + fillers. A segment that is ONLY these (e.g. "那这个呢")
// has no standalone content — it needs a prior question, or it is unanswerable.
const STRIP_CHARS = /[那这刚才个的了吗呢吧啊么呀再还有另外其它接然后继续\s，,。!！?？]/g;

function hasZh(s: string): boolean {
  return /[一-鿿]/.test(s);
}
function charLen(s: string): number {
  return [...s].length;
}
function wordCount(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}
// True when, after removing anaphoric refs/particles/fillers, almost nothing
// remains ("那这个呢" → "") — an unanswerable stub absent a prior question.
function isContentless(s: string): boolean {
  if (!hasZh(s)) return false;
  return charLen(s.replace(STRIP_CHARS, '')) <= 1;
}

// Cap returned text: Chinese by chars, English by words (keeps the query focused).
function cap(s: string): string {
  return hasZh(s) ? s.slice(0, 200) : s.split(/\s+/).slice(0, 40).join(' ');
}

export function isInterrogative(s: string): boolean {
  if (/[?？]\s*$/.test(s)) return true;
  if (EN_TAG.test(s)) return true;
  if (EN_WH.test(s) || EN_YESNO.test(s)) return true;
  if (hasZh(s)) {
    if (ZH_TAIL_Q.test(s)) return true;
    if (ZH_ANOTA.some((w) => s.includes(w))) return true;
    if (ZH_OPINION.some((w) => s.includes(w))) return true;
    if (ZH_WH.some((w) => s.includes(w))) return true;
    // Scenario/hypothetical prompts ("换做你…","给你一个场景…") elicit an answer
    // even without an explicit question word.
    if (ZH_SCENARIO.some((w) => s.includes(w))) return true;
  }
  return false;
}

export function isImperative(s: string): boolean {
  if (EN_IMPERATIVE.test(s) || EN_IMPERATIVE_LEAD.test(s)) return true;
  if (hasZh(s) && ZH_IMPERATIVE.some((w) => s.includes(w))) return true;
  return false;
}

function leadsWithImperative(s: string): boolean {
  return EN_IMPERATIVE_LEAD.test(s) || (hasZh(s) && ZH_IMPERATIVE_LEAD.test(s));
}

// The speaker talking about themselves ("我先介绍一下我们的产品") needs no answer.
// But "我想了解一下你的项目" targets 你 → still a directive to you.
function looksSelfStatement(s: string): boolean {
  return /^(我们?|我来|我先|让我|我这边|我可以|我想先)/.test(s) && !/你|您|你们|你的|您的/.test(s) && !isInterrogative(s);
}

function isFollowUp(seg: string): boolean {
  const len = charLen(seg);
  const short = len <= 18 || wordCount(seg) <= 5;
  const strongLead = ZH_FOLLOW_LEAD.test(seg) || EN_FOLLOW_LEAD.test(seg);
  // Bare anaphoric continuation, or a short segment that opens with a reference.
  const anaphoric =
    strongLead ||
    FOLLOW_BARE.some((w) => seg === w || seg.startsWith(w)) ||
    isContentless(seg);
  // A strong anaphoric lead extends the length budget (long follow-ups exist).
  return anaphoric && (short || (strongLead && len <= 32));
}

/**
 * Classify a transcript segment. Returns null when no response is required.
 * Pass the previously detected question so anaphoric follow-ups gain context.
 */
export function classifyQuestion(
  text: string,
  opts: { priorQuestion?: string } = {},
): Classification | null {
  const stripped = (text ?? '').trim();
  if (!stripped) return null;
  // A single-char fragment is ASR noise (e.g. "列" split off "消息队列"), never a
  // real question/answerable segment — don't let it become a spurious follow-up.
  if (charLen(stripped) < 2) return null;

  // Follow-up takes priority: a short/anaphoric continuation only makes sense
  // after the previous question, so prepend it to give matching real context.
  if (opts.priorQuestion && isFollowUp(stripped)) {
    return { type: 'follow_up', text: `${opts.priorQuestion}，${stripped}`.slice(0, 200) };
  }

  // A bare anaphoric stub ("那这个呢") with no prior question has nothing to match.
  if (!opts.priorQuestion && isContentless(stripped)) return null;

  // Split on hard enders (keep ?/？ inside so their signal survives), classify the
  // first sentence that needs an answer.
  const sentences = stripped.split(/[。！!\n]+/).map((x) => x.trim()).filter(Boolean);
  for (const s of sentences) {
    if (looksSelfStatement(s)) continue;
    if (leadsWithImperative(s)) return { type: 'imperative', text: cap(s) };
    if (isInterrogative(s)) return { type: 'interrogative', text: cap(s) };
    if (isImperative(s)) return { type: 'imperative', text: cap(s) };
  }
  return null;
}

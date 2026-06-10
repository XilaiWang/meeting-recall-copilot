import { describe, it, expect } from 'vitest';
import { classifyQuestion, type QuestionType } from './question-detect.js';

// Synthetic, labeled meeting corpus. Most lines intentionally OMIT punctuation
// to mirror real ASR output (the hard case the old keyword list missed).
interface Case {
  input: string;
  expect: QuestionType | null;
  prior?: string;
  note?: string;
}

const CASES: Case[] = [
  // ── 疑问句 interrogative — Chinese (no punctuation) ──
  { input: '你用过 Redis 吗', expect: 'interrogative', note: '语气词 吗' },
  { input: '这样做能扛住高并发吗', expect: 'interrogative', note: '语气词 吗' },
  { input: '这个方案有什么风险', expect: 'interrogative', note: 'wh 什么' },
  { input: '为什么选择微服务架构', expect: 'interrogative' },
  { input: '系统有哪些瓶颈', expect: 'interrogative', note: 'wh 哪些' },
  { input: '这块谁负责', expect: 'interrogative', note: 'wh 谁' },
  { input: 'QPS 大概是多少', expect: 'interrogative', note: 'wh 多少' },
  { input: '数据量有多大', expect: 'interrogative', note: 'wh 多大' },
  { input: '上线多久了', expect: 'interrogative', note: 'wh 多久' },
  { input: '你们团队几个人', expect: 'interrogative', note: 'wh 几' },
  { input: '是不是用了缓存', expect: 'interrogative', note: 'A-not-A 是不是' },
  { input: '你是怎么做性能优化的', expect: 'interrogative' },
  { input: '你觉得这个设计合理吗', expect: 'interrogative', note: '观点 + 吗' },
  { input: '这个跟 Kafka 比有什么区别', expect: 'interrogative' },
  { input: '你确定这样没问题？', expect: 'interrogative', note: '仅靠问号' },

  // ── 疑问句 interrogative — English ──
  { input: 'what was the hardest part', expect: 'interrogative' },
  { input: 'how did you scale it', expect: 'interrogative' },
  { input: 'why did you choose postgres', expect: 'interrogative' },
  { input: 'is it horizontally scalable', expect: 'interrogative', note: 'yes/no inversion' },
  { input: 'should we worry about consistency', expect: 'interrogative', note: 'modal inversion' },
  { input: 'did you write tests for that', expect: 'interrogative' },
  { input: "what's the throughput", expect: 'interrogative' },
  { input: 'so it is eventually consistent, right', expect: 'interrogative', note: 'tag question' },
  { input: 'can you explain the architecture', expect: 'interrogative', note: 'polite question form' },

  // ── 命令句 imperative — Chinese ──
  { input: '讲讲你的项目架构', expect: 'imperative' },
  { input: '介绍一下这个系统', expect: 'imperative' },
  { input: '说说你遇到的难点', expect: 'imperative' },
  { input: '给我讲讲缓存策略', expect: 'imperative' },
  { input: '具体展开说一下', expect: 'imperative' },
  { input: '描述一下部署流程', expect: 'imperative' },
  { input: '举个例子', expect: 'imperative' },
  { input: '解释一下这个设计', expect: 'imperative' },
  { input: '详细说说你的优化思路', expect: 'imperative' },
  { input: '对比一下这两种方案', expect: 'imperative' },
  { input: '请你讲一讲你做过的项目 整体架构是怎样设计的', expect: 'imperative', note: '请你讲…多前缀命令-lead 压过 wh 怎样' },
  // 非疑问的祈使/指令句（会议常见, 之前易漏）
  { input: '请讲一讲你的兴趣爱好', expect: 'imperative' },
  { input: '请你补充一下项目经历', expect: 'imperative', note: '补充一下' },
  { input: '谈谈你对 AI Agent 的理解', expect: 'imperative' },
  { input: '总结一下你的核心优势', expect: 'imperative', note: '总结一下' },
  { input: '回顾一下那个最难的项目', expect: 'imperative', note: '回顾一下' },
  { input: '评价一下这个技术选型', expect: 'imperative', note: '评价一下' },
  // 情景/假设题（整类之前漏，常缺显式疑问词）
  { input: '换做你你会怎么处理这个冲突', expect: 'interrogative', note: '情景 换做你' },
  { input: '给你一个秒杀系统你会怎么设计', expect: 'interrogative', note: '情景 给你一个' },
  { input: '假设让你负责这个项目', expect: 'interrogative', note: '情景 假设让你(无显式疑问词)' },
  { input: '如果是你你怎么权衡', expect: 'interrogative' },
  // A-not-A / 是非问
  { input: '你用没用过 Kafka', expect: 'interrogative', note: 'A-not-A 用没用过' },
  { input: '考没考虑过性能问题', expect: 'interrogative' },
  { input: '你了解不了解分布式事务', expect: 'interrogative' },
  // 观点征询
  { input: '你怎么评价微服务架构', expect: 'interrogative' },
  { input: '以你的经验哪种方案更好', expect: 'interrogative' },
  // 更多指令动词
  { input: '手撕一个快速排序', expect: 'imperative', note: '手撕' },
  { input: '估算一下这个接口的 QPS', expect: 'imperative' },
  { input: '复盘一下那次线上故障', expect: 'imperative' },
  { input: '做个自我介绍吧', expect: 'imperative', note: '省略主语祈使' },
  { input: '归纳一下你的核心竞争力', expect: 'imperative' },
  // 追问短句（需 prior）
  { input: '然后呢', expect: 'follow_up', prior: '讲讲你的方案' },
  { input: '底层原理是什么', expect: 'follow_up', prior: '说说 HashMap' },
  { input: '还有别的方案吗', expect: 'follow_up', prior: '你怎么优化的' },
  // 防误伤：含"如果"但是陈述/评论（如果≠如果是你，不应触发情景）
  { input: '如果你用过 React 那很好', expect: null, note: '陈述评论, 非情景题' },
  { input: '列', expect: null, prior: '换作你遇到线上故障会怎么处理', note: '1字 ASR 碎片, 不应成追问' },

  // ── 命令句 imperative — English ──
  { input: 'tell me about your project', expect: 'imperative' },
  { input: 'describe the deployment pipeline', expect: 'imperative' },
  { input: 'walk me through the request flow', expect: 'imperative' },
  { input: 'explain how caching works here', expect: 'imperative' },
  { input: 'talk about a challenge you faced', expect: 'imperative' },
  { input: 'give me an example', expect: 'imperative' },
  { input: "i'd like to hear about your role", expect: 'imperative' },

  // ── 追问句 follow_up (needs prior question) ──
  { input: '那这个方案的瓶颈在哪里呢', expect: 'follow_up', prior: '你怎么做性能优化的' },
  { input: '那缓存呢', expect: 'follow_up', prior: '介绍一下你的系统架构' },
  { input: '再展开说说', expect: 'follow_up', prior: '说说你的项目' },
  { input: '为什么', expect: 'follow_up', prior: '你们为什么选了微服务' },
  { input: '具体一点', expect: 'follow_up', prior: '讲讲你的优化' },
  { input: '还有呢', expect: 'follow_up', prior: '有哪些风险' },
  { input: '那你刚才说的那个限流是怎么实现的', expect: 'follow_up', prior: '讲讲高并发设计' },
  { input: 'and how about scaling', expect: 'follow_up', prior: 'what is your stack' },

  // 没有 prior 的指代句无法独立应答 → 不应判为 follow_up（且本身无内容 → null）
  { input: '那这个呢', expect: null, note: '无 prior 的孤立指代' },

  // ── 负例 null — 对方陈述 / 寒暄 / 噪声 ──
  { input: '好的 没问题', expect: null },
  { input: '嗯 我看一下你的材料', expect: null },
  { input: '我们公司主要做支付方向', expect: null, note: '单方陈述' },
  { input: '今天天气不错', expect: null },
  { input: '这个项目我很感兴趣', expect: null },
  { input: 'thanks for coming in today', expect: null },
  { input: 'let me introduce myself first', expect: null, note: '对方自我介绍, 非指令' },
  { input: '我先介绍一下我们团队', expect: null, note: '难负例: 含 介绍一下 但主语是我' },
  { input: '我来说一下今天的流程', expect: null, note: '难负例: 含 说一下 但主语是我' },
  { input: '你说得对', expect: null, note: '陈述句, 多前缀 lead 不应误伤(说得 不在指令动词组)' },

  // 反例的对照: "我想了解一下你的项目" 指向 你 → 仍是要应答的指令
  { input: '我想了解一下你的项目', expect: 'imperative', note: '一人称但指向 你' },
];

describe('classifyQuestion', () => {
  for (const c of CASES) {
    const label = `${c.expect ?? 'null'} ⇐ "${c.input}"${c.note ? ` (${c.note})` : ''}`;
    it(label, () => {
      const r = classifyQuestion(c.input, { priorQuestion: c.prior });
      expect(r?.type ?? null).toBe(c.expect);
    });
  }

  it('follow-up prepends the prior question for downstream matching context', () => {
    const r = classifyQuestion('那缓存呢', { priorQuestion: '介绍一下系统架构' });
    expect(r?.type).toBe('follow_up');
    expect(r?.text).toContain('介绍一下系统架构');
    expect(r?.text).toContain('那缓存呢');
  });

  it('overall accuracy on the labeled corpus is ≥ 95%', () => {
    const correct = CASES.filter(
      (c) => (classifyQuestion(c.input, { priorQuestion: c.prior })?.type ?? null) === c.expect,
    ).length;
    expect(correct / CASES.length).toBeGreaterThanOrEqual(0.95);
  });
});

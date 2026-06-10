export type LlmProvider = 'anthropic' | 'openai' | 'deepseek' | 'qwen';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
}

interface ProviderConfig {
  baseUrl: string;
  defaultModel: string;
  protocol: 'anthropic' | 'openai';
}

// Why: registry lets us add new providers by inserting one entry here instead of
// forking the if/else chain in every call site.
const PROVIDER_CONFIGS: Record<LlmProvider, ProviderConfig> = {
  anthropic: { baseUrl: 'https://api.anthropic.com',                                defaultModel: 'claude-haiku-4-5', protocol: 'anthropic' },
  openai:    { baseUrl: 'https://api.openai.com',                                   defaultModel: 'gpt-4o-mini',      protocol: 'openai'    },
  deepseek:  { baseUrl: 'https://api.deepseek.com',                                 defaultModel: 'deepseek-chat',    protocol: 'openai'    },
  qwen:      { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',           defaultModel: 'qwen-plus',        protocol: 'openai'    },
};

// Why: reasoning models (DeepSeek-R1/QwQ/Qwen3-thinking) emit <think>...</think>
// before the actual answer. Those braces pollute the depth-based JSON scanner in
// extract.ts (false objects, missed cards, wasted repair retries). Strip *closed*
// blocks only; an unclosed block mid-stream is left for the caller to wait on.
const THINK_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_OPEN = /<think\b[^>]*>/i;

export function stripThinkingBlocks(text: string): string {
  return text.replace(THINK_BLOCK, '');
}

// True when, after removing closed blocks, an opening <think> still remains — the
// streaming caller should wait for more chunks before parsing (the close is coming).
export function hasUnclosedThink(text: string): boolean {
  return THINK_OPEN.test(stripThinkingBlocks(text));
}

// Why: parses raw SSE lines — splits on '\n', yields the payload of 'data: ...' lines.
async function* parseSSE(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) yield line.slice(6).trim();
    }
  }
}

async function* streamAnthropic(url: string, apiKey: string, model: string, systemPrompt: string, userMessage: string, maxTokens: number): AsyncIterable<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic API 错误 ${res.status}: ${err.slice(0, 200)}`); }
  for await (const data of parseSSE(res)) {
    try {
      const obj = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta.text) {
        yield obj.delta.text;
      }
    } catch { /* non-JSON SSE line, skip */ }
  }
}

async function* streamOpenAICompat(url: string, apiKey: string, model: string, systemPrompt: string, userMessage: string, maxTokens: number): AsyncIterable<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, stream: true,
      // Why: OpenAI/DeepSeek/Qwen all support a dedicated system role; using it
      // (instead of prepending the system prompt to the user turn) improves
      // instruction-following and keeps the user content clean.
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`API 错误 ${res.status}: ${err.slice(0, 200)}`); }
  for await (const data of parseSSE(res)) {
    if (data === '[DONE]') break;
    try {
      const obj = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const text = obj.choices?.[0]?.delta?.content;
      if (text) yield text;
    } catch { /* non-JSON SSE line, skip */ }
  }
}

// Streams text chunks from the LLM — caller accumulates them to build the full response.
// Why: maxTokens defaults to 16384 for normal generation but callers that need only a
// short reply (e.g. classify) can pass a small value to cut server-side generation time.
export async function* streamLlm(config: LlmConfig, systemPrompt: string, userMessage: string, maxTokens = 16384): AsyncIterable<string> {
  const pCfg = PROVIDER_CONFIGS[config.provider];
  const model = config.model ?? pCfg.defaultModel;
  if (pCfg.protocol === 'anthropic') {
    yield* streamAnthropic(`${pCfg.baseUrl}/v1/messages`, config.apiKey, model, systemPrompt, userMessage, maxTokens);
  } else {
    yield* streamOpenAICompat(`${pCfg.baseUrl}/v1/chat/completions`, config.apiKey, model, systemPrompt, userMessage, maxTokens);
  }
}

// Why: single function handles all providers. Add to PROVIDER_CONFIGS to onboard new ones.
export async function callLlm(config: LlmConfig, systemPrompt: string, userMessage: string): Promise<string> {
  const pCfg = PROVIDER_CONFIGS[config.provider];
  const model = config.model ?? pCfg.defaultModel;

  if (pCfg.protocol === 'anthropic') {
    const res = await fetch(`${pCfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 16384, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic API 错误 ${res.status}: ${err.slice(0, 200)}`); }
    const data = await res.json() as { content: Array<{ text: string }> };
    return stripThinkingBlocks(data.content[0]?.text ?? '');
  }

  const res = await fetch(`${pCfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model, max_tokens: 16384, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }] }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`${config.provider} API 错误 ${res.status}: ${err.slice(0, 200)}`); }
  const data = await res.json() as { choices: Array<{ message: { role: string; content: string } }> };
  return stripThinkingBlocks(data.choices[0]?.message.content ?? '');
}

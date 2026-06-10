import { eq, sql, and, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, proxyCalls } from '../db/schema.js';
import { COLD_START_QUOTA_MAX } from '@qa-matching/shared/constants';
import type { ProxyVendor } from '@qa-matching/shared/schemas';

export class QuotaExceededError extends Error {
  constructor() {
    super('Cold-start quota exhausted');
    this.name = 'QuotaExceededError';
  }
}

export class LlmVendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmVendorError';
  }
}

// Why: defaults chosen for cost/capability balance at cold-start scale.
// Haiku is cheapest Anthropic model; gpt-4o-mini is cheapest capable OpenAI model.
const VENDOR_DEFAULTS = {
  anthropic: { model: 'claude-haiku-4-5-20251001', apiVersion: '2023-06-01' },
  openai: { model: 'gpt-4o-mini' },
} as const;

interface VendorResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

async function callAnthropic(prompt: string, model: string, maxTokens: number): Promise<VendorResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LlmVendorError('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': VENDOR_DEFAULTS.anthropic.apiVersion,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmVendorError(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const text = data.content.find((b) => b.type === 'text')?.text ?? '';
  return {
    content: text,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  };
}

async function callOpenAi(prompt: string, model: string, maxTokens: number): Promise<VendorResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new LlmVendorError('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmVendorError(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message.content ?? '',
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
  };
}

interface ProxyParams {
  userId: string;
  prompt: string;
  vendor: ProxyVendor;
  model?: string;
  maxTokens: number;
}

interface ProxyResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  remainingQuota: number;
}

// Why: quota is decremented atomically before calling the vendor so concurrent
// requests can't both pass the quota check. On vendor failure the decrement
// is compensated so the user doesn't lose a call to a transient 503.
export async function callLlmProxy(params: ProxyParams): Promise<ProxyResult> {
  const { userId, prompt, vendor, maxTokens } = params;
  const resolvedModel = params.model ?? VENDOR_DEFAULTS[vendor].model;

  // Atomic check + decrement
  const updated = await db
    .update(users)
    .set({ coldStartQuotaUsed: sql`${users.coldStartQuotaUsed} + 1` })
    .where(and(eq(users.id, userId), lt(users.coldStartQuotaUsed, COLD_START_QUOTA_MAX)))
    .returning({ coldStartQuotaUsed: users.coldStartQuotaUsed });

  if (updated.length === 0) throw new QuotaExceededError();
  const quotaUsed = updated[0]!.coldStartQuotaUsed;
  const remainingQuota = COLD_START_QUOTA_MAX - quotaUsed;

  // Call vendor; compensate quota on failure
  let result: VendorResult;
  try {
    result = vendor === 'anthropic'
      ? await callAnthropic(prompt, resolvedModel, maxTokens)
      : await callOpenAi(prompt, resolvedModel, maxTokens);
  } catch (err: unknown) {
    // Compensate: give back the quota unit
    await db
      .update(users)
      .set({ coldStartQuotaUsed: sql`${users.coldStartQuotaUsed} - 1` })
      .where(eq(users.id, userId));

    await db.insert(proxyCalls).values({
      userId,
      vendor,
      model: resolvedModel,
      inputTokens: 0,
      outputTokens: 0,
      status: 'failed',
      errorMsg: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
    });

    throw err instanceof LlmVendorError ? err : new LlmVendorError('Vendor call failed');
  }

  await db.insert(proxyCalls).values({
    userId,
    vendor,
    model: resolvedModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    status: 'success',
    errorMsg: null,
  });

  return { ...result, remainingQuota };
}

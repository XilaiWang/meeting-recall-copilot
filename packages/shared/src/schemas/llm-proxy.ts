import { z } from 'zod';

export const proxyVendors = ['anthropic', 'openai'] as const;

export const llmProxyExtractSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  vendor: z.enum(proxyVendors).default('anthropic'),
  // Why: model is optional — server applies a safe default per vendor.
  // Max 50 chars matches the proxy_calls.model column (3.3 §2.6).
  model: z.string().min(1).max(50).optional(),
  // Why: output cap is 8K tokens per spec (3.4 §4.8). Client may request
  // less but never more; server enforces the ceiling.
  maxTokens: z.number().int().min(1).max(8000).default(4000),
  metadata: z
    .object({ purpose: z.string().max(50) })
    .optional(),
});

export type LlmProxyExtractInput = z.infer<typeof llmProxyExtractSchema>;
export type ProxyVendor = (typeof proxyVendors)[number];

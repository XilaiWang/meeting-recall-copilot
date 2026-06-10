import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, type AuthVars } from '../middleware/auth.js';
import { userRateLimit } from '../middleware/rate-limit.js';
import { callLlmProxy, QuotaExceededError, LlmVendorError } from '../services/proxy-service.js';
import { llmProxyExtractSchema } from '@qa-matching/shared/schemas';
import { envelopeValidationHook } from '../lib/validation-hook.js';

// 10/user/min — prevents prompt-spam on a free quota (3.4 §5).
const extractLimit = userRateLimit({ max: 10, windowMs: 60_000, prefix: 'llm-extract' });

export const llmProxyRoutes = new Hono<{ Variables: AuthVars }>();

llmProxyRoutes.use('*', requireAuth);

// POST /v1/llm/proxy/extract — cold-start LLM proxy (first 100 calls free).
// Prompt content is never logged; only token counts and status are stored.
llmProxyRoutes.post(
  '/proxy/extract',
  extractLimit,
  zValidator('json', llmProxyExtractSchema, envelopeValidationHook),
  async (c) => {
    const userId = c.get('userId');
    const { prompt, vendor, model, maxTokens } = c.req.valid('json');

    try {
      const result = await callLlmProxy({ userId, prompt, vendor, model, maxTokens });
      return c.json({
        ok: true,
        data: {
          content: result.content,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
          remainingQuota: result.remainingQuota,
        },
        error: null,
      });
    } catch (err: unknown) {
      if (err instanceof QuotaExceededError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: {
              code: 'QUOTA_EXCEEDED',
              message: 'Cold-start quota exhausted. Please configure your own API key (BYOK).',
            },
          },
          422,
        );
      }
      if (err instanceof LlmVendorError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: { code: 'VENDOR_ERROR', message: 'LLM vendor unavailable. Please try again later.' },
          },
          503,
        );
      }
      throw err;
    }
  },
);

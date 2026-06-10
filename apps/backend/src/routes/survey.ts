import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, type AuthVars } from '../middleware/auth.js';
import { userRateLimit } from '../middleware/rate-limit.js';
import { submitSurvey, DuplicateSurveyError } from '../services/survey-service.js';
import { submitSurveySchema } from '@qa-matching/shared/schemas';
import { envelopeValidationHook } from '../lib/validation-hook.js';

// 3/user/h — generous enough for retries, tight enough to prevent spam.
const submitLimit = userRateLimit({ max: 3, windowMs: 60 * 60_000, prefix: 'survey-submit' });

export const surveyRoutes = new Hono<{ Variables: AuthVars }>();

surveyRoutes.use('*', requireAuth);

// POST /v1/survey/submit — stores a post-meeting survey response.
// `will_use_next` is the primary north-star B metric (3.4 §4.7).
surveyRoutes.post(
  '/submit',
  submitLimit,
  zValidator('json', submitSurveySchema, envelopeValidationHook),
  async (c) => {
    const userId = c.get('userId');
    const { projectId, meetingDate, companyNameHash, outcome, cardHelpful, willUseNext, freeText } =
      c.req.valid('json');

    try {
      await submitSurvey({ userId, projectId, meetingDate, companyNameHash, outcome, cardHelpful, willUseNext, freeText });
      return c.json({ ok: true, data: { submitted: true }, error: null });
    } catch (err: unknown) {
      if (err instanceof DuplicateSurveyError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: { code: 'DUPLICATE_SURVEY', message: 'Survey already submitted for this meeting' },
          },
          409,
        );
      }
      throw err;
    }
  },
);

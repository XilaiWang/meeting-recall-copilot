import { ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { getSession } from '../store/session.js';
import { apiPost } from '../api/client.js';
import type { ApiEnvelope } from '@qa-matching/shared';

export interface SurveyInput {
  projectId: string;
  meetingDate: string; // YYYY-MM-DD
  outcome: 'went_well' | 'needs_followup' | 'no_progress' | 'prefer_not_to_say';
  cardHelpful: 'used_helpful' | 'used_not_helpful' | 'not_used';
  willUseNext: 'definitely' | 'maybe' | 'depends' | 'no';
  companyName?: string; // hashed before sending — never stored in plain text
  freeText?: string;
}

export function registerSurveyIpcHandlers() {
  // Why: the survey is the primary north-star B metric (card match rate / usefulness).
  // We hash the company name client-side so the server never stores PII.
  ipcMain.handle('survey:submit', async (_event, input: SurveyInput): Promise<{ ok: boolean }> => {
    const session = getSession();
    if (!session) return { ok: false };

    const companyNameHash = input.companyName?.trim()
      ? createHash('sha256').update(input.companyName.trim().toLowerCase()).digest('hex')
      : undefined;

    const res = await apiPost<{ submitted: boolean }>(
      '/v1/survey/submit',
      {
        projectId: input.projectId,
        meetingDate: input.meetingDate,
        companyNameHash,
        outcome: input.outcome,
        cardHelpful: input.cardHelpful,
        willUseNext: input.willUseNext,
        freeText: input.freeText?.trim() || undefined,
      },
      session.accessToken,
    ) as ApiEnvelope<{ submitted: boolean }>;

    return { ok: res.ok };
  });
}

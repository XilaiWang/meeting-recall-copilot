import { db } from '../db/client.js';
import { surveyResponses } from '../db/schema.js';
import { isPgUniqueViolation } from '../lib/pg-errors.js';
import type { Outcome, CardHelpful, WillUseNext } from '@qa-matching/shared/schemas';

export class DuplicateSurveyError extends Error {
  constructor() {
    super('Survey already submitted for this user + project + date');
    this.name = 'DuplicateSurveyError';
  }
}

interface SubmitSurveyParams {
  userId: string;
  projectId: string;
  meetingDate: string;
  companyNameHash?: string;
  outcome: Outcome;
  cardHelpful: CardHelpful;
  willUseNext: WillUseNext;
  freeText?: string;
}

// Why: thin insert with duplicate detection. The unique constraint on
// (user_id, project_local_id, meeting_date) is the authoritative guard;
// we map PG error 23505 → DuplicateSurveyError so the route layer can
// return a clean 409 instead of a raw 500.
export async function submitSurvey(params: SubmitSurveyParams): Promise<void> {
  try {
    await db.insert(surveyResponses).values({
      userId: params.userId,
      projectLocalId: params.projectId,
      meetingDate: params.meetingDate,
      companyNameHash: params.companyNameHash ?? null,
      outcome: params.outcome,
      cardHelpful: params.cardHelpful,
      willUseNext: params.willUseNext,
      freeText: params.freeText ?? null,
    });
  } catch (err: unknown) {
    if (isPgUniqueViolation(err)) throw new DuplicateSurveyError();
    throw err;
  }
}

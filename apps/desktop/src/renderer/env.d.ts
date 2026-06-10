import type { ApiEnvelope } from '@qa-matching/shared';

interface AuthSessionData {
  userId: string;
  email: string;
  displayName?: string;
  licenseStatus: 'active' | 'expired' | 'none';
  // null = online (verified this launch), 0 = grace expired (readonly), 1-7 = offline grace period
  offlineDaysLeft: number | null;
}

interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  licenseStatus: 'active' | 'expired' | 'none';
}

interface AuthTokenData {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface Material {
  id: string;
  projectId: string;
  type: 'github_url' | 'zip' | 'file' | 'url' | 'text' | 'company_url' | 'obsidian';
  category: 'project' | 'company';
  sourceRef: string | null;
  rawContent: string;
  fileSize: number | null;
  sourceMtime: Date | null;
  uploadedAt: Date;
}

export type ObsidianNoteStatus = 'new' | 'changed' | 'unchanged';

export interface ObsidianScanNote {
  relPath: string;
  sizeKB: number;
  folder: string;
  tags: string[];
  status: ObsidianNoteStatus;
}

export interface ObsidianScanResult {
  count: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  notes: ObsidianScanNote[];
  folders: { name: string; count: number }[];
  tags: { name: string; count: number }[];
}

export type CardType = 'tech_principle' | 'domain_fact' | 'data_metric' | 'process_method' | 'decision_tradeoff' | 'difficulty_solution' | 'result_impact';

export interface OverlayConfig {
  screenshotProtected: boolean;
  overlayWidth: number;
  overlayHeight: number;
}
export type CardLanguage = 'zh' | 'en' | 'bilingual';

export interface Card {
  id: string;
  projectId: string;
  sourceMaterialId: string | null;
  type: CardType;
  title: string;
  summary: string;
  details: string;
  tags: string[];
  language: CardLanguage;
  confidence: number;
  userVerified: boolean;
  isImportant: boolean;
  createdAt: Date;
  updatedAt: Date;
  // FSRS spaced-repetition state (null = New, never reviewed)
  fsrsDue:           Date | null;
  fsrsStability:     number | null;
  fsrsDifficulty:    number | null;
  fsrsElapsedDays:   number | null;
  fsrsScheduledDays: number | null;
  fsrsReps:          number | null;
  fsrsLapses:        number | null;
  fsrsLearningSteps: number | null;
  fsrsState:         number | null;
}

export interface LlmConfigPublic {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'qwen';
  model?: string;
  hasKey: boolean;
}

export interface Project {
  id: string;
  parentProjectId: string | null;
  isProfile: boolean;
  name: string;
  targetRole: string;
  jdText: string | null;
  status: 'draft' | 'materializing' | 'extracting' | 'needs_review' | 'ready' | 'exported' | 'archived';
  companyName: string | null;
  companyBrief: string | null;
  companyBriefGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Why: declares the shape of window.api set by preload/index.ts so the
// renderer gets full TypeScript coverage without importing Electron directly.
declare global {
  interface Window {
    api: {
      auth: {
        signup(email: string, password: string, displayName?: string): Promise<ApiEnvelope<AuthTokenData>>;
        login(email: string, password: string): Promise<ApiEnvelope<AuthTokenData>>;
        logout(): Promise<ApiEnvelope<{ loggedOut: boolean }>>;
        session(): Promise<ApiEnvelope<AuthSessionData>>;
      };
      projects: {
        list(): Promise<Project[]>;
        getOrCreateProfile(): Promise<Project>;
        get(id: string): Promise<Project | null>;
        create(input: { name: string; targetRole: string; jdText?: string }): Promise<Project>;
        delete(id: string): Promise<void>;
        clone(id: string): Promise<Project>;
        regenerateCompanyBrief(projectId: string): Promise<{ companyName: string; brief: string }>;
        onCompanyBriefUpdated(cb: (data: { companyName: string; brief: string }) => void): void;
        offCompanyBriefUpdated(): void;
      };
      materials: {
        list(projectId: string): Promise<Material[]>;
        addText(projectId: string, text: string): Promise<Material>;
        addGithubUrl(projectId: string, url: string): Promise<Material>;
        addUrl(projectId: string, url: string): Promise<Material>;
        addCompanyUrl(projectId: string, url: string): Promise<Material>;
        pickFiles(projectId: string): Promise<Material[]>;
        addDroppedFiles(projectId: string, filePaths: string[]): Promise<Material[]>;
        cancel(): Promise<void>;
        delete(id: string): Promise<void>;
        onProgress(cb: (message: string) => void): void;
        offProgress(): void;
        pickObsidianVault(): Promise<string | null>;
        scanObsidianVault(vaultPath: string, projectId?: string): Promise<ObsidianScanResult>;
        addObsidian(projectId: string, vaultPath: string, relPaths?: string[]): Promise<Material[]>;
      };
      cards: {
        list(projectId: string): Promise<Card[]>;
        listForMeeting(projectId: string): Promise<Card[]>;
        delete(id: string): Promise<void>;
        setVerified(id: string, v: boolean): Promise<void>;
        setImportant(id: string, v: boolean): Promise<void>;
        updateContent(id: string, patch: { title?: string; summary?: string; details?: string; tags?: string[] }): Promise<Card>;
        extract(projectId: string): Promise<Card[]>;
        onCardExtracted(cb: (card: Card) => void): void;
        offCardExtracted(): void;
        review(id: string, rating: number): Promise<Card>;
        dueForReview(projectId: string): Promise<Card[]>;
        deleteBatch(ids: string[]): Promise<void>;
        setImportantBatch(ids: string[], v: boolean): Promise<void>;
        setVerifiedBatch(ids: string[], v: boolean): Promise<void>;
      };
      license: {
        check(): Promise<{ offlineDaysLeft: number | null }>;
      };
      retrieval: {
        meetingSearch(projectId: string, query: string): Promise<{ cards: Card[]; lowConfidence: boolean }>;
        cardSearch(projectId: string, query: string): Promise<Card[]>;
      };
      survey: {
        submit(input: {
          projectId: string;
          meetingDate: string;
          outcome: 'went_well' | 'needs_followup' | 'no_progress' | 'prefer_not_to_say';
          cardHelpful: 'used_helpful' | 'used_not_helpful' | 'not_used';
          willUseNext: 'definitely' | 'maybe' | 'depends' | 'no';
          companyName?: string;
          freeText?: string;
        }): Promise<{ ok: boolean }>;
      };
      settings: {
        getLlmConfig(): Promise<LlmConfigPublic | null>;
        setLlmConfig(provider: string, apiKey: string, model?: string): Promise<void>;
        clearLlmConfig(): Promise<void>;
        verifyApiKey(provider: string, apiKey: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
        getObsidianConfig(): Promise<{ lastVaultPath?: string } | null>;
        setObsidianConfig(config: { lastVaultPath?: string }): Promise<void>;
      };
      meeting: {
        openFloat(): Promise<void>;
        updateCards(cards: Card[]): Promise<void>;
        updateCompanyBrief(brief: string | null): Promise<void>;
        onCompanyBriefUpdated(cb: (brief: string | null) => void): void;
        offCompanyBriefUpdated(): void;
        closeFloat(): Promise<void>;
        reshowFloat(): Promise<void>;
        onCardsUpdated(cb: (cards: Card[]) => void): void;
        offCardsUpdated(): void;
        classify(
          text: string,
        ): Promise<{ type: 'interrogative' | 'imperative' | 'follow_up'; text: string } | null>;
        getCorrectionRules(): Promise<string>;
        setCorrectionRules(text: string): Promise<void>;
        answer(payload: {
          requestId: number;
          question: string;
          cards: Array<{ title: string; summary: string; details: string }>;
        }): Promise<void>;
        onAnswerDelta(cb: (d: { requestId: number; delta: string }) => void): void;
        offAnswerDelta(): void;
        onAnswerDone(cb: (d: { requestId: number; ok: boolean }) => void): void;
        offAnswerDone(): void;
        // Swift SFSpeechRecognizer helper
        speechAvailable(): Promise<boolean>;
        speechStart(locale: string, contextWords: string[]): Promise<void>;
        speechStop(): Promise<void>;
        speechContext(words: string[], locale?: string): Promise<void>;
        onSpeechResult(cb: (msg: { type: string; text?: string; role?: 'self' | 'speaker' }) => void): void;
        offSpeechResult(): void;
        // System-audio (speaker) channel availability for graceful degradation.
        retrySystemAudio(): Promise<void>;
        onSystemAudioStatus(cb: (status: { available: boolean; denied: boolean; reason: string }) => void): void;
        offSystemAudioStatus(): void;
        getOverlayConfig(): Promise<OverlayConfig>;
        setOverlayConfig(config: OverlayConfig): Promise<void>;
        onOverlayResized(cb: (dims: { width: number; height: number }) => void): void;
        offOverlayResized(): void;
        onQuestionNav(cb: (msg: { delta: number }) => void): void;
        offQuestionNav(): void;
        // CoreML single-mic speaker gate (voiceprint enrollment + gated fallback).
        speakerModelAvailable(): Promise<boolean>;
        hasVoiceprint(): Promise<boolean>;
        getGateStatus(): Promise<{ enrolled: boolean; modelAvailable: boolean; gating: 'off' | 'active' }>;
        enrollStart(locale: string): Promise<{ ok: boolean; error?: string }>;
        enrollFinalize(): Promise<{ ok: boolean; error?: string }>;
        clearVoiceprint(): Promise<void>;
        onEnrollProgress(cb: (p: { seconds: number }) => void): void;
        offEnrollProgress(): void;
        onGateStatus(cb: (s: { enrolled: boolean; modelAvailable: boolean; gating: 'off' | 'active' }) => void): void;
        offGateStatus(): void;
      };
      export: {
        copyClipboard(projectId: string, range: 'auto' | 'all' | 'important'): Promise<number>;
        saveFile(projectId: string, range: 'auto' | 'all' | 'important'): Promise<string | null>;
        generatePdf(projectId: string, template: 'simple' | 'modern', range: 'auto' | 'all' | 'important'): Promise<string | null>;
        exportObsidian(projectId: string, range: 'auto' | 'all' | 'important'): Promise<{ folder: string; count: number } | null>;
        cardCounts(projectId: string): Promise<{ auto: number; all: number; important: number }>;
      };
    };
  }
}

export {};

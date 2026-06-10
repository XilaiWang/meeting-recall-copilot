import { contextBridge, ipcRenderer } from 'electron';

// Why: exposeInMainWorld is the only safe way to give renderer access to Node APIs.
// We expose a typed `window.api` object instead of raw ipcRenderer so the renderer
// can never accidentally send arbitrary IPC channels.
contextBridge.exposeInMainWorld('api', {
  auth: {
    signup: (email: string, password: string, displayName?: string) =>
      ipcRenderer.invoke('auth:signup', email, password, displayName),
    login: (email: string, password: string) =>
      ipcRenderer.invoke('auth:login', email, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    session: () => ipcRenderer.invoke('auth:session'),
  },
  projects: {
    list: () => ipcRenderer.invoke('project:list'),
    getOrCreateProfile: () => ipcRenderer.invoke('project:get-or-create-profile'),
    get: (id: string) => ipcRenderer.invoke('project:get', id),
    create: (input: { name: string; targetRole: string; jdText?: string }) =>
      ipcRenderer.invoke('project:create', input),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    clone: (id: string) => ipcRenderer.invoke('project:clone', id),
    regenerateCompanyBrief: (projectId: string) =>
      ipcRenderer.invoke('project:regenerate-company-brief', projectId),
    onCompanyBriefUpdated: (cb: (data: { companyName: string; brief: string }) => void) => {
      ipcRenderer.on('project:company-brief-updated', (_e, data: { companyName: string; brief: string }) => cb(data));
    },
    offCompanyBriefUpdated: () => { ipcRenderer.removeAllListeners('project:company-brief-updated'); },
  },
  materials: {
    list: (projectId: string) => ipcRenderer.invoke('material:list', projectId),
    addText: (projectId: string, text: string) => ipcRenderer.invoke('material:add-text', projectId, text),
    addGithubUrl: (projectId: string, url: string) => ipcRenderer.invoke('material:add-github-url', projectId, url),
    addUrl: (projectId: string, url: string) => ipcRenderer.invoke('material:add-url', projectId, url),
    addCompanyUrl: (projectId: string, url: string) => ipcRenderer.invoke('material:add-company-url', projectId, url),
    pickFiles: (projectId: string) => ipcRenderer.invoke('material:pick-files', projectId),
    addDroppedFiles: (projectId: string, filePaths: string[]) => ipcRenderer.invoke('material:add-dropped-files', projectId, filePaths),
    cancel: () => ipcRenderer.invoke('material:cancel'),
    delete: (id: string) => ipcRenderer.invoke('material:delete', id),
    onProgress: (cb: (message: string) => void) => {
      ipcRenderer.on('material:progress', (_e, message: string) => cb(message));
    },
    offProgress: () => { ipcRenderer.removeAllListeners('material:progress'); },
    pickObsidianVault: () => ipcRenderer.invoke('material:obsidian-pick-vault'),
    scanObsidianVault: (vaultPath: string, projectId?: string) => ipcRenderer.invoke('material:obsidian-scan', vaultPath, projectId),
    addObsidian: (projectId: string, vaultPath: string, relPaths?: string[]) =>
      ipcRenderer.invoke('material:add-obsidian', projectId, vaultPath, relPaths),
  },
  cards: {
    list: (projectId: string) => ipcRenderer.invoke('card:list', projectId),
    listForMeeting: (projectId: string) => ipcRenderer.invoke('card:list-for-meeting', projectId),
    delete: (id: string) => ipcRenderer.invoke('card:delete', id),
    setVerified: (id: string, v: boolean) => ipcRenderer.invoke('card:update-verified', id, v),
    setImportant: (id: string, v: boolean) => ipcRenderer.invoke('card:update-important', id, v),
    updateContent: (id: string, patch: { title?: string; summary?: string; details?: string; tags?: string[] }) =>
      ipcRenderer.invoke('card:update-content', id, patch),
    extract: (projectId: string) => ipcRenderer.invoke('project:extract-cards', projectId),
    onCardExtracted: (cb: (card: unknown) => void) => {
      ipcRenderer.on('card:extracted', (_e, card: unknown) => cb(card));
    },
    offCardExtracted: () => { ipcRenderer.removeAllListeners('card:extracted'); },
    review: (id: string, rating: number) => ipcRenderer.invoke('card:review', id, rating),
    dueForReview: (projectId: string) => ipcRenderer.invoke('card:due-review', projectId),
    deleteBatch: (ids: string[]) => ipcRenderer.invoke('card:delete-batch', ids),
    setImportantBatch: (ids: string[], v: boolean) => ipcRenderer.invoke('card:update-important-batch', ids, v),
    setVerifiedBatch: (ids: string[], v: boolean) => ipcRenderer.invoke('card:update-verified-batch', ids, v),
  },
  settings: {
    getLlmConfig: () => ipcRenderer.invoke('settings:get-llm-config'),
    setLlmConfig: (provider: string, apiKey: string, model?: string) =>
      ipcRenderer.invoke('settings:set-llm-config', provider, apiKey, model),
    clearLlmConfig: () => ipcRenderer.invoke('settings:clear-llm-config'),
    verifyApiKey: (provider: string, apiKey: string) =>
      ipcRenderer.invoke('settings:verify-api-key', provider, apiKey),
    getObsidianConfig: () => ipcRenderer.invoke('settings:get-obsidian-config'),
    setObsidianConfig: (config: { lastVaultPath?: string }) =>
      ipcRenderer.invoke('settings:set-obsidian-config', config),
  },
  meeting: {
    openFloat: () => ipcRenderer.invoke('meeting:open-float'),
    updateCards: (cards: unknown[]) => ipcRenderer.invoke('meeting:update-cards', cards),
    updateCompanyBrief: (brief: string | null) => ipcRenderer.invoke('meeting:update-company-brief', brief),
    onCompanyBriefUpdated: (cb: (brief: string | null) => void) => {
      ipcRenderer.on('meeting:company-brief-updated', (_e, brief: string | null) => cb(brief));
    },
    offCompanyBriefUpdated: () => { ipcRenderer.removeAllListeners('meeting:company-brief-updated'); },
    closeFloat: () => ipcRenderer.invoke('meeting:close-float'),
    reshowFloat: () => ipcRenderer.invoke('meeting:reshow-float'),
    onCardsUpdated: (cb: (cards: unknown[]) => void) => {
      ipcRenderer.on('meeting:cards-updated', (_e, cards: unknown[]) => cb(cards));
    },
    offCardsUpdated: () => { ipcRenderer.removeAllListeners('meeting:cards-updated'); },
    classify: (text: string) =>
      ipcRenderer.invoke('meeting:classify', text),
    getCorrectionRules: (): Promise<string> => ipcRenderer.invoke('meeting:get-correction-rules'),
    setCorrectionRules: (text: string) => ipcRenderer.invoke('meeting:set-correction-rules', text),
    // No-match LLM fallback answer (streaming via answer-delta / answer-done events)
    answer: (payload: { requestId: number; question: string; cards: Array<{ title: string; summary: string; details: string }> }) =>
      ipcRenderer.invoke('meeting:answer', payload),
    onAnswerDelta: (cb: (d: { requestId: number; delta: string }) => void) => {
      ipcRenderer.on('meeting:answer-delta', (_e, d: { requestId: number; delta: string }) => cb(d));
    },
    offAnswerDelta: () => { ipcRenderer.removeAllListeners('meeting:answer-delta'); },
    onAnswerDone: (cb: (d: { requestId: number; ok: boolean }) => void) => {
      ipcRenderer.on('meeting:answer-done', (_e, d: { requestId: number; ok: boolean }) => cb(d));
    },
    offAnswerDone: () => { ipcRenderer.removeAllListeners('meeting:answer-done'); },
    // Swift SFSpeechRecognizer helper
    speechAvailable: () => ipcRenderer.invoke('meeting:swift-available'),
    speechStart: (locale: string, contextWords: string[]) =>
      ipcRenderer.invoke('meeting:speech-start', locale, contextWords),
    speechStop: () => ipcRenderer.invoke('meeting:speech-stop'),
    speechContext: (words: string[], locale?: string) => ipcRenderer.invoke('meeting:speech-context', words, locale),
    onSpeechResult: (cb: (msg: { type: string; text?: string; role?: 'self' | 'speaker' }) => void) => {
      ipcRenderer.on('meeting:speech-result', (_e, msg: { type: string; text?: string; role?: 'self' | 'speaker' }) => cb(msg));
    },
    offSpeechResult: () => { ipcRenderer.removeAllListeners('meeting:speech-result'); },
    retrySystemAudio: () => ipcRenderer.invoke('meeting:retry-system-audio'),
    onSystemAudioStatus: (cb: (status: { available: boolean; denied: boolean; reason: string }) => void) => {
      ipcRenderer.on('meeting:system-audio-status', (_e, status: { available: boolean; denied: boolean; reason: string }) => cb(status));
    },
    offSystemAudioStatus: () => { ipcRenderer.removeAllListeners('meeting:system-audio-status'); },
    getOverlayConfig: () => ipcRenderer.invoke('meeting:get-overlay-config'),
    setOverlayConfig: (config: unknown) => ipcRenderer.invoke('meeting:set-overlay-config', config),
    onOverlayResized: (cb: (dims: { width: number; height: number }) => void) => {
      ipcRenderer.on('meeting:overlay-resized', (_e, dims: { width: number; height: number }) => cb(dims));
    },
    offOverlayResized: () => { ipcRenderer.removeAllListeners('meeting:overlay-resized'); },
    onQuestionNav: (cb: (msg: { delta: number }) => void) => {
      ipcRenderer.on('meeting:question-nav', (_e, msg: { delta: number }) => cb(msg));
    },
    offQuestionNav: () => { ipcRenderer.removeAllListeners('meeting:question-nav'); },
    // CoreML single-mic speaker gate (voiceprint enrollment + gated fallback).
    speakerModelAvailable: () => ipcRenderer.invoke('meeting:speaker-model-available'),
    hasVoiceprint: () => ipcRenderer.invoke('meeting:has-voiceprint'),
    getGateStatus: () => ipcRenderer.invoke('meeting:gate-status'),
    enrollStart: (locale: string) => ipcRenderer.invoke('meeting:enroll-start', locale),
    enrollFinalize: () => ipcRenderer.invoke('meeting:enroll-finalize'),
    clearVoiceprint: () => ipcRenderer.invoke('meeting:clear-voiceprint'),
    onEnrollProgress: (cb: (p: { seconds: number }) => void) => {
      ipcRenderer.on('meeting:enroll-progress', (_e, p: { seconds: number }) => cb(p));
    },
    offEnrollProgress: () => { ipcRenderer.removeAllListeners('meeting:enroll-progress'); },
    onGateStatus: (cb: (s: { enrolled: boolean; modelAvailable: boolean; gating: 'off' | 'active' }) => void) => {
      ipcRenderer.on('meeting:gate-status-changed', (_e, s: { enrolled: boolean; modelAvailable: boolean; gating: 'off' | 'active' }) => cb(s));
    },
    offGateStatus: () => { ipcRenderer.removeAllListeners('meeting:gate-status-changed'); },
  },
  license: {
    check: () => ipcRenderer.invoke('license:check'),
  },
  retrieval: {
    meetingSearch: (projectId: string, query: string) =>
      ipcRenderer.invoke('retrieval:meeting-search', projectId, query),
    cardSearch: (projectId: string, query: string) =>
      ipcRenderer.invoke('retrieval:card-search', projectId, query),
  },
  survey: {
    submit: (input: {
      projectId: string;
      meetingDate: string;
      outcome: string;
      cardHelpful: string;
      willUseNext: string;
      companyName?: string;
      freeText?: string;
    }) => ipcRenderer.invoke('survey:submit', input),
  },
  export: {
    copyClipboard: (projectId: string, range: string) => ipcRenderer.invoke('export:copy-clipboard', projectId, range),
    saveFile: (projectId: string, range: string) => ipcRenderer.invoke('export:save-file', projectId, range),
    generatePdf: (projectId: string, template: string, range: string) =>
      ipcRenderer.invoke('export:generate-pdf', projectId, template, range),
    exportObsidian: (projectId: string, range: string) => ipcRenderer.invoke('export:obsidian', projectId, range),
    cardCounts: (projectId: string) => ipcRenderer.invoke('export:card-counts', projectId),
  },
});

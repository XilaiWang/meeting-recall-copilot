import { ipcMain, BrowserWindow, app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { getDb } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getLlmConfig } from './settings.js';
import { streamLlm } from '../lib/llm.js';
import { classifyQuestion, type QuestionType } from '../lib/question-detect.js';
import { applyCorrectionRules, parseCorrectionRules, type CorrectionRule } from '../lib/correction.js';
import { meetingBundleIdsForSource } from '../lib/meeting-apps.js';
import {
  type GateMode,
  type StoredVoiceprint,
  parseStoredVoiceprint,
  serializeVoiceprint,
  decideGateActivation,
  shouldDisarmOnSystemRecovery,
  gateStatus,
} from '../lib/speaker-gate-policy.js';

// ── Native NSPanel overlay process ───────────────────────────────────────────

const OVERLAY_CONFIG_KEY = 'overlay_config';
const CORRECTION_RULES_KEY = 'correction_rules';
// Cached post-ASR correction rules (loaded at startup, refreshed on set). Applied
// in the classify handler so mis-heard terms are fixed before detection/matching.
let correctionRulesText = '';
let correctionRules: CorrectionRule[] = [];

interface OverlayConfig {
  screenshotProtected: boolean;
  overlayWidth: number;
  overlayHeight: number;
}

let overlayConfig: OverlayConfig = { screenshotProtected: true, overlayWidth: 600, overlayHeight: 200 };
let overlayProc: ChildProcess | null = null;
let overlayCards: unknown[] = [];

// Why: module-level so it persists across IPC calls and can be prepended to short
// follow-up segments ("那个呢？"、"再说说？") that have no standalone context.
let lastDetectedQuestion: string | null = null;

// ── Swift SpeechHelper child process ─────────────────────────────────────────

// Why two channels: on-device recognition is single-session per process, so the
// mic (self) and the system-audio tap (speaker) each run in their own
// SpeechHelper process. Each tracks its own retry state (exponential back-off
// after an unexpected exit, e.g. AVAudioEngineConfigurationChange on Bluetooth).
type SpeechSource = 'mic' | 'system';

interface SpeechChannel {
  source: SpeechSource;
  proc: ChildProcess | null;
  win: BrowserWindow | null;
  shouldRetry: boolean;
  retryCount: number;
  locale: string;
  words: string[];
  retryTimer: ReturnType<typeof setTimeout> | null;
  // Why: carries the single-mic gating intent across exponential-backoff respawns,
  // so spawnSpeechChannel rebuilds argv with --gate --model after an unexpected exit
  // without the caller re-arming it each time.
  gate: boolean;
  // Why: when the gate is armed via the system-tap fallback (not fresh enrollment),
  // we must restore the persisted voiceprint after the helper reports 'listening' so
  // it classifies without re-recording. Set once, consumed on the next 'listening'.
  loadVoiceprintOnListening: boolean;
}

const SPEECH_MAX_RETRIES = 8;

function makeChannel(source: SpeechSource): SpeechChannel {
  return { source, proc: null, win: null, shouldRetry: false, retryCount: 0, locale: 'zh-CN', words: [], retryTimer: null, gate: false, loadVoiceprintOnListening: false };
}
const speechChannels: Record<SpeechSource, SpeechChannel> = {
  mic: makeChannel('mic'),
  system: makeChannel('system'),
};

function roleFor(source: SpeechSource): 'self' | 'speaker' {
  return source === 'system' ? 'speaker' : 'self';
}

// ── Single-mic speaker gate (CoreML) ─────────────────────────────────────────
// Why: when the system-audio tap is denied/unavailable we fall back to ONE mic and
// use a CAM++ voiceprint (Swift helper + CoreML) to label each final as self
// vs speaker. Every feature here is INERT when the model file is absent — the
// common case today — so dual-channel behaviour is never altered.

const VOICEPRINT_KEY = 'speaker_voiceprint';

// Why: module-level so the persisted voiceprint and current gating mode survive
// across IPC calls and the backoff respawn. voiceprint is loaded lazily on first
// registration (mirrors overlay_config) and updated on enroll/clear.
let voiceprint: StoredVoiceprint | null = null;
let gating: GateMode = 'off';
// Why: true only while the gate was armed as a SINGLE-MIC FALLBACK (system tap lost),
// as opposed to a deliberate enrollment session. Lets us DISARM the fallback — and
// only the fallback — when the system tap recovers, so the live system channel (not
// the mic voiceprint) labels the speaker and we don't double-classify.
let singleMicFallbackArmed = false;

// Why: enroll-finalize is inherently async — the helper computes the embedding and
// only THEN emits 'voiceprint' (or 'error':'enroll_failed'). A one-shot resolver lets
// the IPC call await the authoritative result instead of the renderer racing a status
// read (which would resolve before the round-trip and show a spurious failure).
type EnrollResult = { ok: boolean; error?: string };
let pendingEnroll: { resolve: (r: EnrollResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;
function settleEnroll(result: EnrollResult): void {
  if (!pendingEnroll) return;
  clearTimeout(pendingEnroll.timer);
  const resolve = pendingEnroll.resolve;
  pendingEnroll = null;
  resolve(result);
}

function sendSpeechResult(win: BrowserWindow | null, msg: Record<string, unknown>): void {
  if (win && !win.isDestroyed()) win.webContents.send('meeting:speech-result', msg);
}
function sendSystemAudioStatus(win: BrowserWindow | null, status: { available: boolean; denied: boolean; reason: string }): void {
  if (win && !win.isDestroyed()) win.webContents.send('meeting:system-audio-status', status);
}

function getSpeechHelperPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'SpeechHelper');
  }
  // Dev: main bundle is at out/main/, resources/ is two levels up from there.
  return join(__dirname, '../../resources/SpeechHelper');
}

// Why: mirrors getSpeechHelperPath() but for the compiled CoreML speaker model.
// It is a DROP-IN that does not exist yet — every gate/enroll path existsSync-guards
// this so the feature gracefully no-ops (reports unavailable) until the file lands.
function getSpeakerModelPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'CAMPlusSpeaker.mlmodelc');
  }
  return join(__dirname, '../../resources/CAMPlusSpeaker.mlmodelc');
}

function isSpeakerModelAvailable(): boolean {
  return existsSync(getSpeakerModelPath());
}

// Why: push the current gate status to all windows after any state change (enroll,
// clear, fallback arm) so the renderer reflects enrolled/model/gating without polling.
function pushGateStatusChanged(): void {
  const status = gateStatus({ hasVoiceprint: voiceprint !== null, modelAvailable: isSpeakerModelAvailable(), gating });
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('meeting:gate-status-changed', status);
  }
}

// Why: persist the enrolled voiceprint into the appSettings key-value table, mirroring
// the overlay_config insert/onConflictDoUpdate pattern (no migration / no new table).
async function persistVoiceprint(v: StoredVoiceprint): Promise<void> {
  const valueJson = JSON.parse(serializeVoiceprint(v)) as Record<string, unknown>;
  const db = getDb();
  await db.insert(appSettings)
    .values({ key: VOICEPRINT_KEY, valueJson, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: new Date() } });
}

// Why: drop the persisted voiceprint so a future session starts un-enrolled; the gate
// then stays inert until the user re-records (mirrors a settings delete).
async function deleteVoiceprint(): Promise<void> {
  const db = getDb();
  await db.delete(appSettings).where(eq(appSettings.key, VOICEPRINT_KEY));
}

// Why: arm single-mic speaker gating when the system tap is unavailable AND a
// voiceprint + model exist. Idempotent (no-op once gated), so it can be called from
// EVERY system-channel failure path — the JSON 'error' event, a spawn 'error', and a
// retry-exhausted 'exit' (silent crash). Without an enrolled voiceprint/model it is a
// no-op, so the un-enrolled common case is never altered.
function maybeArmSingleMicFallback(triggerWin: BrowserWindow | null): void {
  if (gating === 'active' || speechChannels.mic.gate) return;
  const mode = decideGateActivation({
    systemAvailable: false,
    hasVoiceprint: voiceprint !== null,
    modelAvailable: isSpeakerModelAvailable(),
  });
  if (mode !== 'active') return;
  const mic = speechChannels.mic;
  const micWin = mic.win ?? triggerWin;
  if (!micWin || micWin.isDestroyed()) return;
  gating = 'active';
  singleMicFallbackArmed = true;
  mic.gate = true;
  mic.loadVoiceprintOnListening = true;
  mic.shouldRetry = true;
  mic.retryCount = 0;
  spawnSpeechChannel(mic, micWin);
  pushGateStatusChanged();
}

// Why: the inverse of maybeArmSingleMicFallback — when the system tap RECOVERS (its
// channel reaches 'listening' again) after a fallback was armed, disarm the gate so
// the live system channel labels the speaker instead of the mic voiceprint;
// otherwise both channels classify the speaker at once. Respawns the mic ungated
// so it reverts to plain self-only capture. Only a fallback-armed gate disarms;
// a deliberate enrollment session's gate is left intact.
function maybeDisarmSingleMicFallback(): void {
  if (!shouldDisarmOnSystemRecovery({ gating, fallbackArmed: singleMicFallbackArmed })) return;
  singleMicFallbackArmed = false;
  gating = 'off';
  const mic = speechChannels.mic;
  mic.gate = false;
  mic.loadVoiceprintOnListening = false;
  if (mic.win && !mic.win.isDestroyed()) {
    mic.shouldRetry = true;
    mic.retryCount = 0;
    spawnSpeechChannel(mic, mic.win);
  }
  pushGateStatusChanged();
}

function spawnSpeechChannel(ch: SpeechChannel, targetWin: BrowserWindow): void {
  killChannel(ch);

  const helperPath = getSpeechHelperPath();
  if (!existsSync(helperPath)) {
    sendSpeechResult(targetWin, { type: 'error', text: 'helper_not_found', role: roleFor(ch.source) });
    return;
  }

  // --source selects the audio channel at launch; the start command repeats it.
  const argv = ['--source', ch.source];
  // Why: only append --gate --model when the channel asked for gating AND the CoreML
  // model is actually present. Passing --gate with a missing model is harmless (the
  // Swift gate stays inert), but we existsSync-guard so a missing drop-in NEVER alters
  // today's argv / behaviour. Persists across backoff respawns via ch.gate.
  const modelPath = getSpeakerModelPath();
  if (ch.gate && existsSync(modelPath)) {
    argv.push('--gate', '--model', modelPath);
  }
  const proc = spawn(helperPath, argv, {
    // Why: 'inherit' for stderr so Swift crashes appear in the Electron console.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  ch.proc = proc;
  ch.win = targetWin;

  let buf = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { type: string; text?: string; role?: string; seconds?: string; data?: string; dim?: string };
        // Enrollment telemetry: surface recorded seconds to the renderer's progress UI.
        // Strings per the Swift contract; coerce to number for the typed push payload.
        if (msg.type === 'enroll-progress') {
          const seconds = Number(msg.seconds);
          if (ch.win && !ch.win.isDestroyed()) {
            ch.win.webContents.send('meeting:enroll-progress', { seconds });
          }
          continue;
        }
        // Voiceprint emitted after gate-finalize: persist {data,dim}, mark the gate
        // active, and push the new status. This is the only place enrollment completes.
        if (msg.type === 'voiceprint' && typeof msg.data === 'string' && msg.data.length > 0) {
          const parsed = parseStoredVoiceprint({ data: msg.data, dim: Number(msg.dim) });
          if (parsed) {
            voiceprint = parsed;
            gating = 'active';
            settleEnroll({ ok: true });
            void persistVoiceprint(parsed)
              .catch(() => { /* best-effort: an in-memory voiceprint still gates this session */ })
              .finally(() => { pushGateStatusChanged(); });
          } else {
            settleEnroll({ ok: false, error: 'invalid_voiceprint' });
          }
          continue;
        }
        // Enrollment failure from the helper (e.g. too little usable audio) → resolve
        // the pending enroll-finalize so the modal shows the right message, not a hang.
        if (msg.type === 'error' && msg.text === 'enroll_failed') {
          settleEnroll({ ok: false, error: 'enroll_failed' });
          continue;
        }
        if (msg.type === 'ready') {
          // System (speaker) channel: pass the meeting-app whitelist so the
          // helper taps a running meeting app directly, falling back to the whole-
          // system mixdown if none is running. The mic channel gets none.
          const startMsg: Record<string, unknown> = {
            action: 'start', source: ch.source, locale: ch.locale, contextWords: ch.words,
          };
          const bundleIds = meetingBundleIdsForSource(ch.source);
          if (bundleIds.length) startMsg['bundleIds'] = bundleIds;
          proc.stdin?.write(JSON.stringify(startMsg) + '\n');
          continue;
        }
        if (msg.type === 'listening' && ch.loadVoiceprintOnListening && voiceprint) {
          // Restore the persisted voiceprint into the freshly-gated mic channel so it
          // classifies self vs speaker without re-recording (fallback arm).
          ch.loadVoiceprintOnListening = false;
          proc.stdin?.write(JSON.stringify({ action: 'load-voiceprint', data: voiceprint.data }) + '\n');
        }
        if (ch.source === 'system' && msg.type === 'listening') {
          // System tap is live (initial start or recovery after a failure) — clear any
          // degradation banner, and if a single-mic fallback was armed while it was
          // down, disarm it so we don't double-classify the speaker.
          sendSystemAudioStatus(ch.win, { available: true, denied: false, reason: '' });
          maybeDisarmSingleMicFallback();
        }
        const role = msg.role ?? roleFor(ch.source);
        // System-channel failure degrades gracefully: tell the renderer (banner +
        // retry), stop the auto-retry loop, and leave the mic channel untouched. We
        // do NOT silently fall back to classifying the mic — role separation holds.
        if (ch.source === 'system' && msg.type === 'error') {
          const reason = msg.text ?? 'unknown';
          ch.shouldRetry = false;
          sendSystemAudioStatus(ch.win, { available: false, denied: /denied/i.test(reason), reason });
          // Single-mic fallback: arm gating on the mic channel if a voiceprint is
          // enrolled AND the model is present (idempotent; no-op otherwise).
          maybeArmSingleMicFallback(ch.win);
        }
        sendSpeechResult(ch.win, { ...msg, role });
      } catch { /* malformed JSON line — ignore */ }
    }
  });

  proc.on('error', (err) => {
    sendSpeechResult(ch.win, { type: 'error', text: `spawn_failed: ${err.message}`, role: roleFor(ch.source) });
    // A system-channel spawn failure means the tap can't run at all → degrade + arm
    // the single-mic fallback (same as a JSON 'error'), so gating isn't missed.
    if (ch.source === 'system') {
      ch.shouldRetry = false;
      sendSystemAudioStatus(ch.win, { available: false, denied: false, reason: `spawn_failed: ${err.message}` });
      maybeArmSingleMicFallback(ch.win);
    }
  });

  proc.on('exit', () => {
    if (ch.proc === proc) ch.proc = null;
    // Unexpected exit: per-channel retry with exponential back-off (Textream pattern:
    // 0.5 + rand(0,1) * (retryCount+1) seconds).
    if (ch.shouldRetry && ch.retryCount < SPEECH_MAX_RETRIES) {
      // A gated mic that crashed mid-session must re-restore its voiceprint on the
      // respawn — loadVoiceprintOnListening was consumed on the first 'listening'.
      // Guarded by `voiceprint` so a fresh enrollment (voiceprint still null) is a
      // no-op and we never clobber an in-progress enroll.
      if (ch.gate && voiceprint) ch.loadVoiceprintOnListening = true;
      const delaySecs = 0.5 + Math.random() * (ch.retryCount + 1);
      ch.retryCount++;
      ch.retryTimer = setTimeout(() => {
        ch.retryTimer = null;
        if (ch.shouldRetry && ch.win && !ch.win.isDestroyed()) spawnSpeechChannel(ch, ch.win);
      }, delaySecs * 1000);
    } else if (ch.source === 'system' && ch.shouldRetry) {
      // Retries exhausted on a SILENT system crash (no JSON 'error' was ever emitted):
      // degrade + arm the single-mic fallback, matching the explicit-error path.
      ch.shouldRetry = false;
      sendSystemAudioStatus(ch.win, { available: false, denied: false, reason: 'system_audio_exited' });
      maybeArmSingleMicFallback(ch.win);
    }
  });
}

function killChannel(ch: SpeechChannel): void {
  ch.shouldRetry = false;
  ch.retryCount = 0;
  if (ch.retryTimer) { clearTimeout(ch.retryTimer); ch.retryTimer = null; }
  if (ch.proc) {
    try { ch.proc.kill(); } catch { /* ignore */ }
    ch.proc = null;
  }
  ch.win = null;
}

function killAllSpeech(): void {
  killChannel(speechChannels.mic);
  killChannel(speechChannels.system);
}

// Clean up on app quit.
app.on('before-quit', killAllSpeech);
app.on('before-quit', killOverlay);

function getOverlayPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'QAMatchingOverlay');
  }
  return join(__dirname, '../../resources/QAMatchingOverlay');
}

function killOverlay(): void {
  if (overlayProc) {
    try { overlayProc.stdin?.write(JSON.stringify({ action: 'quit' }) + '\n'); } catch { /* ignore */ }
    try { overlayProc.kill(); } catch { /* ignore */ }
    overlayProc = null;
  }
}

function spawnOverlay(): void {
  if (overlayProc && !overlayProc.killed) return;
  const helperPath = getOverlayPath();
  if (!existsSync(helperPath)) return;

  const proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  overlayProc = proc;

  // Read overlay stdout for "resized" events (emitted when user drags the handle).
  let overlayBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    overlayBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = overlayBuf.indexOf('\n')) !== -1) {
      const line = overlayBuf.slice(0, nl).trim();
      overlayBuf = overlayBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { type: string; width?: number; height?: number; delta?: number };
        if (msg.type === 'resized' && typeof msg.width === 'number' && typeof msg.height === 'number') {
          overlayConfig.overlayWidth  = Math.round(msg.width);
          overlayConfig.overlayHeight = Math.round(msg.height);
          const cfg = { ...overlayConfig };
          void getDb().insert(appSettings)
            .values({ key: OVERLAY_CONFIG_KEY, valueJson: cfg as unknown as Record<string, unknown>, updatedAt: new Date() })
            .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: cfg as unknown as Record<string, unknown>, updatedAt: new Date() } })
            .catch(() => { /* persisting overlay size is best-effort — never crash on a DB write error */ });
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('meeting:overlay-resized', { width: cfg.overlayWidth, height: cfg.overlayHeight });
            }
          }
        } else if (msg.type === 'question-nav' && typeof msg.delta === 'number') {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('meeting:question-nav', { delta: msg.delta });
            }
          }
        }
      } catch { /* ignore malformed lines */ }
    }
  });

  proc.on('exit', () => { if (overlayProc === proc) overlayProc = null; });
  proc.on('error', () => { if (overlayProc === proc) overlayProc = null; });
}

export function registerMeetingIpcHandlers() {
  // Load persisted overlay config (fire-and-forget; defaults apply until loaded)
  void (async () => {
    const db = getDb();
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, OVERLAY_CONFIG_KEY));
    if (row) {
      const v = row.valueJson as Partial<OverlayConfig>;
      overlayConfig = {
        screenshotProtected: v.screenshotProtected ?? true,
        overlayWidth:  v.overlayWidth  ?? 600,
        overlayHeight: v.overlayHeight ?? 200,
      };
    }
  })();

  // Load persisted post-ASR correction rules (fire-and-forget; empty until loaded).
  void (async () => {
    const db = getDb();
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, CORRECTION_RULES_KEY));
    if (row && typeof row.valueJson === 'string') {
      correctionRulesText = row.valueJson;
      correctionRules = parseCorrectionRules(correctionRulesText);
    }
  })();

  // Load persisted speaker voiceprint (fire-and-forget; gate stays inert until loaded).
  // parseStoredVoiceprint discards a corrupted/legacy row so we never arm with garbage.
  void (async () => {
    const db = getDb();
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, VOICEPRINT_KEY));
    if (row) voiceprint = parseStoredVoiceprint(row.valueJson);
  })();

  // ── Native NSPanel overlay (QAMatchingOverlay Swift binary) ──────────────
  // Why: NSPanel at .screenSaver level with [.canJoinAllSpaces, .fullScreenAuxiliary,
  // .stationary] gives true system-level overlay behavior that a BrowserWindow
  // cannot replicate: it appears over fullscreen apps, persists across Spaces,
  // never steals focus, and can merge with the hardware notch via precise y=0 placement.

  function overlayShowPayload(cards: unknown[]) {
    return JSON.stringify({
      action: 'show', cards,
      width: overlayConfig.overlayWidth,
      height: overlayConfig.overlayHeight,
      screenshotProtected: overlayConfig.screenshotProtected,
    }) + '\n';
  }

  ipcMain.handle('meeting:open-float', () => {
    spawnOverlay();
    overlayProc?.stdin?.write(overlayShowPayload(overlayCards));
  });

  ipcMain.handle('meeting:update-cards', (_event, cards: unknown[]) => {
    overlayCards = cards;
    spawnOverlay();
    overlayProc?.stdin?.write(JSON.stringify({ action: 'update', cards }) + '\n');
  });

  ipcMain.handle('meeting:update-company-brief', (_event, brief: string | null) => {
    overlayProc?.stdin?.write(JSON.stringify({ action: 'companyBrief', brief }) + '\n');
    // Mirror brief to all open windows (web float listens for this event).
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('meeting:company-brief-updated', brief);
    }
  });

  ipcMain.handle('meeting:close-float', () => {
    overlayProc?.stdin?.write(JSON.stringify({ action: 'hide' }) + '\n');
  });

  ipcMain.handle('meeting:reshow-float', () => {
    spawnOverlay();
    overlayProc?.stdin?.write(overlayShowPayload(overlayCards));
  });

  ipcMain.handle('meeting:get-overlay-config', (): OverlayConfig => overlayConfig);

  ipcMain.handle('meeting:set-overlay-config', async (_event, config: OverlayConfig): Promise<void> => {
    const prev = overlayConfig;
    overlayConfig = config;
    const db = getDb();
    await db.insert(appSettings)
      .values({ key: OVERLAY_CONFIG_KEY, valueJson: config as unknown as Record<string, unknown>, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: config as unknown as Record<string, unknown>, updatedAt: new Date() } });
    // Live-apply screenshot toggle without restarting the overlay
    if (prev.screenshotProtected !== config.screenshotProtected && overlayProc) {
      overlayProc.stdin?.write(JSON.stringify({ action: 'screenshot', protected: config.screenshotProtected }) + '\n');
    }
  });

  // ── Swift SFSpeechRecognizer IPC ──
  // Why: SFSpeechRecognizer supports contextualStrings (domain keyword priming)
  // and runs fully on-device on macOS 14+, unlike the Web Speech API which hits
  // Apple's servers. We spawn a compiled Swift helper as a child process and
  // communicate via newline-delimited JSON on stdin/stdout.

  // Post-ASR correction rules — stored as the raw textarea string ("听错 => 正确"
  // per line). get returns the in-memory copy; set persists + refreshes the cache.
  ipcMain.handle('meeting:get-correction-rules', (): string => correctionRulesText);

  ipcMain.handle('meeting:set-correction-rules', async (_event, text: string): Promise<void> => {
    correctionRulesText = typeof text === 'string' ? text : '';
    correctionRules = parseCorrectionRules(correctionRulesText);
    const db = getDb();
    const value = correctionRulesText as unknown as Record<string, unknown>;
    await db.insert(appSettings)
      .values({ key: CORRECTION_RULES_KEY, valueJson: value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: value, updatedAt: new Date() } });
  });

  ipcMain.handle('meeting:swift-available', () => existsSync(getSpeechHelperPath()));

  ipcMain.handle('meeting:speech-start', (event, locale: string, contextWords: string[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    // Why: begin a clean DUAL-channel session — never inherit a single-mic gate that a
    // PRIOR session armed as a fallback (otherwise the mic would run gated while the
    // system tap works, double-classifying the speaker). The fallback re-arms on
    // demand if the system tap fails again this session.
    speechChannels.mic.gate = false;
    speechChannels.mic.loadVoiceprintOnListening = false;
    if (gating !== 'off') { gating = 'off'; }
    singleMicFallbackArmed = false;
    // Start BOTH channels: mic (self) + system tap (speaker; whole-system
    // output by default). contextualStrings prime only the speaker channel.
    for (const source of ['mic', 'system'] as SpeechSource[]) {
      const ch = speechChannels[source];
      ch.shouldRetry = true;
      ch.retryCount = 0;
      ch.locale = locale;
      ch.words = source === 'system' ? contextWords : [];
      spawnSpeechChannel(ch, win);
    }
  });

  ipcMain.handle('meeting:speech-stop', () => {
    killAllSpeech();
    // No channel is running → tear down gate state. The enrolled voiceprint persists
    // (so the next session can re-arm the fallback on system-tap failure), but the
    // gate/fallback intent is cleared so it never leaks into the next session as a
    // mic gate while the system tap works.
    if (gating !== 'off') { gating = 'off'; pushGateStatusChanged(); }
    singleMicFallbackArmed = false;
    speechChannels.mic.gate = false;
    speechChannels.mic.loadVoiceprintOnListening = false;
    // Why: lastDetectedQuestion is a module singleton; clear it so a follow-up like
    // "那这个呢" at the START of the NEXT meeting can't inherit the prior session's
    // question as its anaphoric referent.
    lastDetectedQuestion = null;
  });

  ipcMain.handle('meeting:speech-context', (_event, words: string[], locale?: string) => {
    // Why: contextualStrings (matched-card keywords) only help the speaker
    // channel — that's the audio we classify and match against.
    const ch = speechChannels.system;
    ch.words = words;
    if (locale) ch.locale = locale;
    const msg: Record<string, unknown> = { action: 'context', words };
    if (locale) msg['locale'] = locale;
    ch.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  });

  // Manual retry for the system-audio channel (banner "重试" after a tap/permission
  // failure) — leaves the mic channel running.
  ipcMain.handle('meeting:retry-system-audio', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? speechChannels.system.win;
    if (!win) return;
    const ch = speechChannels.system;
    ch.shouldRetry = true;
    ch.retryCount = 0;
    spawnSpeechChannel(ch, win);
  });

  // ── CoreML single-mic speaker gate IPC ──
  // Why: lets the renderer enroll the user's own voiceprint and query gate state.
  // Every handler is INERT (reports unavailable / no-ops) when the model file is
  // absent, so today's dual-channel behaviour is never altered by these channels.

  // Why: model presence is the master switch — true only when the .mlmodelc drop-in exists.
  ipcMain.handle('meeting:speaker-model-available', (): boolean => isSpeakerModelAvailable());

  // Why: "has voiceprint" means usable — a persisted voiceprint AND the model present;
  // a voiceprint without the model can never be loaded, so it doesn't count.
  ipcMain.handle('meeting:has-voiceprint', (): boolean => voiceprint !== null && isSpeakerModelAvailable());

  ipcMain.handle('meeting:gate-status', (): { enrolled: boolean; modelAvailable: boolean; gating: GateMode } =>
    gateStatus({ hasVoiceprint: voiceprint !== null, modelAvailable: isSpeakerModelAvailable(), gating }));

  // Why: begin enrollment — ensure the mic channel is spawned WITH the gate (so it can
  // record an embedding), then write enroll-start. Reports model_unavailable when the
  // drop-in is missing so the renderer can disable the flow gracefully.
  ipcMain.handle('meeting:enroll-start', (event, locale: string): { ok: boolean; error?: string } => {
    if (!isSpeakerModelAvailable()) return { ok: false, error: 'model_unavailable' };
    const win = BrowserWindow.fromWebContents(event.sender) ?? speechChannels.mic.win;
    if (!win) return { ok: false, error: 'no_window' };
    const ch = speechChannels.mic;
    ch.locale = locale;
    // (Re)spawn the mic channel gated if it isn't already, so the helper loads the model.
    if (!ch.gate || !ch.proc) {
      ch.gate = true;
      ch.loadVoiceprintOnListening = false;
      ch.shouldRetry = true;
      ch.retryCount = 0;
      spawnSpeechChannel(ch, win);
    }
    ch.proc?.stdin?.write(JSON.stringify({ action: 'enroll-start' }) + '\n');
    return { ok: true };
  });

  // Why: finalize enrollment and RESOLVE with the authoritative result. The helper's
  // 'voiceprint' (success) / 'error':'enroll_failed' stdout event settles the promise
  // (with an 8 s timeout fallback), so the renderer never races a premature status read.
  ipcMain.handle('meeting:enroll-finalize', (): Promise<EnrollResult> => {
    const mic = speechChannels.mic;
    if (!mic.proc) return Promise.resolve({ ok: false, error: 'not_recording' });
    settleEnroll({ ok: false, error: 'superseded' }); // clear any stale pending first
    return new Promise<EnrollResult>((resolve) => {
      const timer = setTimeout(() => settleEnroll({ ok: false, error: 'timeout' }), 8000);
      pendingEnroll = { resolve, timer };
      mic.proc?.stdin?.write(JSON.stringify({ action: 'gate-finalize' }) + '\n');
    });
  });

  // Why: forget the enrolled voiceprint — delete the persisted row, drop the in-memory
  // copy, turn gating off, and push the new status so the renderer reflects it.
  ipcMain.handle('meeting:clear-voiceprint', async (): Promise<void> => {
    voiceprint = null;
    gating = 'off';
    singleMicFallbackArmed = false;
    speechChannels.mic.gate = false;
    speechChannels.mic.loadVoiceprintOnListening = false;
    await deleteVoiceprint().catch(() => { /* best-effort delete; in-memory state already cleared */ });
    pushGateStatusChanged();
  });

  // ── No-match LLM fallback answer (streaming) ──
  // Why: when no card confidently matches (the matching.ts gate returns no-match),
  // stream a short answer grounded in the closest cards so the user isn't left
  // empty-handed. latestAnswerReq cancels a superseded stream: when a newer question
  // arrives, the older loop stops sending (the renderer also drops stale deltas).
  let latestAnswerReq = 0;
  const ANSWER_SYSTEM_PROMPT =
    '你是会议中本人的实时助手。下面给你本人记忆卡片库里最相关的几张卡片,以及对方刚问的问题。\n' +
    '- 只基于这些卡片作答,用第一人称("我/我们"),帮本人开口回答。\n' +
    '- 卡片没覆盖到的事实、数字一律不要编造;没把握就用笼统说法,绝不杜撰具体数字。\n' +
    '- 简洁:2-4 句。问题是中文用中文,英文用英文。\n' +
    '- 只输出回答正文,不要前后缀、不要解释。';

  ipcMain.handle(
    'meeting:answer',
    async (
      event,
      payload: { requestId: number; question: string; cards: Array<{ title: string; summary: string; details: string }> },
    ): Promise<void> => {
      const reqId = payload.requestId;
      latestAnswerReq = reqId;
      const cfg = await getLlmConfig();
      if (!cfg) {
        event.sender.send('meeting:answer-done', { requestId: reqId, ok: false });
        return;
      }
      const ctx = payload.cards.length
        ? payload.cards.map((c, i) => `卡片${i + 1}【${c.title}】${c.summary} ${c.details}`.slice(0, 600)).join('\n')
        : '(无相关卡片)';
      const userMessage = `相关卡片:\n${ctx}\n\n对方的问题:${payload.question}\n\n请基于以上卡片用第一人称简短作答。`;
      try {
        let acc = '';
        for await (const chunk of streamLlm(cfg, ANSWER_SYSTEM_PROMPT, userMessage, 400)) {
          if (reqId !== latestAnswerReq) return; // superseded by a newer question — stop
          acc += chunk;
          event.sender.send('meeting:answer-delta', { requestId: reqId, delta: chunk });
          if (acc.length > 1500) break;
        }
        if (reqId === latestAnswerReq) event.sender.send('meeting:answer-done', { requestId: reqId, ok: true });
      } catch {
        if (reqId === latestAnswerReq) event.sender.send('meeting:answer-done', { requestId: reqId, ok: false });
      }
    },
  );

  // ── Question classification ──
  // Why: transcription captures ALL audio; this step keeps only segments the
  // user must answer and tags them 疑问/命令/追问 (see lib/question-detect).
  // The heuristic classifier resolves the common cases offline (no latency/cost);
  // only genuinely ambiguous segments fall through to the user's BYOK LLM.
  ipcMain.handle(
    'meeting:classify',
    async (_event, text: string): Promise<{ type: QuestionType; text: string } | null> => {
      if (!text) return null;

      // Why: fix mis-heard proper nouns / terms BEFORE detection & matching, so the
      // correction flows through to the question text used as the BM25 query too.
      const q = applyCorrectionRules(text, correctionRules);

      // lastDetectedQuestion gives anaphoric follow-ups ("那这个呢") their referent.
      const local = classifyQuestion(q, { priorQuestion: lastDetectedQuestion ?? undefined });
      if (local) {
        // Cap stored context to 100 chars to prevent runaway growth across rounds.
        lastDetectedQuestion = local.text.slice(0, 100);
        return local;
      }

      // Ambiguous (heuristic found no cue): delegate to the user's BYOK LLM.
      if (q.trim().length < 8) return null;
      const cfg = await getLlmConfig();
      if (!cfg) return null;

      try {
        const systemPrompt = 'You are analyzing a meeting transcription snippet.';
        const userMessage =
          `Text: "${q.slice(0, 300)}"\n\n` +
          'Task: Does this snippet contain a question or directive that you must answer ' +
          '(e.g. "Tell me about X", "How did you Y", "What was Z")?\n' +
          '- If YES: reply with only the core question/request (≤40 words, same language as input).\n' +
          '- If NO (filler, background noise, one-sided statement, etc.): reply with exactly: SKIP';

        // Why: maxTokens=80 + early break at 100 chars cuts result latency versus a
        // full non-streaming call — a ≤40-word classification needs no more.
        let result = '';
        for await (const chunk of streamLlm(cfg, systemPrompt, userMessage, 80)) {
          result += chunk;
          if (result.length >= 100) break;
        }

        const trimmed = result.trim();
        if (!trimmed || trimmed === 'SKIP') return null;
        lastDetectedQuestion = trimmed.slice(0, 100);
        // Type the LLM's extracted question with the same heuristic; default to
        // 'interrogative' (the most common meeting form) when it stays unclear.
        const type = classifyQuestion(trimmed)?.type ?? 'interrogative';
        return { type, text: trimmed };
      } catch {
        return null;
      }
    },
  );
}

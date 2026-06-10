import { useEffect, useRef, useState } from 'react';
import type { Card, OverlayConfig } from '../../env.js';
import SurveyModal from '../../components/survey-modal.js';
import EnrollVoiceprintModal from '../../components/enroll-voiceprint-modal.js';
// Why: retrieval moved to the main process (hybrid FTS5 + vec). Only the ASR-locale
// detector and the contextual-keyword extractor stay renderer-side here.
import { detectAsrLocale, extractContextWords, type ScoredCard } from '../../lib/matching.js';
import { normalizeRole, routeSegment } from '../../lib/turn-routing.js';
import {
  startAnswer, applyAnswerDelta, finishAnswer, IDLE_ANSWER, type AnswerState,
} from '../../lib/answer-stream.js';
import { useToast } from '../../components/ui/toast.js';
import Spinner from '../../components/ui/spinner.js';
import { FOCUS_RING, DISABLED } from '../../lib/ui.js';
import CountUp from '../../components/ui/reactbits/count-up.js';
// 去 emoji 化：用 Phosphor glyph 替换原 emoji / 文本符号图标
import { Microphone, GearSix, Warning, Star, CaretUp, CaretDown } from '@phosphor-icons/react';

interface Props { projectId: string }
// Each detected question keeps its own pre-computed matched cards.
// This lets the user click any past question and instantly see its cards.
type QType = 'interrogative' | 'imperative' | 'follow_up';
// Why: `lowConfidence` distinguishes "had candidates but the top one was too weak
// (suppressed to avoid a misleading match)" from "no candidates at all" — the two
// render different empty-state copy.
interface QuestionEntry { text: string; type: QType; matches: ScoredCard[]; lowConfidence?: boolean; requestId?: number }

// Why: surface the detected type so you see at a glance whether the
// speaker asked a question, gave a directive, or is following up.
const Q_TYPE_BADGE: Record<QType, { label: string; cls: string }> = {
  interrogative: { label: '疑问', cls: 'bg-blue-100 text-blue-700' },
  imperative:    { label: '命令', cls: 'bg-amber-100 text-amber-700' },
  follow_up:     { label: '追问', cls: 'bg-purple-100 text-purple-700' },
};
type Lang = 'zh' | 'en';
type AsrMode = 'swift' | 'web' | null;

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  result_impact: '结果影响', data_metric: '数据指标', difficulty_solution: '难点解法',
  decision_tradeoff: '决策权衡', tech_principle: '技术原理', process_method: '流程方法', domain_fact: '领域知识',
};
const TYPE_COLOR: Record<string, string> = {
  result_impact: 'bg-green-100 text-green-700', data_metric: 'bg-blue-100 text-blue-700',
  difficulty_solution: 'bg-red-100 text-red-700', decision_tradeoff: 'bg-amber-100 text-amber-700',
  tech_principle: 'bg-purple-100 text-purple-700', process_method: 'bg-cyan-100 text-cyan-700',
  domain_fact: 'bg-gray-100 text-gray-600',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function MeetingTab({ projectId }: Props) {
  const { toast } = useToast();
  const [cards, setCards] = useState<Card[]>([]);
  const [companyBrief, setCompanyBrief] = useState<string | null>(null);
  const [showSurvey, setShowSurvey] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);

  const [listening, setListening] = useState(false);
  // Why: 停止监听涉及 IPC + 写素材库文件，期间显示「保存转译中」并禁用清空按钮防重复点击。
  const [saving, setSaving] = useState(false);
  const [finalText, setFinalText] = useState('');

  const [interimStable, setInterimStable] = useState('');
  const [interimFresh, setInterimFresh] = useState('');
  const [freshKey, setFreshKey] = useState(0);

  // Each entry stores the question text + its pre-computed matched cards so
  // the user can click any past question and see its cards instantly.
  const [questionEntries, setQuestionEntries] = useState<QuestionEntry[]>([]);
  const [selectedQIdx, setSelectedQIdx] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [lang, setLang] = useState<Lang>('zh');
  const [error, setError] = useState('');
  // Self (mic) channel: display-only live transcript (never classified).
  const [selfInterim, setSelfInterim] = useState('');
  // System (speaker) audio channel availability + reason, for the degrade banner.
  const [systemAvailable, setSystemAvailable] = useState(true);
  const [systemAudioReason, setSystemAudioReason] = useState<{ denied: boolean; reason: string } | null>(null);
  // CoreML single-mic speaker gate: enrolled voiceprint + active gating state.
  const [gateStatus, setGateStatus] = useState<{ enrolled: boolean; modelAvailable: boolean; gating: 'off' | 'active' }>(
    { enrolled: false, modelAvailable: false, gating: 'off' },
  );
  const [showSettings, setShowSettings] = useState(false);
  // Post-ASR correction rules ("听错 => 正确" per line); persisted on blur.
  const [correctionText, setCorrectionText] = useState('');
  // No-match LLM fallback answer (streamed). answerReqRef monotonically bumps per
  // question so a previous question's late tokens can't bleed into a new answer.
  const [answer, setAnswer] = useState<AnswerState>(IDLE_ANSWER);
  const answerReqRef = useRef(0);
  const [overlayConfig, setOverlayConfigState] = useState<OverlayConfig>({
    screenshotProtected: true,
    overlayWidth: 600,
    overlayHeight: 200,
  });

  const previewTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Why: stale-closure fix — onQuestionNav callback captures this ref, not the state.
  const questionEntriesRef    = useRef<QuestionEntry[]>([]);
  const recognizerRef    = useRef<SpeechRecognition | null>(null);
  const listeningRef     = useRef(false);
  // Why: stale-closure fix — the long-lived onSpeechResult handler reads gating
  // and system availability through refs so it routes segments with live state.
  const gateGatingRef    = useRef<'off' | 'active'>('off');
  const systemAvailableRef = useRef(true);
  const asrModeRef       = useRef<AsrMode>(null);
  const langRef          = useRef<Lang>('zh');
  // Why: the answer-stream fallback (read in an async classify() closure) checks whether
  // the card library is non-empty via a ref to avoid a stale-state capture.
  const hasCardsRef      = useRef(false);
  const transcriptRef    = useRef('');
  const prevInterimRef   = useRef('');
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Swift ASR: interim text is cumulative per 55 s session.
  // committedLenRef tracks what's already been flushed to transcriptRef.
  const currentInterimRef = useRef('');
  const committedLenRef   = useRef(0);
  const silenceTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Why: sessionGenRef guards against silence timers from a just-expired 55s sub-session
  // firing after a new sub-session's "listening" event has reset the refs.
  const sessionGenRef     = useRef(0);
  // Why: the cumulative `final` and the silence timer can both commit the same
  // speaker segment — dedupe identical segments seen within a short window.
  const lastFlushRef      = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  useEffect(() => {
    // Meeting matches against the application's cards UNION the personal corpus.
    window.api.cards.listForMeeting(projectId).then(setCards);
    window.api.projects.get(projectId).then((p) => { if (p) setCompanyBrief(p.companyBrief); });
    window.api.meeting.getOverlayConfig().then(setOverlayConfigState);
    window.api.meeting.getCorrectionRules().then(setCorrectionText);
    // Sync sliders when user drags the overlay resize handle.
    window.api.meeting.onOverlayResized(({ width, height }) => {
      setOverlayConfigState((prev) => ({ ...prev, overlayWidth: width, overlayHeight: height }));
    });
    // Vertical swipe on overlay navigates between detected questions.
    window.api.meeting.onQuestionNav(({ delta }) => {
      const entries = questionEntriesRef.current;
      if (entries.length === 0) return;
      setSelectedQIdx((prev) => {
        const next = Math.max(0, Math.min(entries.length - 1, prev + delta));
        if (next === prev) return prev;
        const entry = entries[next];
        if (entry && listeningRef.current) {
          void window.api.meeting.updateCards(entry.matches.slice(0, 3));
        }
        return next;
      });
    });
    // System-audio (speaker) channel availability → drive the degrade banner.
    window.api.meeting.onSystemAudioStatus((status) => {
      setSystemAvailable(status.available);
      setSystemAudioReason(status.available ? null : { denied: status.denied, reason: status.reason });
    });
    // CoreML speaker-gate status (enrolled / model available / gating) → drives the
    // single-mic fallback indicator + degrade-banner copy. Mirrors the system-audio sub.
    window.api.meeting.getGateStatus().then(setGateStatus);
    window.api.meeting.onGateStatus(setGateStatus);
    return () => {
      void stopListening();
      window.api.meeting.offOverlayResized();
      window.api.meeting.offQuestionNav();
      window.api.meeting.offSystemAudioStatus();
      window.api.meeting.offGateStatus();
    };
  }, [projectId]);

  async function updateOverlayConfig(config: OverlayConfig) {
    setOverlayConfigState(config);
    await window.api.meeting.setOverlayConfig(config);
  }

  function handleSizeChange(field: 'overlayWidth' | 'overlayHeight', value: number) {
    const newConfig = { ...overlayConfig, [field]: value };
    setOverlayConfigState(newConfig);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      void window.api.meeting.setOverlayConfig(newConfig);
      void window.api.meeting.reshowFloat();
    }, 30);
  }

  // ESC closes the float window while a meeting is active (main window focus path)
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void window.api.meeting.closeFloat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);

  useEffect(() => {
    langRef.current = lang;
    if (recognizerRef.current) recognizerRef.current.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
  }, [lang]);
  useEffect(() => { hasCardsRef.current = cards.length > 0; }, [cards]);
  useEffect(() => { questionEntriesRef.current = questionEntries; }, [questionEntries]);
  useEffect(() => { gateGatingRef.current = gateStatus.gating; }, [gateStatus.gating]);
  useEffect(() => { systemAvailableRef.current = systemAvailable; }, [systemAvailable]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [finalText, interimFresh]);

  // No-match fallback answer stream: accumulate deltas (the reducer drops any whose
  // requestId is stale, so a superseded question's tokens never bleed in).
  useEffect(() => {
    window.api.meeting.onAnswerDelta((d) => setAnswer((s) => applyAnswerDelta(s, d)));
    window.api.meeting.onAnswerDone((d) => setAnswer((s) => finishAnswer(s, d)));
    return () => {
      window.api.meeting.offAnswerDelta();
      window.api.meeting.offAnswerDone();
    };
  }, []);

  // ── Core helpers ──

  // Flush a completed speech segment: add to transcript, classify, compute
  // matches immediately, and push a QuestionEntry so cards are available at once.
  function flushSegment(text: string) {
    if (!text.trim()) return;
    // Dedupe: skip a segment identical to the last one flushed within 4s (the
    // cumulative `final` + the silence timer otherwise commit the same sentence twice).
    const now = Date.now();
    if (text === lastFlushRef.current.text && now - lastFlushRef.current.at < 4000) return;
    lastFlushRef.current = { text, at: now };
    transcriptRef.current += text;
    setFinalText(transcriptRef.current);

    void window.api.meeting.classify(text).then(async (result) => {
      if (!result) return;
      const question = result.text;
      // Why: search on the classified question (not the raw transcript tail) — the tail
      // includes your own answers + filler, which pulls matches off-topic.
      // Hybrid retrieval (semantic + lexical, RRF-fused, gated) runs in the main process.
      // `closest` is the top-k cards in RRF rank order, returned EVEN when low-confidence
      // so a fallback answer can ground on them; lowConfidence = the gate judged the top
      // card too weak to trust as a shown match.
      const search = await window.api.retrieval.meetingSearch(projectId, question);
      // Coerce plain cards → ScoredCard[]; the synthetic descending score just preserves
      // the engine's rank order for any downstream score-based use.
      const closest: ScoredCard[] = search.cards.map((c, i) => ({ ...c, score: search.cards.length - i }));
      const confident = !search.lowConfidence && closest.length > 0;
      const matches = confident ? closest : [];
      const lowConfidence = search.lowConfidence && closest.length > 0;

      // Why: bump the answer requestId for EVERY question so any in-flight fallback
      // stream from a prior question is invalidated (its late deltas get dropped).
      answerReqRef.current += 1;
      const requestId = answerReqRef.current;
      const entry: QuestionEntry = { text: question, type: result.type, matches, lowConfidence, requestId };

      // No confident card → ask the BYOK LLM for a short answer grounded in the
      // closest cards (even if below the confidence bar). Skip if the card library is
      // empty (nothing to ground on).
      if (!confident && hasCardsRef.current) {
        setAnswer(startAnswer(requestId));
        const ctxCards = closest.slice(0, 3).map((c) => ({ title: c.title, summary: c.summary, details: c.details }));
        void window.api.meeting.answer({ requestId, question, cards: ctxCards });
      } else {
        setAnswer(IDLE_ANSWER); // confident match (or no library) → no fallback shown
      }

      // Prepend newest question; auto-select it so cards update immediately.
      setQuestionEntries((prev) => [entry, ...prev]);
      setSelectedQIdx(0);

      // Update float window with the new question's cards right now. On a no-match
      // we push [] so the float never shows a card we don't trust.
      if (listeningRef.current) {
        void window.api.meeting.updateCards(matches.slice(0, 3));
        if (asrModeRef.current === 'swift') {
          const locale = detectAsrLocale(transcriptRef.current.slice(-500));
          void window.api.meeting.speechContext(extractContextWords(matches), locale);
        }
      }
    });
  }

  // User clicked a past question → switch displayed cards + update float window.
  function selectQuestion(idx: number) {
    setSelectedQIdx(idx);
    setExpandedId(null);
    const entry = questionEntries[idx];
    if (!entry) return;
    if (listeningRef.current) {
      void window.api.meeting.updateCards(entry.matches.slice(0, 3));
      if (asrModeRef.current === 'swift') {
        const locale = detectAsrLocale(transcriptRef.current.slice(-500));
        void window.api.meeting.speechContext(extractContextWords(entry.matches), locale);
      }
    }
  }

  // Commit pending silent segment immediately (called on stop).
  function drainSilenceTimer() {
    if (!silenceTimerRef.current) return;
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    const segment = currentInterimRef.current.slice(committedLenRef.current);
    committedLenRef.current = currentInterimRef.current.length;
    prevInterimRef.current = '';
    setInterimStable('');
    setInterimFresh('');
    if (segment.trim()) flushSegment(segment);
  }

  // Commit the speaker's pending interim segment now. Triggered by the 1500ms
  // silence timer AND, more responsively, the moment you start speaking
  // (turn boundary) — so a question is classified/matched without the blind wait.
  function commitSpeakerTurn() {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    const segment = currentInterimRef.current.slice(committedLenRef.current);
    if (!segment.trim()) return;
    committedLenRef.current = currentInterimRef.current.length;
    prevInterimRef.current = '';
    setInterimStable('');
    setInterimFresh('');
    flushSegment(segment);
  }

  // Update interim display; in Swift mode schedule silence-based segmentation.
  function updateInterim(newText: string) {
    currentInterimRef.current = newText;

    // Swift: display only the uncommitted tail (committed part is already in finalText).
    const displayText = asrModeRef.current === 'swift'
      ? newText.slice(committedLenRef.current)
      : newText;

    const prev = prevInterimRef.current;
    prevInterimRef.current = displayText;

    if (!displayText) {
      setInterimStable('');
      setInterimFresh('');
    } else if (displayText.startsWith(prev)) {
      setInterimStable(prev);
      setInterimFresh(displayText.slice(prev.length));
      setFreshKey((k) => k + 1);
    } else {
      setInterimStable('');
      setInterimFresh(displayText);
      setFreshKey((k) => k + 1);
    }

    if (asrModeRef.current === 'swift') {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (newText) {
        const gen = sessionGenRef.current; // capture so timer can reject stale sub-sessions
        silenceTimerRef.current = setTimeout(() => {
          if (sessionGenRef.current !== gen) return; // new sub-session started, discard
          commitSpeakerTurn();
        }, 1500);
      }
    }
  }

  // ── ASR: Swift SFSpeechRecognizer ──

  async function startSwift(locale: string) {
    asrModeRef.current = 'swift';
    listeningRef.current = true;

    window.api.meeting.onSpeechResult((msg) => {
      const role = normalizeRole(msg.role);
      // Why: route every segment through the shared policy. With gating active the
      // CoreML gate can label a mic segment role:'speaker' → 'classify'; without
      // it, mic audio (self) stays 'display-only'. The speaker system-tap
      // channel always routes 'classify' while systemAvailable.
      const action = routeSegment(role, { systemAvailable: systemAvailableRef.current, gating: gateGatingRef.current });

      // DISPLAY-ONLY: your own speech (and mic-channel control events) — never
      // classified or matched, so your own voice can't trigger a card.
      if (action === 'display-only') {
        // NOTE: self-triggered turn-taking (commit the speaker turn when you
        // start speaking) is only safe with channel isolation (headphones).
        // Without headphones the mic re-captures the speaker output as an "echo" in this
        // channel, which would prematurely fragment the speaker's question — so it's
        // intentionally not wired here. Proper turn detection belongs in Swift VAD /
        // pause-gating (TODO).
        if (msg.type === 'interim' || msg.type === 'final') setSelfInterim(msg.text ?? '');
        else if (msg.type === 'listening') setSelfInterim('');
        else if (msg.type === 'error') {
          const t = msg.text ?? '';
          if (t === 'microphone_denied' || t === 'speech_denied') {
            // Why: 补充可操作的逐步路径，用户照做即可恢复，而非模糊的「请在系统偏好设置中允许」。
            setError('麦克风或语音识别权限被拒绝。\n开启步骤：系统设置 › 隐私与安全性 › 麦克风 › 允许 QA Matching，然后重启应用。');
            listeningRef.current = false;
            setListening(false);
          }
        }
        return;
      }

      // CLASSIFY: the speaker's audio (system tap, or gated mic) drives the
      // classify + match pipeline.
      if (msg.type === 'listening') {
        setSystemAvailable(true); // speaker audio flowing ⇒ system tap is up
        setSystemAudioReason(null);
        // Why: flush uncommitted tail before wiping refs so words at the 55-s
        // sub-session boundary are not silently dropped.
        // Guard: skip on the very first 'listening' event (gen=0) — nothing to flush.
        if (sessionGenRef.current > 0) {
          if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
          const tail = currentInterimRef.current.slice(committedLenRef.current).trim();
          if (tail) flushSegment(tail);
          setInterimStable('');
          setInterimFresh('');
        }
        sessionGenRef.current++;
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        committedLenRef.current = 0;
        currentInterimRef.current = '';
        prevInterimRef.current = '';
        setListening(true);
      } else if (msg.type === 'interim') {
        updateInterim(msg.text ?? '');
      } else if (msg.type === 'final') {
        // Swift's final is cumulative — only flush the uncommitted tail.
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        const segment = (msg.text ?? '').slice(committedLenRef.current);
        committedLenRef.current = 0;
        prevInterimRef.current = '';
        setInterimStable('');
        setInterimFresh('');
        if (segment.trim()) flushSegment(segment);
      } else if (msg.type === 'endpoint') {
        // VAD detected end-of-speech on the speaker channel → commit the
        // pending question now (lower latency than the 1500ms silence timer,
        // which stays as a fallback if VAD misses).
        commitSpeakerTurn();
      }
      // Speaker-channel 'error' surfaces via the system-audio-status banner
      // (sent from main); no per-segment handling needed here.
    });

    await window.api.meeting.speechStart(locale, []);
    await window.api.meeting.openFloat();
    if (companyBrief) void window.api.meeting.updateCompanyBrief(companyBrief);
  }

  // ── ASR: Web Speech API (fallback) ──

  async function startWebSpeech(locale: string) {
    asrModeRef.current = 'web';
    type Ctor = new () => SpeechRecognition;
    const w = window as Window & { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
    const Recognizer = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Recognizer) {
      setError('当前 Electron 版本不支持语音识别，请更新应用');
      asrModeRef.current = null;
      return;
    }

    const recognition = new Recognizer();
    recognition.continuous     = true;
    recognition.interimResults = true;
    recognition.lang           = locale;
    recognizerRef.current      = recognition;
    listeningRef.current       = true;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) {
          flushSegment(result[0]!.transcript);
        } else {
          interim += result[0]!.transcript;
        }
      }
      updateInterim(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return;
      if (event.error === 'network') {
        setError('语音识别需要网络连接，请检查网络设置');
        listeningRef.current = false;
        setListening(false);
      } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Why: 补充可操作的逐步路径，用户照做即可恢复授权。
        setError('麦克风权限被拒绝。\n开启步骤：系统设置 › 隐私与安全性 › 麦克风 › 允许 QA Matching，然后重启应用。');
        listeningRef.current = false;
        setListening(false);
      } else {
        setError(`语音识别错误: ${event.error}`);
      }
    };

    recognition.onend = () => {
      updateInterim('');
      if (listeningRef.current) {
        try { recognition.start(); } catch { /* already starting */ }
      }
    };

    recognition.start();
    setListening(true);
    await window.api.meeting.openFloat();
    if (companyBrief) void window.api.meeting.updateCompanyBrief(companyBrief);
  }

  // ── Recording controls ──

  async function startListening() {
    // Re-entry guard: in single-mic gated mode the `listening` STATE may not flip
    // (speaker-role events drive it), so a second click must not stack a second
    // onSpeechResult listener and double-process every segment.
    if (listeningRef.current) return;
    setError('');
    const locale = langRef.current === 'zh' ? 'zh-CN' : 'en-US';
    const swiftOk = await window.api.meeting.speechAvailable();
    if (swiftOk) {
      await startSwift(locale);
    } else {
      await startWebSpeech(locale);
    }
  }

  async function stopListening() {
    listeningRef.current = false;
    drainSilenceTimer();
    // Why: 停止全程置 saving，UI 显示「保存转译中…」并禁用清空，避免 IPC/写文件期间重复操作。
    setSaving(true);
    try {
      if (asrModeRef.current === 'swift') {
        window.api.meeting.offSpeechResult();
        await window.api.meeting.speechStop();
        setListening(false);
      } else {
        recognizerRef.current?.stop();
        recognizerRef.current = null;
        setListening(false);
      }

      asrModeRef.current = null;
      prevInterimRef.current = '';
      setInterimStable('');
      setInterimFresh('');
      await window.api.meeting.closeFloat();
      await saveSession();
    } finally {
      setSaving(false);
    }
  }

  async function saveSession() {
    const text = transcriptRef.current.trim();
    if (text.length < 50) return;
    const ts = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // Why: 保存成功/失败给一次 toast，让用户确认转译记录已落库（之前静默无反馈）。
    try {
      await window.api.materials.addText(projectId, `【会议记录 · ${ts}】\n\n${text}`);
      toast('转译记录已保存到素材库', { variant: 'success' });
    }
    catch { toast('转译记录保存失败', { variant: 'error' }); }
    // Prompt for post-meeting survey after session is saved.
    setShowSurvey(true);
  }

  function clearTranscript() {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    transcriptRef.current = '';
    currentInterimRef.current = '';
    committedLenRef.current = 0;
    prevInterimRef.current = '';
    setFinalText('');
    setInterimStable('');
    setInterimFresh('');
    setQuestionEntries([]);
    setSelectedQIdx(0);
    setExpandedId(null);
    // Invalidate any in-flight fallback answer so its late deltas are dropped.
    answerReqRef.current += 1;
    setAnswer(IDLE_ANSWER);
    void window.api.meeting.updateCards([]);
  }

  // ── Render: main meeting UI ──

  const hasCards = cards.length > 0;
  const interimText = interimStable + interimFresh;
  const selectedEntry = questionEntries[selectedQIdx];
  const displayedMatches = selectedEntry?.matches ?? [];

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={listening ? stopListening : startListening}
          disabled={!hasCards || saving}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all ${FOCUS_RING} ${DISABLED} ${
            listening
              ? 'bg-red-500 text-white hover:bg-red-600'
              : 'bg-gray-900 text-white hover:bg-gray-700'
          }`}
        >
          {/* Why: 保存阶段按钮显示 Spinner + 文案，明确告知转译正在写入素材库。 */}
          {saving
            ? <><Spinner className="w-4 h-4" />保存转译中…</>
            : <><Microphone size={16} weight="regular" className={listening ? 'animate-pulse' : ''} />{listening ? '停止会议' : '开始会议'}</>}
        </button>

        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(['zh', 'en'] as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)}
              className={`px-3 py-1.5 transition-colors ${FOCUS_RING} ${lang === l ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              {l === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>

        {/* Why: 用带底色 badge 替代裸绿点，监听态更醒目；并区分「等待发言」与「正在录音」。 */}
        {listening && !saving && (
          <span className="flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            {interimText || selfInterim ? '正在监听·录音中…' : '正在监听…'}
          </span>
        )}

        {finalText && !listening && (
          <button
            onClick={clearTranscript}
            disabled={saving}
            className={`text-xs text-gray-400 hover:text-gray-600 ${FOCUS_RING} ${DISABLED}`}
          >
            清空记录
          </button>
        )}

        {/* Gate active indicator — single-mic voiceprint mode is classifying. */}
        {gateStatus.gating === 'active' && (
          <span className="flex items-center gap-1.5 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700" title="系统音频不可用，已启用单麦声纹门控，仅识别对方语音">
            <Microphone size={12} weight="fill" />单麦声纹模式
          </span>
        )}

        {/* Why: 入口录入与对方无关的「本人声纹」，供系统音频不可用时的单麦门控使用。 */}
        <button
          onClick={() => setShowEnroll(true)}
          disabled={listening}
          aria-label="录入声纹"
          className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors ${FOCUS_RING} ${DISABLED} ${gateStatus.enrolled ? 'text-indigo-600 hover:text-indigo-800' : 'text-gray-400 hover:text-gray-600'}`}
          title={gateStatus.enrolled ? '已录入声纹，点击可重新录入' : '录入声纹以启用单麦模式'}
        >
          <Microphone size={14} weight="regular" />{gateStatus.enrolled ? '声纹已录入' : '录入声纹'}
        </button>

        <button
          onClick={() => setShowSettings((v) => !v)}
          aria-label="浮层设置"
          className={`inline-flex items-center justify-center text-sm px-2 py-1 rounded transition-colors ${FOCUS_RING} ${showSettings ? 'bg-gray-100 text-gray-700' : 'text-gray-300 hover:text-gray-600'}`}
          title="浮层设置"
        >{/* 去 emoji：⚙ -> GearSix */}<GearSix size={18} weight="regular" /></button>

        {!hasCards && (
          <span className="text-xs text-amber-600">请先在「素材」Tab 提取卡片</span>
        )}
      </div>

      {/* Overlay settings panel */}
      {showSettings && (
        <div className="flex gap-8 items-start bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">

          {/* Screenshot protection toggle */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-gray-700">截图保护</span>
            <button
              onClick={() => void updateOverlayConfig({ ...overlayConfig, screenshotProtected: !overlayConfig.screenshotProtected })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${overlayConfig.screenshotProtected ? 'bg-gray-800' : 'bg-gray-300'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${overlayConfig.screenshotProtected ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-[10px] text-gray-400 leading-tight">
              {overlayConfig.screenshotProtected ? '浮层不出现在截图中' : '浮层出现在截图中'}
            </span>
          </div>

          {/* Size sliders */}
          <div className="flex flex-col gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium text-gray-700">浮层大小</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-4 shrink-0">宽</span>
              <input
                type="range" min={50} max={800} step={10}
                value={overlayConfig.overlayWidth}
                onChange={(e) => handleSizeChange('overlayWidth', Number(e.target.value))}
                className="flex-1 accent-gray-700 cursor-pointer h-1"
              />
              <span className="text-[10px] text-gray-400 w-7 text-right tabular-nums shrink-0">
                {overlayConfig.overlayWidth}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-4 shrink-0">高</span>
              <input
                type="range" min={20} max={380} step={10}
                value={overlayConfig.overlayHeight}
                onChange={(e) => handleSizeChange('overlayHeight', Number(e.target.value))}
                className="flex-1 accent-gray-700 cursor-pointer h-1"
              />
              <span className="text-[10px] text-gray-400 w-7 text-right tabular-nums shrink-0">
                {overlayConfig.overlayHeight}
              </span>
            </div>
            <span className="text-[10px] text-gray-400">拖动时浮层实时预览</span>
          </div>

          {/* Post-ASR correction dictionary — fixes mis-heard terms before matching */}
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <span className="text-xs font-medium text-gray-700">纠错词典</span>
            <textarea
              value={correctionText}
              onChange={(e) => setCorrectionText(e.target.value)}
              onBlur={() => void window.api.meeting.setCorrectionRules(correctionText)}
              spellCheck={false}
              rows={3}
              placeholder={'每行一条「听错 => 正确」，例如：\njizzle => Drizzle\ncube net => Kubernetes'}
              className={`w-full resize-y rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-mono leading-relaxed text-gray-700 placeholder:text-gray-300 ${FOCUS_RING}`}
            />
            <span className="text-[10px] text-gray-400 leading-tight">
              ASR 听错的专有名词在匹配前自动纠正；支持单个 {'{num}'} 数字通配符。失焦保存。
            </span>
          </div>

        </div>
      )}

      {/* Why: 错误容器加 role=alert/aria-live=polite，屏幕阅读器能即时朗读错误。 */}
      {error && (
        <p role="alert" aria-live="polite" className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg whitespace-pre-line leading-relaxed">
          {error}
        </p>
      )}

      {/* Degrade banner: system-audio (speaker) channel unavailable.
          - If a voiceprint is enrolled, we DO fall back to single-mic classification
            via the CoreML speaker gate, and surface an info line (no retry needed).
          - Otherwise we do NOT silently single-mic — you are told explicitly
            with a retry, plus a hint to enroll a voiceprint to enable single-mic mode. */}
      {!systemAvailable && gateStatus.enrolled && (
        <div className="flex items-center gap-2 text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-2 rounded-lg">
          <Microphone size={16} weight="fill" className="shrink-0" />
          <span className="flex-1">已启用单麦声纹模式（仅识别对方语音）。系统音频不可用时，由本地声纹门控区分发言人。</span>
          <button
            onClick={() => { void window.api.meeting.retrySystemAudio(); }}
            className="shrink-0 px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700"
          >
            重试系统音频
          </button>
        </div>
      )}
      {!systemAvailable && !gateStatus.enrolled && (
        <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          {/* 去 emoji：⚠️ -> Warning(fill) */}
          <Warning size={16} weight="fill" className="shrink-0" />
          <span className="flex-1">
            {systemAudioReason?.denied
              ? '系统音频录制权限被拒绝，无法采集对方声道。请在「系统设置 › 隐私与安全性 › 音频录制」中允许 QA Matching 后重试。'
              : `系统音频采集失败（${systemAudioReason?.reason ?? '未知'}），对方声道暂不可用；本人声道仍在工作。`}
          </span>
          {/* Why: 提供升级路径——录入声纹后系统音频不可用时可自动启用单麦门控。 */}
          <button
            onClick={() => setShowEnroll(true)}
            className="shrink-0 px-2.5 py-1 rounded-md border border-amber-400 text-amber-700 text-xs hover:bg-amber-100"
          >
            录入声纹以启用单麦模式
          </button>
          <button
            onClick={() => { void window.api.meeting.retrySystemAudio(); }}
            className="shrink-0 px-2.5 py-1 rounded-md bg-amber-600 text-white text-xs hover:bg-amber-700"
          >
            重试
          </button>
        </div>
      )}

      {/* Why: flex-1 + min-h-0 让三栏网格填满本区剩余高度(替代过去写死的 460px)，
          grid-rows-1 约束每栏高度，使每栏内部 flex-1/overflow-y-auto 滚动生效。 */}
      <div className="grid grid-cols-[1fr_1fr_1.4fr] grid-rows-1 gap-3 flex-1 min-h-0">

        {/* ── Col 1: Transcript ── */}
        <div className="flex flex-col border border-gray-100 rounded-2xl overflow-hidden bg-white">
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border-b border-gray-100 shrink-0">
            <span className="text-xs font-medium text-gray-600">实时转译 · 对方</span>
            {finalText && <span className="ml-auto text-xs text-gray-400">{finalText.length} 字</span>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 text-sm leading-relaxed text-gray-800">
            {/* Why: 空态上移更贴近内容区顶部；加淡色「准备就绪」让用户确认卡片已加载、可开始。 */}
            {!finalText && !interimText && !listening && (
              <div className="text-center mt-4 leading-relaxed">
                {/* 去 emoji：🎙 -> Microphone，容器 inline-flex 居中对齐 */}
                <p className="inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-gray-400"><Microphone size={14} weight="regular" />准备就绪</p>
                <p className="text-gray-300 text-xs mt-1.5">
                  点击「开始会议」后<br />所有语音内容会显示在这里
                </p>
              </div>
            )}
            <span>{finalText}</span>
            {interimText && (
              <span className="text-gray-400">
                <span>{interimStable}</span>
                {interimFresh && (
                  <span key={freshKey} style={{ animation: 'fadeSlideIn 0.15s ease-out' }}>
                    {interimFresh}
                  </span>
                )}
              </span>
            )}
            {listening && !interimText && (
              <span className="inline-block w-1 h-3.5 bg-gray-300 ml-0.5 animate-pulse rounded-sm" />
            )}
            {/* Candidate (mic) channel — display only, never matched. */}
            {selfInterim && (
              <div className="mt-3 pt-3 border-t border-dashed border-gray-100 text-gray-400">
                <span className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 align-middle text-[10px] text-gray-500">你</span>
                {selfInterim}
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* ── Col 2: Detected questions (clickable) ── */}
        <div className="flex flex-col border border-gray-100 rounded-2xl overflow-hidden bg-white">
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border-b border-gray-100 shrink-0">
            <span className="text-xs font-medium text-gray-600">检测到的问题</span>
            {questionEntries.length > 0 && (
              <span className="ml-auto text-xs text-gray-400">{questionEntries.length} 条</span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
            {questionEntries.length === 0 && (
              <p className="text-gray-300 text-center mt-12 text-xs leading-relaxed">
                对方的提问<br />会自动出现在这里
              </p>
            )}
            {questionEntries.map((entry, i) => (
              <button
                key={i}
                onClick={() => selectQuestion(i)}
                aria-pressed={i === selectedQIdx}
                /* Why: 选中态统一为 border+背景色系（去掉 ring），与卡片展开态视觉语言一致。 */
                className={`w-full text-left px-3 py-2.5 rounded-xl border text-xs leading-snug transition-colors ${FOCUS_RING} ${
                  i === selectedQIdx
                    ? 'bg-blue-50 border-blue-300 text-blue-900'
                    : 'bg-gray-50 border-gray-100 text-gray-500 hover:bg-gray-100 hover:border-gray-200'
                }`}
              >
                <span
                  className={`mr-1.5 inline-block rounded px-1.5 py-0.5 align-middle text-[10px] font-medium ${Q_TYPE_BADGE[entry.type].cls}`}
                >
                  {Q_TYPE_BADGE[entry.type].label}
                </span>
                {entry.text}
              </button>
            ))}
          </div>
        </div>

        {/* ── Col 3: Matched cards for selected question ── */}
        <div className="flex flex-col border border-gray-100 rounded-2xl overflow-hidden bg-white">
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border-b border-gray-100 shrink-0">
            <span className="text-xs font-medium text-gray-600">
              匹配卡片
            </span>
            {/* CountUp: 命中数滚动, 开会时一眼可扫到相关卡片增减。 */}
            {displayedMatches.length > 0 && (
              <span className="ml-auto text-xs text-gray-400">命中 <CountUp to={displayedMatches.length} duration={0.5} /> 张</span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
            {displayedMatches.length === 0 && (
              selectedEntry && selectedEntry.requestId === answer.requestId && answer.status !== 'idle' ? (
                /* No confident card → show the streamed LLM fallback answer. */
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                  <p className="text-[10px] font-medium text-amber-700 mb-1.5">
                    未找到把握匹配 · AI 实时生成（非你的项目卡片，仅供提示）
                  </p>
                  {answer.status === 'error' ? (
                    <p className="text-xs text-gray-400">AI 兜底不可用（请检查 LLM 配置）</p>
                  ) : (
                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                      {answer.text}
                      {answer.status === 'streaming' && <span className="ml-0.5 animate-pulse text-amber-500">▍</span>}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-gray-300 text-center mt-12 text-xs leading-relaxed">
                  {questionEntries.length === 0
                    ? '检测到问题后\n相关卡片会出现在这里'
                    : selectedEntry?.lowConfidence
                      ? '未找到把握匹配\n（已隐藏低置信结果）'
                      : '未找到匹配卡片'}
                </p>
              )
            )}
            {displayedMatches.map((card) => {
              const expanded = expandedId === card.id;
              return (
              /* Why: 展开态用 border+背景蓝色系强调，与问题列表选中态保持统一的视觉语言。 */
              <div key={card.id} className={`rounded-xl border overflow-hidden transition-colors ${expanded ? 'bg-blue-50 border-blue-300' : 'bg-gray-50 border-gray-100'}`}>
                <button
                  className={`w-full text-left px-3 py-2.5 ${FOCUS_RING}`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : card.id)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TYPE_COLOR[card.type] ?? 'bg-gray-100 text-gray-600'}`}>
                      {TYPE_LABEL[card.type] ?? card.type}
                    </span>
                    {/* 去 emoji：★ -> Star(fill) 保留琥珀色 */}
                    {card.isImportant && <Star size={12} weight="fill" className="text-amber-400" />}
                    {/* 去 emoji：▲/▼ 展开指示 -> CaretUp/CaretDown */}
                    <span className="ml-auto text-gray-400 inline-flex items-center">{expanded ? <CaretUp size={10} weight="regular" /> : <CaretDown size={10} weight="regular" />}</span>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 leading-snug">{card.title}</p>
                  <p className="text-xs text-gray-500 leading-relaxed mt-0.5 line-clamp-1">{card.summary}</p>
                </button>
                {expanded && (
                  <div className="px-3 pb-3 border-t border-blue-200 pt-2">
                    <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">{card.details}</p>
                    {Array.isArray(card.tags) && card.tags.length > 0 && (
                      <p className="text-[10px] text-gray-400 mt-2">{(card.tags as string[]).join(' · ')}</p>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-300 text-center">
        {/* 去多余中点：同行原有 2 个「·」，第二个改为中文冒号「：」 */}
        系统 ASR · {lang === 'zh' ? '中文' : 'English'}：停止后转译记录自动保存到素材库
      </p>

      {showSurvey && (
        <SurveyModal projectId={projectId} onClose={() => setShowSurvey(false)} />
      )}

      {showEnroll && (
        <EnrollVoiceprintModal
          locale={lang === 'zh' ? 'zh-CN' : 'en-US'}
          onClose={() => setShowEnroll(false)}
          onEnrolled={() => { void window.api.meeting.getGateStatus().then(setGateStatus); }}
        />
      )}
    </div>
  );
}

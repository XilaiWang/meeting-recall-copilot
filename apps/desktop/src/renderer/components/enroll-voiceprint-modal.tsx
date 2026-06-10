import { useEffect, useRef, useState } from 'react';
import { Microphone, Warning, SealCheck } from '@phosphor-icons/react';
import { useToast } from './ui/toast.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';

interface Props {
  // Locale of the active meeting language, forwarded to enroll-start so the
  // mic channel spawns the recognizer in the matching language.
  locale: string;
  onClose: () => void;
  // Fired when the gate reports the voiceprint is enrolled, so the parent can
  // refresh its gateStatus and reflect single-mic mode in the degrade banner.
  onEnrolled: () => void;
}

type Phase = 'idle' | 'unavailable' | 'recording' | 'finalizing' | 'done';

// A short sentence for the user to read aloud while we capture their voiceprint.
const ENROLL_PROMPT = '请用平时说话的语气，朗读下面这句话：「我准备好开始这场会议了，希望今天沟通顺利。」';

// Why: drives CoreML voiceprint enrollment — start the gated mic channel, show
// live capture seconds, then finalize to persist the voiceprint. Every step
// no-ops gracefully (phase 'unavailable') when the model file is absent.
export default function EnrollVoiceprintModal({ locale, onClose, onEnrolled }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const { toast } = useToast();
  // Why: avoid double-firing onEnrolled / closing when both onGateStatus and the
  // finalize round-trip report enrollment within the same tick.
  const closedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Live capture progress from the helper (string seconds → number in main).
    // NOTE: we intentionally do NOT subscribe to onGateStatus here — its preload
    // off-helper does removeAllListeners on a channel the parent tab also uses, so a
    // modal subscription's cleanup would wipe the tab's listener. Completion is driven
    // by the authoritative enrollFinalize() result instead.
    window.api.meeting.onEnrollProgress((p) => { setSeconds(p.seconds); });

    void (async () => {
      const res = await window.api.meeting.enrollStart(locale);
      if (cancelled) return;
      if (!res.ok) {
        setPhase('unavailable');
        return;
      }
      setPhase('recording');
    })();

    return () => {
      cancelled = true;
      window.api.meeting.offEnrollProgress();
    };
  }, [locale]);

  async function handleFinalize() {
    setPhase('finalizing');
    try {
      // enrollFinalize resolves only after the helper emits the voiceprint (ok) or
      // fails — so this result is authoritative, no status-read race.
      const res = await window.api.meeting.enrollFinalize();
      if (res.ok) {
        if (!closedRef.current) { closedRef.current = true; setPhase('done'); }
      } else {
        const message = res.error === 'enroll_failed'
          ? '声纹采集时长不足，请再朗读一遍后重试'
          : '声纹录入失败，请重试';
        toast(message, { variant: 'error' });
        setPhase('recording');
      }
    } catch {
      toast('声纹录入失败，请重试', { variant: 'error' });
      setPhase('recording');
    }
  }

  function handleDone() {
    onEnrolled();
    onClose();
  }

  if (phase === 'unavailable') {
    return (
      <Shell>
        <Warning size={48} className="text-amber-500" weight="fill" />
        <h2 className="text-lg font-semibold text-gray-900">声纹模型暂不可用</h2>
        <p className="text-sm text-gray-500 text-center leading-relaxed">
          单麦声纹门控需要本地的 CoreML 说话人模型，当前版本尚未内置。
          请等待包含模型文件的更新后再录入；现有双声道会议功能不受影响。
        </p>
        <button
          onClick={onClose}
          className={`mt-2 px-6 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
        >
          知道了
        </button>
      </Shell>
    );
  }

  if (phase === 'done') {
    return (
      <Shell>
        <SealCheck size={48} className="text-green-600" weight="regular" />
        <h2 className="text-lg font-semibold text-gray-900">声纹录入完成</h2>
        <p className="text-sm text-gray-500 text-center leading-relaxed">
          当系统音频不可用时，将自动启用单麦声纹模式，仅识别对方的语音。
        </p>
        <button
          onClick={handleDone}
          className={`mt-2 px-6 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
        >
          完成
        </button>
      </Shell>
    );
  }

  const starting = phase === 'idle';
  const finalizing = phase === 'finalizing';

  return (
    <Shell>
      <Microphone size={40} weight="regular" className={`text-gray-700 ${phase === 'recording' ? 'animate-pulse' : ''}`} />
      <h2 className="text-lg font-semibold text-gray-900">录入声纹</h2>
      <p className="text-sm text-gray-600 text-center leading-relaxed">{ENROLL_PROMPT}</p>

      <div className="flex items-center gap-2 text-sm text-gray-500">
        {starting ? (
          <span>正在准备麦克风…</span>
        ) : (
          <>
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span>已采集 <span className="tabular-nums font-medium text-gray-700">{seconds.toFixed(1)}</span> 秒</span>
          </>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center">建议至少朗读 3 秒以上，让声纹更稳定。</p>

      <div className="flex gap-2 justify-center pt-1">
        <button
          onClick={onClose}
          className={`px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors ${FOCUS_RING} rounded-lg`}
        >
          取消
        </button>
        <button
          onClick={() => { void handleFinalize(); }}
          disabled={starting || finalizing}
          className={`px-5 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}
        >
          {finalizing ? '处理中…' : '完成录入'}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8 flex flex-col items-center gap-4">
        {children}
      </div>
    </div>
  );
}

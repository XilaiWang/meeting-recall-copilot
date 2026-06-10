// SpeechHelper — native macOS speech recognition helper for QA Matching.
// Spawned as a child process by the Electron main process.
// Protocol: newline-delimited JSON on stdin/stdout.
//
// stdin  commands: {"action":"start","locale":"zh-CN","contextWords":["词1"]}
//                  {"action":"stop"}
//                  {"action":"context","words":["词1","词2"]}
//                  {"action":"enroll-start"}                 // single-mic gate: enroll
//                  {"action":"gate-finalize"}                // build + emit voiceprint
//                  {"action":"load-voiceprint","data":"<b64>"} // restore voiceprint
// stdout events:   {"type":"ready"}
//                  {"type":"listening"}
//                  {"type":"interim","text":"..."}
//                  {"type":"final","text":"...","role":"self|speaker"}
//                  {"type":"endpoint"}
//                  {"type":"enroll-progress","seconds":"1.5"}
//                  {"type":"voiceprint","data":"<b64>","dim":"192"}
//                  {"type":"error","text":"reason"}
// argv: --source mic|system   --gate   --model <path-to.mlmodelc>   --dump-fbank
//
// Why SFSpeechRecognizer instead of Web Speech API:
//   1. contextualStrings — prime ASR with card keywords → better technical term accuracy
//   2. Graceful 55 s boundary handoff — endAudio() + wait for isFinal before restarting,
//      so no audio is dropped at the session boundary
//   3. Purely on-device for supported locales (zh-CN uses on-device model on macOS 14+)

import Foundation
import Speech
import AVFoundation

// ── Stdout helpers ────────────────────────────────────────────────────────────

// Role attached to every event so the renderer can route self(mic) vs
// speaker(system). Set from the start command; default self keeps older
// single-mic callers backward-compatible (no role → self).
var currentRole = "self"

func emit(_ dict: [String: String]) {
    var d = dict
    if d["role"] == nil { d["role"] = currentRole }
    guard let data = try? JSONSerialization.data(withJSONObject: d),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

// Voiceprint transport: a Float embedding ↔ base64 of little-endian Float32 bytes,
// so it rides the existing newline-JSON protocol and the main process can persist
// it (and restore it via load-voiceprint on the next gated session).
func floatsToBase64(_ v: [Float]) -> String {
    var le = v.map { $0.bitPattern.littleEndian }
    return Data(bytes: &le, count: le.count * 4).base64EncodedString()
}
func base64ToFloats(_ s: String) -> [Float]? {
    guard let data = Data(base64Encoded: s), data.count % 4 == 0 else { return nil }
    let count = data.count / 4
    var out = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { raw in
        let p = raw.bindMemory(to: UInt32.self)
        for i in 0..<count { out[i] = Float(bitPattern: UInt32(littleEndian: p[i])) }
    }
    return out
}

// ── Audio sources ───────────────────────────────────────────────────────────
// Why: make the recognizer source-agnostic so the SAME 55s-handoff /
// contextualStrings / restart logic drives either the microphone (self) or a
// system-audio process-tap (speaker). on-device recognition is single-session
// per process, so each source runs in its own helper process (see ipc/meeting.ts).

enum AudioSourceError: Error { case unavailable(String) }

protocol AudioSource {
    // Begin delivering PCM buffers via onBuffer; throw if the source can't start.
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws
    func stop()
}

// Microphone via AVAudioEngine.inputNode — the original behavior, extracted verbatim.
final class MicSource: AudioSource {
    private var engine = AVAudioEngine()
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        engine = AVAudioEngine()
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { throw AudioSourceError.unavailable("audio_format_unavailable") }
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in onBuffer(buf) }
        engine.prepare()
        try engine.start()
    }
    func stop() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }
}

// ── Recognizer ────────────────────────────────────────────────────────────────

class Recognizer {
    var locale = "zh-CN"
    var contextWords: [String] = []
    private(set) var isActive = false

    private let source: AudioSource
    init(source: AudioSource) { self.source = source }

    // Energy-based VAD: after speech, ~0.9 s of silence on THIS channel emits an
    // "endpoint" event so the renderer can commit/classify immediately instead of
    // waiting on the fixed silence timer. Per-channel energy → unaffected by the
    // other channel / cross-talk.
    private var vadHadSpeech = false
    private var vadSilentSamples = 0

    // Single-mic fallback speaker gating. When set, accumulate each finalized
    // segment's audio so the gate can label it by speaker; during enrollment route
    // audio to gate.enroll instead so your own voiceprint can be built.
    var gate: SpeakerGate?
    var enrolling = false
    private var segmentAudio: [AVAudioPCMBuffer] = []
    private var enrollAccum = 0
    private var lastEnrollEmit = 0.0
    // Speaker labeling (CoreML + fbank + resample) is too heavy for the main RunLoop
    // that also drives the 55 s handoff timer and ASR callbacks; run it here off-thread.
    private static let gateQueue = DispatchQueue(label: "qa.speaker-gate", qos: .userInitiated)

    // Enter/leave enrollment mode (driven by the enroll-start / gate-finalize
    // stdin commands). beginEnroll discards any audio from a prior aborted attempt.
    func beginEnroll() {
        enrolling = true
        enrollAccum = 0
        lastEnrollEmit = 0
        gate?.beginEnrollment()
    }
    func finalizeEnroll() {
        enrolling = false
        gate?.finalizeEnrollment()
        if let vp = gate?.voiceprint {
            emit(["type": "voiceprint", "data": floatsToBase64(vp), "dim": String(vp.count)])
        } else {
            emit(["type": "error", "text": "enroll_failed"])
        }
    }

    private func handleBuffer(_ buf: AVAudioPCMBuffer) {
        req?.append(buf)
        if let g = gate {
            if enrolling {
                g.enroll(buf)
                enrollAccum += Int(buf.frameLength)
                let secs = Double(enrollAccum) / buf.format.sampleRate
                if secs - lastEnrollEmit >= 0.5 {
                    lastEnrollEmit = secs
                    DispatchQueue.main.async { emit(["type": "enroll-progress", "seconds": String(format: "%.1f", secs)]) }
                }
            } else {
                segmentAudio.append(buf)
                if segmentAudio.count > 400 { segmentAudio.removeFirst() } // bound ~ last few seconds
            }
        }
        guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return }
        let n = Int(buf.frameLength)
        let p = ch[0]
        var sum: Float = 0
        for i in 0..<n { let v = p[i]; sum += v * v }
        let rms = (sum / Float(n)).squareRoot()
        if rms > 0.008 {
            vadHadSpeech = true
            vadSilentSamples = 0
        } else if vadHadSpeech {
            vadSilentSamples += n
            if Double(vadSilentSamples) / buf.format.sampleRate >= 0.9 {
                vadHadSpeech = false
                vadSilentSamples = 0
                DispatchQueue.main.async { emit(["type": "endpoint"]) }
            }
        }
    }

    private var sfRec: SFSpeechRecognizer?
    private var req: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var preemptTimer: Timer?
    // Why: handingOff signals that the 55 s boundary restart is in progress.
    // The task callback waits for isFinal=true, then begins the next session —
    // avoiding the word-drop that occurred when task.cancel() interrupted mid-utterance.
    private var handingOff = false
    private var handoffTimeout: Timer?
    private var sessionStartTime: Date?

    func start() {
        guard !isActive else { return }
        isActive = true
        beginSession()
    }

    func stop() {
        isActive = false
        teardown()
    }

    func updateContext(_ words: [String], newLocale: String? = nil) {
        let localeChanged = newLocale != nil && newLocale != locale
        if let nl = newLocale { locale = nl }
        guard words != contextWords || localeChanged else { return }
        contextWords = words
        // Why: trigger an immediate graceful restart when keywords or locale change
        // (new card matched or language switched), so the recognizer primes for the
        // new vocabulary / locale without waiting for the 55 s timer.
        // Guard: session must have been running > 5 s to avoid thrashing on rapid updates.
        guard isActive, !handingOff,
              let start = sessionStartTime,
              Date().timeIntervalSince(start) > 5.0 else { return }
        endSessionGracefully()
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private func teardown() {
        preemptTimer?.invalidate()
        preemptTimer = nil
        handoffTimeout?.invalidate()
        handoffTimeout = nil
        handingOff = false
        vadHadSpeech = false
        vadSilentSamples = 0
        // Clear the segment window so a timeout-error restart (no isFinal) can't mix
        // the previous utterance's audio into the next segment's speaker label.
        segmentAudio = []
        req?.endAudio()
        req = nil
        task?.cancel()
        task = nil
        source.stop()
    }

    // Graceful boundary handoff: stop collecting audio, flush with endAudio(),
    // then let the isFinal callback trigger the next session.
    private func endSessionGracefully() {
        preemptTimer?.invalidate()
        preemptTimer = nil
        handingOff = true
        // Stop feeding audio to the recognizer without cancelling the task,
        // so it can transcribe the last buffered samples.
        source.stop()
        req?.endAudio()
        // Fallback: if the final callback never arrives (e.g. recognizer stalls),
        // force a hard restart after 3 seconds so the session doesn't hang.
        handoffTimeout = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            guard let self, self.handingOff else { return }
            self.handingOff = false
            self.task?.cancel()
            self.task = nil
            self.req = nil
            if self.isActive { self.beginSession() }
        }
    }

    private func beginSession() {
        teardown()

        sfRec = SFSpeechRecognizer(locale: Locale(identifier: locale))
        guard let sfRec, sfRec.isAvailable else {
            emit(["type": "error", "text": "recognizer_unavailable"])
            isActive = false
            return
        }

        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        // Why: keep recognition on-device (private, offline, low-latency) where the
        // locale supports it — also lets mic + system run as independent single-session
        // processes without competing for a shared server request slot.
        if sfRec.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
        // Why: contextualStrings biases the LM toward domain-specific terms from
        // the currently matched card, recovering accuracy for jargon like "前置算法".
        if !contextWords.isEmpty {
            r.contextualStrings = Array(contextWords.prefix(50))
        }
        req = r

        task = sfRec.recognitionTask(with: r) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        let finalText = text
                        // Single-mic fallback: a real (enrolled) gate labels this
                        // segment's speaker role; .unknown / no-gate keeps the default role.
                        if let g = self.gate, g.isEnrolled {
                            // Compute the label OFF the main RunLoop (CoreML/fbank are
                            // heavy) and emit the final with role when done. The handoff
                            // continuation below is NOT blocked on it, so 55 s timing holds.
                            let seg = self.segmentAudio
                            self.segmentAudio = []
                            Recognizer.gateQueue.async {
                                let lbl = g.label(seg)
                                DispatchQueue.main.async {
                                    var d: [String: String] = ["type": "final", "text": finalText]
                                    if lbl != .unknown { d["role"] = lbl.rawValue }
                                    emit(d)
                                }
                            }
                        } else {
                            self.segmentAudio = []
                            emit(["type": "final", "text": finalText])
                        }
                    } else {
                        emit(["type": "interim", "text": text])
                    }
                    // Graceful handoff complete: final transcript received, now restart.
                    if result.isFinal && self.handingOff {
                        self.handoffTimeout?.invalidate()
                        self.handoffTimeout = nil
                        self.handingOff = false
                        self.task = nil
                        self.req = nil
                        if self.isActive { self.beginSession() }
                        return
                    }
                }
                if let error {
                    let code = (error as NSError).code
                    // Codes 1110 and 216 are Apple's speech recognition timeout.
                    if (code == 1110 || code == 216) && self.isActive {
                        self.handingOff = false
                        self.beginSession()
                    }
                }
            }
        }

        // Start feeding audio from the configured source (mic or system tap).
        do {
            try source.start { [weak self] buf in self?.handleBuffer(buf) }
        } catch let AudioSourceError.unavailable(reason) {
            emit(["type": "error", "text": reason])
            isActive = false
            return
        } catch {
            emit(["type": "error", "text": "audio_source_failed"])
            isActive = false
            return
        }

        sessionStartTime = Date()
        emit(["type": "listening"])

        // Why: SFSpeechRecognizer hard-stops at 60 s. Trigger a graceful handoff at
        // 55 s: stop audio input, flush with endAudio(), wait for isFinal callback.
        // This preserves the last syllable instead of discarding it on task.cancel().
        preemptTimer = Timer.scheduledTimer(withTimeInterval: 55.0, repeats: false) { [weak self] _ in
            guard let self, self.isActive else { return }
            self.endSessionGracefully()
        }
    }
}

// ── Permissions ───────────────────────────────────────────────────────────────

func requestPermissions(forSystem: Bool, then: @escaping (Bool) -> Void) {
    func speechThen() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                if status == .authorized { then(true) }
                else { emit(["type": "error", "text": "speech_denied"]); then(false) }
            }
        }
    }
    // System-tap capture uses Core Audio, not the mic device — skip the mic prompt.
    if forSystem { speechThen(); return }
    AVCaptureDevice.requestAccess(for: .audio) { micOk in
        guard micOk else { emit(["type": "error", "text": "microphone_denied"]); then(false); return }
        speechThen()
    }
}

// ── Command dispatch ──────────────────────────────────────────────────────────

// Default source from argv (--source mic|system); a start command may override it.
let defaultSource: String = {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--source"), i + 1 < a.count { return a[i + 1] }
    return "mic"
}()
// --gate enables single-mic fallback speaker gating. --model <path> points at the
// compiled CoreML speaker-embedding model (.mlmodelc). Both off/absent by default →
// normal dual-channel. The gate is inert (always .unknown, never enrolled) when the
// model is missing or fails to load, so enabling --gate alone never changes behavior.
let gateEnabled = CommandLine.arguments.contains("--gate")
let modelPath: String? = {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--model"), i + 1 < a.count { return a[i + 1] }
    return nil
}()

var rec: Recognizer?

func dispatch(_ line: String) {
    guard let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let action = json["action"] as? String else { return }
    switch action {
    case "start":
        let kind = (json["source"] as? String) ?? defaultSource
        currentRole = (kind == "system") ? "speaker" : "self"
        let locale = json["locale"] as? String ?? "zh-CN"
        let words = json["contextWords"] as? [String] ?? []
        let bundleIds = json["bundleIds"] as? [String] ?? []
        requestPermissions(forSystem: kind == "system") { ok in
            guard ok else { return }  // error already emitted (mic/speech denied)
            let src: AudioSource = (kind == "system") ? SystemTapSource(bundleIds: bundleIds) : MicSource()
            let r = Recognizer(source: src)
            r.locale = locale
            r.contextWords = words
            if gateEnabled { r.gate = makeSpeakerGate(modelPath: modelPath) }
            rec = r
            r.start()
        }
    case "stop":
        rec?.stop()
    case "enroll-start":
        // You begin reading the enrollment prompt → route audio to the gate.
        rec?.beginEnroll()
    case "gate-finalize":
        // Enrollment finished → build the voiceprint and emit it for persistence.
        rec?.finalizeEnroll()
    case "load-voiceprint":
        // Restore a persisted voiceprint so single-mic gating works without
        // re-recording (sent after the gated session is listening).
        if let s = json["data"] as? String, let vec = base64ToFloats(s) {
            rec?.gate?.loadVoiceprint(vec)
        }
    case "context":
        rec?.updateContext(json["words"] as? [String] ?? [], newLocale: json["locale"] as? String)
    default:
        break
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Why @main: with two source files, Swift only allows top-level executable code
// in a `main.swift`. The entry statements live in an @main type instead, so
// SpeechHelper.swift + SystemAudioTap.swift compile together.
@main
struct SpeechHelperApp {
    static func main() {
        // Offline fbank alignment selftest: print features for a fixed signal and
        // exit (compared against the Python reference, no model needed). See
        // AudioFeature.swift / scripts/convert-campplus-coreml.py --check-fbank.
        if CommandLine.arguments.contains("--dump-fbank") {
            FbankSelfTest.run()
            return
        }

        // Ready as soon as the process is up; permissions are requested per source
        // at `start` (mic needs the mic prompt; the system tap does not).
        emit(["type": "ready"])

        // Read commands from stdin on a background thread while the main RunLoop
        // handles timers and the recognition task callbacks.
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                DispatchQueue.main.async { dispatch(trimmed) }
            }
            // stdin closed (Electron exited) → clean up and exit
            DispatchQueue.main.async {
                rec?.stop()
                exit(0)
            }
        }

        RunLoop.main.run()
    }
}

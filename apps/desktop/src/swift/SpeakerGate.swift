// Speaker gating for the SINGLE-MIC FALLBACK (no headphones / system tap denied).
//
// In that mode one microphone captures everyone, so we can no longer separate
// self vs speaker by audio SOURCE. A SpeakerGate instead labels each
// finalized segment by SPEAKER, so only the other speaker's segments are classified —
// recovering the "your own speech never triggers a match" guarantee.
//
// ── Design ────────────────────────────────────────────────────────────────────
// macOS has NO built-in speaker-identification API (SFSpeechRecognizer does not
// diarize; SoundAnalysis only classifies sounds). So we bundle an on-device
// speaker-embedding model (CAM++ zh_en, 3D-Speaker, ~28 MB, 192-dim) compiled to
// CoreML (.mlmodelc). The flow:
//   1. Enroll yourself once (read a sentence) → mean-pooled, L2-normalized
//      voiceprint embedding, persisted by the main process.
//   2. Per finalized segment: fbank → embedding → cosine vs the enrolled voiceprint.
//      cos ≥ τ_high ⇒ the enrolled speaker (SELF); cos ≤ τ_low ⇒ someone
//      else (the other SPEAKER); in between ⇒ .unknown (caller keeps its default).
//
// ── Graceful degradation (why this is safe to ship before the model lands) ─────
// CamPlusSpeakerGate is the real implementation, BUT if the .mlmodelc is absent or
// fails to load, `model` is nil → isEnrolled stays false → label() is never reached
// and would return .unknown anyway. So with no model bundled the gate behaves
// EXACTLY like the old inert stub: gated mode == dual-channel behavior, nothing
// breaks. Drop the compiled model into resources/ + enroll, and it activates.
import Foundation
import AVFoundation
import CoreML

enum SpeakerLabel: String { case `self` = "self", speaker, unknown }

protocol SpeakerGate {
    /// Start a fresh enrollment, discarding any audio from a prior aborted attempt.
    func beginEnrollment()
    /// Feed enrollment audio (you reading a known prompt).
    func enroll(_ buffer: AVAudioPCMBuffer)
    /// Build your own voiceprint from the accumulated enrollment audio.
    func finalizeEnrollment()
    /// Restore a previously persisted voiceprint (skip re-recording on relaunch).
    func loadVoiceprint(_ vector: [Float])
    /// The current voiceprint embedding (to persist after enrollment), or nil.
    var voiceprint: [Float]? { get }
    var isEnrolled: Bool { get }
    /// Label a finalized segment's audio. `.unknown` ⇒ caller keeps its default role.
    func label(_ segmentAudio: [AVAudioPCMBuffer]) -> SpeakerLabel
}

/// Inert placeholder kept for callers that never bundle a model. Performs no
/// speaker ID; always `.unknown`. CamPlusSpeakerGate supersedes it when a model is
/// present; makeSpeakerGate() picks the right one.
final class StubSpeakerGate: SpeakerGate {
    private(set) var isEnrolled = false
    var voiceprint: [Float]? { nil }
    func beginEnrollment() {}
    func enroll(_ buffer: AVAudioPCMBuffer) {}
    func finalizeEnrollment() { isEnrolled = true }
    func loadVoiceprint(_ vector: [Float]) {}
    func label(_ segmentAudio: [AVAudioPCMBuffer]) -> SpeakerLabel { .unknown }
}

/// CoreML CAM++ speaker-embedding gate. Inert (always .unknown, never enrolled)
/// when the model can't be loaded, so it is safe to wire on before the model ships.
final class CamPlusSpeakerGate: SpeakerGate {
    // Cosine thresholds with a hysteresis dead-zone. Starting points from the
    // CAM++ zh_en model card; calibrate on-device with real short segments.
    private let tauHigh: Float = 0.70   // ≥ ⇒ enrolled speaker (self)
    private let tauLow: Float = 0.55    // ≤ ⇒ different speaker (the other speaker)
    // Embeddings shorter than this are unreliable; skip → .unknown. Must stay ≥ the
    // CoreML model's RangeDim frame floor: 8_400 samples → 1+(8400-400)/160 = 51
    // frames ≥ the converter's --min-frames 50, so the shortest accepted segment can
    // always run inference (8_000 → 48 frames would be rejected by CoreML).
    private let minEmbedSamples = 8_400 // ~0.525 s at 16 kHz (51 fbank frames)
    // Cap enrollment audio so finalize stays bounded (most recent ~20 s).
    private let maxEnrollSamples = 16_000 * 20
    // Bound retained enrollment INPUT (pre-resample) by ~30 s at any device rate, so
    // memory/finalize cost can't grow with a stuck enrollment regardless of buffer size.
    private let maxEnrollInputFrames = 48_000 * 30
    private var enrollInputFrames = 0

    private let model: MLModel?
    private let fbank = FbankExtractor(applyCMN: true)
    private let inputName: String
    private let outputName: String

    private var enrollBuffers: [AVAudioPCMBuffer] = []
    private var voiceprintVec: [Float]?

    var voiceprint: [Float]? { voiceprintVec }
    // Enrolled only when we can actually act: a usable model AND a voiceprint.
    var isEnrolled: Bool { model != nil && voiceprintVec != nil }

    init(modelPath: String?) {
        var loaded: MLModel?
        if let p = modelPath, FileManager.default.fileExists(atPath: p) {
            let cfg = MLModelConfiguration()
            cfg.computeUnits = .all  // CPU + GPU + Neural Engine
            loaded = try? MLModel(contentsOf: URL(fileURLWithPath: p), configuration: cfg)
        }
        self.model = loaded
        // Resolve I/O feature names (convert script fixes them to fbank/embedding;
        // fall back to the model's first input/output for robustness).
        let desc = loaded?.modelDescription
        self.inputName = desc?.inputDescriptionsByName.keys.contains("fbank") == true
            ? "fbank" : (desc?.inputDescriptionsByName.keys.first ?? "fbank")
        self.outputName = desc?.outputDescriptionsByName.keys.contains("embedding") == true
            ? "embedding" : (desc?.outputDescriptionsByName.keys.first ?? "embedding")
    }

    func beginEnrollment() { enrollBuffers.removeAll(); enrollInputFrames = 0 }

    func enroll(_ buffer: AVAudioPCMBuffer) {
        guard model != nil else { return }
        enrollBuffers.append(buffer)
        enrollInputFrames += Int(buffer.frameLength)
        // Bound by accumulated INPUT frames (not buffer count) so memory tracks real
        // duration at any device sample rate; finalize then trims the resampled
        // stream to the most-recent maxEnrollSamples (~20 s @ 16 kHz).
        while enrollInputFrames > maxEnrollInputFrames, enrollBuffers.count > 1 {
            enrollInputFrames -= Int(enrollBuffers.removeFirst().frameLength)
        }
    }

    func finalizeEnrollment() {
        defer { enrollBuffers.removeAll() }
        guard model != nil, var samples = AudioPrep.concatTo16kMono(enrollBuffers) else { return }
        if samples.count > maxEnrollSamples { samples.removeFirst(samples.count - maxEnrollSamples) }
        if let emb = embed(samples16k: samples) { voiceprintVec = emb }
    }

    func loadVoiceprint(_ vector: [Float]) {
        voiceprintVec = l2normalize(vector)
    }

    func label(_ segmentAudio: [AVAudioPCMBuffer]) -> SpeakerLabel {
        guard model != nil, let vp = voiceprintVec,
              let samples = AudioPrep.concatTo16kMono(segmentAudio),
              samples.count >= minEmbedSamples,
              let emb = embed(samples16k: samples)
        else { return .unknown }
        let cos = dot(emb, vp)
        if cos >= tauHigh { return .`self` }
        if cos <= tauLow { return .speaker }
        return .unknown
    }

    // ── Embedding extraction ───────────────────────────────────────────────────
    private func embed(samples16k: [Float]) -> [Float]? {
        guard let model else { return nil }
        let feats = fbank.compute(samples16k)             // T × 80, CMN applied
        guard !feats.isEmpty else { return nil }
        let T = feats.count, F = feats[0].count
        guard let arr = try? MLMultiArray(shape: [1, NSNumber(value: T), NSNumber(value: F)],
                                          dataType: .float32) else { return nil }
        let ptr = arr.dataPointer.bindMemory(to: Float.self, capacity: T * F)
        for t in 0..<T { for f in 0..<F { ptr[t * F + f] = feats[t][f] } }

        guard let provider = try? MLDictionaryFeatureProvider(
                dictionary: [inputName: MLFeatureValue(multiArray: arr)]),
              let out = try? model.prediction(from: provider),
              let vec = out.featureValue(for: outputName)?.multiArrayValue
        else { return nil }

        let count = vec.count
        var emb = [Float](repeating: 0, count: count)
        let vptr = vec.dataPointer.bindMemory(to: Float.self, capacity: count)
        if vec.dataType == .float32 {
            for i in 0..<count { emb[i] = vptr[i] }
        } else {
            for i in 0..<count { emb[i] = vec[i].floatValue }
        }
        // A degenerate (near-zero-norm) embedding would make dot()≈0 and be misread as
        // a confident low-similarity ⇒ .speaker. Treat it as "no embedding" so
        // label() falls through to .unknown instead of a false classification.
        var norm: Float = 0
        for x in emb { norm += x * x }
        guard norm.squareRoot() > 1e-6 else { return nil }
        return l2normalize(emb)
    }

    private func l2normalize(_ v: [Float]) -> [Float] {
        var norm: Float = 0
        for x in v { norm += x * x }
        norm = norm.squareRoot()
        guard norm > 1e-9 else { return v }
        return v.map { $0 / norm }
    }

    private func dot(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count else { return 0 }
        var s: Float = 0
        for i in 0..<a.count { s += a[i] * b[i] }
        return s
    }
}

/// Factory — returns the CoreML gate when a model path is given, else the inert
/// stub. CamPlusSpeakerGate is itself inert if the model fails to load, so callers
/// never need to special-case a missing model.
func makeSpeakerGate(modelPath: String?) -> SpeakerGate {
    if modelPath != nil { return CamPlusSpeakerGate(modelPath: modelPath) }
    return StubSpeakerGate()
}

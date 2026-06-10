// Audio front-end for the single-mic speaker gate (see SpeakerGate.swift).
//
// Two responsibilities, both pure DSP (no CoreML, no model file) so they compile
// and run even when no embedding model is bundled:
//   1. AudioPrep.concatTo16kMono — concat the recognizer's heterogeneous
//      AVAudioPCMBuffers (mic = device-native rate/channels; system tap = mono at
//      tap rate) into a single 16 kHz mono Float stream via AVAudioConverter. The
//      embedding model is trained at a fixed 16 kHz mono, so every consumer must
//      normalize first — nothing upstream does this today.
//   2. FbankExtractor — an 80-dim log-mel filterbank that mirrors the
//      Kaldi/torchaudio.compliance.kaldi.fbank conventions CAM++ (3D-Speaker) was
//      trained with, so the Swift features line up with the model's expected input.
//
// Why re-implement fbank in Swift instead of baking it into the CoreML graph:
// torchaudio's Kaldi fbank uses framing/windowing ops that do not trace cleanly to
// CoreML; the robust, controllable path is a documented Swift front-end feeding a
// model that takes [1, T, 80] fbank. Every constant below is chosen to match the
// reference (scripts/convert-campplus-coreml.py prints the same constants); the
// `--dump-fbank` selftest emits features for a deterministic signal so the numeric
// alignment (cosine ≥ 0.999 vs the Python reference) can be verified offline.
import Foundation
import AVFoundation
import Accelerate

// ── Resample + downmix to 16 kHz mono ─────────────────────────────────────────
enum AudioPrep {
    static let targetSampleRate: Double = 16_000

    /// Concatenate + resample a list of PCM buffers to a single 16 kHz mono Float
    /// array. Returns nil if the buffers are empty or a converter can't be built.
    static func concatTo16kMono(_ buffers: [AVAudioPCMBuffer]) -> [Float]? {
        guard let firstFmt = buffers.first?.format,
              let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                         sampleRate: targetSampleRate,
                                         channels: 1, interleaved: false)
        else { return nil }

        // One stateful sample-rate converter for the whole stream preserves phase
        // continuity across buffers. A mid-stream format change (rare: device
        // hot-swap) rebuilds the converter for the new format.
        var srcFmt = firstFmt
        var converter = AVAudioConverter(from: srcFmt, to: target)
        converter?.sampleRateConverterQuality = .max

        var out: [Float] = []
        out.reserveCapacity(Int(targetSampleRate))  // grows as needed
        let ratio = target.sampleRate / srcFmt.sampleRate

        for buf in buffers where buf.frameLength > 0 {
            if buf.format != srcFmt {
                srcFmt = buf.format
                converter = AVAudioConverter(from: srcFmt, to: target)
                converter?.sampleRateConverterQuality = .max
            }
            guard let conv = converter else { continue }
            let outCap = AVAudioFrameCount(Double(buf.frameLength) * (target.sampleRate / srcFmt.sampleRate)) + 32
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: max(outCap, 1)) else { continue }

            var fed = false
            var err: NSError?
            // Feed exactly this one input buffer, then report no-data so convert()
            // emits whatever output it can for it (the documented streaming pattern).
            let status = conv.convert(to: outBuf, error: &err) { _, outStatus in
                if fed { outStatus.pointee = .noDataNow; return nil }
                fed = true
                outStatus.pointee = .haveData
                return buf
            }
            if status == .error { continue }
            if let ch = outBuf.floatChannelData, outBuf.frameLength > 0 {
                out.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(outBuf.frameLength)))
            }
        }
        _ = ratio  // documented for readers; outCap already uses the live ratio
        // Note: the resampler's terminal filter delay-line tail (a few ms at 16 kHz,
        // well under one 10 ms fbank hop) is intentionally not drained — snip_edges
        // discards a trailing partial frame anyway, so it costs at most ~1 frame at
        // the very end of a multi-second enrollment/label segment.
        return out.isEmpty ? nil : out
    }
}

// ── Kaldi-compatible 80-dim log-mel filterbank ────────────────────────────────
struct FbankExtractor {
    let sampleRate: Double
    let numMelBins: Int
    let frameLength: Int       // samples per frame  (25 ms @ 16 kHz = 400)
    let frameShift: Int        // hop in samples     (10 ms @ 16 kHz = 160)
    let fftSize: Int           // next pow2 ≥ frameLength (400 → 512)
    let log2n: vDSP_Length
    let preemph: Float = 0.97
    let applyCMN: Bool         // cepstral mean norm over time (CAM++ uses it)

    // torchaudio.compliance.kaldi floors mel energies at float eps before log().
    private static let energyFloor: Float = 1.1920929e-07
    // 3D-Speaker scales the [-1,1] waveform by 1<<15 (Kaldi expects int16 range)
    // before fbank. A global scale only shifts log-mel by a constant that CMN later
    // removes, but we match it anyway so non-CMN dumps line up with the reference.
    private static let waveScale: Float = 32768.0

    private let window: [Float]          // povey window, length frameLength
    private let melWeights: [[Float]]    // numMelBins × (fftSize/2 + 1)
    private let fftSetup: FFTSetup

    init(sampleRate: Double = 16_000, numMelBins: Int = 80,
         frameLengthMs: Double = 25, frameShiftMs: Double = 10, applyCMN: Bool = true) {
        self.sampleRate = sampleRate
        self.numMelBins = numMelBins
        self.frameLength = Int(sampleRate * frameLengthMs / 1000.0)   // 400
        self.frameShift = Int(sampleRate * frameShiftMs / 1000.0)     // 160
        var fft = 1
        while fft < self.frameLength { fft <<= 1 }
        self.fftSize = fft                                            // 512
        self.log2n = vDSP_Length(log2(Double(fft)).rounded())
        self.applyCMN = applyCMN

        // Povey window: (0.5 - 0.5·cos(2π n/(L-1)))^0.85  — Kaldi default.
        let L = self.frameLength
        self.window = (0..<L).map { n in
            let h = 0.5 - 0.5 * cos(2.0 * Double.pi * Double(n) / Double(L - 1))
            return Float(pow(h, 0.85))
        }
        self.melWeights = FbankExtractor.makeMelWeights(
            numMelBins: numMelBins, fftSize: fft, sampleRate: sampleRate,
            lowFreq: 20.0, highFreq: sampleRate / 2.0)
        self.fftSetup = vDSP_create_fftsetup(self.log2n, FFTRadix(kFFTRadix2))!
    }

    /// frames × numMelBins log-mel features (CMN applied when configured).
    /// Returns an empty array if there is less than one full frame of audio.
    func compute(_ samples: [Float]) -> [[Float]] {
        let n = samples.count
        guard n >= frameLength else { return [] }
        let numFrames = 1 + (n - frameLength) / frameShift   // Kaldi snip_edges=true

        let half = fftSize / 2
        var realp = [Float](repeating: 0, count: half)
        var imagp = [Float](repeating: 0, count: half)
        var frame = [Float](repeating: 0, count: fftSize)    // zero-padded
        var feats = [[Float]](repeating: [Float](repeating: 0, count: numMelBins), count: numFrames)

        for t in 0..<numFrames {
            let start = t * frameShift
            // copy + scale to Kaldi int16 range
            for i in 0..<frameLength { frame[i] = samples[start + i] * FbankExtractor.waveScale }
            for i in frameLength..<fftSize { frame[i] = 0 }

            // remove DC offset (mean of the 400-sample window)
            var mean: Float = 0
            vDSP_meanv(frame, 1, &mean, vDSP_Length(frameLength))
            var negMean = -mean
            vDSP_vsadd(frame, 1, &negMean, &frame, 1, vDSP_Length(frameLength))

            // pre-emphasis: x[i] -= 0.97·x[i-1] (descending), then x[0] -= 0.97·x[0]
            var i = frameLength - 1
            while i > 0 { frame[i] -= preemph * frame[i - 1]; i -= 1 }
            frame[0] -= preemph * frame[0]

            // povey window
            vDSP_vmul(frame, 1, window, 1, &frame, 1, vDSP_Length(frameLength))

            // real FFT (packed). vDSP scales by 2 vs a plain DFT; we undo it with
            // 0.5 so non-CMN dumps match the reference (CMN would cancel it anyway).
            frame.withUnsafeBufferPointer { ptr in
                ptr.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { cptr in
                    realp.withUnsafeMutableBufferPointer { rp in
                        imagp.withUnsafeMutableBufferPointer { ip in
                            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                            vDSP_ctoz(cptr, 2, &split, 1, vDSP_Length(half))
                            vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                        }
                    }
                }
            }

            // power spectrum, bins 0…half (fftSize/2 + 1). Packed format:
            // realp[0]=DC, imagp[0]=Nyquist; bins 1…half-1 are realp/imagp[k].
            var power = [Float](repeating: 0, count: half + 1)
            let scale: Float = 0.5
            power[0] = (realp[0] * scale) * (realp[0] * scale)
            power[half] = (imagp[0] * scale) * (imagp[0] * scale)
            for k in 1..<half {
                let re = realp[k] * scale, im = imagp[k] * scale
                power[k] = re * re + im * im
            }

            // mel filterbank + log floor
            for m in 0..<numMelBins {
                var e: Float = 0
                let w = melWeights[m]
                for k in 0...half { e += power[k] * w[k] }
                feats[t][m] = log(max(e, FbankExtractor.energyFloor))
            }
        }

        if applyCMN { subtractMeanOverTime(&feats) }
        return feats
    }

    /// CMN: subtract each mel-dim's mean across all frames (CAM++ cmn=True).
    private func subtractMeanOverTime(_ feats: inout [[Float]]) {
        guard let first = feats.first else { return }
        let dims = first.count, frames = feats.count
        for d in 0..<dims {
            var s: Float = 0
            for t in 0..<frames { s += feats[t][d] }
            let mean = s / Float(frames)
            for t in 0..<frames { feats[t][d] -= mean }
        }
    }

    // Triangular mel filterbank weights over the power-spectrum bins, matching
    // Kaldi's MelBanks (mel(f) = 1127·ln(1 + f/700), filters equally spaced in mel).
    private static func makeMelWeights(numMelBins: Int, fftSize: Int, sampleRate: Double,
                                       lowFreq: Double, highFreq: Double) -> [[Float]] {
        let numBins = fftSize / 2 + 1
        let fftBinWidth = sampleRate / Double(fftSize)
        func hzToMel(_ f: Double) -> Double { 1127.0 * log(1.0 + f / 700.0) }

        let melLow = hzToMel(lowFreq), melHigh = hzToMel(highFreq)
        let melDelta = (melHigh - melLow) / Double(numMelBins + 1)

        var weights = [[Float]](repeating: [Float](repeating: 0, count: numBins), count: numMelBins)
        for m in 0..<numMelBins {
            let leftMel = melLow + Double(m) * melDelta
            let centerMel = melLow + Double(m + 1) * melDelta
            let rightMel = melLow + Double(m + 2) * melDelta
            for k in 0..<numBins {
                let freq = fftBinWidth * Double(k)
                if freq < lowFreq || freq > highFreq { continue }
                let mel = hzToMel(freq)
                if mel <= leftMel || mel >= rightMel { continue }
                let w = mel <= centerMel
                    ? (mel - leftMel) / (centerMel - leftMel)
                    : (rightMel - mel) / (rightMel - centerMel)
                weights[m][k] = Float(w)
            }
        }
        return weights
    }
}

// ── Deterministic selftest: `SpeechHelper --dump-fbank` ───────────────────────
// Prints the 80-dim fbank of a fixed 1 s signal as JSON {frames, dim, data:[[…]]}
// (CMN OFF so the absolute values are comparable). The Python reference
// (scripts/convert-campplus-coreml.py --check-fbank) generates the identical signal
// and asserts cosine ≥ 0.999 per frame. Run this offline once the model lands to
// confirm the Swift front-end matches the model's training featurizer.
enum FbankSelfTest {
    static func deterministicSignal(seconds: Double = 1.0, sampleRate: Double = 16_000) -> [Float] {
        let n = Int(seconds * sampleRate)
        return (0..<n).map { i in
            let t = Double(i) / sampleRate
            let s = 0.5 * sin(2 * .pi * 220 * t)
                  + 0.3 * sin(2 * .pi * 1000 * t)
                  + 0.2 * sin(2 * .pi * 3500 * t)
            return Float(s)
        }
    }

    static func run() {
        let fbank = FbankExtractor(applyCMN: false)
        let feats = fbank.compute(deterministicSignal())
        let payload: [String: Any] = [
            "frames": feats.count,
            "dim": fbank.numMelBins,
            "data": feats.map { row in row.map { Double($0) } },
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
    }
}

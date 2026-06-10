// Why: AudioContext.createMediaStreamSource() is broken in this Electron env,
// but decodeAudioData() works because it decodes a pre-recorded buffer (a codec
// operation) rather than routing a live microphone stream through the audio graph.
//
// Pipeline: short WebM chunks → decodeAudioData → RMS VAD → accumulate PCM
//           → (on silence) concatenate + RNNoise → WAV → Groq

import createRNNWasmModuleSync from '@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js';
import RnnoiseProcessor, { type IRnnoiseModule } from '@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js';

const FRAME_SIZE  = 480;   // RNNoise constant — must be exactly 480
const INT16_SCALE = 32768; // RNNoise expects samples scaled to int16 range

// RMS above this value counts as "someone is speaking".
// Speech typically 0.03–0.15; AC/fan noise typically 0.001–0.008.
export const VAD_THRESHOLD = 0.015;

// Analysis window for peak VAD — 150 ms gives 3 windows per 0.5 s chunk,
// better resolution than 200 ms (2.5 windows) without excessive compute.
const VAD_WINDOW_MS = 0.15; // 150 ms

let _processor: RnnoiseProcessor | null = null;
let _audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') _audioCtx = new AudioContext();
  return _audioCtx;
}

function getProcessor(): RnnoiseProcessor {
  if (!_processor) {
    const wasm = createRNNWasmModuleSync() as unknown as IRnnoiseModule;
    _processor = new RnnoiseProcessor(wasm);
  }
  return _processor;
}

function encodeWAV(samples: Float32Array, sampleRate: number): Blob {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); // PCM, mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Decode one WebM chunk to raw Float32 PCM. Returns null on decode failure. */
export async function decodeChunk(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  try {
    const arrayBuf = await blob.arrayBuffer();
    const decoded  = await getAudioCtx().decodeAudioData(arrayBuf);
    return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
  } catch {
    return null;
  }
}

/**
 * Returns true if ANY 200 ms window inside the chunk exceeds VAD_THRESHOLD.
 * Why: averaging RMS over the whole chunk misclassifies chunks where speech
 * ends near a boundary (e.g. comma pause) — the silence drags the mean below
 * the threshold even though speech was clearly present.  Peak-window detection
 * keeps those chunks as "speech" so the sentence isn't split prematurely.
 */
export function hasSpeechPresence(samples: Float32Array, sampleRate: number): boolean {
  const windowSize = Math.round(sampleRate * VAD_WINDOW_MS);
  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    let sumSq = 0;
    for (let j = i; j < i + windowSize; j++) {
      const s = samples[j] ?? 0;
      sumSq += s * s;
    }
    if (Math.sqrt(sumSq / windowSize) >= VAD_THRESHOLD) return true;
  }
  return false;
}

/**
 * Concatenate accumulated Float32 PCM chunks, apply RNNoise, and encode to WAV.
 * Called after VAD detects end-of-speech to produce a single clean audio blob.
 */
export function denoiseAndEncode(chunks: Float32Array[], sampleRate: number): Blob {
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const combined = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

  const processor = getProcessor();
  const denoised  = new Float32Array(totalLen);
  const frame     = new Float32Array(FRAME_SIZE);

  for (let i = 0; i + FRAME_SIZE <= combined.length; i += FRAME_SIZE) {
    for (let j = 0; j < FRAME_SIZE; j++) frame[j] = (combined[i + j] ?? 0) * INT16_SCALE;
    processor.processAudioFrame(frame, true);
    for (let j = 0; j < FRAME_SIZE; j++) denoised[i + j] = frame[j]! / INT16_SCALE;
  }

  return encodeWAV(denoised, sampleRate);
}

/** Call when the meeting session ends to release WASM memory. */
export function destroyDenoiser(): void {
  _processor?.destroy();
  _processor = null;
}

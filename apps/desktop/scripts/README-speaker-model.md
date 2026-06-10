# On-device speaker model — drop-in guide

This is the end-to-end procedure for converting, compiling, aligning, and shipping the
CAM++ speaker-embedding model that powers the **single-mic speaker gate**
(`src/swift/SpeakerGate.swift`, `src/swift/AudioFeature.swift`). The converter lives in
`scripts/convert-campplus-coreml.py`.

> **Until you drop the compiled model into `resources/`, the gate stays inert.**
> `CamPlusSpeakerGate` loads `model = nil` when the `.mlmodelc` is missing → `isEnrolled`
> never becomes true → `label()` always returns `.unknown` → callers keep their default
> role. So dual-channel (headphones / system-tap) behavior is **completely unaffected**.
> Shipping no model is the safe default; only the single-mic fallback gains speaker ID
> once a model is present **and** you have enrolled.

---

## 0. The I/O contract (do not change)

The Swift gate calls the **compiled** model `CAMPlusSpeaker.mlmodelc` with:

| | feature name | shape | dtype | notes |
|---|---|---|---|---|
| input | `fbank` | `[1, T, 80]` | float32 | T = number of 10 ms frames; flexible via `RangeDim(50..2000)` |
| output | `embedding` | `[1, 192]` | float32 | L2-normalized **in Swift**, not in the graph |

fbank is computed **in Swift** (`FbankExtractor`), not inside the CoreML graph, because
torchaudio's Kaldi fbank framing does not `torch.jit.trace` cleanly into a fixed CoreML
program. The converted model is a pure network: fbank in → embedding out.

---

## 1. Verify the weight license (mandatory, human step)

```bash
python scripts/convert-campplus-coreml.py license
```

- The **3D-Speaker toolkit** (`speakerlab`) is **Apache-2.0** — fine to ship.
- **Weights are a separate license.** Many speaker-verification checkpoints are trained on
  **VoxCeleb**, which is **research / non-commercial only** — shipping those in this paid
  product is a license violation and a real legal risk.
- The target model `iic/speech_campplus_sv_zh_en_16k-common_advanced` is documented as
  trained on an **in-house Mandarin+English corpus (not VoxCeleb)**, so it is *claimed* to
  be commercially usable — but **you must open the model page and confirm the `license`
  field + the training-data statement yourself**:
  <https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced>

`convert` **refuses to run** without `--i-have-verified-license`. Passing that flag is your
assertion that you confirmed both (a) a permissive/commercial license and (b) non-VoxCeleb
training data.

---

## 2. Convert + compile (offline machine with the deps)

This needs `torch`, `torchaudio`, `coremltools`, `modelscope`, `numpy` — **none of which are
installed in the app environment**. Use a throwaway venv:

```bash
python3 -m venv /tmp/campplus && source /tmp/campplus/bin/activate
pip install "modelscope==1.18.0" "torch==2.2.2" "torchaudio==2.2.2" \
            "coremltools==8.0" "numpy<2.0"
# If `import speakerlab` fails after snapshot_download:
#   pip install "git+https://github.com/modelscope/3D-Speaker.git"   # Apache-2.0
```

Run the conversion (downloads ~28 MB, traces, converts, compiles):

```bash
python scripts/convert-campplus-coreml.py convert --i-have-verified-license
# optional: --out-dir resources  --min-frames 50 --max-frames 2000  --keep-mlpackage
```

What it does:

1. `modelscope.snapshot_download(...)` the CAM++ snapshot.
2. Load the **raw** CAM++ `nn.Module` via `speakerlab` (not the pipeline wrapper, which
   would re-run fbank internally).
3. Wrap it so `forward(fbank[1, T, 80]) -> embedding[1, 192]` (no fbank / no CMN / no
   L2-norm in the graph — the Swift side does CMN on fbank and L2-normalizes the output).
4. `torch.jit.trace` on a dummy `[1, 200, 80]` input.
5. `coremltools.convert(..., convert_to="mlprogram", compute_units=ALL)` with input
   `ct.TensorType(name="fbank", shape=(1, RangeDim(50, 2000), 80))`, rename the output to
   `embedding`, save `resources/CAMPlusSpeaker.mlpackage`.
6. Compile to `resources/CAMPlusSpeaker.mlmodelc` with:

   ```bash
   xcrun coremlc compile resources/CAMPlusSpeaker.mlpackage resources/
   ```

   (The script runs this for you; the exact command is printed so you can re-run it
   manually if needed. `coremlc` names the output after the `.mlpackage` basename, i.e.
   `CAMPlusSpeaker.mlmodelc`.)

**Operator-compatibility note:** CAM++ is **conv / TDNN-based** (D-TDNN + statistics
pooling), so it converts cleanly. **Avoid SpeechBrain-style ECAPA wrappers** whose
`forward` takes a relative-`lengths`/`length` tensor — that injects dynamic control flow
that does not trace/convert. If you ever swap models, keep the forward signature to a single
fbank tensor.

---

## 3. Wire it into the build

Add this entry to `package.json` → `build.extraResources` (alongside `SpeechHelper`):

```json
{ "from": "resources/CAMPlusSpeaker.mlmodelc", "to": "CAMPlusSpeaker.mlmodelc" }
```

`.mlmodelc` is a **directory**, and electron-builder copies directories fine. After packing
it lands next to `SpeechHelper` in the app's `Resources/`, where the main process passes its
absolute path to `SpeechHelper --gate --model <path>`.

---

## 4. Numeric fbank-alignment gate (run before trusting embeddings)

The model only produces meaningful embeddings if the **Swift fbank front-end matches the
model's training featurizer**. Verify it numerically:

```bash
# Build the Swift helper if needed:  pnpm run build:swift
resources/SpeechHelper --dump-fbank > /tmp/swift_fbank.json
python scripts/convert-campplus-coreml.py check-fbank /tmp/swift_fbank.json
```

This regenerates the **exact** deterministic 1 s @ 16 kHz signal the Swift selftest uses:

```
x[n] = 0.5*sin(2π*220*n/16000) + 0.3*sin(2π*1000*n/16000) + 0.2*sin(2π*3500*n/16000),  n = 0..15999
```

computes the reference fbank with `torchaudio.compliance.kaldi.fbank` (num_mel_bins=80,
frame_length=25, frame_shift=10, dither=0, window='povey', remove_dc_offset=True,
preemphasis=0.97, use_energy=False, **CMN off** — matching `--dump-fbank` which sets
`applyCMN=false`), and asserts **per-frame cosine ≥ 0.999**, printing min / mean cosine and
the worst frame. If it FAILS, fix the Swift `FbankExtractor` (common culprits: window type,
preemph, DC removal, the `1<<15` wave scale, mel-bank edge freqs) before shipping — the
embeddings are meaningless until this passes. This check needs **no model weights**, only
`torch` + `torchaudio` + `numpy`.

---

## 5. Enroll on-device + calibrate thresholds

1. Launch the helper with the gate + model:
   `SpeechHelper --gate --model <abs path to CAMPlusSpeaker.mlmodelc>` (the main process
   does this in single-mic fallback mode).
2. You read the enrollment prompt → `enroll-start` then `gate-finalize` builds a
   mean-pooled, L2-normalized voiceprint; persist it and restore via `load-voiceprint`.
3. **Calibrate the cosine thresholds** on real short segments. Starting points (from the
   model card / `CamPlusSpeakerGate`):
   - `τ_high ≈ 0.70` → cosine ≥ τ_high ⇒ the enrolled speaker (**self**)
   - `τ_low ≈ 0.55` → cosine ≤ τ_low ⇒ a different speaker (**the other speaker**)
   - in between ⇒ `.unknown` (caller keeps its default role)

   The dead-zone is hysteresis: short noisy segments fall into `.unknown` rather than being
   mislabeled. Tune τ on a few real speaker/self clips before trusting it.

---

## Quick reference

```bash
python scripts/convert-campplus-coreml.py license                                   # 1. read license gate
python scripts/convert-campplus-coreml.py convert --i-have-verified-license         # 2. convert + compile
# add extraResources entry, then:
resources/SpeechHelper --dump-fbank > /tmp/swift_fbank.json                          # 3. dump Swift fbank
python scripts/convert-campplus-coreml.py check-fbank /tmp/swift_fbank.json          # 4. assert cosine ≥ 0.999
# 5. enroll on-device, calibrate τ_high≈0.70 / τ_low≈0.55
```

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert-campplus-coreml.py
==========================

OFFLINE conversion + alignment tool for the on-device speaker-embedding model used
by the single-mic speaker gate (see ../src/swift/SpeakerGate.swift,
../src/swift/AudioFeature.swift).

Target model
------------
CAM++ Chinese-English speaker verification from 3D-Speaker / ModelScope:
    iic/speech_campplus_sv_zh_en_16k-common_advanced
  - ~28 MB, 192-dim L2-normalizable embedding
  - 80-dim log-mel fbank input, 16 kHz mono
  - conv / TDNN (D-TDNN + context-aware masking) architecture — NOT RNN/attention with
    a `length` argument, so it traces and converts to CoreML cleanly (unlike SpeechBrain
    ECAPA wrappers that take a relative-`lengths` tensor and inject dynamic control flow).

Why fbank is NOT in the CoreML graph
------------------------------------
torchaudio's Kaldi-compatible fbank (`torchaudio.compliance.kaldi.fbank`) uses framing,
windowing and DC/pre-emphasis ops that do not `torch.jit.trace` into a clean, fixed CoreML
program (variable framing + Kaldi snip_edges logic). The robust path — already implemented
on the Swift side — is to compute fbank in Swift (FbankExtractor) and feed the model a
[1, T, 80] tensor. So the exported model's forward() takes fbank, NOT a raw waveform.

I/O CONTRACT (must match the Swift gate exactly — do not change these names/shapes)
-----------------------------------------------------------------------------------
  input  feature name : "fbank"      shape (1, T, 80)  float32   T in [50, 2000] (RangeDim)
  output feature name : "embedding"  shape (1, 192)    float32
The Swift gate (CamPlusSpeakerGate.embed) builds an MLMultiArray [1, T, 80] under the key
"fbank" and reads featureValue(for: "embedding"). It falls back to the model's first
input/output if those names are absent, but we fix them so the contract is explicit.

============================================================================================
REQUIREMENTS (pinned — install into a throwaway venv; these are NOT in the app env)
============================================================================================
    python>=3.9,<3.12        # coremltools wheels lag the newest CPython
    modelscope==1.18.0
    torch==2.2.2             # torch 2.2.x has the most reliable coremltools trace path
    torchaudio==2.2.2        # MUST match the torch minor version
    coremltools==8.0
    numpy>=1.24,<2.0         # coremltools 8 + torch 2.2 still expect numpy 1.x ABI
    speakerlab               # pulled in transitively by 3D-Speaker; see note below
    # 3D-Speaker "speakerlab" is the package that defines the CAM++ nn.Module. ModelScope
    # ships the config + speakerlab loader inside the snapshot; if `import speakerlab`
    # fails, `pip install git+https://github.com/modelscope/3D-Speaker.git` (Apache-2.0).

    pip install "modelscope==1.18.0" "torch==2.2.2" "torchaudio==2.2.2" \
                "coremltools==8.0" "numpy<2.0"

============================================================================================
USAGE — three INDEPENDENT subcommands (license, convert, check-fbank)
============================================================================================
  1) Read the license gate (does nothing else):
       python convert-campplus-coreml.py license

  2) Convert (download → wrap → trace → coremltools → .mlpackage → compile to .mlmodelc):
       python convert-campplus-coreml.py convert --i-have-verified-license
     Optional: --out-dir ../resources  --keep-mlpackage  --min-frames 50 --max-frames 2000

  3) Numeric fbank-alignment gate (NO model weights needed; pure torchaudio vs Swift dump):
       # First produce the Swift dump:
       #   ../resources/SpeechHelper --dump-fbank > /tmp/swift_fbank.json
       python convert-campplus-coreml.py check-fbank /tmp/swift_fbank.json

The convert step REFUSES to run without --i-have-verified-license (see WARNING below).
============================================================================================
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys

# Pinned identifiers --------------------------------------------------------------------
MODEL_ID = "iic/speech_campplus_sv_zh_en_16k-common_advanced"
INPUT_NAME = "fbank"          # MUST match SpeakerGate.swift inputName
OUTPUT_NAME = "embedding"     # MUST match SpeakerGate.swift outputName
EMBED_DIM = 192
NUM_MEL_BINS = 80
SAMPLE_RATE = 16000.0
COMPILED_NAME = "CAMPlusSpeaker.mlmodelc"   # what the Swift gate / package.json expects
DEFAULT_OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources")
)

# Fbank constants — these MUST mirror AudioFeature.swift / FbankExtractor exactly. The
# Swift side scales the [-1,1] waveform by 1<<15 before fbank (Kaldi int16 range); we feed
# torchaudio the already-scaled waveform too so the non-CMN dumps line up bit-for-bit-ish.
WAVE_SCALE = 32768.0
FRAME_LENGTH_MS = 25.0
FRAME_SHIFT_MS = 10.0
PREEMPH = 0.97


# ───────────────────────────────────────────────────────────────────────────────────────
# 1. LICENSE GATE
# ───────────────────────────────────────────────────────────────────────────────────────
LICENSE_WARNING = """\
========================================================================================
  ⚠️  WEIGHT LICENSE — READ BEFORE YOU DOWNLOAD OR CONVERT
========================================================================================
  The 3D-Speaker *toolkit / source code* (speakerlab) is Apache-2.0 — fine to ship.
  But MODEL WEIGHTS carry their own, separate license, and this is the commercial trap:

    • Many speaker-verification checkpoints in the wild are trained on VoxCeleb. VoxCeleb
      is licensed for RESEARCH / NON-COMMERCIAL use only. Shipping VoxCeleb-trained
      weights inside a commercial product (this app is a paid/BYOK product) is a
      LICENSE VIOLATION and a real legal risk.

    • The target model here —
        {model_id}
      is the 'advanced' CAM++ zh_en checkpoint, which 3D-Speaker DOCUMENTS as trained on
      a large in-house Mandarin+English corpus (NOT VoxCeleb). If that holds, it is
      commercially usable. BUT model cards drift and re-uploads happen, so:

  >>> YOU, A HUMAN, MUST open the model page on ModelScope and CONFIRM the `license`
  >>> field + the training-data statement BEFORE shipping:
  >>>     https://modelscope.cn/models/{model_id}
  >>> Verify: (a) license is a permissive/commercial one (e.g. Apache-2.0),
  >>>         (b) the training data is the in-house corpus, NOT VoxCeleb / CN-Celeb-only.

  If you cannot confirm BOTH, DO NOT SHIP these weights. The gate is designed to stay
  inert without a model (dual-channel behavior is unaffected), so shipping nothing is the
  safe default.

  By passing --i-have-verified-license you assert you have done the above check.
========================================================================================
""".format(model_id=MODEL_ID)


def cmd_license(_args):
    """Print the license warning. Pure documentation; downloads/converts nothing."""
    print(LICENSE_WARNING)
    print("This subcommand only prints the warning. To actually convert, run:")
    print("    python convert-campplus-coreml.py convert --i-have-verified-license")
    return 0


# ───────────────────────────────────────────────────────────────────────────────────────
# 2/3. FBANK REFERENCE (shared by check-fbank; mirrors FbankExtractor in AudioFeature.swift)
# ───────────────────────────────────────────────────────────────────────────────────────
def deterministic_signal(seconds=1.0, sample_rate=SAMPLE_RATE):
    """The EXACT signal FbankSelfTest.deterministicSignal() emits in Swift:
       x[n] = 0.5*sin(2π*220*t) + 0.3*sin(2π*1000*t) + 0.2*sin(2π*3500*t), t = n/16000,
       n = 0..15999. Returned as a 1-D float32 numpy array in [-1, 1]."""
    import numpy as np

    n = int(round(seconds * sample_rate))
    idx = np.arange(n, dtype=np.float64)
    t = idx / sample_rate
    x = (0.5 * np.sin(2 * math.pi * 220.0 * t)
         + 0.3 * np.sin(2 * math.pi * 1000.0 * t)
         + 0.2 * np.sin(2 * math.pi * 3500.0 * t))
    return x.astype("float32")


def reference_fbank(wav_float):
    """Compute the 80-dim log-mel fbank with torchaudio's Kaldi-compatible front-end,
    matching the Swift FbankExtractor (povey window, preemph 0.97, remove DC, energy
    floor, snip_edges) and the model's training featurizer.

    CRITICAL: CMN is NOT applied here — the Swift `--dump-fbank` selftest sets
    applyCMN=false, so we compare raw log-mel values frame-by-frame to isolate the
    front-end DSP. (The live gate DOES apply CMN — a per-dim time-mean subtraction
    layered on top, exercised in production. CMN does NOT cancel in the embedding
    cosine, so the non-CMN check validates only the DSP front-end, not the CMN path.
    Because every frame shares a large positive offset (wave*32768), raw per-frame
    cosine is too forgiving on its own — cmd_check_fbank ALSO gates on max-abs log-mel
    diff and a mean-subtracted cosine so a subtle DSP divergence can't slip through.)

    Returns a [frames, 80] float32 numpy array.
    """
    import numpy as np
    import torch
    import torchaudio.compliance.kaldi as kaldi

    # Swift scales by 1<<15 before fbank (Kaldi int16 range). Feed the same scaled signal.
    wav = torch.from_numpy(np.asarray(wav_float, dtype="float32")).unsqueeze(0) * WAVE_SCALE
    feats = kaldi.fbank(
        waveform=wav,
        num_mel_bins=NUM_MEL_BINS,
        frame_length=FRAME_LENGTH_MS,
        frame_shift=FRAME_SHIFT_MS,
        dither=0.0,                       # determinism — must be 0 to match Swift
        sample_frequency=SAMPLE_RATE,
        window_type="povey",              # Kaldi/Swift default
        remove_dc_offset=True,            # Swift subtracts per-frame mean
        preemphasis_coefficient=PREEMPH,  # 0.97, matches Swift
        use_energy=False,                 # 80 pure mel dims, no energy column
        low_freq=20.0,                    # matches FbankExtractor.makeMelWeights lowFreq
        high_freq=0.0,                    # 0.0 ⇒ Nyquist (8000 Hz) = Swift highFreq = SR/2
        # NB: no CMN flag here; torchaudio.kaldi.fbank doesn't CMN. Matches applyCMN=false.
    )
    return feats.numpy().astype("float32")


def _cosine(a, b):
    import numpy as np

    a = np.asarray(a, dtype="float64")
    b = np.asarray(b, dtype="float64")
    na = math.sqrt(float(np.dot(a, a)))
    nb = math.sqrt(float(np.dot(b, b)))
    if na < 1e-12 or nb < 1e-12:
        # Both near-zero (e.g. a silent/floored frame) → treat as perfectly aligned.
        return 1.0 if (na < 1e-12 and nb < 1e-12) else 0.0
    return float(np.dot(a, b) / (na * nb))


def cmd_check_fbank(args):
    """Numeric-alignment gate: regenerate the deterministic signal, compute the reference
    fbank with torchaudio, load the Swift `--dump-fbank` JSON, and assert per-frame cosine
    similarity >= 0.999. This is the trust gate before believing any embedding the model
    produces — if the front-end features don't line up, the embeddings are meaningless."""
    import numpy as np

    dump_path = args.dump_json
    if not os.path.isfile(dump_path):
        print("ERROR: dump JSON not found: %s" % dump_path, file=sys.stderr)
        print("Produce it first with:  ../resources/SpeechHelper --dump-fbank > %s"
              % dump_path, file=sys.stderr)
        return 2

    with open(dump_path, "r", encoding="utf-8") as fh:
        dump = json.load(fh)
    swift = np.asarray(dump["data"], dtype="float32")  # [frames, dim]
    swift_frames = int(dump.get("frames", swift.shape[0]))
    swift_dim = int(dump.get("dim", swift.shape[1] if swift.ndim == 2 else 0))
    print("Swift dump : frames=%d dim=%d  (file=%s)" % (swift_frames, swift_dim, dump_path))

    ref = reference_fbank(deterministic_signal())
    print("Reference  : frames=%d dim=%d  (torchaudio kaldi.fbank, CMN off)"
          % (ref.shape[0], ref.shape[1]))

    if swift_dim != ref.shape[1]:
        print("ERROR: dim mismatch (swift=%d ref=%d). The mel-bank config diverged."
              % (swift_dim, ref.shape[1]), file=sys.stderr)
        return 3

    # Frame counts can differ by ±1 at the edges depending on snip_edges rounding; compare
    # the overlapping prefix and warn if they differ.
    n = min(swift.shape[0], ref.shape[0])
    if swift.shape[0] != ref.shape[0]:
        print("WARNING: frame-count mismatch (swift=%d ref=%d). Comparing first %d frames; "
              "investigate the snip_edges/frame math if this is more than ±1."
              % (swift.shape[0], ref.shape[0], n))

    cosines = np.array([_cosine(swift[i], ref[i]) for i in range(n)], dtype="float64")
    min_cos = float(cosines.min())
    mean_cos = float(cosines.mean())
    worst = int(cosines.argmin())

    # Raw cosine is offset-dominated and too forgiving (a 0.97→0.95 preemph bug still
    # scores ~0.9996). Add a max-abs log-mel diff and a mean-subtracted per-frame
    # cosine, both of which expose subtle DSP divergence that raw cosine misses.
    diff = np.abs(swift[:n] - ref[:n])
    max_abs = float(diff.max())
    max_rel = float((diff / (np.abs(ref[:n]) + 1e-3)).max())
    sw_c = swift[:n] - swift[:n].mean(axis=1, keepdims=True)
    rf_c = ref[:n] - ref[:n].mean(axis=1, keepdims=True)
    ms_cos = np.array([_cosine(sw_c[i], rf_c[i]) for i in range(n)], dtype="float64")
    min_ms_cos = float(ms_cos.min())

    print("-" * 78)
    print("per-frame cosine    : min=%.6f  mean=%.6f  worst_frame=%d (cos=%.6f)"
          % (min_cos, mean_cos, worst, cosines[worst]))
    print("mean-subtracted cos : min=%.6f" % min_ms_cos)
    print("log-mel abs diff    : max_abs=%.4f  max_rel=%.4f" % (max_abs, max_rel))
    # Show the worst frame's first few dims to aid debugging if the gate trips.
    print("worst frame head — swift: %s" % np.array2string(
        swift[worst][:6], precision=4, max_line_width=120))
    print("worst frame head — ref  : %s" % np.array2string(
        ref[worst][:6], precision=4, max_line_width=120))
    print("-" * 78)

    cos_thr = 0.999
    ms_thr = 0.999
    abs_tol = 0.05  # log-mel units; ~5e-2 catches edge/preemph/window divergence
    if min_cos >= cos_thr and min_ms_cos >= ms_thr and max_abs <= abs_tol:
        print("PASS  ✅  cosine %.6f / mean-sub %.6f >= %.3f AND max-abs %.4f <= %.2f — "
              "Swift fbank aligns with the model's training featurizer. Embeddings are "
              "trustworthy." % (min_cos, min_ms_cos, cos_thr, max_abs, abs_tol))
        return 0
    print("FAIL  ❌  alignment gate failed (cosine %.6f, mean-sub %.6f, max-abs %.4f; need "
          "cosine & mean-sub >= %.3f AND max-abs <= %.2f). Do NOT trust embeddings until the "
          "Swift FbankExtractor matches the reference.\n"
          "Common causes: window_type (must be 'povey'), preemph (0.97), remove_dc_offset, "
          "wave scale (1<<15), or the mel-bank low/high freq edges."
          % (min_cos, min_ms_cos, max_abs, cos_thr, abs_tol), file=sys.stderr)
    return 1


# ───────────────────────────────────────────────────────────────────────────────────────
# 2. CONVERSION
# ───────────────────────────────────────────────────────────────────────────────────────
def _load_campplus_module(model_dir):
    """Load the CAM++ torch nn.Module from a ModelScope snapshot directory.

    3D-Speaker ships a config.yaml that names the model class + init kwargs and a
    .pt/.bin checkpoint. We instantiate via speakerlab's dynamic loader (the same path
    the ModelScope pipeline uses) so we get the *raw* nn.Module — not the pipeline
    wrapper, which would re-run fbank internally. Returns an nn.Module in eval() mode whose
    forward(fbank[B, T, 80]) -> embedding[B, 192].
    """
    import torch
    import yaml  # pyyaml ships with modelscope

    # speakerlab's dynamic importer: config 'obj' is a dotted path like
    # 'speakerlab.models.campplus.DTDNN.CAMPPlus'; 'args' are its ctor kwargs.
    from speakerlab.utils.builder import dynamic_import  # 3D-Speaker, Apache-2.0

    config_path = None
    for name in ("config.yaml", "configuration.json"):
        p = os.path.join(model_dir, name)
        if os.path.isfile(p):
            config_path = p
            break
    if config_path is None:
        raise FileNotFoundError(
            "No config.yaml/configuration.json under %s — the snapshot layout changed; "
            "open the dir and adapt _load_campplus_module()." % model_dir)

    with open(config_path, "r", encoding="utf-8") as fh:
        conf = yaml.safe_load(fh)

    # Two config shapes seen in the wild:
    #  (a) 3D-Speaker:  model: {obj: <dotted path>, args: {...}}
    #  (b) FunASR/ModelScope CAM++ "common/advanced":  model: <ClassName>  +  model_conf: {...args}
    # Handle both, and filter args by the class __init__ signature so a version-drifted
    # config key (e.g. 'output_level', which the current CAMPPlus no longer accepts)
    # doesn't crash instantiation.
    import inspect
    model_node = conf.get("model")
    if model_node is None:
        model_node = conf.get("embedding_model")
    if model_node is None:
        raise KeyError("Could not find 'model' in %s; inspect the config and adapt."
                       % config_path)
    CLASS_DOTTED = {"CAMPPlus": "speakerlab.models.campplus.DTDNN.CAMPPlus"}
    if isinstance(model_node, str):
        obj = CLASS_DOTTED.get(model_node, model_node)
        args = conf.get("model_conf", {}) or {}
    else:
        obj = model_node["obj"]
        args = model_node.get("args", {}) or {}
    model_cls = dynamic_import(obj)
    accepted = set(inspect.signature(model_cls.__init__).parameters) - {"self"}
    dropped = {k: v for k, v in args.items() if k not in accepted}
    if dropped:
        print("NOTE dropping config args not accepted by %s.__init__: %s"
              % (obj.rsplit('.', 1)[-1], dropped))
    args = {k: v for k, v in args.items() if k in accepted}
    model = model_cls(**args)

    # Find + load the checkpoint (campplus_*.bin / *.pt / pytorch_model.bin).
    ckpt = None
    for fname in sorted(os.listdir(model_dir)):
        if fname.endswith((".bin", ".pt", ".pth", ".ckpt")) and "campplus" in fname.lower():
            ckpt = os.path.join(model_dir, fname)
            break
    if ckpt is None:
        for fname in ("pytorch_model.bin", "model.pt"):
            p = os.path.join(model_dir, fname)
            if os.path.isfile(p):
                ckpt = p
                break
    if ckpt is None:
        raise FileNotFoundError("No checkpoint (.bin/.pt) found under %s." % model_dir)

    state = torch.load(ckpt, map_location="cpu")
    # Some checkpoints nest under 'state_dict' / 'model'.
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    if isinstance(state, dict) and "model" in state and isinstance(state["model"], dict):
        state = state["model"]
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print("NOTE load_state_dict missing keys (first 5): %s" % list(missing)[:5])
    if unexpected:
        print("NOTE load_state_dict unexpected keys (first 5): %s" % list(unexpected)[:5])
    model.eval()
    return model


def _make_fbank_to_embedding(torch_mod):
    """Build the trace-wrapper nn.Module class. Defined lazily (given the imported `torch`
    module) so this file imports fine for the `license` / `check-fbank` subcommands without
    torch installed.

    The wrapper pins a single fbank-in / 192-vector-out signature so the trace + CoreML I/O
    are EXACTLY the contract the Swift gate relies on. NO fbank, NO CMN, NO L2-norm here —
    the Swift side already CMNs the fbank and L2-normalizes the embedding (SpeakerGate.embed).
    Keeping the graph pure (just the network) avoids tracing non-traceable ops.
    """

    class FbankToEmbedding(torch_mod.nn.Module):
        def __init__(self, backbone):
            super().__init__()
            self.backbone = backbone

        def forward(self, fbank):  # fbank: [1, T, 80] float32 -> [1, 192]
            out = self.backbone(fbank)
            # CAM++ returns the 192-dim embedding directly; some forks return (emb, logits).
            if isinstance(out, (tuple, list)):
                out = out[0]
            return out

    return FbankToEmbedding


def cmd_convert(args):
    """Download → load CAM++ → wrap → trace → coremltools mlprogram → .mlpackage → compile
    to resources/CAMPlusSpeaker.mlmodelc. Refuses without --i-have-verified-license."""
    if not args.i_have_verified_license:
        print(LICENSE_WARNING, file=sys.stderr)
        print("REFUSING to download/convert: pass --i-have-verified-license once you have "
              "confirmed the ModelScope license + training-data fields.", file=sys.stderr)
        return 2

    # Imports are local so `license` / `check-fbank` work without torch/coremltools present.
    import numpy as np
    import torch  # noqa: F401  (also imported in helpers)
    import coremltools as ct
    from modelscope import snapshot_download

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    min_f, max_f = int(args.min_frames), int(args.max_frames)

    print("[1/5] Downloading %s via modelscope snapshot_download ..." % MODEL_ID)
    model_dir = snapshot_download(MODEL_ID)
    print("      snapshot at: %s" % model_dir)

    print("[2/5] Loading CAM++ torch module (speakerlab) ...")
    backbone = _load_campplus_module(model_dir)
    FbankToEmbedding = _make_fbank_to_embedding(torch)
    wrapper = FbankToEmbedding(backbone).eval()

    print("[3/5] Tracing on a dummy [1, 200, 80] fbank ...")
    dummy = torch.rand(1, 200, NUM_MEL_BINS, dtype=torch.float32)
    with torch.no_grad():
        emb = wrapper(dummy)
        emb_dim = int(emb.shape[-1])
        if emb_dim != EMBED_DIM:
            print("WARNING: traced embedding dim %d != expected %d. The Swift gate reads "
                  "whatever length comes out (it L2-normalizes the full vector), but the "
                  "model card says 192 — double-check you loaded the right checkpoint."
                  % (emb_dim, EMBED_DIM))
        traced = torch.jit.trace(wrapper, dummy)

    print("[4/5] coremltools convert (mlprogram, flexible T via RangeDim %d..%d) ..."
          % (min_f, max_f))
    # RangeDim lets T (number of fbank frames) vary at runtime — segments are not a fixed
    # length. CAM++ is conv/TDNN over time + statistics pooling, so a dynamic T is supported.
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(
            name=INPUT_NAME,
            shape=(1, ct.RangeDim(lower_bound=min_f, upper_bound=max_f, default=200),
                   NUM_MEL_BINS),
            dtype=np.float32,
        )],
        convert_to="mlprogram",
        compute_units=ct.ComputeUnit.ALL,   # CPU + GPU + Neural Engine
        minimum_deployment_target=ct.target.macOS14,  # matches package.json minimumSystemVersion 14.4
    )

    # Rename the single output to the contract name "embedding".
    out_spec = mlmodel._spec.description.output
    if len(out_spec) != 1:
        print("WARNING: model has %d outputs; renaming the first to '%s'."
              % (len(out_spec), OUTPUT_NAME))
    old_out = out_spec[0].name
    if old_out != OUTPUT_NAME:
        ct.utils.rename_feature(mlmodel._spec, old_out, OUTPUT_NAME, rename_outputs=True)
        # Reload so the renamed spec is the active one for save().
        mlmodel = ct.models.MLModel(mlmodel._spec, weights_dir=mlmodel.weights_dir)
    mlmodel.author = "3D-Speaker CAM++ zh_en (converted offline); verify weight license"
    mlmodel.short_description = ("CAM++ zh_en speaker embedding. input 'fbank' [1,T,80] f32, "
                                 "output 'embedding' [1,192] f32. fbank computed in Swift.")

    mlpackage_path = os.path.join(out_dir, "CAMPlusSpeaker.mlpackage")
    if os.path.isdir(mlpackage_path):
        shutil.rmtree(mlpackage_path)
    mlmodel.save(mlpackage_path)
    print("      saved .mlpackage: %s" % mlpackage_path)
    print("      I/O: input='%s' [1,%d..%d,%d]  output='%s' [1,%d]"
          % (INPUT_NAME, min_f, max_f, NUM_MEL_BINS, OUTPUT_NAME, emb_dim))

    print("[5/5] Compiling to %s with `xcrun coremlc compile` ..." % COMPILED_NAME)
    # `xcrun coremlc compile <model.mlpackage> <out-dir>` emits <out-dir>/CAMPlusSpeaker.mlmodelc
    # (the .mlmodelc name is derived from the .mlpackage basename). This is the EXACT command;
    # run it by hand if this step is skipped/fails:
    #     xcrun coremlc compile resources/CAMPlusSpeaker.mlpackage resources/
    compiled_dir = out_dir
    target_mlmodelc = os.path.join(compiled_dir, COMPILED_NAME)
    if os.path.isdir(target_mlmodelc):
        shutil.rmtree(target_mlmodelc)
    try:
        subprocess.run(
            ["xcrun", "coremlc", "compile", mlpackage_path, compiled_dir],
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print("ERROR: `xcrun coremlc compile` failed (%s). Run it manually:\n"
              "    xcrun coremlc compile %s %s" % (exc, mlpackage_path, compiled_dir),
              file=sys.stderr)
        return 4

    if not os.path.isdir(target_mlmodelc):
        # coremlc may name it after the mlpackage basename; normalize if needed.
        produced = os.path.join(compiled_dir, "CAMPlusSpeaker.mlmodelc")
        if os.path.isdir(produced) and produced != target_mlmodelc:
            shutil.move(produced, target_mlmodelc)

    print("      compiled: %s" % target_mlmodelc)

    if not args.keep_mlpackage:
        shutil.rmtree(mlpackage_path, ignore_errors=True)
        print("      removed intermediate .mlpackage (pass --keep-mlpackage to retain)")

    print("\nDONE. Next steps:")
    print("  1) Add to package.json build.extraResources:")
    print('       { "from": "resources/CAMPlusSpeaker.mlmodelc", "to": "CAMPlusSpeaker.mlmodelc" }')
    print("  2) Verify the front-end alignment (see README-speaker-model.md):")
    print("       ../resources/SpeechHelper --dump-fbank > /tmp/swift_fbank.json")
    print("       python convert-campplus-coreml.py check-fbank /tmp/swift_fbank.json")
    print("  3) Launch SpeechHelper with --gate --model <abs path to %s>, enroll, calibrate τ."
          % COMPILED_NAME)
    return 0


# ───────────────────────────────────────────────────────────────────────────────────────
# CLI
# ───────────────────────────────────────────────────────────────────────────────────────
def build_parser():
    p = argparse.ArgumentParser(
        description="Offline CAM++ → CoreML converter + fbank-alignment gate for the "
                    "single-mic speaker gate.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp_lic = sub.add_parser("license", help="Print the weight-license warning (no download).")
    sp_lic.set_defaults(func=cmd_license)

    sp_conv = sub.add_parser("convert", help="Download + convert + compile to .mlmodelc.")
    sp_conv.add_argument("--i-have-verified-license", action="store_true",
                         help="Assert you confirmed the ModelScope license + training data. "
                              "REQUIRED — convert refuses without it.")
    sp_conv.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                         help="Output dir for the .mlpackage/.mlmodelc (default: ../resources).")
    sp_conv.add_argument("--min-frames", type=int, default=50,
                         help="RangeDim lower bound for T (default 50 ≈ 0.5 s).")
    sp_conv.add_argument("--max-frames", type=int, default=2000,
                         help="RangeDim upper bound for T (default 2000 ≈ 20 s).")
    sp_conv.add_argument("--keep-mlpackage", action="store_true",
                         help="Keep the intermediate .mlpackage (default: delete after compile).")
    sp_conv.set_defaults(func=cmd_convert)

    sp_chk = sub.add_parser("check-fbank",
                            help="Assert Swift --dump-fbank matches the torchaudio reference.")
    sp_chk.add_argument("dump_json",
                        help="Path to JSON from `SpeechHelper --dump-fbank` "
                             "({frames, dim, data:[[...]]}).")
    sp_chk.set_defaults(func=cmd_check_fbank)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

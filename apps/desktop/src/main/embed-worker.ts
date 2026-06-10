// Why: e5-small embedding inference runs in an Electron utilityProcess (forked from
// embedding.ts) so the ~1-3s model load and per-query ONNX inference never block the
// main process event loop / the floating overlay UI. Communicates with the parent via
// process.parentPort newline-free structured messages.
//
// @huggingface/transformers is ESM-only and the main bundle is CJS, so it's pulled in
// with a dynamic import(). onnxruntime-node (napi-v6) loads fine here.

interface InitMsg { type: 'init'; cacheDir: string; localModelPath?: string }
interface EmbedMsg { type: 'embed'; id: number; prefix: string; texts: string[] }
type InMsg = InitMsg | EmbedMsg;

// e5 requires "query: " / "passage: " prefixes; mean pooling + L2 normalize.
const MODEL_ID = 'Xenova/multilingual-e5-small';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
let ready: Promise<void> | null = null;

async function loadModel(cfg: InitMsg): Promise<void> {
  const { pipeline, env } = await import('@huggingface/transformers');
  // Persist the downloaded model under userData so it survives restarts; if a bundled
  // model path is provided (packaged/offline), prefer it and disable remote fetch.
  env.cacheDir = cfg.cacheDir;
  if (cfg.localModelPath) {
    env.localModelPath = cfg.localModelPath;
    env.allowRemoteModels = false;
  }
  extractor = await pipeline('feature-extraction', MODEL_ID);
  // Warmup so the first real query isn't slow (graph/alloc init on first inference).
  await extractor('query: warmup', { pooling: 'mean', normalize: true });
}

function post(msg: unknown): void {
  process.parentPort.postMessage(msg);
}

process.parentPort.on('message', (e: { data: InMsg }) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = loadModel(msg)
      .then(() => post({ type: 'ready' }))
      .catch((err: unknown) => post({ type: 'init-error', error: String(err) }));
    return;
  }
  if (msg.type === 'embed') {
    const { id, prefix, texts } = msg;
    void (async () => {
      try {
        if (!ready) throw new Error('embed before init');
        await ready;
        const prefixed = texts.map((t) => `${prefix}${t}`);
        const out = await extractor(prefixed, { pooling: 'mean', normalize: true });
        // tolist() → number[][] (one 384-dim L2-normalized vector per input).
        post({ type: 'embedded', id, vectors: out.tolist() as number[][] });
      } catch (err: unknown) {
        post({ type: 'embed-error', id, error: String(err) });
      }
    })();
  }
});

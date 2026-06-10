import { utilityProcess, app, type UtilityProcess } from 'electron';
import { join } from 'node:path';

// Why: owns the e5 embedding utilityProcess (embed-worker.js). Forked once at startup
// and warmed, so the first meeting query doesn't pay model-load latency. Every embed
// call degrades to null on failure (worker crash / offline model fetch) so retrieval
// falls back to FTS5-only instead of breaking — vector search is best-effort.

type WorkerOut =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'embedded'; id: number; vectors: number[][] }
  | { type: 'embed-error'; id: number; error: string };

interface Pending { resolve: (v: number[][]) => void; reject: (e: Error) => void }

class EmbeddingService {
  private child: UtilityProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private _ready = false;
  private startedAt = 0;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  get isReady(): boolean {
    return this._ready;
  }

  start(): void {
    if (this.child) return;
    this.startedAt = performance.now();
    this.readyPromise = new Promise<void>((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    // Why: forking the worker must NEVER break app startup — if it throws (bad path,
    // sandbox), degrade to lexical-only search instead of crashing the main process.
    try {
      const workerPath = join(__dirname, 'embed-worker.js');
      this.child = utilityProcess.fork(workerPath, [], { serviceName: 'embed-worker', stdio: 'inherit' });
    } catch (e) {
      console.error('[embedding] failed to fork worker; vector search disabled:', e);
      this.readyReject?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.child.on('message', (msg: WorkerOut) => this.onMessage(msg));
    this.child.on('exit', () => {
      this._ready = false;
      // Fail any in-flight requests so callers fall back instead of hanging.
      for (const p of this.pending.values()) p.reject(new Error('embed worker exited'));
      this.pending.clear();
      this.child = null;
    });
    // Cache the downloaded model under userData so it persists across restarts.
    const cacheDir = join(app.getPath('userData'), 'transformers-cache');
    // In packaged apps the model is bundled under Resources/models/ (extraResources);
    // tell the worker to prefer it so the app works fully offline from first launch.
    const initMsg: { type: 'init'; cacheDir: string; localModelPath?: string } = { type: 'init', cacheDir };
    if (app.isPackaged) {
      initMsg.localModelPath = join(process.resourcesPath, 'models');
    }
    this.child.postMessage(initMsg);
  }

  private onMessage(msg: WorkerOut): void {
    switch (msg.type) {
      case 'ready':
        this._ready = true;
        console.warn(`[embedding] model ready + warmed in ${(performance.now() - this.startedAt).toFixed(0)}ms`);
        this.readyResolve?.();
        break;
      case 'init-error':
        this._ready = false;
        console.error('[embedding] model init failed; vector search disabled:', msg.error);
        this.readyReject?.(new Error(msg.error));
        break;
      case 'embedded':
        this.pending.get(msg.id)?.resolve(msg.vectors);
        this.pending.delete(msg.id);
        break;
      case 'embed-error':
        this.pending.get(msg.id)?.reject(new Error(msg.error));
        this.pending.delete(msg.id);
        break;
    }
  }

  private embed(prefix: string, texts: string[]): Promise<number[][]> {
    if (!this.child) return Promise.reject(new Error('embed worker not started'));
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.postMessage({ type: 'embed', id, prefix, texts });
    });
  }

  // Why: returns null (not throw) on any failure so retrieval/ingestion can degrade to
  // lexical-only without special-casing errors at every call site.
  async embedQuery(text: string): Promise<number[] | null> {
    try {
      const v = await this.embed('query: ', [text]);
      return v[0] ?? null;
    } catch {
      return null;
    }
  }

  async embedPassages(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    try {
      return await this.embed('passage: ', texts);
    } catch {
      return null;
    }
  }

  // Resolves when the model is loaded + warmed, rejects on init failure. Callers that
  // need vectors await this; ingestion uses it to know whether to embed or skip.
  whenReady(): Promise<void> {
    return this.readyPromise ?? Promise.reject(new Error('embed worker not started'));
  }

  stop(): void {
    if (this.child) {
      try { this.child.kill(); } catch { /* already gone */ }
      this.child = null;
    }
  }
}

export const embeddingService = new EmbeddingService();

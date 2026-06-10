import { ipcMain, safeStorage } from 'electron';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import type { LlmConfig, LlmProvider } from '../lib/llm.js';

const LLM_CONFIG_KEY = 'llm_config';

// v=1 (legacy): apiKey stored as plaintext JSON.
// v=2: apiKey encrypted via OS keychain (safeStorage), stored as base64.
interface StoredLlmConfig {
  v?: 1 | 2;
  provider: LlmProvider;
  model?: string;
  apiKey?: string;     // v1 only — migrated to v2 on first read
  apiKeyEnc?: string;  // v2 — base64(safeStorage.encryptString(apiKey))
}

// Why: safeStorage uses macOS Keychain / Windows DPAPI / Linux Secret Service.
// Falls back to identity when OS keychain is unavailable (headless / CI).
function encryptKey(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  return plain;
}

function decryptKey(stored: string): string | null {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      // Corrupt keychain entry — signal caller to force reconfiguration
      // rather than returning a garbled string that would cause provider 401.
      return null;
    }
  }
  return stored;
}

async function persistLlmConfig(provider: LlmProvider, apiKey: string, model?: string): Promise<void> {
  const stored: StoredLlmConfig = { v: 2, provider, apiKeyEnc: encryptKey(apiKey), model };
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ key: LLM_CONFIG_KEY, valueJson: stored as unknown, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { valueJson: stored as unknown, updatedAt: new Date() },
    });
}

async function getLlmConfigRaw(): Promise<LlmConfig | null> {
  const db = getDb();
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, LLM_CONFIG_KEY));
  if (!row) return null;

  const val = row.valueJson as StoredLlmConfig;
  if (!val.provider) return null;

  let apiKey: string;
  if (val.v === 2 && val.apiKeyEnc) {
    const decrypted = decryptKey(val.apiKeyEnc);
    if (decrypted === null) return null; // corrupt keychain entry — trigger reconfiguration
    apiKey = decrypted;
  } else if (val.apiKey) {
    // Legacy plaintext — auto-migrate to v2 on first read.
    apiKey = val.apiKey;
    await persistLlmConfig(val.provider, apiKey, val.model);
  } else {
    return null;
  }

  return { provider: val.provider, apiKey, model: val.model };
}

export interface LlmConfigPublic {
  provider: LlmProvider;
  model?: string;
  // apiKey deliberately omitted — never sent to renderer
  hasKey: boolean;
}

// Why: exported for use in cards-extract IPC without going through renderer.
export { getLlmConfigRaw as getLlmConfig };

// Why: remember the user's last-used Obsidian vault path so the import tab can
// pre-fill it; a filesystem path is non-sensitive so it's stored as plain JSON.
const OBSIDIAN_CONFIG_KEY = 'obsidian_config';
interface StoredObsidianConfig { lastVaultPath?: string }

async function persistObsidianConfig(config: StoredObsidianConfig): Promise<void> {
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ key: OBSIDIAN_CONFIG_KEY, valueJson: config as unknown, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { valueJson: config as unknown, updatedAt: new Date() },
    });
}

async function getObsidianConfigRaw(): Promise<StoredObsidianConfig | null> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, OBSIDIAN_CONFIG_KEY));
  return row ? (row.valueJson as StoredObsidianConfig) : null;
}

export interface VerifyApiKeyResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

// Why: one entry per provider keeps the verify paths in sync with PROVIDER_CONFIGS
// in llm.ts without coupling the two files at import time.
const VERIFY_ENDPOINTS: Record<LlmProvider, {
  url: string;
  headers: (key: string) => Record<string, string>;
}> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

// Why: 8 s gives slow international connections a fair chance while not
// making the UI feel frozen.
const VERIFY_TIMEOUT_MS = 8_000;

// Why: single source of truth for runtime provider validation, shared by
// set-llm-config and verify-api-key (both receive provider as an untyped string
// from the renderer).
const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'deepseek', 'qwen'];

async function verifyApiKeyOnline(provider: LlmProvider, apiKey: string): Promise<VerifyApiKeyResult> {
  const ep = VERIFY_ENDPOINTS[provider];
  if (!ep) return { ok: false, error: '未知服务商' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(ep.url, {
      method: 'GET',
      headers: ep.headers(apiKey.trim()),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    if (res.ok) return { ok: true, latencyMs };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'API Key 无效，请检查是否完整复制' };
    }
    return { ok: false, error: `服务器返回 ${res.status}，请稍后重试` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: '连接超时，请检查网络' };
    }
    return { ok: false, error: '网络错误，请检查网络连接' };
  } finally {
    clearTimeout(timer);
  }
}

export function registerSettingsIpcHandlers() {
  ipcMain.handle('settings:get-llm-config', async (): Promise<LlmConfigPublic | null> => {
    const cfg = await getLlmConfigRaw();
    if (!cfg) return null;
    return { provider: cfg.provider, model: cfg.model, hasKey: true };
  });

  ipcMain.handle('settings:set-llm-config', async (
    _event,
    provider: LlmProvider,
    apiKey: string,
    model?: string,
  ): Promise<void> => {
    // Why: provider arrives from the renderer as a plain string; validate it here
    // (defence in depth) so an unknown value can't be persisted and later blow up
    // PROVIDER_CONFIGS[provider] lookups in llm.ts with `undefined`.
    if (!VALID_PROVIDERS.includes(provider)) throw new Error('未知服务商');
    if (!apiKey.trim()) throw new Error('API Key 不能为空');
    await persistLlmConfig(provider, apiKey.trim(), model);
  });

  ipcMain.handle('settings:clear-llm-config', async (): Promise<void> => {
    await getDb().delete(appSettings).where(eq(appSettings.key, LLM_CONFIG_KEY));
  });

  ipcMain.handle(
    'settings:verify-api-key',
    async (_event, provider: string, apiKey: string): Promise<VerifyApiKeyResult> => {
      if (!VALID_PROVIDERS.includes(provider as LlmProvider)) {
        return { ok: false, error: '未知服务商' };
      }
      return verifyApiKeyOnline(provider as LlmProvider, apiKey);
    },
  );

  ipcMain.handle('settings:get-obsidian-config', async (): Promise<StoredObsidianConfig | null> => {
    return getObsidianConfigRaw();
  });

  ipcMain.handle('settings:set-obsidian-config', async (_event, config: StoredObsidianConfig): Promise<void> => {
    await persistObsidianConfig(config);
  });
}

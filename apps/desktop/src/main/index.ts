import { app, BrowserWindow, shell, nativeImage, session } from 'electron';
import { join } from 'node:path';
import { runMigrations } from './db/migrate.js';
import { registerAuthIpcHandlers } from './ipc/auth.js';
import { registerProjectIpcHandlers } from './ipc/projects.js';
import { registerMaterialIpcHandlers } from './ipc/materials.js';
import { registerCardIpcHandlers } from './ipc/cards.js';
import { registerSettingsIpcHandlers } from './ipc/settings.js';
import { registerExportIpcHandlers } from './ipc/export.js';
import { registerMeetingIpcHandlers } from './ipc/meeting.js';
import { registerLicenseIpcHandlers } from './ipc/license.js';
import { registerSurveyIpcHandlers } from './ipc/survey.js';
import { registerRetrievalIpcHandlers } from './ipc/retrieval.js';
import { embeddingService } from './lib/embedding.js';
import { backfillIndex } from './lib/search-index.js';

// Why: in dev, vite HMR requires 'unsafe-eval', which trips Electron's insecure-CSP
// warning. It is dev-only (Electron auto-hides these warnings once packaged), so silence
// the noisy console warning here; the packaged build gets a real CSP in app.whenReady.
if (process.env['ELECTRON_RENDERER_URL']) {
  process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      // Why: contextIsolation + no nodeIntegration is the Electron security baseline.
      // All Node.js access goes through the contextBridge in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  // Open external links in the system browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    if (!app.isPackaged) win.webContents.openDevTools();
  });
}

app.whenReady().then(() => {
  // Set dock icon on macOS (dev mode; packaged builds pick it up from Info.plist)
  if (process.platform === 'darwin') {
    const iconPath = join(__dirname, '../../resources/icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }

  // Why: the production renderer loads from file:// — enforce a strict Content-Security-Policy
  // (no JS eval) as defense-in-depth against injection. Dev is excluded because vite HMR needs
  // eval. 'wasm-unsafe-eval' is required by the in-renderer RNNoise WASM without re-opening eval.
  if (!process.env['ELECTRON_RENDERER_URL']) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }

  runMigrations();
  registerAuthIpcHandlers();
  registerProjectIpcHandlers();
  registerMaterialIpcHandlers();
  registerCardIpcHandlers();
  registerSettingsIpcHandlers();
  registerExportIpcHandlers();
  registerMeetingIpcHandlers();
  registerLicenseIpcHandlers();
  registerSurveyIpcHandlers();
  registerRetrievalIpcHandlers();

  // Hybrid retrieval: fork + warm the embedding worker at startup so the first
  // meeting query doesn't pay model-load latency, then backfill any card vectors
  // that are missing. Both are best-effort — failures degrade to FTS5-only search.
  embeddingService.start();
  app.on('before-quit', () => embeddingService.stop());
  void backfillIndex().catch((e) => console.error('[retrieval] backfill failed:', e));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

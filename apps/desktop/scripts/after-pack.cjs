// Why: electron-builder never codesigns binaries placed in extraResources.
// Without at least an ad-hoc signature, macOS Gatekeeper refuses to let the
// main process spawn SpeechHelper and QAMatchingOverlay even for local use.
//
// Also signs .dylib files from native Node.js addons (sqlite-vec, onnxruntime)
// that live outside the asar (auto-unpacked by smartUnpack). Without a matching
// ad-hoc signature, hardened runtime's library validation may refuse to dlopen
// them even though the main executable has disable-library-validation — the
// entitlement only relaxes signature checks, it doesn't eliminate them entirely.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const appDir = path.join(appOutDir, 'QA Matching.app');
  const resourcesDir = path.join(appDir, 'Contents', 'Resources');
  const entitlementsPath = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist');

  // Binaries placed via extraResources that need ad-hoc signing
  const extraBinaries = ['SpeechHelper', 'QAMatchingOverlay'];

  for (const binary of extraBinaries) {
    const binaryPath = path.join(resourcesDir, binary);

    if (!fs.existsSync(binaryPath)) {
      console.warn(`[after-pack] WARNING: binary not found, skipping: ${binaryPath}`);
      continue;
    }

    // Why: --sign "-" = ad-hoc signature (no developer cert required).
    // --options runtime = hardened runtime so entitlements are honoured.
    // --force = re-sign even if already signed (idempotent).
    const cmd = [
      'codesign',
      '--force',
      '--options', 'runtime',
      '--entitlements', `"${entitlementsPath}"`,
      '--sign', '"-"',
      `"${binaryPath}"`,
    ].join(' ');

    console.warn(`[after-pack] Signing: ${binary}`);
    try {
      execSync(cmd, { stdio: 'inherit' });
      console.warn(`[after-pack] Signed OK: ${binary}`);
    } catch (err) {
      console.error(`[after-pack] codesign failed for ${binary}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // Native .dylib files from node_modules that smartUnpack placed outside the
  // asar — sqlite-vec (vec0.dylib) and onnxruntime (libonnxruntime.*.dylib).
  // Sign them with the same ad-hoc identity so hardened runtime doesn't block
  // dlopen at runtime. Use simple ad-hoc signing (no entitlements, no runtime
  // options) — these are shared libraries, not executables.
  try {
    const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
    if (fs.existsSync(unpackedDir)) {
      const dylibs = findDylibs(unpackedDir);
      console.warn(`[after-pack] Found ${dylibs.length} native .dylib(s) to sign`);
      for (const dylib of dylibs) {
        const cmd = `codesign --force --sign "-" "${dylib}"`;
        try {
          execSync(cmd, { stdio: 'pipe' });
          console.warn(`[after-pack] Signed dylib: ${path.relative(appDir, dylib)}`);
        } catch (err) {
          console.error(`[after-pack] dylib sign failed (non-fatal): ${path.basename(dylib)}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } catch (err) {
    // dylib signing is best-effort — the disable-library-validation entitlement
    // already allows loading unsigned dylibs under ad-hoc signing.
    console.warn('[after-pack] dylib scan/sign skipped:', err instanceof Error ? err.message : String(err));
  }
};

function findDylibs(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) { stack.push(full); }
      else if (e.isFile() && (e.name.endsWith('.dylib') || e.name.endsWith('.so'))) { results.push(full); }
    }
  }
  return results;
}

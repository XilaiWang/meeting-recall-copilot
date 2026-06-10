// Bulk-generate license keys for testing/promo distribution.
// Usage:
//   pnpm --filter=@qa-matching/backend licenses:seed                 → 10 keys, tier=lifetime
//   pnpm --filter=@qa-matching/backend licenses:seed -- 20 trial    → 20 keys, tier=trial
//
// Writes rows to `licenses` table (status=pending, userId=null) and prints
// each key to stdout so you can paste them into Notion / Gumroad / emails.
//
// Why: keeping this in scripts/ rather than as an HTTP endpoint —
// generation is an admin action, not a user-facing flow, and exposing it
// over HTTP would mean a separate admin-auth layer we don't need yet.

import 'dotenv/config';
import { createLicense, maskLicenseKey } from '../src/services/license-service.js';

async function main() {
  // Why: `pnpm run X -- a b` can pass `--` through to the script (varies by
  // pnpm version). Strip it so `pnpm licenses:seed -- 3 trial` works the
  // same as `tsx scripts/generate-license-keys.ts 3 trial`.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const countArg = args[0] ? Number(args[0]) : 10;
  const tierArg = (args[1] ?? 'lifetime') as 'lifetime' | 'trial';

  if (!Number.isFinite(countArg) || countArg <= 0 || countArg > 1000) {
    console.error(`[seed] invalid count "${args[0]}". Expected 1-1000.`);
    process.exit(1);
  }
  if (tierArg !== 'lifetime' && tierArg !== 'trial') {
    console.error(`[seed] invalid tier "${tierArg}". Expected lifetime|trial.`);
    process.exit(1);
  }

  const batchLabel = `seed-${new Date().toISOString().slice(0, 10)}`;
  console.log(`[seed] generating ${countArg} ${tierArg} keys (notes="${batchLabel}")`);

  for (let i = 0; i < countArg; i++) {
    const license = await createLicense({ tier: tierArg, notes: batchLabel });
    // Why: print full key here because this is an admin-only stdout flow.
    // Never log full keys in server logs (per 3.5 §5.4 PII rules).
    console.log(`${license.key}    (id=${license.id}, masked=${maskLicenseKey(license.key)})`);
  }

  console.log(`[seed] done.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});

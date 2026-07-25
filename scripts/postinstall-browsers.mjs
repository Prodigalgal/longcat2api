/**
 * Install Camoufox binary + Patchright Chromium.
 * Stock Playwright is NOT used.
 * Failures are non-fatal so `npm install` still succeeds offline.
 */
import { execSync } from 'node:child_process';

function run(cmd, label) {
  console.log(`[browsers] ${label}: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
    console.log(`[browsers] ${label}: ok`);
    return true;
  } catch (e) {
    console.warn(`[browsers] ${label}: skipped/failed — ${e.message}`);
    return false;
  }
}

const skip = process.env.LONGCAT2API_SKIP_BROWSER_DOWNLOAD === '1'
  || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1';

if (skip) {
  console.log('[browsers] skip download (LONGCAT2API_SKIP_BROWSER_DOWNLOAD=1)');
  process.exit(0);
}

// Camoufox first (preferred engine)
run('npx camoufox-js fetch', 'camoufox-js fetch');
// Patchright Chromium fallback
run('npx patchright install chromium', 'patchright chromium');

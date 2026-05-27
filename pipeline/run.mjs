#!/usr/bin/env node

/**
 * PPIO 产业政策信息流 — Full Pipeline Runner
 *
 * Usage:
 *   node pipeline/run.mjs              # Run all 4 steps
 *   node pipeline/run.mjs --step 2     # Run only step 2 (curate)
 *   node pipeline/run.mjs --dry-run    # Show what would happen without executing
 *
 * Environment:
 *   PPIO_DEEPSEEK_API_KEY   — DeepSeek API key (required for AI classification)
 *   PPIO_DEEPSEEK_BASE_URL  — DeepSeek API base URL (default: https://api.deepseek.com/v1)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env file if present
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const STEPS = [
  { id: 1, name: 'fetch',       file: '01-fetch.mjs',       produces: 'data/raw-items.json' },
  { id: 2, name: 'curate',      file: '02-curate.mjs',      produces: 'data/curated-items.json',   needs: 'data/raw-items.json' },
  { id: 3, name: 'synthesize',  file: '03-synthesize.mjs',  produces: 'data/weekly-synthesis.json', needs: 'data/curated-items.json' },
  { id: 4, name: 'render',      file: '04-render.mjs',      produces: 'index.html',                  needs: 'data/curated-items.json' }
];

function run(cmd) {
  console.log(`\n  $ ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const stepArg = args.find(a => a.startsWith('--step='));
  const targetStep = stepArg ? parseInt(stepArg.split('=')[1]) : null;

  console.log('╔══════════════════════════════════════╗');
  console.log('║   PPIO 产业政策信息流 — Pipeline Runner    ║');
  console.log('╚══════════════════════════════════════╝');

  if (!process.env.PPIO_DEEPSEEK_API_KEY && !dryRun) {
    console.log('\n  ⚠ PPIO_DEEPSEEK_API_KEY not set — steps 2-3 will use rule-based fallback');
    console.log('  Set via: export PPIO_DEEPSEEK_API_KEY="your-key"');
  }
  if (!process.env.PPIO_DEEPSEEK_BASE_URL && !dryRun) {
    console.log('  ℹ PPIO_DEEPSEEK_BASE_URL not set — using default https://api.deepseek.com/v1');
  }

  const stepsToRun = targetStep
    ? STEPS.filter(s => s.id === targetStep)
    : STEPS;

  if (dryRun) {
    console.log('\n  DRY RUN — would execute:');
    stepsToRun.forEach(s => {
      const needs = s.needs ? ` (needs ${s.needs})` : '';
      console.log(`    Step ${s.id}: ${s.name} → ${s.produces}${needs}`);
    });
    return;
  }

  const startTime = Date.now();
  let allOk = true;

  for (const step of stepsToRun) {
    console.log(`\n━━━ Step ${step.id}/4: ${step.name} ━━━`);

    if (step.needs && !existsSync(resolve(ROOT, step.needs))) {
      console.log(`  ✗ Missing input: ${step.needs}. Run previous steps first.`);
      allOk = false;
      break;
    }

    const ok = run(`node "${resolve(__dirname, step.file)}"`);
    if (!ok) {
      console.log(`  ✗ Step ${step.id} failed`);
      allOk = false;
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n━━━ ${allOk ? '✓ Pipeline complete' : '✗ Pipeline failed'} (${elapsed}s) ━━━`);

  if (allOk && !targetStep) {
    console.log(`\n  Next: open index.html to view the latest Expresso`);
    console.log(`    open ${ROOT}/index.html`);
  }
}

main();


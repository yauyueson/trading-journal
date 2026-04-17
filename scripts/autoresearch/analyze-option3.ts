/**
 * Option 3 — Leaderboard analyzer.
 *
 * Run during or after the overnight loop. Summarizes the leaderboard
 * (full file with holdout metrics included) along these axes:
 *   1. Overall top-10 by combinedSharpe
 *   2. Top-10 by LOW correlation with DTE5 (useful even if Sharpe is low)
 *   3. Validated champion(s) — passes all gates
 *   4. Hit-rate of invalidity reasons (why most attempts fail)
 *
 * Writes scripts/autoresearch/option3-results.md and prints a terse stdout
 * summary. Designed to be idempotent — safe to re-run any time.
 *
 * Usage: npx tsx scripts/autoresearch/analyze-option3.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RunResult } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fullPath = path.resolve(__dirname, '../../data/leaderboard-full-option3.json');
const outPath = path.resolve(__dirname, 'option3-results.md');

if (!fs.existsSync(fullPath)) {
  console.error(`Missing ${fullPath}. Run the loop first.`);
  process.exit(1);
}

const entries: RunResult[] = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
if (entries.length === 0) {
  console.error('Empty leaderboard.');
  process.exit(1);
}

const valid = entries.filter((e) => e.isValid);
const invalidReasons: Record<string, number> = {};
for (const e of entries) {
  if (e.isValid) continue;
  if (!e.passesMinTrades) invalidReasons['min-trades'] = (invalidReasons['min-trades'] ?? 0) + 1;
  if (!e.passesMaxDD) invalidReasons['max-dd'] = (invalidReasons['max-dd'] ?? 0) + 1;
  if (!e.passesWFA) invalidReasons['wfa-sharpe'] = (invalidReasons['wfa-sharpe'] ?? 0) + 1;
  if (!e.passesHoldoutOrIR) invalidReasons['holdout-gate'] = (invalidReasons['holdout-gate'] ?? 0) + 1;
  if (!e.passesSanity) invalidReasons['sanity-bound'] = (invalidReasons['sanity-bound'] ?? 0) + 1;
  if (e.passesDeltaGates === false) invalidReasons['delta-gate'] = (invalidReasons['delta-gate'] ?? 0) + 1;
}

const byCombined = [...entries].sort((a, b) => b.combinedSharpe - a.combinedSharpe).slice(0, 10);
const byLowCorr = [...entries]
  .filter((e) => e.oosTrades >= 30)
  .sort((a, b) => Math.abs(a.correlationWithDTE5) - Math.abs(b.correlationWithDTE5))
  .slice(0, 10);
const champion = valid.length > 0
  ? valid.reduce((best, e) => (e.combinedSharpe > best.combinedSharpe ? e : best))
  : null;

function rowCombined(e: RunResult): string {
  return (
    `| ${e.strategyName.padEnd(40)} | ${e.combinedSharpe.toFixed(3).padStart(6)} | ${e.correlationWithDTE5.toFixed(3).padStart(6)} | ` +
    `${e.oosSharpe.toFixed(3).padStart(6)} | ${e.oosMaxDD.toFixed(1).padStart(5)}% | ${String(e.oosTrades).padStart(6)} | ` +
    `${e.oosSpyIR.toFixed(3).padStart(6)} | ${e.passesHoldoutOrIR ? 'PASS' : 'FAIL'} | ${e.isValid ? 'VALID' : '  no '} |`
  );
}

let md = '';
md += '# Option 3 — Autoresearch Leaderboard Summary\n\n';
md += `**Generated:** ${new Date().toISOString()}\n`;
md += `**Mission:** [program-option3.md](program-option3.md)\n`;
md += `**Total attempts:** ${entries.length}  |  **Valid:** ${valid.length}\n\n`;

if (champion) {
  md += `## Current champion\n\n`;
  md += `**${champion.strategyName}** — combined Sharpe **${champion.combinedSharpe.toFixed(3)}**\n\n`;
  md += `- Correlation with DTE5: ${champion.correlationWithDTE5.toFixed(3)}\n`;
  md += `- Standalone OOS Sharpe: ${champion.oosSharpe.toFixed(3)}  |  MaxDD: ${champion.oosMaxDD.toFixed(1)}%  |  Trades: ${champion.oosTrades}\n`;
  md += `- Holdout Sharpe: ${champion.holdoutSharpe.toFixed(3)}  |  Holdout SPY IR: ${champion.holdoutSpyIR.toFixed(3)}\n`;
  md += `- Bootstrap 95% CI: [${champion.bootstrapSharpe95CI[0].toFixed(3)}, ${champion.bootstrapSharpe95CI[1].toFixed(3)}]\n`;
  md += `- Deflated Sharpe (N=${champion.attemptNumber}): ${champion.deflatedSharpe.toFixed(3)} ${champion.deflatedSharpe > 0 ? '✓' : '✗'}\n\n`;
  md += `**Code:** [best-strategy-option3.ts](best-strategy-option3.ts)\n\n`;
} else {
  md += `## No valid strategy yet.\n\n`;
  md += `All ${entries.length} attempts failed at least one validity gate.\n\n`;
}

md += '## Top 10 by combined Sharpe\n\n';
md += '| Strategy                                 | Combd  | Corr   | StandS | MaxDD | Trades | SPY IR | Hold | Valid |\n';
md += '|------------------------------------------|--------|--------|--------|-------|--------|--------|------|-------|\n';
for (const e of byCombined) md += rowCombined(e) + '\n';

md += '\n## Top 10 by LOW correlation with DTE5 (≥30 trades)\n\n';
md += 'Useful even if standalone Sharpe is low — low correlation is the primary value driver for a complement.\n\n';
md += '| Strategy                                 | Combd  | Corr   | StandS | MaxDD | Trades | SPY IR | Hold | Valid |\n';
md += '|------------------------------------------|--------|--------|--------|-------|--------|--------|------|-------|\n';
for (const e of byLowCorr) md += rowCombined(e) + '\n';

md += '\n## Invalidity reason breakdown\n\n';
md += `${entries.length - valid.length} of ${entries.length} attempts failed. Common reasons:\n\n`;
md += '| Failure reason | Count |\n|---|---|\n';
const sortedReasons = Object.entries(invalidReasons).sort((a, b) => b[1] - a[1]);
for (const [r, c] of sortedReasons) md += `| ${r} | ${c} |\n`;

md += '\n## Raw top-10 JSON\n\n```json\n';
md += JSON.stringify(
  byCombined.map((e) => ({
    name: e.strategyName,
    combined: e.combinedSharpe,
    corr: e.correlationWithDTE5,
    oosSharpe: e.oosSharpe,
    oosMaxDD: e.oosMaxDD,
    trades: e.oosTrades,
    oosSpyIR: e.oosSpyIR,
    holdoutSharpe: e.holdoutSharpe,
    holdoutSpyIR: e.holdoutSpyIR,
    deflatedSharpe: e.deflatedSharpe,
    bootstrapCI: e.bootstrapSharpe95CI,
    passesHoldoutOrIR: e.passesHoldoutOrIR,
    passesDeltaGates: e.passesDeltaGates,
    isValid: e.isValid,
    exitTypeBreakdown: e.exitTypeBreakdown,
  })),
  null,
  2,
);
md += '\n```\n';

fs.writeFileSync(outPath, md);
console.log(`Wrote ${outPath}`);

// Terse stdout summary
console.log('');
console.log(`=== Option 3 Leaderboard (${entries.length} attempts, ${valid.length} valid) ===`);
if (champion) {
  console.log(`Champion: ${champion.strategyName}`);
  console.log(`  combined=${champion.combinedSharpe.toFixed(3)}  corr=${champion.correlationWithDTE5.toFixed(3)}  hldSh=${champion.holdoutSharpe.toFixed(3)}  hldIR=${champion.holdoutSpyIR.toFixed(3)}`);
} else {
  console.log(`No valid champion yet.`);
}
console.log('');
console.log('Top 5 by combined Sharpe:');
for (const e of byCombined.slice(0, 5)) {
  console.log(
    `  ${e.strategyName.padEnd(45)} combd=${e.combinedSharpe.toFixed(3)}  corr=${e.correlationWithDTE5.toFixed(3)}  trades=${e.oosTrades}  ${e.isValid ? 'VALID' : 'inval'}`,
  );
}
console.log('');
console.log('Top 5 by low correlation (≥30 trades):');
for (const e of byLowCorr.slice(0, 5)) {
  console.log(
    `  ${e.strategyName.padEnd(45)} corr=${e.correlationWithDTE5.toFixed(3)}  combd=${e.combinedSharpe.toFixed(3)}  trades=${e.oosTrades}  ${e.isValid ? 'VALID' : 'inval'}`,
  );
}

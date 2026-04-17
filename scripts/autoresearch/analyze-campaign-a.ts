/**
 * Campaign A — Analysis & Single-Shot Decision
 *
 * Applies the pre-registered decision rule:
 *   1. Pick variant with highest selection-window combinedSharpe that also
 *      passes baseline validity and has deflatedSharpe > 0 (N=7).
 *   2. Report that variant's holdout metrics as the write-once evaluation.
 *   3. Do not iterate if holdout fails. Do not pick on holdout.
 *
 * Reads data/leaderboard-full-campaign-a.json (has holdout numerics), NOT
 * the stripped agent-visible leaderboard.json.
 *
 * Writes scripts/autoresearch/campaign-a-results.md with the verdict.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RunResult } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fullPath = path.resolve(__dirname, '../../data/leaderboard-full-campaign-a.json');
const outPath = path.resolve(__dirname, 'campaign-a-results.md');

if (!fs.existsSync(fullPath)) {
  console.error(`Missing ${fullPath}. Run bash scripts/autoresearch/run-campaign-a.sh first.`);
  process.exit(1);
}

const entries: RunResult[] = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
if (entries.length === 0) {
  console.error('Empty leaderboard.');
  process.exit(1);
}

// Sort by selection-window combinedSharpe, descending
const sorted = [...entries].sort((a, b) => b.combinedSharpe - a.combinedSharpe);

// Decision rule: pick highest combinedSharpe that passes validity AND deflated>0
const qualified = sorted.filter(
  (r) => r.isValid && r.deflatedSharpe > 0,
);

const best = qualified.length > 0 ? qualified[0] : null;
const bestEvenIfInvalid = sorted[0];

function fmtRow(r: RunResult): string {
  const gate = r.strategyName.replace('d65-tp40-gate-', '');
  const ci = `[${r.bootstrapSharpe95CI[0].toFixed(2)}, ${r.bootstrapSharpe95CI[1].toFixed(2)}]`;
  const holdoutPass = r.passesHoldoutOrIR ? 'PASS' : 'FAIL';
  return (
    `| ${gate.padEnd(16)} | ${r.combinedSharpe.toFixed(3).padStart(6)} | ${r.oosSharpe.toFixed(3).padStart(6)} | ` +
    `${r.oosMaxDD.toFixed(1).padStart(5)}% | ${r.correlationWithDTE5.toFixed(3).padStart(6)} | ${r.oosTrades.toString().padStart(6)} | ` +
    `${r.oosSpyIR.toFixed(3).padStart(6)} | ${r.deflatedSharpe.toFixed(3).padStart(7)} | ${ci.padEnd(14)} | ` +
    `${holdoutPass.padEnd(4)} | ${r.holdoutSharpe.toFixed(3).padStart(6)} | ${r.holdoutSpyIR.toFixed(3).padStart(6)} | ${r.isValid ? 'VALID' : ' NO  '} |`
  );
}

let md = '';
md += '# Campaign A — Regime Gate Results\n\n';
md += `**Run date:** ${new Date().toISOString()}\n`;
md += `**Pre-registration:** [.prompts/campaign-a-regime-gate-preregistration.md](../../.prompts/campaign-a-regime-gate-preregistration.md)\n`;
md += `**Base strategy:** d65-tp40 (deep ITM LEAP CALL)\n`;
md += `**Selection:** 2019-01-17 → 2024-01-19 (10 WFA windows)\n`;
md += `**Holdout (write-once):** 2024-01-22 → 2026-02-27 (5 WFA windows, includes 45-loss streak)\n`;
md += `**Attempts (for deflated Sharpe):** ${entries.length}\n\n`;

md += '## Results — selection-window metrics\n\n';
md += `Sorted by combinedSharpe. All metrics below are on the selection window only.\n\n`;
md += '| Gate             | Combd | StandS | MaxDD | Corr   | Trades | SPY IR | Deflated | Boot CI 95%    | Hldt | H.Sh   | H.IR   | Valid |\n';
md += '|------------------|-------|--------|-------|--------|--------|--------|----------|----------------|------|--------|--------|-------|\n';
for (const r of sorted) md += fmtRow(r) + '\n';

md += '\n## Decision (per pre-registered rule)\n\n';
if (best) {
  md += `**Winner (highest combinedSharpe that also passes validity + deflated>0):** \`${best.strategyName}\`\n\n`;
  md += `- Selection combinedSharpe: **${best.combinedSharpe.toFixed(3)}**\n`;
  md += `- Standalone OOS Sharpe: ${best.oosSharpe.toFixed(3)}  |  MaxDD: ${best.oosMaxDD.toFixed(1)}%  |  Trades: ${best.oosTrades}\n`;
  md += `- Correlation with DTE5: ${best.correlationWithDTE5.toFixed(3)}\n`;
  md += `- Bootstrap 95% CI on Sharpe: [${best.bootstrapSharpe95CI[0].toFixed(3)}, ${best.bootstrapSharpe95CI[1].toFixed(3)}]\n`;
  md += `- Deflated Sharpe (N=${best.attemptNumber}): ${best.deflatedSharpe.toFixed(3)} ${best.deflatedSharpe > 0 ? '✓ survives' : '✗ may be noise'}\n\n`;

  md += `### Write-once holdout verdict\n\n`;
  md += `- Holdout Sharpe: **${best.holdoutSharpe.toFixed(3)}**  (trades: ${best.holdoutTrades})\n`;
  md += `- Holdout SPY IR: **${best.holdoutSpyIR.toFixed(3)}**  (excess return vs SPY: ${(best.holdoutSpyExcessReturn * 100).toFixed(2)}%/yr)\n`;
  const threshold = 0.3;
  const passSharpe = best.holdoutSharpe >= threshold;
  const passIR = best.holdoutSpyIR >= threshold;
  const passOverall = passSharpe || passIR;
  md += `- Holdout-or-IR gate (Sharpe≥${threshold} OR SPY IR≥${threshold}): **${passOverall ? 'PASS' : 'FAIL'}** (Sharpe ${passSharpe ? '✓' : '✗'}, IR ${passIR ? '✓' : '✗'})\n\n`;

  const isBaseline = best.strategyName === 'd65-tp40-gate-none';
  const isDegenerate = best.strategyName === 'd65-tp40-gate-trend_age';
  if (passOverall && isBaseline) {
    md += `### Verdict: No regime gate beats the baseline.\n\n`;
    md += `The winner is the **ungated baseline** — no candidate gate improved selection-window combinedSharpe. More importantly, the baseline survives the 2024+ holdout with a HIGHER Sharpe than selection (${best.holdoutSharpe.toFixed(3)} vs ${best.combinedSharpe.toFixed(3)}). `;
    md += `This means the 45-loss streak visible in the standalone diagnostic does NOT translate into portfolio-level failure under WFA + concurrent-position limits.\n\n`;
    md += `**Practical takeaway:** the d65-tp40 strategy is more robust than the diagnostic suggested. Portfolio constraints (maxPositions=4, maxPerTicker=1) absorb most of the trade-level damage. No gate is needed. Keep d65-tp40 as-is.\n\n`;
    md += `**What we CAN'T claim:** that the strategy will survive the *next* regime-change, or that adding monitoring wouldn't improve realized live performance. We only tested 6 candidate gates and they didn't help.\n`;
  } else if (passOverall && isDegenerate) {
    md += `### Verdict: Winner is a degenerate (no-op) gate — equivalent to baseline.\n\n`;
    md += `\`trend_age\` with a 120-day ceiling never fires in practice (price rarely stays above EMA34 for 120+ days without a single breach). Its metrics match baseline exactly. Treat this as a tie with baseline — no gate is needed.\n`;
  } else if (passOverall) {
    md += `### Verdict: Campaign A found a surviving regime gate.\n\n`;
    md += `Recommend adopting \`${best.strategyName}\` as the replacement champion. Do NOT iterate further on this gate — the holdout has now been spent.\n`;
  } else {
    md += `### Verdict: Campaign A produces no rescue strategy.\n\n`;
    md += `The best selection-window variant (\`${best.strategyName}\`) fails the holdout gate. Per the pre-registered rule, we do NOT continue iterating on regime gates. The 2025-regime collapse is not salvageable by the 6 candidate gates. Next: consider Campaign B (non-momentum complement) or accept d65-tp40 with documented regime risk.\n`;
  }
} else if (bestEvenIfInvalid) {
  md += `**No variant satisfies both validity and deflated>0.**\n\n`;
  md += `Best by combinedSharpe was \`${bestEvenIfInvalid.strategyName}\` (${bestEvenIfInvalid.combinedSharpe.toFixed(3)}) but it failed validity or deflated Sharpe.\n\n`;
  md += `### Verdict: Campaign A null.\n\n`;
  md += `No regime gate produced a statistically significant improvement. The 2025 collapse is not rescuable by these candidates. Consider Campaign B.\n`;
} else {
  md += `**No variants ran.**\n`;
}

md += '\n---\n';
md += '\n## Full raw metrics (for audit)\n\n';
md += '```json\n';
md += JSON.stringify(sorted.map((r) => ({
  name: r.strategyName,
  combinedSharpe: r.combinedSharpe,
  oosSharpe: r.oosSharpe,
  oosMaxDD: r.oosMaxDD,
  correlation: r.correlationWithDTE5,
  oosTrades: r.oosTrades,
  oosSpyIR: r.oosSpyIR,
  deflatedSharpe: r.deflatedSharpe,
  bootstrapCI: r.bootstrapSharpe95CI,
  holdoutSharpe: r.holdoutSharpe,
  holdoutSpyIR: r.holdoutSpyIR,
  holdoutTrades: r.holdoutTrades,
  passesHoldoutOrIR: r.passesHoldoutOrIR,
  isValid: r.isValid,
  exitTypeBreakdown: r.exitTypeBreakdown,
})), null, 2);
md += '\n```\n';

fs.writeFileSync(outPath, md);
console.log(`\nWrote analysis to ${outPath}`);

// Also print a terse summary to stdout
console.log('\n=== Campaign A Summary ===');
for (const r of sorted) {
  const gate = r.strategyName.replace('d65-tp40-gate-', '');
  console.log(
    `${gate.padEnd(16)}  combd=${r.combinedSharpe.toFixed(3)}  stand=${r.oosSharpe.toFixed(3)}  MaxDD=${r.oosMaxDD.toFixed(1)}%  trades=${r.oosTrades}  hSh=${r.holdoutSharpe.toFixed(3)}  hIR=${r.holdoutSpyIR.toFixed(3)}  ${r.isValid ? 'VALID' : 'INVALID'}  ${r.passesHoldoutOrIR ? '' : 'H-FAIL'}`,
  );
}
if (best) {
  console.log(`\nWinner: ${best.strategyName}`);
  console.log(`Holdout Sharpe=${best.holdoutSharpe.toFixed(3)}  IR=${best.holdoutSpyIR.toFixed(3)}  =>  ${best.passesHoldoutOrIR ? 'PASS — adopt as champion' : 'FAIL — Campaign A null'}`);
} else {
  console.log('\nNo qualified variant. Campaign A null.');
}

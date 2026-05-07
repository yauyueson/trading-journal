/**
 * WFA Run Metadata — Reproducibility envelope for unified runner results.
 */
import { execSync } from 'child_process';
import os from 'os';
import type { WFARunDataPolicy } from './wfa-data-policy';

export interface WFARunMetadata {
  version: 'unified-v1';
  profile: 'swing' | 'short';
  cliArgs: string[];
  cliCommand: string;
  gitHash: string;
  gitDirty: boolean;
  timestamp: string;
  seed: number;
  config: Record<string, unknown>;
  elapsedMs: number;
  hostname: string;
  nodeVersion: string;
  dataPolicy?: WFARunDataPolicy;
}

export function buildMetadata(opts: {
  profile: 'swing' | 'short';
  cliArgs: string[];
  seed: number;
  config: Record<string, unknown>;
  elapsedMs: number;
  dataPolicy?: WFARunDataPolicy;
}): WFARunMetadata {
  let gitHash = 'unknown';
  let gitDirty = false;
  try {
    gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch { /* not a git repo or git not available */ }

  const cliCommand = `npx tsx scripts/wfa-run-unified.ts ${opts.cliArgs.join(' ')}`;

  return {
    version: 'unified-v1',
    profile: opts.profile,
    cliArgs: opts.cliArgs,
    cliCommand,
    gitHash,
    gitDirty,
    timestamp: new Date().toISOString(),
    seed: opts.seed,
    config: opts.config,
    elapsedMs: opts.elapsedMs,
    hostname: os.hostname(),
    nodeVersion: process.version,
    dataPolicy: opts.dataPolicy,
  };
}

export function generateRunFilename(profile: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${ts}-unified-${profile}.json`;
}

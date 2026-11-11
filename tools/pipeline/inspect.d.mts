import type { AssetKind, Finding, GlbAnalysis } from './lib/glb.mjs';
import type { Ktx2Info } from './lib/ktx.mjs';

export function checkKtx2Budgets(path: string, info: Ktx2Info, bytes: number): Finding[];
export function printGlbReport(
  path: string,
  analysis: GlbAnalysis,
  kind: AssetKind | null,
  findings: Finding[],
): number;
export function inspectPath(
  target: string,
  options?: { kind?: AssetKind; quiet?: boolean },
): Promise<{
  errors: number;
  files: { file: string; type: string; bytes: number; findings: Finding[] }[];
  totals: { glb: number; ktx2: number; audio: number; other: number };
}>;

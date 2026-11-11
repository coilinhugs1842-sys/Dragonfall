import type { AssetKind, Finding, GlbAnalysis } from './lib/glb.mjs';

export interface OptimizeOptions {
  kind?: AssetKind;
  maxTextureSize?: number;
  textureMode?: 'auto' | 'uastc' | 'etc1s';
  quantizeAll?: boolean;
}
export function optimizeGlb(
  input: string,
  output: string,
  options?: OptimizeOptions,
): Promise<{
  kind: AssetKind | null;
  inputBytes: number;
  analysis: GlbAnalysis;
  textures: { name: string; slots: string[]; from: string; to: string }[];
  findings: Finding[];
}>;

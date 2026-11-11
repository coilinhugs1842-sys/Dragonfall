// Types for the tests (tests/tools); the tools themselves are plain .mjs.
export const PIPELINE_DIR: string;
export const REPO_ROOT: string;
export const BUDGETS: Record<string, number | number[]> & {
  dragonLodTriangles: number[];
  heroRockLodTriangles: number[];
  dragonMaxTextureSize: number;
  dragonMaxFileBytes: number;
  dragonMaxBones: number;
  heroRockMaxFileBytes: number;
  propMaxTriangles: number;
  propMaxFileBytes: number;
  skyPanoramaMaxFileBytes: number;
  mapMaxDownloadBytes: number;
  mapMaxAudioBytes: number;
};
export const DRAGON_ANIM_CLIPS: string[];
export const DRAGON_CLASS_IDS: string[];
export const MAP_IDS: string[];
export const TEXTURE_CAPS: Record<'dragon' | 'rock' | 'prop' | 'sky', number>;
export function isMain(metaUrl: string): boolean;
export function parseArgs(
  argv: readonly string[],
  booleans?: readonly string[],
): { positional: string[]; options: Record<string, string | true> };
export function formatBytes(bytes: number): string;
export function findKtxTool(name: string): string;
export function findFfmpeg(): string;
export function table(rows: readonly (readonly unknown[])[]): string;

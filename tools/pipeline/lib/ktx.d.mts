export interface Ktx2Info {
  width: number;
  height: number;
  levels: number;
  codec: 'ETC1S' | 'UASTC' | 'other';
  srgb: boolean;
  supercompression: string;
}
export function readPngSize(bytes: Uint8Array): { width: number; height: number };
export function readKtx2Info(bytes: Uint8Array): Ktx2Info;
export function readKtx2InfoFromFile(path: string): Ktx2Info;
export function fitTextureSize(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number };
export function chooseKtxMode(options: {
  mode?: string;
  srgb: boolean;
  normal?: boolean;
  width: number;
  height: number;
}): 'uastc' | 'etc1s';

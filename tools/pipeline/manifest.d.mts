export interface ManifestCheck {
  errors: string[];
  warnings: string[];
  dragons: string[];
  maps: string[];
  mapTotals: Record<string, { files: number; bytes: number; audioBytes: number }>;
}
export function checkManifest(assetsDir?: string): Promise<ManifestCheck>;

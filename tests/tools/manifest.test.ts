/**
 * Runs `npm run assets:check` logic on the real runtime assets, once a root manifest exists.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../tools/pipeline/lib/common.mjs';
import { checkManifest } from '../../tools/pipeline/manifest.mjs';

const ASSETS_DIR = join(REPO_ROOT, 'public', 'assets');

describe.skipIf(!existsSync(join(ASSETS_DIR, 'manifest.json')))(
  'public/assets/manifest.json',
  () => {
    it('matches the manifest contracts, references existing files and stays in budget', async () => {
      const result = await checkManifest(ASSETS_DIR);
      expect(result.errors).toEqual([]);
    }, 120_000);
  },
);

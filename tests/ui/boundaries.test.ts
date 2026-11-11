/**
 * `src/ui` is a view: it reads UiState and raises UiIntents, and reaches the rest of the game
 * only through `src/shared`. This scans the source text of every ui module for imports.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const UI = join(SRC, 'ui');
const ALLOWED_MODULES = new Set(['ui', 'shared']);

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

function specifiers(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

describe('src/ui boundaries', () => {
  const files = listSourceFiles(UI);

  it('finds the ui modules', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports only src/ui, src/shared and its own stylesheet', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        const where = `${relative(SRC, file)} -> ${specifier}`;
        if (!specifier.startsWith('.')) {
          // No packages at all: plain TS + DOM (docs/DECISIONS.md 7).
          violations.push(where);
          continue;
        }
        if (specifier.endsWith('.css')) continue;
        const target = relative(SRC, resolve(dirname(file), specifier));
        const top = target.split(sep)[0] ?? '';
        if (target.startsWith('..') || !ALLOWED_MODULES.has(top)) violations.push(where);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the view-model free of the DOM, so it stays unit-testable in node', () => {
    const dom = /(?<![.\w$])(document|window|localStorage|navigator|HTML\w*Element)\b/;
    const offenders = listSourceFiles(join(UI, 'view-model')).filter((file) =>
      dom.test(
        readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1'),
      ),
    );
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});

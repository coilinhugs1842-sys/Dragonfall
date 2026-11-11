/**
 * Writes Higgsfield prompt files to `art-source/prompts/`. Each prompt is the approved STYLE
 * FORMULA, copied byte-for-byte out of docs/ART_DIRECTION.md (never retyped), followed by the
 * subject text. Golden rule: every generation prompt embeds the formula unchanged.
 *
 *   node tools/pipeline/make-prompts.mjs            writes every prompt in PROMPTS
 *   node tools/pipeline/make-prompts.mjs --check    exits 1 if a prompt file lacks the formula
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'art-source', 'prompts');

/** The first fenced block under the "## STYLE FORMULA" heading, exactly as written. */
export function readStyleFormula() {
  const doc = readFileSync(join(ROOT, 'docs', 'ART_DIRECTION.md'), 'utf8').replace(/\r\n/g, '\n');
  const heading = doc.indexOf('## STYLE FORMULA');
  if (heading < 0) throw new Error('ART_DIRECTION.md has no "## STYLE FORMULA" heading');
  const open = doc.indexOf('```\n', heading);
  const close = doc.indexOf('\n```', open + 4);
  if (open < 0 || close < 0) throw new Error('STYLE FORMULA code block not found');
  const formula = doc.slice(open + 4, close);
  if (formula.includes('\n') || formula.length < 200) {
    throw new Error('STYLE FORMULA should be one paragraph on one line');
  }
  return formula;
}

const NO_TEXT = 'No text, no lettering, no UI, no logos, no watermark.';

/** id -> subject text. The id is the file name and the "Prompt file" column of art-source/LOG.md. */
export const PROMPTS = {
  'moodboard-aerie':
    'Scene: a cliffside dragon aerie at sunset, carved into a huge floating slate-blue stone spire above an endless sea of clouds. Two broad stone terraces face each other across a gap: the left terrace hung with molten-orange banners and lit by fire braziers, the right terrace hung with glacier-cyan banners and lit by glowing crystals. Five carved stone perches stand on each terrace, and jewel-toned dragons with small cloaked riders rest on several of them. Wide establishing shot from slightly below the terraces looking up, the sun low behind drifting clouds with long soft light shafts. ' +
    NO_TEXT,
  'moodboard-spires':
    'Scene: a wide aerial overview of a two-kilometre bowl-shaped arena made of shattered floating stone spires, broken arches and small mossy islands carrying ruined columns, with thin waterfalls pouring off the islands into an endless cloud sea below. At the centre floats a glowing sky-well crystal surrounded by a ring of floating stones. There is no ground anywhere, only clouds below. Golden-hour light from a low sun on the right, long shadows across the stone. A few tiny dragons in flight give the scale. ' +
    NO_TEXT,
  'moodboard-dragon':
    'Subject: a single emerald-green dragon in a fast banking glide, with a slim body, a long tail, narrow swept-back wings and swept-back horns. Its wing membranes glow with molten-orange accents, and a small rider in a saddle wears an orange cloak. Three-quarter front view from slightly below, against a cream and peach cloud sky, with shattered slate-blue spires small in the far background. ' +
    NO_TEXT,
  'trailer-keyart':
    'Scene: two dragons with small cloaked riders dive toward each other between shattered floating slate-blue spires above an endless cloud sea: on the left an emerald dragon with molten-orange glowing wing membranes, on the right a sapphire dragon with glacier-cyan glowing wing membranes. The low sun sits between them behind drifting clouds with long light shafts. Wide cinematic composition with clear empty sky in the upper third. ' +
    NO_TEXT,
};

function main() {
  const formula = readStyleFormula();
  if (process.argv.includes('--check')) {
    let bad = 0;
    for (const file of existsSync(OUT) ? readdirSync(OUT) : []) {
      if (!file.endsWith('.txt')) continue;
      if (!readFileSync(join(OUT, file), 'utf8').includes(formula)) {
        console.error(`missing STYLE FORMULA: art-source/prompts/${file}`);
        bad++;
      }
    }
    process.exit(bad === 0 ? 0 : 1);
  }
  mkdirSync(OUT, { recursive: true });
  for (const [id, subject] of Object.entries(PROMPTS)) {
    const file = join(OUT, `${id}.txt`);
    writeFileSync(file, `${formula} ${subject}\n`, 'utf8');
    console.log(`wrote art-source/prompts/${id}.txt`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

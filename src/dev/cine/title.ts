/**
 * `?viewer=cine:title`: a title card for the trailer, made of the game's own pieces: the live
 * sky and cloud sea (or the match map) on the canvas, and over it the title screen's wordmark in
 * the menus' own type and colours (src/ui/ui.css). The only words are the game's name and, on
 * request, one line under it.
 *   &line=<text>     a line under the wordmark (default none)
 *   &in=<seconds>    when the wordmark starts to appear (default 0.5)
 *   &out=<seconds>   when the card starts to fade away again (default never)
 *   &size=<factor>   size of the card against the title screen's wordmark (default 1.55)
 *   &bg=map          the match map behind the card (a slow push along the start of the intro
 *                    flyby) instead of the open sky
 *   &veil=0          no ink cloud behind the letters
 */
import type { PerspectiveCamera } from 'three';
import { catmullRomPoint, clamp01, smoothstep } from '../../cinematics/camera-math';
import { createVec3 } from '../../shared';
import '../../ui/ui.css';
import type { CineFrame, CineHarness } from '../cine-viewer';

const WORDMARK_IN_S = 1.1;
const RULE_AFTER_S = 0.55;
const RULE_IN_S = 0.9;
const LINE_AFTER_S = 1.15;
const LINE_IN_S = 0.8;
const OUT_S = 0.7;
/** `&bg=map`: where on the intro spline the push starts, and how much of it a second covers. */
const PUSH_FROM_U = 0.02;
const PUSH_RATE_U = 0.006;
const PUSH_LOOK_AHEAD_U = 0.45;

function numberParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key) ?? '');
  return params.has(key) && Number.isFinite(value) ? value : fallback;
}

function element(tag: string, className: string, css: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  node.style.cssText = css;
  if (text !== '') node.textContent = text;
  return node;
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const lineText = (params.get('line') ?? '').trim().slice(0, 60);
  const inAt = Math.max(numberParam(params, 'in', 0.5), 0);
  const outAt = numberParam(params, 'out', Infinity);
  const size = Math.min(Math.max(numberParam(params, 'size', 1.55), 0.5), 3);
  const overMap = params.get('bg') === 'map';

  // `dfu-root` carries the menus' palette, type and size scale; everything below is in em.
  const root = element('div', 'dfu-root', 'pointer-events:none;');
  const card = element(
    'div',
    '',
    'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);isolation:isolate;' +
      `font-size:${size}em;text-align:center;` +
      'text-shadow:0 1px 3px rgb(20 24 36 / 85%),0 0 1.4em rgb(20 24 36 / 55%);',
  );
  // The intro card's ink cloud (src/ui/hud/hud.css, `.dfh-intro::before`), centred. It comes
  // and goes with the wordmark.
  const veil = element(
    'div',
    '',
    'position:absolute;inset:-5.5em -9em -5.5em -9em;z-index:-1;opacity:0;' +
      'background:radial-gradient(ellipse closest-side,rgb(14 16 28 / 58%) 0%,' +
      'rgb(14 16 28 / 40%) 45%,rgb(14 16 28 / 0%) 100%);',
  );
  if (params.get('veil') !== '0') card.appendChild(veil);
  // The letter spacing also trails the last letter: the same again on the left keeps it centred.
  const wordmark = element(
    'h1',
    'dfu-wordmark',
    'margin:0;padding-left:0.16em;opacity:0;will-change:opacity,transform;',
    'Dragonfall',
  );
  const rule = element(
    'div',
    '',
    'width:9em;height:1px;margin:1.5em auto 1.3em;background:var(--dfu-text);opacity:0;' +
      'box-shadow:0 0 2px rgb(20 24 36 / 80%);transform:scaleX(0);',
  );
  const line = element(
    'p',
    'dfu-overline',
    'margin:0;padding-left:0.34em;font-size:1.12em;color:var(--dfu-text);opacity:0;',
    lineText,
  );
  card.append(wordmark, rule);
  if (lineText !== '') card.appendChild(line);
  root.appendChild(card);
  harness.uiRoot.appendChild(root);

  const frame: CineFrame = { kind: 'backdrop' };
  let clock = 0;
  if (overMap) {
    harness.loadMatch();
    const spline = harness.map.introSpline ?? [];
    const eye = createVec3();
    const target = createVec3();
    harness.setDirector({
      direct(camera: PerspectiveCamera): boolean {
        if (spline.length < 2) return false;
        const u = PUSH_FROM_U + clock * PUSH_RATE_U;
        catmullRomPoint(eye, spline, u);
        catmullRomPoint(target, spline, u + PUSH_LOOK_AHEAD_U);
        camera.position.set(eye.x, eye.y, eye.z);
        camera.lookAt(target.x, target.y - 30, target.z);
        camera.fov = 50;
        return true;
      },
    });
  }
  harness.setInfo(lineText === '' ? 'wordmark' : `wordmark + "${lineText}"`);

  // Styles are written only when their rounded value changes: a held card writes nothing.
  let shownWord = -1;
  let shownRule = -1;
  let shownLine = -1;
  harness.run((_dtS, timeS) => {
    clock = timeS;
    const out = 1 - smoothstep(outAt, outAt + OUT_S, timeS);
    const word = Math.round(smoothstep(inAt, inAt + WORDMARK_IN_S, timeS) * out * 500);
    if (word !== shownWord) {
      shownWord = word;
      const k = word / 500;
      wordmark.style.opacity = k.toFixed(3);
      veil.style.opacity = k.toFixed(3);
      // Settles the last few percent of its size as it appears.
      wordmark.style.transform = `scale(${(1.045 - 0.045 * clamp01(k)).toFixed(4)})`;
    }
    const ruleAt = inAt + RULE_AFTER_S;
    const ruleK = Math.round(smoothstep(ruleAt, ruleAt + RULE_IN_S, timeS) * out * 500);
    if (ruleK !== shownRule) {
      shownRule = ruleK;
      rule.style.opacity = (ruleK / 500).toFixed(3);
      rule.style.transform = `scaleX(${(ruleK / 500).toFixed(3)})`;
    }
    const lineAt = inAt + LINE_AFTER_S;
    const lineK = Math.round(smoothstep(lineAt, lineAt + LINE_IN_S, timeS) * out * 500);
    if (lineK !== shownLine) {
      shownLine = lineK;
      line.style.opacity = (lineK / 500).toFixed(3);
    }
    return frame;
  });
}

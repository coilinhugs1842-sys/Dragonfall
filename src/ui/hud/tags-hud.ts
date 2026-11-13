/**
 * The friend-or-foe markers over the dragons, drawn from `HudState.dragonTags`: the team's
 * shape in the team's colour standing over each dragon the rules mark (`dragon-tags.ts`), with a
 * team mate's name when near. An enemy's shape sits on a dark disc, so "enemy" is read from
 * the mark's outline as well as from its shape and colour.
 *
 * Cost: a fixed pool of nodes made once. Per frame a marker that moved gets two strings out of
 * ready-made tables (`translate` for x, `transform` for y, in container units of the layer: no
 * pixel size is known or read, and nothing lays out); everything else is written only on a
 * change. Unused markers are `hidden`.
 */

import { HUD_DRAGON_TAGS } from '../../shared/ui';
import type { HudState } from '../../shared/ui';
import { DataAttr, Glyph, StepStyle, TextCell, Visibility, div, span } from './cells';
import { TEAM_SHAPES } from './glyphs';
import { OPACITY_STEPS, OPACITY_STRINGS, quantizeVisible, teamKey } from './hud-model';
import { TAG_X_STRINGS, TAG_Y_STRINGS, tagPositionStep } from './tag-model';

export interface TagsHud {
  /** A full-size layer: goes under every other part of the HUD. */
  readonly layer: HTMLElement;
  update(hud: HudState): void;
}

interface TagPart {
  readonly shown: Visibility;
  readonly x: StepStyle;
  readonly y: StepStyle;
  readonly opacity: StepStyle;
  readonly team: DataAttr;
  readonly foe: DataAttr;
  readonly size: DataAttr;
  readonly icon: Glyph;
  readonly name: TextCell;
}

export function createTagsHud(): TagsHud {
  const layer = div('dfh-tags');
  layer.setAttribute('aria-hidden', 'true');
  const parts: TagPart[] = [];
  for (let i = 0; i < HUD_DRAGON_TAGS; i++) {
    const anchor = div('dfh-tag');
    const body = div('dfh-tag-in');
    // Names are remote text: only ever written through `textContent`.
    const name = span('dfh-tag-name');
    const mark = span('dfh-tag-mark');
    const icon = new Glyph('dfh-shape', TEAM_SHAPES.none, true);
    mark.appendChild(icon.svg);
    body.append(name, mark);
    anchor.appendChild(body);
    layer.appendChild(anchor);
    parts.push({
      shown: new Visibility(anchor),
      // Two properties of the one node that add up: see the tables in tag-model.ts.
      x: new StepStyle(anchor, 'translate', TAG_X_STRINGS),
      y: new StepStyle(anchor, 'transform', TAG_Y_STRINGS),
      opacity: new StepStyle(body, 'opacity', OPACITY_STRINGS),
      team: new DataAttr(body, 'team'),
      foe: new DataAttr(body, 'foe'),
      size: new DataAttr(body, 'size'),
      icon,
      name: new TextCell(name),
    });
  }

  return {
    layer,
    update(hud: HudState): void {
      const tags = hud.dragonTags;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === undefined) continue;
        const tag = tags === undefined ? undefined : tags[i];
        const step =
          tag === undefined || !tag.shown ? 0 : quantizeVisible(tag.opacity, OPACITY_STEPS);
        part.shown.set(step > 0);
        if (tag === undefined || step === 0) continue;
        part.x.set(tagPositionStep(tag.x));
        part.y.set(tagPositionStep(tag.y));
        part.opacity.set(step);
        const key = teamKey(tag.team);
        part.team.set(key);
        part.icon.set(TEAM_SHAPES[key]);
        part.foe.set(tag.foe ? '1' : '0');
        part.size.set(tag.near ? 'near' : 'far');
        part.name.set(tag.name);
      }
    },
  };
}

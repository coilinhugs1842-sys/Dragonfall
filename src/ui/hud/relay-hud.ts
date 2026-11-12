/**
 * Ember Relay's part of the HUD (T-6.3), a function of `HudState.relay`:
 *
 * - the SHARD STRIP under the score: each team's sky-shard on its own side (Ember left, Frost
 *   right, like the score), as the shard mark with the team's shape cut out, a word for its state
 *   (Home / Taken / Dropped) and who carries it or the seconds until it goes home by itself;
 * - the ANNOUNCEMENT under the compass: the latest shard event in the reader's own terms ("Your
 *   shard has been taken"), fading after a few seconds;
 * - the CARRY CALL-OUT: large and constant while the local rider carries the enemy shard, with
 *   the distance to the own brazier.
 *
 * State is told by words and shapes; colour only repeats it. Same cost contract as the rest of
 * the HUD: nodes are made once, every write goes through a write-if-changed cell, and all the
 * sentences are constants of `hud-model`.
 */

import type { TeamId } from '../../shared/constants';
import { TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { ObjectiveKind } from '../../shared/events';
import type { HudState } from '../../shared/ui';
import { DataAttr, Glyph, NumberCell, StepStyle, TextCell, Visibility, div, span } from './cells';
import { BRAZIER_SHAPE, SHARD_SHAPES } from './glyphs';
import {
  OPACITY_STRINGS,
  SHARD_STATUS_KEYS,
  SHARD_STATUS_WORDS,
  countdownSeconds,
  distanceShown,
  relayNoticeGood,
  relayNoticeStep,
  relayNoticeText,
  shardStatusIndex,
  teamKey,
} from './hud-model';

export interface RelayHud {
  /** Goes between the score header and the compass. */
  readonly strip: HTMLElement;
  /** Goes under the compass: the announcement and the carry call-out. */
  readonly callouts: HTMLElement;
  /**
   * Draws this frame. `localTeam` is null for a spectator; `text` is the HUD's 10 Hz tick for
   * numbers (seconds, metres).
   */
  update(hud: HudState, localTeam: TeamId | null, text: boolean): void;
}

interface ShardPart {
  readonly status: DataAttr;
  readonly word: TextCell;
  readonly who: TextCell;
  readonly whoShown: Visibility;
  readonly seconds: NumberCell;
  readonly secondsShown: Visibility;
  lastStatus: number;
}

const STATUS_CARRIED = 1;
const STATUS_DROPPED = 2;

export function createRelayHud(): RelayHud {
  const strip = div('dfh-relay');
  const stripShown = new Visibility(strip);
  const parts: ShardPart[] = [];
  const buildShard = (team: TeamId): HTMLElement => {
    const key = teamKey(team);
    const cell = div(`dfh-shard dfh-shard-${key}`);
    cell.dataset['team'] = key;
    const mark = new Glyph('dfh-shape', SHARD_SHAPES[key], true);
    const word = span('dfh-shard-word');
    const who = span('dfh-shard-who');
    const seconds = span('dfh-num dfh-shard-secs');
    cell.append(mark.svg, word, who, seconds);
    parts.push({
      status: new DataAttr(cell, 'status'),
      word: new TextCell(word),
      who: new TextCell(who),
      whoShown: new Visibility(who),
      seconds: new NumberCell(seconds),
      secondsShown: new Visibility(seconds),
      lastStatus: -1,
    });
    return cell;
  };
  // The gap is the clock's width, so each shard sits under its own team's score.
  strip.append(buildShard(TEAM_EMBER), div('dfh-relay-gap'), buildShard(TEAM_FROST));

  const callouts = div('dfh-relay-calls');
  const notice = div('dfh-notice');
  notice.setAttribute('role', 'status');
  const noticeShown = new Visibility(notice);
  const noticeOpacity = new StepStyle(notice, 'opacity', OPACITY_STRINGS);
  const noticeTone = new DataAttr(notice, 'tone');
  const noticeText = new TextCell(notice);

  const carry = div('dfh-carry');
  carry.setAttribute('role', 'status');
  const carryShown = new Visibility(carry);
  const carryTeam = new DataAttr(carry, 'team');
  const carryMark = new Glyph('dfh-shape dfh-carry-mark', SHARD_SHAPES.none, true);
  const carryWords = div('dfh-carry-words');
  const carryGoal = div('dfh-carry-goal');
  const carryMetres = span('dfh-num dfh-carry-dist');
  const carryDistance = new NumberCell(carryMetres);
  carryGoal.append(
    new Glyph('dfh-shape dfh-carry-brazier', BRAZIER_SHAPE, true).svg,
    span('', 'Bring it to your brazier'),
    carryMetres,
  );
  carryWords.append(div('dfh-carry-title', 'You carry the shard'), carryGoal);
  carry.append(carryMark.svg, carryWords);
  callouts.append(notice, carry);

  let shownKind: ObjectiveKind | null = null;
  let shownTeam: TeamId = TEAM_EMBER;
  let shownFor: TeamId | null = null;
  let wasCarrying = false;

  return {
    strip,
    callouts,
    update(hud: HudState, localTeam: TeamId | null, text: boolean): void {
      const relay = hud.relay;
      if (relay === null || relay === undefined) {
        stripShown.set(false);
        noticeShown.set(false);
        carryShown.set(false);
        wasCarrying = false;
        return;
      }
      stripShown.set(true);
      for (let t = 0; t < parts.length; t++) {
        const part = parts[t];
        const shard = relay.shards[t];
        if (part === undefined || shard === undefined) continue;
        const status = shardStatusIndex(shard.status);
        const changed = status !== part.lastStatus;
        if (changed) {
          part.lastStatus = status;
          part.status.set(SHARD_STATUS_KEYS[status] ?? 'home');
          part.word.set(SHARD_STATUS_WORDS[status] ?? '');
          part.whoShown.set(status === STATUS_CARRIED);
          part.secondsShown.set(status === STATUS_DROPPED);
        }
        if (status === STATUS_CARRIED) part.who.set(shard.carrierName);
        // The number appears with the word, then ticks at the HUD's text rate.
        if (status === STATUS_DROPPED && (text || changed)) {
          part.seconds.set(countdownSeconds(shard.returnInS));
        }
      }

      const kind = relay.noticeKind;
      const step = relayNoticeStep(kind, relay.noticeAgeS);
      noticeShown.set(step > 0);
      if (step > 0 && kind !== null) {
        noticeOpacity.set(step);
        if (kind !== shownKind || relay.noticeTeam !== shownTeam || localTeam !== shownFor) {
          shownKind = kind;
          shownTeam = relay.noticeTeam;
          shownFor = localTeam;
          noticeText.set(relayNoticeText(kind, relay.noticeTeam, localTeam));
          const good = relayNoticeGood(kind, relay.noticeTeam, localTeam);
          noticeTone.set(good === null ? 'plain' : good ? 'good' : 'bad');
        }
      }

      const carrying = relay.carrying && hud.phase === 'playing' && localTeam !== null;
      carryShown.set(carrying);
      if (carrying) {
        // The shard in hand is the other team's.
        const theirs = teamKey(localTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER);
        carryTeam.set(theirs);
        carryMark.set(SHARD_SHAPES[theirs]);
        if (text || !wasCarrying) carryDistance.set(distanceShown(relay.brazierDistanceM));
      }
      wasCarrying = carrying;
    },
  };
}

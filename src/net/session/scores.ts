/**
 * SCOREBOARD (`ctrl`, host -> clients): every rider's running totals, so a client's scoreboard
 * and results show what the host counted (`MatchDirector.stats`) instead of a guess rebuilt
 * from events, and a player who joins or reconnects mid-match gets the whole table at once.
 * Sent when something changed, at most once a second, and with every round / match result.
 *
 * Layout after the 3-byte header: `u8 count`, then per rider `u8 playerId`, `u8 bits`
 * (bit 0 = team, bit 1 = still in the match), `u16 takedowns`, `u16 deaths`, `u16 assists`,
 * `u16 damage` (HP, saturating), `u16 healing`, `u8 captures` (Ember Relay; 0 in other modes).
 * Ten riders are 134 bytes.
 *
 * The host's own page reads the same table: straight from the director on the main thread, as
 * the same bytes in a batch record when the host runs in a worker.
 */

import { MAX_PLAYERS, NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { MatchPlayerStats } from '../../shared';
import { capturesOf } from '../../sim/match';
import type { MatchRiderStats } from '../../sim/match';
import type { Reader, Writer } from '../codec/io';
import { DECODE_BAD_VALUE, HEADER_BYTES, MSG_SCOREBOARD } from '../protocol';

/** A rider that left keeps its row, so a long match can list more rows than seats. */
export const SCOREBOARD_MAX_ROWS = MAX_PLAYERS * 2;
export const SCOREBOARD_ENTRY_BYTES = 13;
export const SCOREBOARD_MAX_BYTES = HEADER_BYTES + 1 + SCOREBOARD_MAX_ROWS * SCOREBOARD_ENTRY_BYTES;

const BIT_TEAM = 1;
const BIT_PRESENT = 2;

/**
 * A decoded scoreboard: the first `count` rows are live. Rows are reused, never replaced. They
 * carry `captures` like the director's own rows (read it with `capturesOf`).
 */
export interface ScoreTable {
  readonly rows: MatchRiderStats[];
  count: number;
}

export function createScoreTable(): ScoreTable {
  const rows: MatchRiderStats[] = [];
  for (let i = 0; i < SCOREBOARD_MAX_ROWS; i++) {
    rows.push({
      playerId: NO_PLAYER,
      team: TEAM_EMBER,
      present: false,
      takedowns: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      healing: 0,
      captures: 0,
    });
  }
  return { rows, count: 0 };
}

function u16Of(value: number): number {
  const whole = Math.round(value);
  return whole > 0 ? (whole < 0xffff ? whole : 0xffff) : 0;
}

function u8Of(value: number): number {
  const whole = Math.round(value);
  return whole > 0 ? (whole < 0xff ? whole : 0xff) : 0;
}

/** Writes the message into `w` and returns its length. Allocation-free. */
export function encodeScoreboard(
  w: Writer,
  tick: number,
  stats: readonly Readonly<MatchPlayerStats>[],
  statsCount: number,
): number {
  const count = statsCount < SCOREBOARD_MAX_ROWS ? statsCount : SCOREBOARD_MAX_ROWS;
  w.reset();
  w.header(MSG_SCOREBOARD, tick & 0xffff);
  const countAt = HEADER_BYTES;
  w.u8(0);
  let written = 0;
  for (let i = 0; i < count; i++) {
    const row = stats[i];
    if (row === undefined) continue;
    w.u8(row.playerId);
    w.u8((row.team === TEAM_FROST ? BIT_TEAM : 0) | (row.present ? BIT_PRESENT : 0));
    w.u16(u16Of(row.takedowns));
    w.u16(u16Of(row.deaths));
    w.u16(u16Of(row.assists));
    w.u16(u16Of(row.damage));
    w.u16(u16Of(row.healing));
    w.u8(u8Of(capturesOf(row)));
    written++;
  }
  w.patchU8(countAt, written);
  return w.finish();
}

/** Reads the message into `into`. False (and `into` untouched) when it is malformed. */
export function decodeScoreboard(r: Reader, into: ScoreTable): boolean {
  r.header(MSG_SCOREBOARD, SCOREBOARD_MAX_BYTES);
  const count = r.u8();
  if (!r.ok) return false;
  if (count > SCOREBOARD_MAX_ROWS) return r.fail(DECODE_BAD_VALUE);
  if (r.remaining !== count * SCOREBOARD_ENTRY_BYTES) {
    r.skip(count * SCOREBOARD_ENTRY_BYTES);
    return r.finish();
  }
  for (let i = 0; i < count; i++) {
    const row = into.rows[i];
    if (row === undefined) {
      r.skip(SCOREBOARD_ENTRY_BYTES);
      continue;
    }
    row.playerId = r.u8();
    const bits = r.u8();
    row.team = (bits & BIT_TEAM) !== 0 ? TEAM_FROST : TEAM_EMBER;
    row.present = (bits & BIT_PRESENT) !== 0;
    row.takedowns = r.u16();
    row.deaths = r.u16();
    row.assists = r.u16();
    row.damage = r.u16();
    row.healing = r.u16();
    row.captures = r.u8();
  }
  if (!r.finish()) {
    into.count = 0;
    return false;
  }
  into.count = count;
  return true;
}

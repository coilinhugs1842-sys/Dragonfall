"""Dragonfall's music, composed in code (T-4.8). Original material: the progressions, themes and
ostinati below were written for this game.

  lobby       "Aerie at Dusk"   D major with a mixolydian turn, 66 BPM, 16 bars, loops
  match_low   "Stormwing" calm layer   D minor, 120 BPM, 24 bars, loops
  match_high  "Stormwing" battle layer  same bars, tempo and harmony, so the two cross-fade
  victory / defeat  one-shot stings

Loops are rendered with their tails wrapped round (dsp.wrap_loop), so the end rings into the
start exactly as it would on the second pass.
"""

from __future__ import annotations

import numpy as np

import instruments as ins
from dsp import SR, note_hz, norm, place, reverb, sat, secs, wrap_loop


class Mix:
    """Named stereo tracks on one timeline, with a shared hall on a send."""

    def __init__(self, length_s: float, tail_s: float = 7.0):
        self.n = secs(length_s)
        self.total = self.n + secs(tail_s)
        self.tracks: dict[str, np.ndarray] = {}

    def add(self, name: str, x: np.ndarray, t: float, gain: float = 1.0) -> None:
        if name not in self.tracks:
            self.tracks[name] = np.zeros((self.total, 2))
        place(self.tracks[name], x, t, gain)

    def render(self, levels: dict[str, tuple[float, float]], decay: float, wet: float, loop: bool,
               drive: float = 1.0) -> np.ndarray:
        dry = np.zeros((self.total, 2))
        send = np.zeros((self.total, 2))
        for name, buf in self.tracks.items():
            gain, to_hall = levels[name]
            dry += buf * gain
            send += buf * gain * to_hall
        hall = reverb(send, decay=decay, wet=1.0, seed=41, lo=180, hi=5200, predelay=0.02)
        out = np.zeros((max(len(hall), self.total), 2))
        out[: self.total] += dry
        out[: len(hall)] += (hall - np.pad(send, ((0, len(hall) - len(send)), (0, 0)))) * wet
        out = wrap_loop(out, self.n) if loop else out
        # Memoryless glue, so a loop stays exactly periodic.
        return norm(sat(norm(out, 1.0) * drive, 1.0), 0.9)


def hz(m: float) -> float:
    return note_hz(m)


# =================================================================================================
# Lobby: "Aerie at Dusk"
# =================================================================================================

LOBBY_BPM = 66.0
LOBBY_BARS = 16
# (bar, beat, beats, bass, pad voicing)
LOBBY_CHORDS = [
    (0, 0, 4, 38, [57, 62, 66, 69]),      # D
    (1, 0, 4, 37, [57, 61, 64, 69]),      # A/C#
    (2, 0, 4, 35, [59, 62, 66]),          # Bm
    (3, 0, 4, 43, [59, 62, 67]),          # G
    (4, 0, 4, 42, [57, 62, 66]),          # D/F#
    (5, 0, 4, 43, [59, 62, 67, 71]),      # G
    (6, 0, 4, 40, [55, 59, 62, 64]),      # Em7
    (7, 0, 2, 45, [57, 62, 64]),          # Asus4
    (7, 2, 2, 45, [57, 61, 64]),          # A
    (8, 0, 4, 35, [59, 62, 66, 71]),      # Bm
    (9, 0, 4, 43, [59, 62, 67]),          # G
    (10, 0, 4, 45, [57, 62, 66]),         # D/A
    (11, 0, 4, 42, [57, 61, 66]),         # F#m
    (12, 0, 4, 43, [59, 62, 67]),         # G
    (13, 0, 4, 36, [55, 60, 64, 67]),     # C  (the mixolydian colour)
    (14, 0, 2, 40, [55, 59, 62, 64]),     # Em7
    (14, 2, 2, 45, [55, 57, 62, 64]),     # A7sus
    (15, 0, 2, 38, [57, 62, 67]),         # Dsus4
    (15, 2, 2, 38, [57, 62, 66]),         # D
]
# The theme: (bar, beat, beats, midi)
LOBBY_THEME = [
    (0, 0, 2, 66), (0, 2, 1, 69), (0, 3, 1, 74),
    (1, 0, 1.5, 73), (1, 1.5, 0.5, 71), (1, 2, 2, 69),
    (2, 0, 1, 71), (2, 1, 1, 74), (2, 2, 2, 78),
    (3, 0, 1.5, 76), (3, 1.5, 0.5, 74), (3, 2, 2, 71),
    (4, 0, 2, 69), (4, 2, 1, 74), (4, 3, 1, 78),
    (5, 0, 1.5, 79), (5, 1.5, 0.5, 78), (5, 2, 2, 74),
    (6, 0, 1, 76), (6, 1, 1, 79), (6, 2, 2, 71),
    (7, 0, 2, 74), (7, 2, 2, 73),
    (8, 0, 1.5, 78), (8, 1.5, 0.5, 76), (8, 2, 1, 74), (8, 3, 1, 71),
    (9, 0, 2, 74), (9, 2, 2, 79),
    (10, 0, 1, 78), (10, 1, 1, 81), (10, 2, 1, 78), (10, 3, 1, 74),
    (11, 0, 3, 73),
    (12, 0, 1, 71), (12, 1, 1, 74), (12, 2, 2, 79),
    (13, 0, 1.5, 76), (13, 1.5, 0.5, 74), (13, 2, 2, 72),
    (14, 0, 1, 71), (14, 1, 1, 74), (14, 2, 2, 76),
    (15, 0, 4, 74),
]


def lobby(seed: int = 1101) -> np.ndarray:
    rng = np.random.default_rng(seed)
    beat = 60.0 / LOBBY_BPM
    mix = Mix(LOBBY_BARS * 4 * beat)

    def at(bar: float, b: float) -> float:
        return (bar * 4 + b) * beat

    for bar, b, beats, root, voicing in LOBBY_CHORDS:
        dur = beats * beat
        for m in voicing:
            mix.add("pad", ins.strings(hz(m), dur + 0.25, 0.42, rng, attack=0.5, release=1.0, bright=0.7), at(bar, b) - 0.12)
        mix.add("pad", ins.strings(hz(voicing[0] - 12), dur + 0.25, 0.38, rng, attack=0.5, release=1.0, bright=0.5, voices=4), at(bar, b) - 0.12)
        mix.add("bass", ins.bass(hz(root), dur, 0.55, rng), at(bar, b))
        # Harp: flowing eighths over the chord, up then down; the first phrase is sparser.
        ladder = [root + 12] + voicing + [voicing[0] + 12, voicing[1] + 12]
        steps = int(beats * 2)
        for i in range(steps):
            if bar < 4 and i % 2 == 1:
                continue
            order = [0, 1, 2, 3, 4, 3, 2, 1]
            m = ladder[order[(i + (0 if b == 0 else 4)) % 8] % len(ladder)]
            vel = 0.5 if i % 4 == 0 else 0.36
            mix.add("harp", ins.harp(hz(m), 0.8, vel * rng.uniform(0.9, 1.05), rng), at(bar, b + i * 0.5) + rng.uniform(0, 0.008))
        if bar >= 8:
            for m in voicing[-2:]:
                mix.add("choir", ins.choir(hz(m), dur, 0.35, rng, "oo", attack=0.6, release=1.2), at(bar, b) - 0.1)

    for bar, b, beats, m in LOBBY_THEME:
        dur = beats * beat
        legato = dur * 0.96
        mix.add("horn", ins.horn(hz(m - 12), legato, 0.5 if bar < 8 else 0.62, rng, players=1 if bar < 8 else 2, attack=0.07), at(bar, b))
        if 8 <= bar < 12:
            mix.add("celesta", ins.celesta(hz(m + 12), dur, 0.6, rng), at(bar, b))
        if bar >= 12:
            mix.add("violins", ins.strings(hz(m), legato, 0.4, rng, attack=0.18, release=0.5, bright=1.1, voices=5), at(bar, b))

    mix.add("timp", ins.timpani(hz(38), 0.45, rng), at(0, 0))
    mix.add("timp", ins.timpani_roll(hz(45), 2 * beat, 0.08, 0.3, rng), at(7, 2))
    mix.add("timp", ins.timpani(hz(35), 0.5, rng), at(8, 0))
    mix.add("timp", ins.timpani(hz(36), 0.35, rng), at(13, 0))
    mix.add("timp", ins.timpani(hz(38), 0.3, rng), at(15, 0))
    mix.add("cym", ins.cymbal_swell(2 * beat, 0.3, rng), at(7, 2))
    for bar, b, m in [(3, 3, 86), (5, 3.5, 90), (11, 3, 85), (11, 3.5, 90), (13, 3, 84), (15, 2.5, 93)]:
        mix.add("celesta", ins.celesta(hz(m), 1.0, 0.3, rng), at(bar, b))

    levels = {
        "pad": (0.75, 0.5), "bass": (0.8, 0.15), "harp": (0.95, 0.5), "choir": (0.55, 0.7), "horn": (1.05, 0.55),
        "celesta": (0.7, 0.7), "violins": (0.55, 0.6), "timp": (0.8, 0.5), "cym": (0.5, 0.6),
    }
    return mix.render(levels, decay=2.8, wet=0.34, loop=True, drive=1.3)


# =================================================================================================
# Match: "Stormwing" (two layers over the same 24 bars)
# =================================================================================================

MATCH_BPM = 120.0
MATCH_BARS = 24
# chord name -> (bass, triad around middle C)
CH = {
    "Dm": (38, [62, 65, 69]), "Bb": (34, [58, 62, 65]), "C": (36, [60, 64, 67]), "F": (41, [60, 65, 69]),
    "Gm": (43, [58, 62, 67]), "A": (33, [61, 64, 69]), "Asus": (33, [62, 64, 69]), "C/E": (40, [60, 64, 67]),
    "Dm/F": (41, [62, 65, 69]),
}
MATCH_BARS_CHORDS = [
    "Dm", "Dm", "Bb", "C", "Dm", "F", "Gm", "A",
    "Bb", "C", "Dm", "Dm/F", "Gm", "Bb", "Asus", "A",
    "Dm", "C/E", "F", "Gm", "Bb", "C", "A", "A",
]
MATCH_THEME = [
    (0, 0, 1.5, 62), (0, 1.5, 0.5, 64), (0, 2, 2, 65),
    (1, 0, 3, 69), (1, 3, 1, 67),
    (2, 0, 1.5, 70), (2, 1.5, 0.5, 69), (2, 2, 2, 65),
    (3, 0, 1.5, 67), (3, 1.5, 0.5, 69), (3, 2, 2, 72),
    (4, 0, 3, 74), (4, 3, 1, 72),
    (5, 0, 1.5, 69), (5, 1.5, 0.5, 72), (5, 2, 2, 77),
    (6, 0, 1, 74), (6, 1, 1, 70), (6, 2, 1, 67), (6, 3, 1, 70),
    (7, 0, 2, 69), (7, 2, 1, 73), (7, 3, 1, 76),
    (8, 0, 1.5, 77), (8, 1.5, 0.5, 74), (8, 2, 2, 70),
    (9, 0, 1.5, 76), (9, 1.5, 0.5, 72), (9, 2, 2, 67),
    (10, 0, 0.5, 65), (10, 0.5, 0.5, 69), (10, 1, 3, 74),
    (11, 0, 1, 72), (11, 1, 1, 69), (11, 2, 2, 65),
    (12, 0, 1.5, 67), (12, 1.5, 0.5, 69), (12, 2, 1, 70), (12, 3, 1, 74),
    (13, 0, 2, 77), (13, 2, 1, 74), (13, 3, 1, 70),
    (14, 0, 2, 74), (14, 2, 2, 76),
    (15, 0, 3, 73), (15, 3, 1, 69),
    (16, 0, 1.5, 74), (16, 1.5, 0.5, 76), (16, 2, 2, 77),
    (17, 0, 2, 79), (17, 2, 1, 76), (17, 3, 1, 72),
    (18, 0, 3, 81), (18, 3, 1, 79),
    (19, 0, 1, 82), (19, 1, 1, 81), (19, 2, 2, 79),
    (20, 0, 1.5, 77), (20, 1.5, 0.5, 79), (20, 2, 2, 74),
    (21, 0, 1.5, 76), (21, 1.5, 0.5, 77), (21, 2, 2, 79),
    (22, 0, 1, 76), (22, 1, 1, 73), (22, 2, 2, 69),
    (23, 0, 1, 69), (23, 1, 1, 73), (23, 2, 1, 76), (23, 3, 1, 81),
]
# Sixteenth-note accents: 3 + 3 + 2 + 3 + 3 + 2.
ACCENTS = (0, 3, 6, 8, 11, 14)
# Ostinato shape over a triad [r, t, f]: index into (r-12, f-12, r, t, f)
OSTINATO = [0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 2, 3, 2]
OSTINATO_B = [0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 2, 0, 0, 4, 3, 2]


def _match_time(bar: float, b: float) -> float:
    return (bar * 4 + b) * 60.0 / MATCH_BPM


def match_high(seed: int = 2202) -> np.ndarray:
    rng = np.random.default_rng(seed)
    beat = 60.0 / MATCH_BPM
    six = beat / 4
    mix = Mix(MATCH_BARS * 4 * beat)
    at = _match_time

    for bar, name in enumerate(MATCH_BARS_CHORDS):
        root, triad = CH[name]
        r, t3, f5 = triad[0] - 12, triad[1] - 12, triad[2] - 12
        ladder = [r - 12 if r > 50 else r, f5 - 12, r, t3, f5]
        shape = OSTINATO_B if bar % 4 == 3 or bar >= 16 else OSTINATO
        for i in range(16):
            accent = i in ACCENTS
            vel = (0.95 if accent else 0.55) * rng.uniform(0.92, 1.0)
            t = at(bar, 0) + i * six + rng.uniform(-0.003, 0.003)
            mix.add("ost", ins.spiccato(hz(ladder[shape[i]]), vel, rng), t)
            if accent or bar >= 16:
                mix.add("ost_hi", ins.spiccato(hz(ladder[shape[i]] + 12), vel * 0.8, rng, 0.13), t)
            if accent:
                mix.add("bass", ins.bass(hz(root), six * 1.6, 0.9 if i in (0, 8) else 0.7, rng, short=True), t)
        # Sustained strings above the ostinato, and the low brass floor.
        for m in triad:
            mix.add("pad", ins.strings(hz(m + 12), 4 * beat + 0.1, 0.5, rng, attack=0.12, release=0.4, bright=1.2, voices=5), at(bar, 0) - 0.04)
        mix.add("brass_lo", ins.low_brass(hz(root + 12), 4 * beat * 0.95, 0.6 if bar < 16 else 0.8, rng), at(bar, 0))
        # Drums: the big hit on one, the accents, and a fill at the end of each eight.
        mix.add("boom", ins.sub_boom(0.8 if bar % 4 == 0 else 0.5), at(bar, 0))
        for i in ACCENTS:
            strong = i in (0, 8)
            mix.add("taiko", ins.taiko(0.95 if strong else 0.6 * rng.uniform(0.85, 1.0), rng, 58 if strong else 74,
                                       0.3 if strong else 0.2), at(bar, 0) + i * six + rng.uniform(-0.004, 0.004))
        if bar % 2 == 1:
            for i in (4, 12, 13):
                mix.add("taiko", ins.taiko(0.4, rng, 96, 0.12), at(bar, 0) + i * six)
        if bar % 8 == 7:
            for i in range(8, 16):
                mix.add("taiko", ins.taiko(0.45 + 0.07 * (i - 8), rng, 70 if i % 2 else 58, 0.18), at(bar, 0) + i * six)
            mix.add("cym", ins.cymbal_swell(2 * beat, 0.75, rng), at(bar, 2))
        if bar % 4 == 0:
            mix.add("timp", ins.timpani(hz(root if root >= 36 else root + 12), 0.8, rng, 0.9), at(bar, 0))
        if bar >= 16 or 4 <= bar < 8:
            for m in triad[1:]:
                mix.add("choir", ins.choir(hz(m + 12), 4 * beat, 0.5 if bar < 16 else 0.65, rng, "ah", attack=0.15, release=0.5), at(bar, 0) - 0.03)

    mix.add("timp", ins.timpani_roll(hz(45), 4 * beat, 0.25, 0.8, rng), at(23, 0))
    for bar, b, beats, m in MATCH_THEME:
        dur = beats * beat * 0.94
        low = m - 12 if bar < 16 else m - 12
        mix.add("horn", ins.horn(hz(low), dur, 0.85 if bar < 16 else 1.0, rng, players=4, attack=0.035), at(bar, b))
        if bar >= 16:
            mix.add("horn_hi", ins.horn(hz(m), dur, 0.8, rng, players=2, attack=0.035), at(bar, b))
            mix.add("violins", ins.strings(hz(m + 12), dur, 0.55, rng, attack=0.06, release=0.3, bright=1.3, voices=5), at(bar, b))

    levels = {
        "ost": (0.9, 0.3), "ost_hi": (0.55, 0.35), "bass": (0.85, 0.1), "pad": (0.42, 0.5), "brass_lo": (0.6, 0.4),
        "boom": (0.7, 0.05), "taiko": (1.0, 0.4), "cym": (0.6, 0.6), "timp": (0.8, 0.45), "choir": (0.5, 0.7),
        "horn": (1.0, 0.5), "horn_hi": (0.7, 0.5), "violins": (0.45, 0.55),
    }
    return mix.render(levels, decay=2.2, wet=0.26, loop=True, drive=1.7)


def match_low(seed: int = 2203) -> np.ndarray:
    rng = np.random.default_rng(seed)
    beat = 60.0 / MATCH_BPM
    mix = Mix(MATCH_BARS * 4 * beat)
    at = _match_time
    theme_long = {bar: m for bar, b, beats, m in MATCH_THEME if b == 0}

    for bar, name in enumerate(MATCH_BARS_CHORDS):
        root, triad = CH[name]
        for m in triad:
            mix.add("pad", ins.strings(hz(m), 4 * beat + 0.4, 0.4, rng, attack=0.6, release=1.1, bright=0.55), at(bar, 0) - 0.15)
        mix.add("pad", ins.strings(hz(triad[0] - 12), 4 * beat + 0.4, 0.4, rng, attack=0.6, release=1.1, bright=0.45, voices=4), at(bar, 0) - 0.15)
        mix.add("bass", ins.bass(hz(root), 4 * beat, 0.5, rng), at(bar, 0))
        # A quiet pulse that keeps the battle layer's 3+3+2 alive underneath.
        ladder = [triad[0] - 12, triad[2] - 12, triad[0], triad[1], triad[2]]
        for i in ACCENTS:
            m = ladder[[0, 1, 2, 0, 1, 3][ACCENTS.index(i)]]
            mix.add("harp", ins.harp(hz(m), 0.5, 0.5 if i in (0, 8) else 0.36, rng), at(bar, 0) + i * beat / 4 + rng.uniform(0, 0.006))
        for i in (0, 6, 8, 14):
            mix.add("frame", ins.frame_drum(0.5 if i in (0, 8) else 0.3, rng), at(bar, 0) + i * beat / 4)
        if bar % 2 == 0:
            mix.add("taiko", ins.taiko(0.5, rng, 52, 0.45), at(bar, 0))
        if bar % 4 == 3:
            mix.add("taiko", ins.taiko(0.35, rng, 60, 0.3), at(bar, 3))
            mix.add("taiko", ins.taiko(0.42, rng, 56, 0.3), at(bar, 3.5))
        top = theme_long.get(bar, triad[2])
        mix.add("choir", ins.choir(hz(top), 4 * beat, 0.4, rng, "oo", voices=5, attack=0.7, release=1.2), at(bar, 0) - 0.1)
        # A lone horn answers every fourth bar with the head of the theme.
        if bar % 8 in (3, 7):
            notes = [(n_b, n_beats, m) for n_bar, n_b, n_beats, m in MATCH_THEME if n_bar == bar]
            for n_b, n_beats, m in notes:
                mix.add("horn", ins.horn(hz(m - 12), n_beats * beat * 0.95, 0.42, rng, players=1, attack=0.08), at(bar, n_b))
    mix.add("cym", ins.cymbal_swell(3 * beat, 0.22, rng, crash=False), at(23, 1))

    levels = {
        "pad": (0.8, 0.5), "bass": (0.8, 0.15), "harp": (0.75, 0.5), "frame": (0.55, 0.5), "taiko": (0.7, 0.7),
        "choir": (0.5, 0.8), "horn": (0.7, 0.8), "cym": (0.4, 0.6),
    }
    return mix.render(levels, decay=2.8, wet=0.36, loop=True, drive=1.2)


# =================================================================================================
# Stings
# =================================================================================================


def victory(seed: int = 3301) -> np.ndarray:
    rng = np.random.default_rng(seed)
    beat = 60.0 / 126.0
    mix = Mix(6.2, tail_s=0.1)
    t0 = 0.05
    # Call: A D F# E F# | A (held) over G(add9) -> D.
    call = [(0, 0.5, 69), (0.5, 0.5, 74), (1, 1, 78), (2, 0.5, 76), (2.5, 0.5, 78), (3, 5.5, 81)]
    for b, beats, m in call:
        mix.add("horn", ins.horn(hz(m - 12), beats * beat * 0.95, 1.0, rng, players=4, attack=0.03), t0 + b * beat)
        mix.add("horn", ins.horn(hz(m), beats * beat * 0.95, 0.75, rng, players=2, attack=0.03), t0 + b * beat)
    for b, beats, root, tones in [(0, 3, 38, [57, 62, 66]), (3, 1.5, 43, [59, 62, 67, 69]), (4.5, 4, 38, [62, 66, 69, 74])]:
        dur = beats * beat
        for m in tones:
            mix.add("pad", ins.strings(hz(m + 12), dur, 0.7, rng, attack=0.05, release=0.9, bright=1.3), t0 + b * beat)
            mix.add("brass", ins.low_brass(hz(m - 12), dur, 0.8, rng), t0 + b * beat)
        mix.add("bass", ins.bass(hz(root), dur, 0.9, rng), t0 + b * beat)
        mix.add("timp", ins.timpani(hz(root if root > 40 else root + 12), 0.9, rng), t0 + b * beat)
    for m in [74, 78, 81]:
        mix.add("choir", ins.choir(hz(m), 3.5 * beat, 0.7, rng, "ah", attack=0.1, release=1.2), t0 + 4.5 * beat)
    mix.add("taiko", ins.taiko(1.0, rng, 56, 0.4), t0)
    mix.add("taiko", ins.taiko(0.9, rng, 56, 0.4), t0 + 3 * beat)
    mix.add("taiko", ins.taiko(1.0, rng, 52, 0.5), t0 + 4.5 * beat)
    mix.add("boom", ins.sub_boom(0.9), t0 + 4.5 * beat)
    mix.add("cym", ins.cymbal_swell(1.5 * beat, 0.9, rng), t0 + 3 * beat)
    mix.add("timp", ins.timpani_roll(hz(50), 3.0 * beat, 0.5, 0.2, rng), t0 + 4.5 * beat)
    for i, m in enumerate([86, 90, 93, 98]):
        mix.add("bell", ins.celesta(hz(m), 1.5, 0.5, rng), t0 + (4.5 + i * 0.25) * beat)
    levels = {"horn": (1.0, 0.5), "pad": (0.5, 0.5), "brass": (0.5, 0.4), "bass": (0.8, 0.1), "timp": (0.8, 0.5),
              "choir": (0.5, 0.7), "taiko": (0.9, 0.4), "boom": (0.7, 0.0), "cym": (0.6, 0.6), "bell": (0.6, 0.7)}
    return mix.render(levels, decay=2.4, wet=0.3, loop=False, drive=1.6)


def defeat(seed: int = 3302) -> np.ndarray:
    rng = np.random.default_rng(seed)
    beat = 60.0 / 60.0
    mix = Mix(6.0, tail_s=0.1)
    t0 = 0.05
    line = [(0, 1, 69), (1, 1, 65), (2, 1, 64), (3, 2.6, 62)]
    for b, beats, m in line:
        mix.add("horn", ins.horn(hz(m - 12), beats * beat * 0.97, 0.55, rng, players=3, attack=0.09, release=0.5), t0 + b * beat)
    for b, beats, root, tones in [(0, 1, 38, [57, 62, 65]), (1, 1, 34, [58, 62, 65]), (2, 1, 43, [58, 62, 64]),
                                  (3, 2.6, 26, [50, 57, 62, 64])]:
        dur = beats * beat
        for m in tones:
            mix.add("pad", ins.strings(hz(m), dur, 0.5, rng, attack=0.3, release=1.4, bright=0.5), t0 + b * beat - 0.05)
        mix.add("bass", ins.bass(hz(root), dur, 0.8, rng), t0 + b * beat)
    mix.add("choir", ins.choir(hz(62), 2.4, 0.4, rng, "oo", attack=0.5, release=1.6), t0 + 3 * beat)
    mix.add("choir", ins.choir(hz(57), 2.4, 0.4, rng, "oo", attack=0.5, release=1.6), t0 + 3 * beat)
    mix.add("taiko", ins.taiko(0.9, rng, 48, 0.6), t0)
    mix.add("taiko", ins.taiko(0.7, rng, 46, 0.7), t0 + 3 * beat)
    mix.add("boom", ins.sub_boom(0.8, 50, 26, 1.2), t0 + 3 * beat)
    mix.add("bell", ins.bell(hz(50), 3.0, 0.5, rng), t0 + 3 * beat)
    levels = {"horn": (1.0, 0.7), "pad": (0.7, 0.6), "bass": (0.8, 0.2), "choir": (0.5, 0.8), "taiko": (0.9, 0.7),
              "boom": (0.7, 0.0), "bell": (0.5, 0.8)}
    return mix.render(levels, decay=3.0, wet=0.4, loop=False, drive=1.2)


TRACKS = {
    "lobby": (lobby, LOBBY_BPM, LOBBY_BARS),
    "matchLow": (match_low, MATCH_BPM, MATCH_BARS),
    "matchHigh": (match_high, MATCH_BPM, MATCH_BARS),
}

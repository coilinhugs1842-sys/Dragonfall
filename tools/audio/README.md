# tools/audio: Dragonfall's sound, synthesised offline (T-4.8)

Every sound effect, ambience bed and piece of music in the game is rendered by these scripts.
No samples, no downloads, no generated audio: numpy and scipy only, with fixed seeds, so a build
gives the same audio every time.

```
python tools/audio/build.py                      # render, encode, measure, write the manifest
python tools/audio/build.py --only fireBolt,lobby  # re-render just these ids
python tools/audio/build.py --no-render          # re-encode and re-measure the rendered WAVs
```

Needs Python 3 with numpy and scipy, `ffmpeg` on PATH and node (for `tools/pipeline/audio.mjs`).
A full build takes about a minute and a half.

| File | What it is |
| --- | --- |
| `dsp.py` | Primitives: tilted noise, band-limited oscillators, FM, swept filters, granular clouds, crackle, convolution reverb with synthetic impulses, loop helpers, the tone balancer |
| `instruments.py` | Strings, spiccato strings, horns, low brass, choir (vowel formants), harp, celesta, bell, taiko, frame drum, timpani, cymbal swell, bass |
| `sfx.py` | One function per sound id (flight, the four classes' abilities, roars, impacts, feedback, interface) and the three ambience beds; the registry at the bottom sets variations and loop lengths |
| `music.py` | The compositions: lobby theme, the two match layers (same 24 bars, same tempo and harmony), victory and defeat stings |
| `build.py` | The pipeline and its checks |

## What the build does

1. **Render** each file to float WAV in `art-source/_scratch/audio-wav/` (git-ignored).
2. **Tone balance** (`dsp.balance`): a static four-band level trim so no sound is mostly sub-bass.
   The target is small laptop speakers: by default at most 18 % of a sound's energy may sit below
   90 Hz and 36 % between 90 and 300 Hz, and at least 5 % above 2.5 kHz. Heavy sounds (blast,
   thunder, Bastion's roar) get more room; see `BALANCE` in `sfx.py`.
3. **Loops** get 0.25 s (SFX) or 0.5 s (music, ambience) of pre- and post-roll copied from the
   other side of the seam, so the lossy codec sees continuous audio through both loop points. The
   manifest carries the loop points; the runtime sets `loopStart` / `loopEnd`.
4. **Encode** with `tools/pipeline/audio.mjs`: Ogg Vorbis, SFX at -1 dBTP, music at -16 LUFS
   (the calm match layer at -18), ambience at -23 LUFS. Positional sounds are mono; interface,
   feedback, own-flight loops, ambience and music are stereo.
5. **Measure the shipped `.ogg`** (decoded again with ffmpeg): peak, true peak, LUFS, crest factor,
   DC offset, clipped samples, spectral centroid, and for loops the step across the seam against
   the file's ordinary sample-to-sample steps, plus a check that the decode lines up with the
   source. A failed check exits non-zero.
6. **Write** `public/assets/audio/manifest.json` and `art-source/audio-raw/report.json`.

## Manifest

```json
{
  "version": 1,
  "sounds": { "<SoundId>": { "files": ["sfx/x_1.ogg", "..."], "gain": 0.62, "loop": null } },
  "music": { "lobby|matchLow|matchHigh": { "file": "music/x.ogg", "gain": 0.8, "loop": { "startS": 0.5, "endS": 48.5 } } },
  "ambience": { "aerie|windBed|thunder": { "file": "ambience/x.ogg", "gain": 0.9, "loop": { } } },
  "totalBytes": 0
}
```

- Sound ids are the `SoundId`s of `src/audio/sounds.ts`. An id missing here keeps its procedural
  fallback in the game; an id unknown to the game is ignored.
- `gain` for a sound is computed from the encoded file: it brings the loudest 100 ms (the whole
  file for a loop) to -18 dBFS RMS, so `SoundDef.gain` in the game means the same loudness for
  every sound.
- A new variation count or a new sound: edit the `SFX` registry in `sfx.py`, add the id to
  `sounds.ts` (with a fallback generator) and rebuild.

Nobody has listened to these on speakers as part of the build: the checks above catch silence,
clipping, DC, wrong loop points and bass-only sounds, not taste.

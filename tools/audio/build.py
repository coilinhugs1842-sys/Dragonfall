"""Renders, encodes, checks and lists every Dragonfall sound (T-4.8).

    python tools/audio/build.py                 # everything
    python tools/audio/build.py --only fireBolt,lobby   # just these ids (the manifest keeps the rest)
    python tools/audio/build.py --no-render     # re-encode / re-measure the wavs already rendered

Steps: synthesise to float WAV in art-source/_scratch/audio-wav (git-ignored) -> encode with
tools/pipeline/audio.mjs (Ogg Vorbis; SFX peak -1 dBTP, music -16 LUFS, ambience -23 LUFS) ->
decode the .ogg again and measure what actually ships (peak, crest, DC, clipping, spectral
centroid, loop seam) -> write public/assets/audio/manifest.json and
art-source/audio-raw/report.json. Exits non-zero when a check fails.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

import numpy as np
from scipy.io import wavfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))

from dsp import SR, balance, dc, fade, hp, mono, norm, pad_loop, secs, trim_tail  # noqa: E402

WAV_DIR = REPO / "art-source" / "_scratch" / "audio-wav"
OUT_DIR = REPO / "public" / "assets" / "audio"
REPORT = REPO / "art-source" / "audio-raw" / "report.json"
ENCODER = REPO / "tools" / "pipeline" / "audio.mjs"

SFX_LOOP_PAD_S = 0.25
LONG_LOOP_PAD_S = 0.5
# A sound whose loudest 100 ms sits at this level plays at SoundDef.gain = 1.
SFX_REFERENCE_DB = -18.0
MUSIC_LUFS = {"lobby": -16.0, "matchLow": -18.0, "matchHigh": -16.0}
MUSIC_GAIN = 0.8
AMBIENCE_GAIN = {"windBed": 0.8, "thunder": 1.0, "aerie": 0.9}
TOTAL_BUDGET_BYTES = 15 * 1024 * 1024


def seed_of(name: str, v: int) -> int:
    return zlib.crc32(f"dragonfall:{name}:{v}".encode())


# --- render (worker processes) -----------------------------------------------------------------


def render_unit(unit: dict) -> dict:
    """Renders one file's worth of audio to WAV. Runs in a worker process."""
    import music
    import sfx

    kind, name, v = unit["kind"], unit["id"], unit["v"]
    rng = np.random.default_rng(seed_of(name, v))
    loop_s = None
    if kind == "sfx":
        fn, _, loop_s = sfx.SFX[name]
        x = fn(rng, v)
    elif kind == "ambience":
        fn, loop_s = sfx.AMBIENCE[name]
        x = fn(rng, v)
    elif kind == "music":
        fn, bpm, bars = music.TRACKS[name]
        x = fn()
        loop_s = bars * 4 * 60.0 / bpm
    else:  # sting
        x = {"victory": music.victory, "defeat": music.defeat}[name]()
    x = np.asarray(x, dtype=np.float64)
    target = sfx.BALANCE.get(name, (0.35, 0.45, 0.0) if (kind, name) == ("ambience", "thunder") else sfx.BALANCE_DEFAULT)
    x, tone = balance(dc(x) if loop_s is not None else hp(x, 30.0), *target, periodic=loop_s is not None)
    loop = None
    if loop_s is not None:
        n_loop = secs(loop_s)
        if len(x) != n_loop:
            raise RuntimeError(f"{name}: loop rendered {len(x)} samples, expected {n_loop}")
        x = norm(dc(x), 0.9)
        pad = secs(SFX_LOOP_PAD_S if kind == "sfx" else LONG_LOOP_PAD_S)
        x = pad_loop(x, pad)
        loop = {"startS": pad / SR, "endS": (pad + n_loop) / SR}
    else:
        # A one-shot's DC is filtered out, not subtracted: subtracting would leave a step in its tail.
        x = norm(fade(trim_tail(hp(x, 22.0)), 0.001, 0.03), 0.9)
    path = Path(unit["wav"])
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(path, SR, x.astype(np.float32))
    return {**unit, "loop": loop, "samples": int(len(x)), "channels": 1 if x.ndim == 1 else 2, "tone": tone}


# --- encode and measure (threads around ffmpeg) -------------------------------------------------


def encode(unit: dict) -> None:
    args = ["node", str(ENCODER), unit["wav"], unit["ogg"], "--kind", unit["encode_kind"]]
    if unit["channels"] == 1:
        args.append("--mono")
    if unit.get("lufs") is not None:
        args += ["--lufs", str(unit["lufs"])]
    done = subprocess.run(args, capture_output=True, text=True, cwd=REPO)
    if done.returncode != 0:
        raise RuntimeError(f"encode failed for {unit['id']}: {done.stderr.strip() or done.stdout.strip()}")


def decode(path: str, channels: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", str(channels), "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    data = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return data.reshape(-1, channels) if channels == 2 else data


def loudness(path: str) -> dict:
    err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af",
                          "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    data = json.loads(err[err.rindex("{"): err.rindex("}") + 1])

    def num(key: str) -> float | None:
        value = float(data[key])
        return value if np.isfinite(value) else None

    return {"lufs": num("input_i"), "truePeakDb": num("input_tp")}


def window_rms_db(x: np.ndarray, window_s: float = 0.1) -> float:
    m = mono(x)
    w = min(len(m), secs(window_s))
    energy = np.convolve(m * m, np.ones(w) / w, mode="valid")
    return float(10 * np.log10(max(energy.max(), 1e-12)))


def analyse(unit: dict) -> dict:
    """Measures the shipped .ogg (decoded again), so the numbers describe what the game plays."""
    x = decode(unit["ogg"], unit["channels"])
    m = mono(x)
    pk = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(m * m)))
    spec = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    freqs = np.fft.rfftfreq(len(m), 1 / SR)
    centroid = float(np.sum(freqs * spec) / max(np.sum(spec), 1e-12))
    out = {
        "id": unit["id"], "v": unit["v"], "kind": unit["kind"], "file": unit["rel"],
        "bytes": os.path.getsize(unit["ogg"]), "channels": unit["channels"],
        "durationS": round(len(x) / SR, 4), "samples": int(len(x)), "sourceSamples": unit["samples"],
        "peak": round(pk, 4), "rmsDb": round(20 * np.log10(max(rms, 1e-9)), 2),
        "crestDb": round(20 * np.log10(max(pk, 1e-9) / max(rms, 1e-9)), 2),
        "dc": round(float(np.mean(m)), 6), "clipped": int(np.sum(np.abs(x) >= 0.999)),
        "centroidHz": round(centroid, 1), "loud100msDb": round(window_rms_db(x), 2),
        "toneBalance": unit.get("tone"),
        **loudness(unit["ogg"]),
    }
    problems = []
    # libvorbis rounds a short file's end to a block (seen: -128 .. +1024 samples of the faded
    # tail). Harmless on a one-shot; a loop must come back sample-exact.
    drift = out["samples"] - unit["samples"]
    if (unit.get("loop") is not None and drift != 0) or abs(drift) > 1100:
        problems.append(f"length changed in encoding ({unit['samples']} -> {out['samples']})")
    if pk < 0.05:
        problems.append("near silent")
    if out["clipped"] > 0:
        problems.append(f"{out['clipped']} clipped samples")
    if abs(out["dc"]) > 0.01:
        problems.append("DC offset")
    if not 40 <= centroid <= 9000:
        problems.append("spectral centroid out of range")
    loop = unit.get("loop")
    if loop is not None:
        a = int(round(loop["startS"] * SR))
        b = int(round(loop["endS"] * SR))
        k = 256
        # Both loop points sit inside copies of the same audio, so after encoding the two
        # neighbourhoods should still match; what is left is codec error.
        diff = x[a - k: a + k] - x[b - k: b + k]
        step = np.max(np.abs(x[a] - x[b - 1]))
        typical = np.percentile(np.abs(np.diff(m)), 99.9)
        out["loop"] = {
            "startS": loop["startS"], "endS": loop["endS"],
            "seamErrorDb": round(float(20 * np.log10(max(np.max(np.abs(diff)), 1e-9))), 1),
            "seamStep": round(float(step), 5), "typicalStep999": round(float(typical), 5),
        }
        if step > max(2.5 * typical, 0.02):
            problems.append("click at the loop seam")
        # The decoded file must still line up with the source, or the loop points would be off.
        src = mono(wavfile.read(unit["wav"])[1].astype(np.float64))
        k0 = int(np.clip(np.argmax(np.abs(src)) - 4096, 64, len(src) - 8192 - 64))
        seg = src[k0: k0 + 8192]
        lags = range(-48, 49)
        scores = [float(np.dot(seg, m[k0 + lag: k0 + lag + 8192])) for lag in lags]
        out["loop"]["decodeLagSamples"] = int(lags[int(np.argmax(scores))])
        # Very low-pitched material has a broad correlation peak: only a clearly better lag counts.
        if out["loop"]["decodeLagSamples"] != 0 and scores[48] < 0.98 * max(scores):
            problems.append("decoded audio is shifted against the source")
    out["problems"] = problems
    return out


# --- main ----------------------------------------------------------------------------------------


def all_units() -> list[dict]:
    import sfx

    units = []
    for name, (_, count, _loop) in sfx.SFX.items():
        for v in range(count):
            units.append({"kind": "sfx", "id": name, "v": v, "rel": f"sfx/{name}_{v + 1}.ogg", "encode_kind": "sfx"})
    for name in ("victory", "defeat"):
        units.append({"kind": "sting", "id": name, "v": 0, "rel": f"music/{name}.ogg", "encode_kind": "music"})
    for name in sfx.AMBIENCE:
        units.append({"kind": "ambience", "id": name, "v": 0, "rel": f"ambience/{name}.ogg", "encode_kind": "ambience"})
    for name, lufs in MUSIC_LUFS.items():
        units.append({"kind": "music", "id": name, "v": 0, "rel": f"music/{name}.ogg", "encode_kind": "music", "lufs": lufs})
    for unit in units:
        unit["wav"] = str(WAV_DIR / unit["rel"].replace(".ogg", ".wav"))
        unit["ogg"] = str(OUT_DIR / unit["rel"])
    return units


def build_manifest(rows: list[dict]) -> dict:
    sounds: dict[str, dict] = {}
    music: dict[str, dict] = {}
    ambience: dict[str, dict] = {}
    for row in rows:
        loop = {"startS": round(row["loop"]["startS"], 6), "endS": round(row["loop"]["endS"], 6)} if "loop" in row else None
        if row["kind"] in ("sfx", "sting"):
            entry = sounds.setdefault(row["id"], {"files": [], "gain": 0.0, "loop": loop, "_loud": []})
            entry["files"].append(row["file"])
            entry["_loud"].append(row["rmsDb"] if loop else row["loud100msDb"])
        elif row["kind"] == "music":
            music[row["id"]] = {"file": row["file"], "gain": MUSIC_GAIN, "loop": loop}
        else:
            ambience[row["id"]] = {"file": row["file"], "gain": AMBIENCE_GAIN[row["id"]], "loop": loop}
    for entry in sounds.values():
        loud = float(np.mean(entry.pop("_loud")))
        entry["gain"] = round(float(np.clip(10 ** ((SFX_REFERENCE_DB - loud) / 20), 0.15, 1.6)), 3)
    return {"version": 1, "sounds": dict(sorted(sounds.items())), "music": music, "ambience": ambience}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    args = parser.parse_args()

    units = all_units()
    only = {name for name in args.only.split(",") if name}
    todo = [u for u in units if not only or u["id"] in only]
    meta_path = WAV_DIR / "units.json"
    known = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    if not args.no_render:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for done in pool.map(render_unit, todo):
                known[done["rel"]] = {k: done[k] for k in ("loop", "samples", "channels", "tone")}
                print(f"rendered {done['rel']}  {done['samples'] / SR:.2f} s  {done['channels']} ch", flush=True)
        meta_path.write_text(json.dumps(known, indent=1))
    for unit in units:
        if unit["rel"] in known:
            unit.update(known[unit["rel"]])
    missing = [u["rel"] for u in units if "samples" not in u]
    if missing:
        print(f"not rendered yet: {missing}", file=sys.stderr)
        return 2

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(encode, todo))
        rows = list(pool.map(analyse, units))

    manifest = build_manifest(rows)
    total = sum(row["bytes"] for row in rows)
    manifest["totalBytes"] = total
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps({"sampleRate": SR, "totalBytes": total, "files": rows}, indent=1) + "\n")

    print(f"\n{'file':34} {'s':>6} {'kB':>6} {'peak':>5} {'TP dB':>6} {'LUFS':>6} {'crest':>5} {'cent Hz':>7} {'clip':>4}  notes")
    failed = 0
    for row in rows:
        lufs = f"{row['lufs']:.1f}" if row["lufs"] is not None else "-"
        tp = f"{row['truePeakDb']:.1f}" if row["truePeakDb"] is not None else "-"
        notes = "; ".join(row["problems"])
        if "loop" in row:
            notes = (f"seam step {row['loop']['seamStep']} (typ {row['loop']['typicalStep999']}) err {row['loop']['seamErrorDb']} dB "
                     f"lag {row['loop']['decodeLagSamples']}  ") + notes
        failed += len(row["problems"])
        print(f"{row['file']:34} {row['durationS']:6.2f} {row['bytes'] / 1024:6.0f} {row['peak']:5.2f} {tp:>6} {lufs:>6} "
              f"{row['crestDb']:5.1f} {row['centroidHz']:7.0f} {row['clipped']:4d}  {notes}")
    print(f"\n{len(rows)} files, {total / 1024 / 1024:.2f} MB of {TOTAL_BUDGET_BYTES / 1024 / 1024:.0f} MB")
    if total > TOTAL_BUDGET_BYTES:
        print("over the audio budget", file=sys.stderr)
        failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

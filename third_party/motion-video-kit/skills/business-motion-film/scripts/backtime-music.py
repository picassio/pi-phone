#!/usr/bin/env python3
"""Back-time a music track to picture: its own final hit lands on the end-card cut, and it plays as ONE continuous piece.

Nothing is cut, looped or spliced. The film opens mid-track; the track's real ending rings out under the end card.
Optionally varispeed (tape-style: pitch moves with tempo) so its beat grid matches the film's cut grid.

Usage:
  python3 backtime-music.py track.mp3 --list-hits                      # candidates for the final hit
  python3 backtime-music.py track.mp3 out.wav --film 18.5 --card 16.0 --hit 96.018 [--bpm 121 --to-bpm 120]
                            [--fade-in 0.04] [--tail-ease 17.6:18.5]
  --hit     the track's final-hit time in the source, in seconds (measure it: --list-hits, then confirm by ear or on a waveform)
  --bpm     the track's measured tempo; with --to-bpm, varispeed by to/bpm (keep it within ~1.7 %, about 0.3 semitone)
  --tail-ease a:b  ease the file end out from a to b (film seconds) if the ring-out is still sounding at the film's end
Prints where the hit landed, the varispeed and the source window used. Needs ffmpeg, numpy and scipy.
"""
import argparse, subprocess, numpy as np
from scipy.signal import resample_poly

SR = 48000
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out', nargs='?')
ap.add_argument('--film', type=float); ap.add_argument('--card', type=float)
ap.add_argument('--hit', type=float); ap.add_argument('--bpm', type=float); ap.add_argument('--to-bpm', type=float)
ap.add_argument('--list-hits', action='store_true'); ap.add_argument('--fade-in', type=float, default=0.04); ap.add_argument('--tail-ease', default=None)
a = ap.parse_args()

raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', a.src, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
x = np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)


def list_hits(x, search=20.0):
    """Strong attacks in the last `search` s, with how far the track drops in the 1.5 s after each. The button ending is
    usually a loud attack followed by a big drop, but a long ring-out can contain later, bigger-dropping attacks:
    auto-picking chose the wrong one on 3 of 6 library endings, so a person confirms by ear."""
    m = x.mean(1); h = int(.01 * SR); n = len(m) // h
    r = 10 * np.log10((m[:n * h].reshape(n, h) ** 2).mean(1) + 1e-12); body = np.percentile(r, 90)
    rows = []
    for i in range(max(3, n - int(search * 100)), n - 1):
        if r[i] > body - 9 and r[i] - r[i - 3:i].min() > 6 and r[i] >= r[max(0, i - 5):i + 6].max():
            later = r[i + 5:i + 150]; drop = r[i] - (10 * np.log10((10 ** (later / 10)).mean()) if len(later) else -120)
            rows.append((i * h / SR, r[i] - body, drop))
    print('  time s   level re body   drop over the next 1.5 s')
    for t, lv, dr in rows: print(f'{t:8.3f}   {lv:+6.1f} dB        {dr:5.1f} dB')
    print('Listen to the last few candidates before choosing: a ring-out can hold later attacks with bigger drops.')


if a.list_hits: list_hits(x); raise SystemExit
if a.hit is None: raise SystemExit('pass --hit (the source time of the final hit); --list-hits shows candidates')
hit = a.hit
ratio = (a.to_bpm / a.bpm) if (a.bpm and a.to_bpm) else 1.0           # >1 = faster
if abs(ratio - 1) > 0.017: print(f'warning: varispeed {100 * (ratio - 1):+.2f} % is over 1.7 % and may be audible')
if abs(ratio - 1) > 1e-6:
    up, down = 1000, int(round(1000 * ratio)); x = resample_poly(x, up, down, axis=0); hit = hit / ratio
start = hit - a.card                                                  # source second playing at film 0
i0 = int(round(start * SR)); n = int(round(a.film * SR))
y = np.zeros((n, 2)); s0 = max(0, i0); d0 = s0 - i0; seg = x[s0:s0 + n - d0]; y[d0:d0 + len(seg)] = seg
fi = max(1, int(a.fade_in * SR)); y[:fi] *= (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fi)))[:, None]
if a.tail_ease:
    t0, t1 = (float(v) for v in a.tail_ease.split(':')); j0, j1 = int(t0 * SR), min(n, int(t1 * SR))
    y[j0:j1] *= (np.cos(np.linspace(0, np.pi / 2, j1 - j0)) ** 2)[:, None]; y[j1:] = 0
y *= 10 ** (-1 / 20) / (np.abs(y).max() + 1e-12)                      # peak -1 dBFS; set the film level in the mix
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f64le', '-ar', str(SR), '-ac', '2', '-i', '-', a.out], input=y.astype(np.float64).tobytes(), check=True)
print(f'hit {hit * ratio:.3f} s in the source -> film {a.card:.3f} s; varispeed {100 * (ratio - 1):+.2f} % '
      f'({12 * np.log2(ratio):+.2f} semitones); source window {start * ratio:.3f}-{(start + a.film) * ratio:.3f} s'
      + ('  (the track starts after film 0: it is shorter than the film before its hit)' if i0 < 0 else ''))

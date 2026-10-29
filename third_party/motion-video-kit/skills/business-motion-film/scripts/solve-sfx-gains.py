#!/usr/bin/env python3
"""Solve a per-event gain so each effect lifts TARGET dB inside its own frequency band over the music,
while the ear-sensitive 2-8 kHz band never lifts more than CAP dB.
Usage: scripts/solve-sfx-gains.py music_only.mp4 events.json [target=3.5] [cap=4]
events.json: [["sfx/whoosh.mp3", 2.67], ["sfx/pop.mp3", 10.9], ...]   (file, start time in seconds)
Prints [file, time, gain] rows. Override collapsed gains for repeated sounds so they stay consistent."""
import subprocess, sys, json, numpy as np
from scipy.signal import butter, sosfilt
SR = 44100
def load(p): return np.frombuffer(subprocess.run(['ffmpeg','-v','error','-i',p,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout, np.float32).copy()
def peak(y): h = int(.05*SR); return max(10*np.log10((y[i:i+h]**2).mean()+1e-12) for i in range(0, len(y)-h, h//2))
music = np.concatenate([np.zeros(SR, np.float32), load(sys.argv[1]), np.zeros(SR, np.float32)])
events = json.load(open(sys.argv[2])); target = float(sys.argv[3]) if len(sys.argv) > 3 else 3.5; cap = float(sys.argv[4]) if len(sys.argv) > 4 else 4.0
HB = butter(4, [2000, 8000], btype='band', fs=SR, output='sos'); W = int(.3*SR)
for path, t in events:
    s = load(path); F = np.abs(np.fft.rfft(s*np.hanning(len(s))))**2; f = np.fft.rfftfreq(len(s), 1/SR); c = np.cumsum(F)/F.sum()
    lo = max(f[np.searchsorted(c, .2)], 40); hi = min(max(f[np.searchsorted(c, .8)], lo*2), SR/2-200)
    sos = butter(4, [lo, hi], btype='band', fs=SR, output='sos')
    i = int(t*SR)+SR; base = music[i-SR//2:i+SR+SR//2]
    b0 = peak(sosfilt(sos, base)[SR//2:SR//2+W]); h0 = peak(sosfilt(HB, base)[SR//2:SR//2+W]); g = prev = .005
    for x in np.geomspace(.005, 1.2, 140):
        seg = base.copy(); seg[SR//2:SR//2+len(s)] += x*s[:len(seg)-SR//2]
        if peak(sosfilt(HB, seg)[SR//2:SR//2+W]) - h0 > cap: g = prev; break
        if peak(sosfilt(sos, seg)[SR//2:SR//2+W]) - b0 >= target: g = x; break
        prev = x
    print(json.dumps([path, t, round(float(g), 3)]))

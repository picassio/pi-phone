#!/usr/bin/env python3
"""Rank sound-effect candidates before anyone has to listen.
Usage: scripts/sfx-candidates.py file1.mp3 file2.wav ...
Reports active duration, rise time, spectral centroid, share of energy below 150 Hz (rumble/boom)
and above 6 kHz (hiss/click), and a verdict. Reject: rumble > 50%, highs > 40% (for UI sounds),
very long whooshes (> 0.8s) for repeated transitions."""
import subprocess, sys, numpy as np
SR = 44100
for f in sys.argv[1:]:
    y = np.frombuffer(subprocess.run(['ffmpeg','-v','error','-i',f,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout, np.float32)
    if not len(y): print(f, 'unreadable'); continue
    env = np.sqrt(np.convolve(y**2, np.ones(441)/441, 'same')); pk = env.max()
    act = np.where(env > pk*.05)[0]; dur = (act[-1]-act[0])/SR; rise = (np.argmax(env)-act[0])/SR*1000
    F = np.abs(np.fft.rfft(y))**2; fr = np.fft.rfftfreq(len(y), 1/SR); tot = F.sum()
    cen = (F*fr).sum()/tot; lo = F[fr < 150].sum()/tot; hi = F[fr > 6000].sum()/tot
    why = [w for w, bad in [('boomy', lo > .5), ('hissy/clicky', hi > .4), ('long', dur > .8)] if bad]
    print(f"{f}: {dur:.2f}s rise {rise:.0f}ms centroid {cen:.0f}Hz <150Hz {lo*100:.0f}% >6k {hi*100:.0f}%  -> {'REJECT: '+', '.join(why) if why else 'ok'}")

# ffmpeg for Android (pi-phone's media tool)

The app carries `ffmpeg` and `ffprobe` for Android arm64 in its runtime (`native/android-arm64/ffmpeg/`), for Pi's
media tool on the phone (PP-296). They are built by `scripts/build-ffmpeg-android.sh` in this repository from these
sources, each pinned and checked:

| Source | Version | License |
|---|---|---|
| [FFmpeg](https://ffmpeg.org/releases/) | 9.0.2 (`ffmpeg-9.0.2.tar.xz`, sha256 in the script) | LGPL 2.1 or later; GPL 2 or later as built (`--enable-gpl`) |
| [x264](https://code.videolan.org/videolan/x264) | stable branch, commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | GPL 2 or later |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) | 1.6.0 (sha256 in the script) | BSD 3-Clause |

Because x264 is linked in, the two programs are distributed under the GNU General Public License, version 2 or later.
They are separate programs that pi-phone runs; pi-phone itself stays under its own license. The corresponding source is
the sources above and the build script (its configure line lists every option); anyone can rebuild the same programs
with the Android NDK r27c:

```sh
ANDROID_NDK_HOME=/path/to/android-ndk-r27c scripts/build-ffmpeg-android.sh out/
```

The server edition's image carries BtbN's static GPL build instead (`scripts/server-tools.ts`, the release machines
install: https://github.com/BtbN/FFmpeg-Builds), downloaded and checked against its pinned sha256 when the image is built.

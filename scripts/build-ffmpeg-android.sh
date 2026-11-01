#!/usr/bin/env bash
# A slim ffmpeg and ffprobe for Android arm64 (PP-296, the owner's pick: one engine everywhere), for Pi's media
# tool on the phone. Built with the Android NDK from pinned sources, each checked against its sha256: ffmpeg (LGPL),
# x264 (GPL: H.264 encoding, so the binaries are GPL), and libwebp (BSD). Only what the media tool uses is enabled:
# common containers, images and audio in; H.264/AAC mp4, JPEG, PNG, WebP and GIF out; the filters for resizing,
# cropping, turning, frames, contact sheets and trimming. The sources and this script are the GPL's corresponding source
# (third_party/ffmpeg-android/README.md). Its own libraries are linked in; Android's libc, libm, libdl and libz are the
# phone's (a fully static executable carries bionic's TLS segment, which Android 10 and later refuse below 64-byte
# alignment, and API 26 does not give it).
#
#   ANDROID_NDK_HOME=/path/to/ndk scripts/build-ffmpeg-android.sh <out dir>
#
# CI runs it (.github/workflows/build-apk.yml) and caches the result by this file's hash; the APK carries
# native/android-arm64/ffmpeg/{ffmpeg,ffprobe}.
set -euo pipefail

OUT="$(realpath -m "${1:?give the folder the binaries go to}")"
NDK="${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the Android NDK (r27 or later)}"
API=26
JOBS="$(nproc)"

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
# x264's stable branch, by commit (its hash checks the sources; GitLab's archives are made on the fly).
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
WEBP_VERSION=1.6.0
WEBP_SHA256=e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CC="$TOOLCHAIN/bin/aarch64-linux-android$API-clang"
CXX="$TOOLCHAIN/bin/aarch64-linux-android$API-clang++"
AR="$TOOLCHAIN/bin/llvm-ar"
RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
STRIP="$TOOLCHAIN/bin/llvm-strip"
NM="$TOOLCHAIN/bin/llvm-nm"

fetch() {
    local url="$1" sum="$2" file="$WORK/$(basename "$1")"
    # A busy mirror resets now and then (CI, 2026-11-01): tried again before giving up.
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o "$file" "$url"
    local got
    got="$(sha256sum "$file" | cut -d' ' -f1)"
    if [ "$got" != "$sum" ]; then
        echo "$(basename "$url") has sha256 $got, not the pinned $sum" >&2
        exit 1
    fi
    echo "$file"
}

cd "$WORK"

# x264: static, no CLI, arm64 assembly through clang.
git init -q "x264-$X264_COMMIT"
(
    cd "x264-$X264_COMMIT"
    for attempt in 1 2 3 4 5; do
        git fetch -q --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT" && break
        [ "$attempt" = 5 ] && exit 1
        sleep 5
    done
    git checkout -q FETCH_HEAD
    test "$(git rev-parse HEAD)" = "$X264_COMMIT"
    CC="$CC" AR="$AR" RANLIB="$RANLIB" STRIP="$STRIP" ./configure \
        --prefix="$PREFIX" --host=aarch64-linux-android --cross-prefix="$TOOLCHAIN/bin/llvm-" \
        --enable-static --enable-pic --disable-cli --disable-opencl --disable-lavf --disable-swscale --disable-ffms --disable-gpac --disable-lsmash
    make -j"$JOBS" && make install
)

# libwebp: static, its encoder and decoder only.
# Each download into a variable first: a failed one stops the script (inside a command's arguments it would not).
webp="$(fetch "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$WEBP_VERSION.tar.gz" "$WEBP_SHA256")"
tar -xzf "$webp"
(
    cd "libwebp-$WEBP_VERSION"
    CC="$CC" AR="$AR" RANLIB="$RANLIB" ./configure \
        --prefix="$PREFIX" --host=aarch64-linux-android --enable-static --disable-shared --with-pic \
        --disable-libwebpdemux --disable-libwebpmux --disable-libwebpdecoder --disable-png --disable-jpeg --disable-tiff --disable-gif --disable-wic --disable-sdl --disable-gl
    make -j"$JOBS" && make install
)

# ffmpeg: static ffmpeg and ffprobe, only what the media tool uses.
ffmpeg="$(fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256")"
tar -xJf "$ffmpeg"
(
    cd "ffmpeg-$FFMPEG_VERSION"
    PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" ./configure \
        --prefix="$PREFIX" --target-os=android --arch=aarch64 --cpu=armv8-a --enable-cross-compile \
        --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" --nm="$NM" --pkg-config=pkg-config \
        --extra-cflags="-I$PREFIX/include -O2" --extra-ldflags="-L$PREFIX/lib" --pkg-config-flags=--static \
        --enable-static --disable-shared --enable-pic --enable-gpl --enable-libx264 --enable-libwebp \
        --disable-everything --disable-doc --disable-debug --disable-ffplay --disable-network --disable-autodetect \
        --disable-avdevice --disable-vulkan --disable-mediacodec --disable-jni \
        --enable-ffmpeg --enable-ffprobe --enable-zlib \
        --enable-protocol=file,pipe \
        --enable-demuxer=mov,matroska,avi,mpegts,mpegps,flv,image2,image2pipe,gif,webp_pipe,png_pipe,jpeg_pipe,mjpeg,wav,mp3,aac,ogg,flac,m4v,h264,hevc,ivf \
        --enable-muxer=mp4,mov,matroska,webm,image2,image2pipe,gif,webp,wav,adts,null \
        --enable-decoder=h264,hevc,vp8,vp9,mpeg4,mpeg2video,mjpeg,png,webp,gif,bmp,tiff,aac,mp3,mp3float,opus,vorbis,flac,pcm_s16le,pcm_s24le,pcm_f32le,pcm_u8,alac \
        --enable-encoder=libx264,aac,mjpeg,png,libwebp,libwebp_anim,gif,pcm_s16le \
        --enable-parser=h264,hevc,vp8,vp9,mpeg4video,mpegvideo,aac,mpegaudio,opus,vorbis,flac,png,mjpeg,webp,gif \
        --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata \
        --enable-filter=scale,crop,transpose,hflip,vflip,rotate,fps,select,tile,pad,trim,atrim,setpts,asetpts,format,aformat,aresample,overlay,thumbnail,null,anull,copy,palettegen,paletteuse,split,concat,scale2ref,setsar,setdar,showinfo,volume,pan
    make -j"$JOBS"
    mkdir -p "$OUT"
    "$STRIP" -o "$OUT/ffmpeg" ffmpeg
    "$STRIP" -o "$OUT/ffprobe" ffprobe
)

ls -l "$OUT"

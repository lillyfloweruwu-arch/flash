#!/usr/bin/env bash
set -euo pipefail

# L1 build recipe, untested locally. Keep libav private so distro FFmpeg builds
# cannot enable GPL components behind Flash's back. Nothing is statically linked.
root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="$root/build/linux-media"
work="$root/build/linux-media-source"
mkdir -p "$prefix" "$work"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
if [[ ! -d "$work/nv-codec-headers" ]]; then
  git clone --depth 1 --branch n12.2.72.0 https://github.com/FFmpeg/nv-codec-headers.git "$work/nv-codec-headers"
fi
make -C "$work/nv-codec-headers" PREFIX="$prefix" install
if [[ ! -d "$work/ffmpeg" ]]; then
  git clone --depth 1 --branch n7.1.2 https://github.com/FFmpeg/FFmpeg.git "$work/ffmpeg"
fi
cd "$work/ffmpeg"
./configure --prefix="$prefix" --libdir="$prefix/lib" \
  --disable-gpl --disable-nonfree --disable-static --enable-shared \
  --disable-autodetect --disable-everything --disable-programs --disable-doc \
  --disable-avdevice --disable-avfilter --disable-postproc --disable-network \
  --enable-avcodec --enable-avformat --enable-avutil --enable-swscale --enable-swresample \
  --enable-libopenh264 --enable-vaapi --enable-ffnvcodec --enable-nvenc \
  --enable-encoder=h264_vaapi,h264_nvenc,av1_vaapi,av1_nvenc,libopenh264,aac,png \
  --enable-decoder=h264,aac --enable-parser=h264,aac \
  --enable-muxer=mp4 --enable-demuxer=mov --enable-protocol=file \
  --enable-bsf=extract_extradata,h264_mp4toannexb,aac_adtstoasc \
  --enable-zlib --extra-ldflags='-Wl,-rpath,$ORIGIN'
make -j"$(nproc)"
make install
if ! grep -q '^#define CONFIG_GPL 0$' config.h || ! grep -q '^#define CONFIG_NONFREE 0$' config.h; then
  echo 'Refusing a GPL or nonfree libav build' >&2
  exit 1
fi
openh264="$(pkg-config --variable=libdir openh264)"
cp -L "$openh264"/libopenh264.so.* "$prefix/lib/"
for library in "$prefix/lib/"*.so*; do patchelf --set-rpath '$ORIGIN' "$library"; done
mkdir -p "$prefix/licenses"
cp COPYING.LGPLv2.1 "$prefix/licenses/FFmpeg-LGPL-2.1.txt"
cp "$work/nv-codec-headers/include/ffnvcodec/nvEncodeAPI.h" "$prefix/licenses/nvEncodeAPI.h"
notice="${OPENH264_LICENSE:-}"
if [[ -z "$notice" ]]; then
  for candidate in /usr/share/doc/libopenh264-dev/copyright /usr/share/licenses/openh264/LICENSE /usr/share/licenses/openh264/LICENCE; do
    if [[ -f "$candidate" ]]; then notice="$candidate"; break; fi
  done
fi
if [[ ! -f "$notice" ]]; then echo 'Set OPENH264_LICENSE to the installed OpenH264 notice file' >&2; exit 1; fi
cp "$notice" "$prefix/licenses/OpenH264-copyright.txt"
cp config.h ffbuild/config.mak "$prefix/licenses/"

# Third-party notices

Flash is distributed under the MIT licence (see `LICENSE`). It bundles or links
the third-party components below. This file is a summary; the full licence text
for each component is shipped with that component.

## Desktop application (Windows and Linux)

| Component | Version | Licence | Copyright |
|-----------|---------|---------|-----------|
| [Electron](https://www.electronjs.org/) | 44.7.0 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| [React](https://react.dev/) | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [React DOM](https://react.dev/) | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [Antonio (Fontsource variable)](https://fontsource.org/fonts/antonio) | 5.3.0 | SIL Open Font License 1.1 | Copyright 2013 The Antonio Project Authors (https://github.com/googlefonts/antonioFont) |

Electron bundles Chromium, Node.js and their own third-party dependencies.
Their notices are included in the packaged application as Electron's `LICENSE`
and `LICENSES.chromium.html`.

The packages listed under `devDependencies` in `apps/desktop/package.json` that
are not in the table above (electron-builder, electron-vite, Vite, TypeScript,
Tailwind CSS, PostCSS and the type packages) are build-time tools and are not
distributed with the application.

## Linux media build

The Linux AppImage and deb link against an LGPL-only build of FFmpeg and against
the system OpenH264 library. Both are copied into the package under
`resources/linux-media` together with their licence files.

| Component | Version | Licence | Notes |
|-----------|---------|---------|-------|
| [FFmpeg](https://ffmpeg.org/) | n7.1.2 | LGPL 2.1 or later | Built with `--disable-gpl --disable-nonfree`; only libavcodec, libavformat, libavutil, libswscale and libswresample are enabled. Full licence in `linux-media/licenses/FFmpeg-LGPL-2.1.txt`. |
| [OpenH264](https://github.com/cisco/openh264) | distribution package | BSD 2-Clause | Linked dynamically as `libopenh264.so`. Full copyright notice in `linux-media/licenses/OpenH264-copyright.txt`. |
| [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | n12.2.72.0 | MIT | Only `nvEncodeAPI.h` is used; the header is included in `linux-media/licenses/nvEncodeAPI.h`. |

The Windows build uses Media Foundation and does not link FFmpeg or OpenH264.

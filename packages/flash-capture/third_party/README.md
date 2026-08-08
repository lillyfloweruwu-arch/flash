# Optional hardware encoder SDK headers

The capture target builds without these headers and uses the Media Foundation
encoder. To enable the dynamically loaded hardware backends, vendor these
public header trees at the paths below:

- NVIDIA `nv-codec-headers` (SDK 13-compatible):
  `nv-codec-headers/include/nvEncodeAPI.h`
- AMD AMF 1.5.0 or newer:
  `AMF/amf/public/include/core/Factory.h`

No vendor import libraries or runtime DLLs are distributed with Flash. The
installed display driver supplies `nvEncodeAPI64.dll` or `amfrt64.dll`, and the
backends load those DLLs at runtime. CMake detects either header tree
automatically.

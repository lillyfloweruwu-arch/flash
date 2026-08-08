#include "nvenc_encoder.h"

#if defined(_WIN32) && __has_include(<nvEncodeAPI.h>)
#define FLASH_HAS_NVENC 1
#include <Windows.h>
#include <d3d11.h>
#include <nvEncodeAPI.h>
#include <wrl/client.h>
#include <cstring>
using Microsoft::WRL::ComPtr;
#else
#define FLASH_HAS_NVENC 0
#endif

namespace flash {

struct NvencEncoder::Impl {
    EncoderConfig config{};
    bool initialized = false;
#if FLASH_HAS_NVENC
    HMODULE library = nullptr;
    NV_ENCODE_API_FUNCTION_LIST api{};
    void* encoder = nullptr;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    NV_ENC_INPUT_PTR input = nullptr;
    NV_ENC_OUTPUT_PTR bitstream = nullptr;
    uint64_t frameIndex = 0;

    void Reset() {
        if (encoder) {
            if (input) api.nvEncDestroyInputBuffer(encoder, input);
            if (bitstream) api.nvEncDestroyBitstreamBuffer(encoder, bitstream);
            api.nvEncDestroyEncoder(encoder);
        }
        input = nullptr; bitstream = nullptr; encoder = nullptr;
        context.Reset(); device.Reset();
        if (library) FreeLibrary(library);
        library = nullptr; initialized = false;
    }
#endif
};

NvencEncoder::NvencEncoder() : impl_(std::make_unique<Impl>()) {}
NvencEncoder::~NvencEncoder() {
#if FLASH_HAS_NVENC
    impl_->Reset();
#endif
}

bool NvencEncoder::Initialize(const EncoderConfig& config) {
#if FLASH_HAS_NVENC
    impl_->Reset(); impl_->config = config;
    impl_->library = LoadLibraryW(L"nvEncodeAPI64.dll");
    if (!impl_->library) return false;
    auto create = reinterpret_cast<PNVENCODEAPICREATEINSTANCE>(GetProcAddress(impl_->library, "NvEncodeAPICreateInstance"));
    if (!create) { impl_->Reset(); return false; }
    impl_->api = {}; impl_->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (create(&impl_->api) != NV_ENC_SUCCESS) { impl_->Reset(); return false; }

    D3D_FEATURE_LEVEL level;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
            D3D11_SDK_VERSION, &impl_->device, &level, &impl_->context))) { impl_->Reset(); return false; }
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.device = impl_->device.Get(); open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.apiVersion = NVENCAPI_VERSION;
    if (impl_->api.nvEncOpenEncodeSessionEx(&open, &impl_->encoder) != NV_ENC_SUCCESS) { impl_->Reset(); return false; }

    GUID preset = config.preset == "slow" ? NV_ENC_PRESET_P7_GUID :
                  config.preset == "medium" ? NV_ENC_PRESET_P4_GUID : NV_ENC_PRESET_P2_GUID;
    NV_ENC_PRESET_CONFIG presetConfig{};
    presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
    presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;
    if (impl_->api.nvEncGetEncodePresetConfigEx(impl_->encoder, NV_ENC_CODEC_H264_GUID, preset,
            NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &presetConfig) != NV_ENC_SUCCESS) { impl_->Reset(); return false; }
    NV_ENC_CONFIG encodeConfig = presetConfig.presetCfg;
    encodeConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
    encodeConfig.gopLength = config.fps * 2;
    encodeConfig.frameIntervalP = 1;
    encodeConfig.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    encodeConfig.rcParams.averageBitRate = config.bitrate;
    encodeConfig.rcParams.maxBitRate = config.bitrate;
    encodeConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    encodeConfig.encodeCodecConfig.h264Config.idrPeriod = encodeConfig.gopLength;

    NV_ENC_INITIALIZE_PARAMS init{};
    init.version = NV_ENC_INITIALIZE_PARAMS_VER; init.encodeConfig = &encodeConfig;
    init.encodeGUID = NV_ENC_CODEC_H264_GUID; init.presetGUID = preset;
    init.encodeWidth = config.width; init.encodeHeight = config.height;
    init.darWidth = config.width; init.darHeight = config.height;
    init.frameRateNum = config.fps; init.frameRateDen = 1;
    init.enablePTD = 1; init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    if (impl_->api.nvEncInitializeEncoder(impl_->encoder, &init) != NV_ENC_SUCCESS) { impl_->Reset(); return false; }

    NV_ENC_CREATE_INPUT_BUFFER input{};
    input.version = NV_ENC_CREATE_INPUT_BUFFER_VER; input.width = config.width; input.height = config.height;
    input.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB;
    NV_ENC_CREATE_BITSTREAM_BUFFER output{}; output.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    if (impl_->api.nvEncCreateInputBuffer(impl_->encoder, &input) != NV_ENC_SUCCESS ||
        impl_->api.nvEncCreateBitstreamBuffer(impl_->encoder, &output) != NV_ENC_SUCCESS) { impl_->Reset(); return false; }
    impl_->input = input.inputBuffer; impl_->bitstream = output.bitstreamBuffer;
    impl_->frameIndex = 0; impl_->initialized = true; return true;
#else
    (void)config; return false;
#endif
}

bool NvencEncoder::EncodeFrame(const FrameData& frame, EncodedPacket& output) {
#if FLASH_HAS_NVENC
    if (!impl_->initialized || !frame.data || frame.width != impl_->config.width || frame.height != impl_->config.height) return false;
    NV_ENC_LOCK_INPUT_BUFFER lock{}; lock.version = NV_ENC_LOCK_INPUT_BUFFER_VER; lock.inputBuffer = impl_->input;
    if (impl_->api.nvEncLockInputBuffer(impl_->encoder, &lock) != NV_ENC_SUCCESS) return false;
    for (uint32_t y = 0; y < frame.height; ++y)
        std::memcpy(static_cast<uint8_t*>(lock.bufferDataPtr) + static_cast<size_t>(y) * lock.pitch,
                    frame.data + static_cast<size_t>(y) * frame.stride, frame.width * 4);
    impl_->api.nvEncUnlockInputBuffer(impl_->encoder, impl_->input);
    NV_ENC_PIC_PARAMS pic{}; pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputBuffer = impl_->input; pic.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB;
    pic.inputWidth = frame.width; pic.inputHeight = frame.height; pic.outputBitstream = impl_->bitstream;
    pic.inputTimeStamp = frame.timestamp_us; pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    NVENCSTATUS status = impl_->api.nvEncEncodePicture(impl_->encoder, &pic);
    if (status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT) return false;
    if (status == NV_ENC_ERR_NEED_MORE_INPUT) return false;
    NV_ENC_LOCK_BITSTREAM bits{}; bits.version = NV_ENC_LOCK_BITSTREAM_VER;
    bits.outputBitstream = impl_->bitstream; bits.doNotWait = 0;
    if (impl_->api.nvEncLockBitstream(impl_->encoder, &bits) != NV_ENC_SUCCESS) return false;
    const auto* begin = static_cast<const uint8_t*>(bits.bitstreamBufferPtr);
    output.data.assign(begin, begin + bits.bitstreamSizeInBytes);
    output.timestamp_us = bits.outputTimeStamp;
    output.isKeyframe = bits.pictureType == NV_ENC_PIC_TYPE_IDR || bits.pictureType == NV_ENC_PIC_TYPE_I;
    impl_->api.nvEncUnlockBitstream(impl_->encoder, impl_->bitstream);
    ++impl_->frameIndex; return !output.data.empty();
#else
    (void)frame; (void)output; return false;
#endif
}

void NvencEncoder::Flush() {
#if FLASH_HAS_NVENC
    if (!impl_->initialized) return;
    NV_ENC_PIC_PARAMS eos{}; eos.version = NV_ENC_PIC_PARAMS_VER; eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
    impl_->api.nvEncEncodePicture(impl_->encoder, &eos);
#endif
}

} // namespace flash

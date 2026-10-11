// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
}
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace flash {
void CheckLibavLicense() {
    // Never silently fall back to x264 or load a GPL-enabled distro build.
    for (const char* config : {avcodec_configuration(), avformat_configuration(), avutil_configuration(), swscale_configuration(), swresample_configuration()})
        if (std::strstr(config, "--enable-gpl") || std::strstr(config, "--enable-nonfree"))
            throw std::runtime_error("Flash requires LGPL-only libav libraries (no --enable-gpl or --enable-nonfree)");
}
namespace {
class LibavEncoder final : public VideoEncoder {
    AVCodecContext* context_ = nullptr;
    AVFrame* frame_ = nullptr;
    AVBufferRef* device_ = nullptr;
    SwsContext* scaler_ = nullptr;
    std::string name_;
    int64_t frames_ = 0;
    void Clear() {
        av_frame_free(&frame_); avcodec_free_context(&context_); av_buffer_unref(&device_);
        sws_freeContext(scaler_); scaler_ = nullptr;
    }
public:
    ~LibavEncoder() override { Clear(); }
    bool Initialize(const EncoderConfig& config) override {
        CheckLibavLicense();
        // L1: device probing and hardware uploads require real GPUs in L2.
        // AV1 is hardware only: there is no software AV1 encoder in the build,
        // so a machine without one returns false and the exporter steps down.
        const std::vector<const char*> names = config.codec == "av1"
            ? std::vector<const char*>{"av1_vaapi", "av1_nvenc"}
            : std::vector<const char*>{"h264_vaapi", "h264_nvenc", "libopenh264"};
        for (const char* name : names) {
            Clear(); const auto* codec = avcodec_find_encoder_by_name(name);
            if (!codec) continue;
            context_ = avcodec_alloc_context3(codec); if (!context_) continue;
            name_ = name;
            context_->width = config.width; context_->height = config.height;
            context_->time_base = AVRational{1, 1000000}; context_->framerate = AVRational{static_cast<int>(config.fps), 1};
            // B-frames stay off for exports too: the muxer takes a clip's end
            // from the last packet in decode order, untested with reordering.
            context_->bit_rate = config.bitrate; context_->max_b_frames = 0;
            context_->gop_size = config.fps * (config.exportQuality ? 4 : 2);
            const bool hardware = name_ != "libopenh264";
            // Every file export asks for High, tuned or not; capture does not.
            const bool highProfile = config.highProfile && config.codec == "h264" && hardware;
            if (config.exportQuality && hardware) {
                context_->rc_max_rate = static_cast<int64_t>(config.bitrate) * 3 / 2;
                context_->rc_buffer_size = static_cast<int>(config.bitrate) * 2;
            }
            if (highProfile) context_->profile = AV_PROFILE_H264_HIGH;
            context_->flags |= AV_CODEC_FLAG_CLOSED_GOP;
            context_->color_range = AVCOL_RANGE_MPEG; context_->colorspace = AVCOL_SPC_BT709;
            context_->color_primaries = AVCOL_PRI_BT709; context_->color_trc = AVCOL_TRC_BT709;
            const bool vaapi = name_.find("_vaapi") != std::string::npos;
            context_->pix_fmt = vaapi ? AV_PIX_FMT_VAAPI : AV_PIX_FMT_YUV420P;
            if (context_->pix_fmt == AV_PIX_FMT_VAAPI) {
                if (av_hwdevice_ctx_create(&device_, AV_HWDEVICE_TYPE_VAAPI, nullptr, nullptr, 0) < 0) continue;
                context_->hw_frames_ctx = av_hwframe_ctx_alloc(device_); if (!context_->hw_frames_ctx) continue;
                auto* frames = reinterpret_cast<AVHWFramesContext*>(context_->hw_frames_ctx->data);
                frames->format = AV_PIX_FMT_VAAPI; frames->sw_format = AV_PIX_FMT_NV12;
                frames->width = config.width; frames->height = config.height; frames->initial_pool_size = 4;
                if (av_hwframe_ctx_init(context_->hw_frames_ctx) < 0) continue;
            }
            av_opt_set(context_->priv_data, "forced-idr", "1", 0);
            const bool nvenc = name_.find("_nvenc") != std::string::npos;
            // NVENC takes its profile from this private option, not from
            // context_->profile. AV1 keeps the encoder's default profile.
            if (highProfile && nvenc) av_opt_set(context_->priv_data, "profile", "high", 0);
            if (config.exportQuality && nvenc) {
                // av_opt_set returns an error for an option an encoder does not
                // have; those errors are deliberately ignored.
                av_opt_set(context_->priv_data, "preset", "p7", 0);
                av_opt_set(context_->priv_data, "tune", "hq", 0);
                av_opt_set(context_->priv_data, "rc", "vbr", 0);
                av_opt_set(context_->priv_data, "rc-lookahead", "32", 0);
            } else if (!config.exportQuality) {
                av_opt_set(context_->priv_data, "rc-lookahead", "0", 0);
            }
            if (avcodec_open2(context_, codec, nullptr) < 0) continue;
            frame_ = av_frame_alloc(); if (!frame_) continue;
            frame_->format = context_->pix_fmt == AV_PIX_FMT_VAAPI ? AV_PIX_FMT_NV12 : context_->pix_fmt;
            frame_->width = config.width; frame_->height = config.height;
            if (av_frame_get_buffer(frame_, 32) < 0) continue;
            return true;
        }
        Clear(); return false;
    }
    bool EncodeFrame(const FrameData& input, std::vector<EncodedPacket>& output) override {
        if (!context_ || !input.data || !input.width || !input.height) return false;
        if (av_frame_make_writable(frame_) < 0) return false;
        scaler_ = sws_getCachedContext(scaler_, input.width, input.height, input.rgb ? AV_PIX_FMT_RGB0 : AV_PIX_FMT_BGR0,
            frame_->width, frame_->height, static_cast<AVPixelFormat>(frame_->format), SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!scaler_) return false;
        const auto* coefficients = sws_getCoefficients(SWS_CS_ITU709);
        sws_setColorspaceDetails(scaler_, coefficients, 1, coefficients, 0, 0, 1 << 16, 1 << 16);
        const uint8_t* source[] = {input.data}; const int stride[] = {static_cast<int>(input.stride)};
        if (sws_scale(scaler_, source, stride, 0, input.height, frame_->data, frame_->linesize) <= 0) return false;
        frame_->pts = input.timestamp_us;
        frame_->pict_type = frames_++ % context_->gop_size == 0 ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
        AVFrame* hardware = nullptr; AVFrame* send = frame_;
        if (context_->hw_frames_ctx) {
            hardware = av_frame_alloc();
            if (!hardware || av_hwframe_get_buffer(context_->hw_frames_ctx, hardware, 0) < 0 || av_hwframe_transfer_data(hardware, frame_, 0) < 0) {
                av_frame_free(&hardware); return false;
            }
            hardware->pts = frame_->pts; hardware->pict_type = frame_->pict_type; send = hardware;
        }
        const int sent = avcodec_send_frame(context_, send); av_frame_free(&hardware);
        if (sent < 0) return false;
        auto* packet = av_packet_alloc(); if (!packet) return false;
        int result;
        while ((result = avcodec_receive_packet(context_, packet)) == 0) {
            EncodedPacket encoded;
            encoded.data.assign(packet->data, packet->data + packet->size);
            encoded.pts_us = packet->pts; encoded.dts_us = packet->dts;
            encoded.duration_us = packet->duration > 0 ? packet->duration : 1000000 / context_->framerate.num;
            encoded.isKeyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;
            output.push_back(std::move(encoded)); av_packet_unref(packet);
        }
        av_packet_free(&packet); return result == AVERROR(EAGAIN) || result == AVERROR_EOF;
    }
    void Flush() override { if (context_) avcodec_flush_buffers(context_); }
    bool Drain(std::vector<EncodedPacket>& output) override {
        if (!context_ || avcodec_send_frame(context_, nullptr) < 0) return false;
        auto* packet = av_packet_alloc(); if (!packet) return false;
        int result;
        while ((result = avcodec_receive_packet(context_, packet)) == 0) {
            EncodedPacket encoded;
            encoded.data.assign(packet->data, packet->data + packet->size);
            encoded.pts_us = packet->pts; encoded.dts_us = packet->dts;
            encoded.duration_us = packet->duration > 0 ? packet->duration : 1000000 / context_->framerate.num;
            encoded.isKeyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;
            output.push_back(std::move(encoded)); av_packet_unref(packet);
        }
        av_packet_free(&packet); return result == AVERROR_EOF;
    }
    std::string GetName() const override { return name_; }
    bool IsHardwareAccelerated() const override { return name_ != "libopenh264"; }
};
}
std::unique_ptr<Encoder> CreateEncoder() { return CreateEncoder(EncoderConfig{}); }
std::unique_ptr<Encoder> CreateEncoder(const EncoderConfig& config) {
    auto encoder = std::make_unique<LibavEncoder>();
    if (encoder->Initialize(config)) return encoder;
    return nullptr;
}
GpuVendor DetectGpuVendor() { return GpuVendor::Unknown; }
} // namespace flash

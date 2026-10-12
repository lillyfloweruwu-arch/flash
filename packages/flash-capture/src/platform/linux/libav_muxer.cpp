// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include "../../core/export_budget.h"
#include "../../core/audio_tracks.h"
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}
#include <algorithm>
#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <ctime>
#include <mutex>
#include <stdexcept>
#include <unistd.h>

namespace flash {
namespace {
constexpr AVRational micros{1, 1000000};
void Check(int result, const char* operation) {
    if (result < 0) { char error[AV_ERROR_MAX_STRING_SIZE]; av_strerror(result, error, sizeof(error)); throw std::runtime_error(std::string(operation) + ": " + error); }
}
struct Media {
    AVFormatContext* input = nullptr;
    AVFormatContext* output = nullptr;
    AVCodecContext* codec = nullptr;
    AVFrame* frame = av_frame_alloc();
    AVPacket* packet = av_packet_alloc();
    SwrContext* resampler = nullptr;
    SwsContext* scaler = nullptr;
    ~Media() {
        av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&codec);
        swr_free(&resampler); sws_freeContext(scaler); avformat_close_input(&input);
        if (output) { if (output->pb) avio_closep(&output->pb); avformat_free_context(output); }
    }
    void Open(const std::string& path) {
        Check(avformat_open_input(&input, path.c_str(), nullptr, nullptr), "Open input");
        Check(avformat_find_stream_info(input, nullptr), "Read streams");
    }
    void Decoder(int index) {
        auto* parameters = input->streams[index]->codecpar;
        const auto* decoder = avcodec_find_decoder(parameters->codec_id);
        if (!decoder) throw std::runtime_error("Decoder is unavailable");
        codec = avcodec_alloc_context3(decoder);
        if (!codec) throw std::bad_alloc();
        Check(avcodec_parameters_to_context(codec, parameters), "Configure decoder");
        Check(avcodec_open2(codec, decoder, nullptr), "Open decoder");
    }
};
class OutputFile {
    std::filesystem::path destination_, partial_;
public:
    explicit OutputFile(const std::string& destination) : destination_(destination) {
        if (!destination_.parent_path().empty()) std::filesystem::create_directories(destination_.parent_path());
        std::string pattern = destination + ".XXXXXX";
        std::vector<char> name(pattern.begin(), pattern.end()); name.push_back(0);
        int fd = mkstemp(name.data()); if (fd < 0) throw std::runtime_error("Could not reserve output");
        close(fd); partial_ = name.data();
    }
    ~OutputFile() { std::error_code ignored; std::filesystem::remove(partial_, ignored); }
    std::string Path() const { return partial_.string(); }
    void Publish() {
        // A hard link publishes atomically without overwriting an existing clip.
        if (link(partial_.c_str(), destination_.c_str()) != 0) throw std::runtime_error("Could not publish output; destination may already exist");
    }
};
std::string ClipPath(const std::string& directory, const std::string& game) {
    static std::mutex mutex; static std::vector<std::string> reserved;
    std::lock_guard lock(mutex);
    std::string safe = game.empty() ? "Unknown" : game;
    for (char& c : safe) if (std::string("<>:\"/\\|?*").find(c) != std::string::npos) c = '_';
    auto now = std::time(nullptr); std::tm local{}; localtime_r(&now, &local);
    char stamp[32]; std::strftime(stamp, sizeof(stamp), "%Y-%m-%d_%H-%M-%S", &local);
    static std::string previous;
    if (previous != stamp) { reserved.clear(); previous = stamp; }
    for (unsigned n = 1;; ++n) {
        auto path = (std::filesystem::path(directory) / safe / (std::string(stamp) + (n == 1 ? "" : "_" + std::to_string(n)) + ".mp4")).string();
        if (!std::filesystem::exists(path) && std::find(reserved.begin(), reserved.end(), path) == reserved.end()) { reserved.push_back(path); return path; }
    }
}
struct AudioPcm { std::string id; std::vector<float> samples; };

// The sequence header OBU of an AV1 temporal unit, with its own header and
// size field, or empty when the unit has none or is not in the size-prefixed
// form MP4 stores.
std::vector<uint8_t> Av1SequenceHeader(const std::vector<uint8_t>& unit) {
    size_t at = 0;
    while (at < unit.size()) {
        const uint8_t header = unit[at];
        if (!(header & 0x02)) return {};                          // obu_has_size_field
        size_t payload = at + 1 + ((header & 0x04) ? 1 : 0);      // optional extension byte
        uint64_t size = 0;
        for (int shift = 0;; shift += 7) {                        // leb128
            if (payload >= unit.size() || shift > 28) return {};
            const uint8_t byte = unit[payload++];
            size |= static_cast<uint64_t>(byte & 0x7f) << shift;
            if (!(byte & 0x80)) break;
        }
        if (size > unit.size() - payload) return {};
        const size_t next = payload + static_cast<size_t>(size);
        if (((header >> 3) & 0x0f) == 1)                          // OBU_SEQUENCE_HEADER
            return std::vector<uint8_t>(unit.begin() + static_cast<std::ptrdiff_t>(at), unit.begin() + static_cast<std::ptrdiff_t>(next));
        at = next;
    }
    return {};
}

std::vector<AudioPcm> DecodePcm(const std::string& path, uint32_t rate, uint32_t channels) {
    Media scan; scan.Open(path); std::vector<AudioPcm> tracks;
    for (unsigned index = 0; index < scan.input->nb_streams; ++index) {
        if (scan.input->streams[index]->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
        Media media; media.Open(path); media.Decoder(index);
        auto* stream = media.input->streams[index];
        const auto* title = av_dict_get(stream->metadata, "handler_name", nullptr, 0);
        if (!title || AudioTrackIndex(title->value) == kAudioTrackCount)
            title = av_dict_get(stream->metadata, "title", nullptr, 0);
        AudioPcm pcm{title ? title->value : (tracks.empty() ? "other" : "mic"), {}};
        AVChannelLayout layout{}; av_channel_layout_default(&layout, channels);
        Check(swr_alloc_set_opts2(&media.resampler, &layout, AV_SAMPLE_FMT_FLT, rate,
            &media.codec->ch_layout, media.codec->sample_fmt, media.codec->sample_rate, 0, nullptr), "Configure audio resampler");
        av_channel_layout_uninit(&layout); Check(swr_init(media.resampler), "Open audio resampler");
        auto receive = [&] {
            int result;
            while ((result = avcodec_receive_frame(media.codec, media.frame)) == 0) {
                const int capacity = swr_get_out_samples(media.resampler, media.frame->nb_samples);
                std::vector<float> converted(static_cast<size_t>(capacity) * channels);
                uint8_t* target[] = {reinterpret_cast<uint8_t*>(converted.data())};
                const int count = swr_convert(media.resampler, target, capacity,
                    const_cast<const uint8_t**>(media.frame->extended_data), media.frame->nb_samples);
                Check(count, "Resample audio");
                const auto pts = media.frame->best_effort_timestamp;
                const int64_t start = pts == AV_NOPTS_VALUE ? static_cast<int64_t>(pcm.samples.size() / channels) :
                    av_rescale_q(pts, stream->time_base, AVRational{1, static_cast<int>(rate)});
                const size_t offset = static_cast<size_t>(std::max<int64_t>(0, start)) * channels;
                pcm.samples.resize(std::max(pcm.samples.size(), offset + static_cast<size_t>(count) * channels), 0);
                std::copy_n(converted.begin(), static_cast<size_t>(count) * channels, pcm.samples.begin() + offset);
                av_frame_unref(media.frame);
            }
            if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) Check(result, "Decode audio");
        };
        while (av_read_frame(media.input, media.packet) >= 0) {
            if (media.packet->stream_index == static_cast<int>(index)) { Check(avcodec_send_packet(media.codec, media.packet), "Send audio"); receive(); }
            av_packet_unref(media.packet);
        }
        Check(avcodec_send_packet(media.codec, nullptr), "Drain audio"); receive(); tracks.push_back(std::move(pcm));
    }
    return tracks;
}

class LibavMuxer final : public ClipMuxer {
public:
    // L1 implementation, not yet compiled or exercised on Linux hardware.
    bool SupportsSmartRender() const override { return false; }
    std::string GenerateClipPath(const std::string& dir, const std::string& game) override { return ClipPath(dir, game); }
    ClipMetadata Write(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height, uint32_t fps, const std::string& game) override {
        return WriteCodec(path, video, audio, width, height, fps, game, AV_CODEC_ID_H264);
    }
    // Saved clips are always H.264; a share copy may be AV1.
    ClipMetadata WriteCodec(const std::string& path, const std::vector<EncodedPacket>& video,
        const std::vector<AudioData>& audio, uint32_t width, uint32_t height, uint32_t fps, const std::string& game,
        AVCodecID videoCodec) {
        if (video.empty() || !video.front().isKeyframe) throw std::runtime_error("Clip must begin on a video keyframe");
        const int64_t base = video.front().pts_us;
        const int64_t end = video.back().pts_us + std::max<int64_t>(video.back().duration_us, 1000000 / fps);
        OutputFile output(path); Media media;
        Check(avformat_alloc_output_context2(&media.output, nullptr, "mp4", output.Path().c_str()), "Create MP4");
        auto* stream = avformat_new_stream(media.output, nullptr); if (!stream) throw std::bad_alloc();
        stream->time_base = micros; stream->avg_frame_rate = AVRational{static_cast<int>(fps), 1};
        auto* parameters = stream->codecpar; parameters->codec_type = AVMEDIA_TYPE_VIDEO; parameters->codec_id = videoCodec;
        parameters->width = width; parameters->height = height; parameters->format = AV_PIX_FMT_YUV420P;
        parameters->color_space = AVCOL_SPC_BT709; parameters->color_range = AVCOL_RANGE_MPEG;
        // The encoder uses Annex B with inline SPS/PPS. MOV extracts these from
        // the first keyframe and converts packet start codes into length prefixes.
        // It does not do the same for AV1: without extradata the av1C box comes
        // out empty, so hand it the first keyframe's sequence header.
        if (videoCodec == AV_CODEC_ID_AV1) {
            const auto header = Av1SequenceHeader(video.front().data);
            if (header.empty()) throw NoEncoder{};
            parameters->extradata = static_cast<uint8_t*>(av_mallocz(header.size() + AV_INPUT_BUFFER_PADDING_SIZE));
            if (!parameters->extradata) throw std::bad_alloc();
            std::copy(header.begin(), header.end(), parameters->extradata);
            parameters->extradata_size = static_cast<int>(header.size());
        }
        std::vector<std::unique_ptr<Media>> encoders;
        std::vector<AudioPcm> pcm;
        for (const std::string_view name : kAudioTrackOrder) {
            const std::string id(name);
            if (std::none_of(audio.begin(), audio.end(), [&](const AudioData& p) { return p.sourceId == id; })) continue;
            AudioPcm track{id, std::vector<float>(static_cast<size_t>(av_rescale(end - base, 48000, 1000000)) * 2, 0)};
            for (const auto& p : audio) if (p.sourceId == id && p.sampleRate == 48000 && p.channels == 2 && p.samples) {
                const int64_t offset = av_rescale(p.timestamp_us - base, 48000, 1000000);
                for (uint32_t i = 0; i < p.frameCount; ++i) {
                    const int64_t at = offset + i;
                    if (at >= 0 && static_cast<size_t>(at) * 2 + 1 < track.samples.size()) {
                        track.samples[at * 2] = p.samples[i * 2]; track.samples[at * 2 + 1] = p.samples[i * 2 + 1];
                    }
                }
            }
            auto encoder = std::make_unique<Media>();
            const auto* codec = avcodec_find_encoder_by_name("aac"); if (!codec) throw std::runtime_error("Native AAC encoder unavailable");
            encoder->codec = avcodec_alloc_context3(codec); if (!encoder->codec) throw std::bad_alloc();
            auto* c = encoder->codec; c->sample_rate = 48000; c->sample_fmt = AV_SAMPLE_FMT_FLTP;
            av_channel_layout_default(&c->ch_layout, 2); c->time_base = AVRational{1, 48000}; c->bit_rate = 128000;
            c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER; Check(avcodec_open2(c, codec, nullptr), "Open AAC encoder");
            auto* audioStream = avformat_new_stream(media.output, nullptr); if (!audioStream) throw std::bad_alloc();
            audioStream->time_base = c->time_base; Check(avcodec_parameters_from_context(audioStream->codecpar, c), "Configure AAC stream");
            av_dict_set(&audioStream->metadata, "title", id.c_str(), 0);
            av_dict_set(&audioStream->metadata, "handler_name", id.c_str(), 0);
            pcm.push_back(std::move(track)); encoders.push_back(std::move(encoder));
        }
        Check(avio_open(&media.output->pb, output.Path().c_str(), AVIO_FLAG_WRITE), "Open MP4 output");
        Check(avformat_write_header(media.output, nullptr), "Write MP4 header");
        struct Packet { EncodedPacket value; int stream; AVRational timeBase; };
        std::vector<Packet> packets;
        for (const auto& p : video) { auto value = p; value.pts_us -= base; value.dts_us -= base; packets.push_back({std::move(value), 0, micros}); }
        for (size_t t = 0; t < encoders.size(); ++t) {
            auto& encoder = *encoders[t]; auto* c = encoder.codec;
            encoder.frame->format = c->sample_fmt; encoder.frame->sample_rate = c->sample_rate;
            Check(av_channel_layout_copy(&encoder.frame->ch_layout, &c->ch_layout), "Copy channel layout");
            encoder.frame->nb_samples = c->frame_size; Check(av_frame_get_buffer(encoder.frame, 0), "Allocate AAC frame");
            auto receive = [&] {
                int result;
                while ((result = avcodec_receive_packet(c, encoder.packet)) == 0) {
                    EncodedPacket value; value.data.assign(encoder.packet->data, encoder.packet->data + encoder.packet->size);
                    value.pts_us = encoder.packet->pts; value.dts_us = encoder.packet->dts; value.duration_us = encoder.packet->duration;
                    packets.push_back({std::move(value), static_cast<int>(t + 1), c->time_base}); av_packet_unref(encoder.packet);
                }
                if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) Check(result, "Encode AAC");
            };
            for (size_t at = 0; at < pcm[t].samples.size() / 2; at += c->frame_size) {
                Check(av_frame_make_writable(encoder.frame), "Write AAC frame"); encoder.frame->pts = at;
                for (int channel = 0; channel < 2; ++channel) for (int i = 0; i < c->frame_size; ++i)
                    reinterpret_cast<float*>(encoder.frame->data[channel])[i] = (at + i) * 2 + channel < pcm[t].samples.size() ? pcm[t].samples[(at + i) * 2 + channel] : 0;
                Check(avcodec_send_frame(c, encoder.frame), "Send AAC frame"); receive();
            }
            Check(avcodec_send_frame(c, nullptr), "Drain AAC"); receive();
        }
        std::stable_sort(packets.begin(), packets.end(), [](const Packet& a, const Packet& b) {
            return av_compare_ts(a.value.dts_us, a.timeBase, b.value.dts_us, b.timeBase) < 0;
        });
        for (const auto& p : packets) {
            Check(av_new_packet(media.packet, p.value.data.size()), "Allocate MP4 packet");
            std::copy(p.value.data.begin(), p.value.data.end(), media.packet->data);
            media.packet->pts = p.value.pts_us; media.packet->dts = p.value.dts_us; media.packet->duration = p.value.duration_us;
            media.packet->stream_index = p.stream; media.packet->flags = p.value.isKeyframe ? AV_PKT_FLAG_KEY : 0;
            av_packet_rescale_ts(media.packet, p.timeBase, media.output->streams[p.stream]->time_base);
            Check(av_interleaved_write_frame(media.output, media.packet), "Write MP4 packet"); av_packet_unref(media.packet);
        }
        Check(av_write_trailer(media.output), "Finish MP4"); Check(avio_closep(&media.output->pb), "Close MP4"); output.Publish();
        return {path, game, (end - base) / 1000000.0, width, height, fps, std::time(nullptr)};
    }
    VideoScan ScanVideo(const std::string& path) override {
        Media media; media.Open(path); const int video = av_find_best_stream(media.input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        Check(video, "Find video"); VideoScan scan;
        while (av_read_frame(media.input, media.packet) >= 0) {
            if (media.packet->stream_index == video) {
                const auto time = av_rescale_q(media.packet->pts, media.input->streams[video]->time_base, micros);
                if (media.packet->flags & AV_PKT_FLAG_KEY) scan.keyframesUs.push_back(time);
                scan.bytes += media.packet->size;
                scan.lastTimeUs = std::max(scan.lastTimeUs, time + av_rescale_q(media.packet->duration, media.input->streams[video]->time_base, micros));
            }
            av_packet_unref(media.packet);
        }
        return scan;
    }
    ClipMetadata Trim(const std::string& input, const std::string& output, int64_t start, int64_t end) override {
        auto scan = ScanVideo(input); int64_t boundary = 0;
        for (auto key : scan.keyframesUs) if (key <= start + 50) boundary = key;
        if (end <= start || scan.keyframesUs.empty()) throw std::runtime_error("Invalid trim range");
        Media media; media.Open(input); OutputFile file(output);
        Check(avformat_alloc_output_context2(&media.output, nullptr, "mp4", file.Path().c_str()), "Create trim output");
        int video = -1;
        for (unsigned i = 0; i < media.input->nb_streams; ++i) {
            auto* source = media.input->streams[i]; auto* target = avformat_new_stream(media.output, nullptr);
            if (!target) throw std::bad_alloc();
            Check(avcodec_parameters_copy(target->codecpar, source->codecpar), "Copy stream"); target->codecpar->codec_tag = 0;
            target->time_base = source->time_base; av_dict_copy(&target->metadata, source->metadata, 0);
            if (source->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) video = i;
        }
        Check(avio_open(&media.output->pb, file.Path().c_str(), AVIO_FLAG_WRITE), "Open trim output");
        Check(avformat_write_header(media.output, nullptr), "Write trim header");
        int64_t last = boundary;
        while (av_read_frame(media.input, media.packet) >= 0) {
            const int index = media.packet->stream_index; const auto tb = media.input->streams[index]->time_base;
            const int64_t time = av_rescale_q(media.packet->pts, tb, micros);
            if (time >= boundary && time < end) {
                if (index == video) last = std::max(last, time + av_rescale_q(media.packet->duration, tb, micros));
                const auto offset = av_rescale_q(boundary, micros, tb);
                if (media.packet->pts != AV_NOPTS_VALUE) media.packet->pts -= offset;
                if (media.packet->dts != AV_NOPTS_VALUE) media.packet->dts -= offset;
                av_packet_rescale_ts(media.packet, tb, media.output->streams[index]->time_base); media.packet->pos = -1;
                Check(av_interleaved_write_frame(media.output, media.packet), "Copy trim packet");
            }
            av_packet_unref(media.packet);
        }
        Check(av_write_trailer(media.output), "Finish trim"); Check(avio_closep(&media.output->pb), "Close trim"); file.Publish();
        auto* v = media.input->streams[video];
        return {output, "", (last - boundary) / 1000000.0, static_cast<uint32_t>(v->codecpar->width),
            static_cast<uint32_t>(v->codecpar->height), static_cast<uint32_t>(av_q2d(v->avg_frame_rate)), std::time(nullptr), boundary / 1000000.0};
    }
    std::vector<DecodedTrack> DecodeAudio(const std::string& path, uint32_t rate) override {
        std::vector<DecodedTrack> result;
        for (auto& pcm : DecodePcm(path, rate, 1)) result.push_back({pcm.id, std::move(pcm.samples)});
        return result;
    }
    // Thrown when the plan's codec cannot be produced here (no encoder, or
    // output the MP4 muxer cannot describe), so Export can step down.
    struct NoEncoder {};

    static std::vector<ExportCodec> ExportLadder(ExportCodecChoice choice) {
        if (choice == ExportCodecChoice::H264) return {ExportCodec::H264};
        // Linux skips HEVC: Chromium here decodes it only through VA-API, so an
        // HEVC copy is often a black frame in Flash's player and in Discord.
        ExportCodec forced = ExportCodec::Av1;
        if (ParseExportCodec(std::getenv("FLASH_EXPORT_CODEC"), forced) && forced != ExportCodec::Av1)
            return {ExportCodec::H264};
        return {ExportCodec::Av1, ExportCodec::H264};
    }

    // One encode at a fixed plan, written to encodedPath (which must not exist).
    ExportResult ExportOnce(const std::string& input, const std::string& encodedPath, const ExportOptions& options,
                            const ExportPlan& plan, int64_t end) {
        Media media; media.Open(input); const int index = av_find_best_stream(media.input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        Check(index, "Find export video"); auto* stream = media.input->streams[index]; media.Decoder(index);
        const uint32_t sourceFps = static_cast<uint32_t>(std::max(1, static_cast<int>(av_q2d(stream->avg_frame_rate) + 0.5)));
        EncoderConfig config; config.width = plan.width; config.height = plan.height; config.fps = plan.fps; config.bitrate = plan.videoKbps * 1000;
        config.codec = ExportCodecName(plan.codec);
        // Only size-limited exports get the share-copy tuning; an editor save
        // keeps the capture settings and only gains the High profile.
        config.highProfile = true; config.exportQuality = options.maxBytes < kExportUnlimitedBytes;
        auto encoder = CreateEncoder(config); if (!encoder) throw NoEncoder{};
        std::vector<EncodedPacket> encoded; std::vector<uint8_t> pixels(static_cast<size_t>(plan.width) * plan.height * 4);
        // Below the source rate, frames are re-timed onto an even grid. At the
        // source rate they keep their own timestamps.
        const bool regrid = plan.fps < sourceFps; FrameGrid grid{plan.fps};
        auto receive = [&] {
            int result;
            while ((result = avcodec_receive_frame(media.codec, media.frame)) == 0) {
                auto time = av_rescale_q(media.frame->best_effort_timestamp, stream->time_base, micros);
                bool keep = time >= options.startUs && time < end;
                if (keep && regrid) {
                    const int64_t slot = grid.Take(time - options.startUs);
                    keep = slot >= 0;
                    if (keep) time = options.startUs + slot * 1000000 / plan.fps;
                }
                if (keep) {
                    media.scaler = sws_getCachedContext(media.scaler, media.frame->width, media.frame->height,
                        static_cast<AVPixelFormat>(media.frame->format), plan.width, plan.height, AV_PIX_FMT_BGR0, SWS_BICUBIC, nullptr, nullptr, nullptr);
                    if (!media.scaler) throw std::runtime_error("Export conversion unavailable");
                    uint8_t* dest[] = {pixels.data()}; int strides[] = {static_cast<int>(plan.width * 4)};
                    sws_scale(media.scaler, media.frame->data, media.frame->linesize, 0, media.frame->height, dest, strides);
                    if (options.saturation != 100) for (size_t i = 0; i < pixels.size(); i += 4) {
                        const double luma = 0.0722 * pixels[i] + 0.7152 * pixels[i + 1] + 0.2126 * pixels[i + 2];
                        for (size_t c = 0; c < 3; ++c) pixels[i + c] = static_cast<uint8_t>(std::clamp(luma +
                            (pixels[i + c] - luma) * options.saturation / 100.0, 0.0, 255.0));
                    }
                    FrameData frame{}; frame.data = pixels.data(); frame.width = plan.width; frame.height = plan.height;
                    frame.stride = plan.width * 4; frame.timestamp_us = time;
                    if (!encoder->EncodeFrame(frame, encoded)) throw std::runtime_error("Export encoding failed");
                }
                av_frame_unref(media.frame);
            }
            if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) Check(result, "Decode export video");
        };
        while (av_read_frame(media.input, media.packet) >= 0) {
            if (media.packet->stream_index == index) { Check(avcodec_send_packet(media.codec, media.packet), "Send export video"); receive(); }
            av_packet_unref(media.packet);
        }
        Check(avcodec_send_packet(media.codec, nullptr), "Drain export decoder"); receive();
        if (!encoder->Drain(encoded)) throw std::runtime_error("Could not drain export encoder");
        if (encoded.empty()) throw std::runtime_error("Export range contains no video");
        const auto start = encoded.front().pts_us;
        std::vector<float> mixed(static_cast<size_t>(av_rescale(end - start, 48000, 1000000)) * 2, 0);
        for (const auto& track : DecodePcm(input, 48000, 2)) {
            // A track this build does not know keeps unity gain and is still mixed.
            const size_t position = AudioTrackIndex(track.id);
            const float gain = position < kAudioTrackCount ? options.gains[position] : 1.0f;
            const auto offset = static_cast<size_t>(av_rescale(start, 48000, 1000000)) * 2;
            for (size_t i = 0; i < mixed.size() && offset + i < track.samples.size(); ++i) mixed[i] += track.samples[offset + i] * gain;
        }
        for (auto& sample : mixed) sample = std::clamp(sample, -1.0f, 1.0f);
        AudioData audio{mixed.data(), static_cast<uint32_t>(mixed.size() / 2), 2, 48000, start, "other"};
        auto metadata = WriteCodec(encodedPath, encoded, {audio}, plan.width, plan.height, plan.fps, "",
            plan.codec == ExportCodec::Av1 ? AV_CODEC_ID_AV1 : AV_CODEC_ID_H264);
        return {"", metadata.durationSeconds, plan.width, plan.height, std::filesystem::file_size(encodedPath),
            plan.videoKbps, ExportCodecName(plan.codec)};
    }

    ExportResult Export(const std::string& input, const std::string& output, const ExportOptions& options) override {
        uint32_t width = 0, height = 0, fps = 30;
        {
            Media probe; probe.Open(input); const int index = av_find_best_stream(probe.input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
            Check(index, "Find export video"); probe.Decoder(index);
            width = probe.codec->width; height = probe.codec->height;
            fps = static_cast<uint32_t>(std::max(1, static_cast<int>(av_q2d(probe.input->streams[index]->avg_frame_rate) + 0.5)));
        }
        const int64_t last = ScanVideo(input).lastTimeUs;
        const int64_t end = options.endUs ? options.endUs : last;
        // The source's overall bitrate caps a size-limited copy.
        const uint32_t sourceKbps = options.maxBytes < kExportUnlimitedBytes && last > 0
            ? static_cast<uint32_t>(std::min(static_cast<double>(kExportMaxVideoKbps),
                std::filesystem::file_size(input) * 8.0 / 1000.0 / (last / 1000000.0)))
            : 0;
        // Each attempt is encoded beside the staged file and only moved onto it
        // when it fits and is the largest so far, so a retry that overshoots
        // cannot cost the copy that already fit.
        OutputFile staged(output);
        const std::string encodedPath = staged.Path() + ".mp4";
        struct Remove { std::string path; ~Remove() { std::error_code error; std::filesystem::remove(path, error); } } cleanup{encodedPath};
        const std::vector<ExportCodec> ladder = ExportLadder(options.codec);
        for (ExportCodec codec : ladder) {
            ExportPlan plan = PlanExport(width, height, fps, (end - options.startUs) / 1000000.0, options.maxBytes,
                options.maxHeight, codec, options.maxFps, sourceKbps);
            if (!plan.videoKbps) throw std::runtime_error("Export budget is too small");
            ExportResult best; bool kept = false;
            try {
                for (int round = 0; round < 3 && plan.width; ++round) {
                    std::error_code ignored; std::filesystem::remove(encodedPath, ignored);
                    ExportResult result;
                    try {
                        result = ExportOnce(input, encodedPath, options, plan, end);
                    } catch (const std::exception& error) {
                        // A copy that already fits outranks a failed retry.
                        if (kept) break;
                        // A hardware encoder can accept set-up and then fail on
                        // the first frame or at the trailer. With nothing kept
                        // and an older codec left, that is a reason to step
                        // down, not to fail. The last codec's error is the real
                        // one, and no codec can fix a bad argument.
                        if (codec == ladder.back() || dynamic_cast<const std::invalid_argument*>(&error)) throw;
                        throw NoEncoder{};
                    }
                    if (result.bytes <= options.maxBytes && (!kept || result.bytes > best.bytes)) {
                        std::filesystem::rename(encodedPath, staged.Path()); best = result; kept = true;
                    }
                    if (!ExportNeedsRetry(plan, options.maxBytes, result.bytes)) break;
                    plan = RetryExportPlan(plan, options.maxBytes, result.bytes);
                }
            } catch (const NoEncoder&) {
                if (!kept) continue;   // next step of the ladder
            }
            if (!kept) throw std::runtime_error("Encoded export exceeds the requested size budget");
            staged.Publish(); best.filePath = output; return best;
        }
        throw std::runtime_error("No LGPL video encoder available");
    }
};
}
std::unique_ptr<ClipMuxer> CreateLibavMuxer() { return std::make_unique<LibavMuxer>(); }
void WriteLinuxPng(const std::string& path, const FrameData& source) {
    CheckLibavLicense(); Media media; OutputFile output(path);
    const auto* codec = avcodec_find_encoder_by_name("png"); if (!codec) throw std::runtime_error("PNG encoder unavailable");
    media.codec = avcodec_alloc_context3(codec); if (!media.codec) throw std::bad_alloc();
    media.codec->width = source.width; media.codec->height = source.height; media.codec->pix_fmt = AV_PIX_FMT_RGB24;
    media.codec->time_base = AVRational{1, 1}; Check(avcodec_open2(media.codec, codec, nullptr), "Open PNG encoder");
    media.frame->width = source.width; media.frame->height = source.height; media.frame->format = AV_PIX_FMT_RGB24;
    Check(av_frame_get_buffer(media.frame, 0), "Allocate PNG frame");
    media.scaler = sws_getContext(source.width, source.height, source.rgb ? AV_PIX_FMT_RGB0 : AV_PIX_FMT_BGR0,
        source.width, source.height, AV_PIX_FMT_RGB24, SWS_POINT, nullptr, nullptr, nullptr);
    if (!media.scaler) throw std::runtime_error("PNG conversion unavailable");
    const uint8_t* data[] = {source.data}; const int strides[] = {static_cast<int>(source.stride)};
    sws_scale(media.scaler, data, strides, 0, source.height, media.frame->data, media.frame->linesize);
    Check(avcodec_send_frame(media.codec, media.frame), "Send PNG frame");
    Check(avcodec_receive_packet(media.codec, media.packet), "Encode PNG");
    std::ofstream file(output.Path(), std::ios::binary); file.write(reinterpret_cast<const char*>(media.packet->data), media.packet->size);
    file.close(); if (!file) throw std::runtime_error("Could not write PNG"); output.Publish();
}
} // namespace flash

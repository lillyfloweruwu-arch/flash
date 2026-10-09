#include "../src/platform/windows/media_output.h"
#include "../src/platform/windows/png_writer.h"
#include "../src/core/clip_writer.h"
#include <cassert>
#include <fstream>
#include <iostream>
#include <wincodec.h>
#include <wrl/client.h>

int main() {
    const auto dir = std::filesystem::temp_directory_path() /
        (L"flash-publication-" + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::create_directories(dir);
    const auto destination = dir / "fixture.png";
    const uint8_t pixels[] = {0, 0, 255, 255};
    flash::WritePng(destination.string(), pixels, 1, 1, 4);
    const auto bytes = [](const auto& path) {
        std::ifstream file(path, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(file), {});
    };
    const auto before = bytes(destination);
    bool refused = false;
    try { flash::WritePng(destination.string(), pixels, 1, 1, 4); }
    catch (const std::exception&) { refused = true; }
    assert(refused && bytes(destination) == before);

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    {
        Microsoft::WRL::ComPtr<IWICImagingFactory> factory;
        assert(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))));
        Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
        assert(SUCCEEDED(factory->CreateDecoderFromFilename(destination.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, &decoder)));
        Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
        assert(SUCCEEDED(decoder->GetFrame(0, &frame)));
        UINT width = 0, height = 0;
        assert(SUCCEEDED(frame->GetSize(&width, &height)) && width == 1 && height == 1);
    }
    CoUninitialize();

    const auto failed = dir / "failed.mp4";
    try {
        flash::MediaOutput output(failed);
        std::ofstream(output.Partial()) << "unfinished";
        assert(!std::filesystem::exists(failed));
        throw std::runtime_error("injected writer failure");
    } catch (const std::exception&) {}
    assert(!std::filesystem::exists(failed));

    const auto existing = dir / "existing.mp4";
    std::ofstream(existing) << "keep this recording";
    flash::EncodedPacket packet{};
    packet.data = {0, 0, 0, 1};
    refused = false;
    try { flash::ClipWriter().Write(existing.string(), {packet}, {}, 2, 2, 30, "Fixture"); }
    catch (const std::exception&) { refused = true; }
    assert(refused && bytes(existing) == "keep this recording");
    for (const auto& entry : std::filesystem::directory_iterator(dir))
        assert(entry.path().filename().string().find(".partial.") == std::string::npos);
    std::filesystem::remove_all(dir);
    std::cout << "PASS: PNG reopens, existing PNG/MP4 unchanged, injected failure unpublished, no partials\n";
}

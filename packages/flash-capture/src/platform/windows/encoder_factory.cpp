#include "../../core/encoder.h"
#include "mf_hardware_encoder.h"
#include "software_encoder.h"

#ifdef _WIN32
#include <dxgi.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
#pragma comment(lib, "dxgi.lib")
#endif

namespace flash {

GpuVendor DetectGpuVendor() {
#ifdef _WIN32
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf()));
    if (FAILED(hr)) return GpuVendor::Unknown;

    ComPtr<IDXGIAdapter1> adapter;
    hr = factory->EnumAdapters1(0, &adapter);
    if (FAILED(hr)) return GpuVendor::Unknown;

    DXGI_ADAPTER_DESC1 desc;
    adapter->GetDesc1(&desc);

    // NVIDIA vendor ID: 0x10DE
    // AMD vendor ID: 0x1002
    // Intel vendor ID: 0x8086
    switch (desc.VendorId) {
        case 0x10DE: return GpuVendor::Nvidia;
        case 0x1002: return GpuVendor::Amd;
        case 0x8086: return GpuVendor::Intel;
        default:     return GpuVendor::Unknown;
    }
#else
    return GpuVendor::Unknown;
#endif
}

std::unique_ptr<Encoder> CreateEncoder() {
    return CreateEncoder(EncoderConfig{});
}

std::unique_ptr<Encoder> CreateEncoder(const EncoderConfig& defaultConfig) {
    auto hardware = std::make_unique<MfHardwareEncoder>();
    if (hardware->Initialize(defaultConfig)) return hardware;

    // Fall back to software encoder
    auto software = std::make_unique<SoftwareEncoder>();
    if (software->Initialize(defaultConfig)) {
        return software;
    }

    return nullptr; // No encoder available (should never happen on Windows 10+)
}

} // namespace flash

// L1 backend: not yet compiled or run on Linux hardware.
#include "linux_backend.h"
#include <gio/gunixfdlist.h>
#include <algorithm>
#include <mutex>
#include <stdexcept>
#include <unistd.h>

namespace flash {
namespace {
constexpr auto service = "org.freedesktop.portal.Desktop";
constexpr auto object = "/org/freedesktop/portal/desktop";
constexpr auto screencast = "org.freedesktop.portal.ScreenCast";
std::mutex tokenMutex;
std::string restoreToken;
std::function<void(const std::string&)> tokenCallback;
std::atomic<uint64_t> sequence{0};
using Variant = std::unique_ptr<GVariant, decltype(&g_variant_unref)>;
std::string Token() { return "flash_" + std::to_string(getpid()) + "_" + std::to_string(sequence++); }
std::runtime_error Error(GError* error) {
    std::string message = error ? error->message : "Portal request failed";
    if (error) g_error_free(error);
    return std::runtime_error(message);
}
struct Response { bool done = false; guint code = 2; GVariant* values = nullptr; };

// Subscribe before making the call. A restored session can reply before the
// method itself returns, so subscribing to the returned handle loses replies.
Variant Request(GDBusConnection* bus, const char* method, const std::string& token,
                GVariant* parameters, GCancellable* cancel) {
    std::string sender = g_dbus_connection_get_unique_name(bus) + 1;
    std::replace(sender.begin(), sender.end(), '.', '_');
    const std::string path = std::string(object) + "/request/" + sender + "/" + token;
    Response response;
    const guint subscription = g_dbus_connection_signal_subscribe(bus, service,
        "org.freedesktop.portal.Request", "Response", path.c_str(), nullptr,
        G_DBUS_SIGNAL_FLAGS_NONE, [](GDBusConnection*, const gchar*, const gchar*,
            const gchar*, const gchar*, GVariant* value, gpointer data) {
            auto& result = *static_cast<Response*>(data);
            g_variant_get(value, "(u@a{sv})", &result.code, &result.values);
            result.done = true;
        }, &response, nullptr);
    GError* error = nullptr;
    Variant reply(g_dbus_connection_call_sync(bus, service, object, screencast, method,
        parameters, G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 30000, cancel, &error), g_variant_unref);
    const gint64 deadline = g_get_monotonic_time() + 120 * G_USEC_PER_SEC;
    auto* context = g_main_context_get_thread_default();
    while (reply && !response.done && !g_cancellable_is_cancelled(cancel) && g_get_monotonic_time() < deadline) {
        while (g_main_context_iteration(context, false)) {}
        g_usleep(10000);
    }
    g_dbus_connection_signal_unsubscribe(bus, subscription);
    Variant values(response.values, g_variant_unref);
    if (!reply) throw Error(error);
    if (!response.done) {
        Variant closed(g_dbus_connection_call_sync(bus, service, path.c_str(),
            "org.freedesktop.portal.Request", "Close", nullptr, nullptr,
            G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, nullptr), g_variant_unref);
        throw std::runtime_error("Screen sharing cancelled or portal timed out");
    }
    if (response.code != 0) throw std::runtime_error("Screen sharing permission was cancelled or denied");
    return values;
}
GVariantBuilder Options(const std::string& token) {
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
    return options;
}
}
void SetPortalRestoreToken(const std::string& token, std::function<void(const std::string&)> callback) {
    std::lock_guard lock(tokenMutex); restoreToken = token; tokenCallback = std::move(callback);
}
PortalSession::~PortalSession() {
    if (fd_ >= 0) close(fd_);
    if (bus_) {
        if (!session_.empty()) {
            Variant reply(g_dbus_connection_call_sync(bus_, service, session_.c_str(),
                "org.freedesktop.portal.Session", "Close", nullptr, nullptr,
                G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, nullptr), g_variant_unref);
        }
        g_object_unref(bus_);
    }
}
int PortalSession::TakeFd() { const int fd = fd_; fd_ = -1; return fd; }
void PortalSession::Open(GCancellable* cancel) {
    // L1: permission UI, cancellation, persistence and fd ownership need L2 hardware tests.
    GError* error = nullptr;
    bus_ = g_bus_get_sync(G_BUS_TYPE_SESSION, cancel, &error);
    if (!bus_) throw Error(error);
    auto token = Token(); auto options = Options(token);
    g_variant_builder_add(&options, "{sv}", "session_handle_token", g_variant_new_string(Token().c_str()));
    auto created = Request(bus_, "CreateSession", token, g_variant_new("(a{sv})", &options), cancel);
    const gchar* session = nullptr;
    if (!g_variant_lookup(created.get(), "session_handle", "&s", &session)) throw std::runtime_error("Portal omitted session handle");
    session_ = session;
    token = Token(); options = Options(token);
    g_variant_builder_add(&options, "{sv}", "types", g_variant_new_uint32(3));
    g_variant_builder_add(&options, "{sv}", "multiple", g_variant_new_boolean(false));
    g_variant_builder_add(&options, "{sv}", "persist_mode", g_variant_new_uint32(2));
    {
        std::lock_guard lock(tokenMutex);
        if (!restoreToken.empty()) g_variant_builder_add(&options, "{sv}", "restore_token", g_variant_new_string(restoreToken.c_str()));
    }
    Request(bus_, "SelectSources", token, g_variant_new("(oa{sv})", session_.c_str(), &options), cancel);
    token = Token(); options = Options(token);
    auto started = Request(bus_, "Start", token, g_variant_new("(osa{sv})", session_.c_str(), "", &options), cancel);
    Variant streams(g_variant_lookup_value(started.get(), "streams", G_VARIANT_TYPE("a(ua{sv})")), g_variant_unref);
    if (!streams || !g_variant_n_children(streams.get())) throw std::runtime_error("Portal returned no video streams");
    Variant stream(g_variant_get_child_value(streams.get(), 0), g_variant_unref);
    GVariant* properties = nullptr;
    g_variant_get(stream.get(), "(u@a{sv})", &node, &properties);
    Variant props(properties, g_variant_unref);
    guint64 streamSerial = 0;
    if (g_variant_lookup(props.get(), "pipewire-serial", "t", &streamSerial)) serial = std::to_string(streamSerial);
    const gchar* replacement = nullptr;
    g_variant_lookup(started.get(), "restore_token", "&s", &replacement);
    {
        // No replacement means persistence was not granted. Clear the consumed
        // token rather than retrying it forever on subsequent launches.
        const std::string next = replacement ? replacement : "";
        std::function<void(const std::string&)> callback;
        { std::lock_guard lock(tokenMutex); restoreToken = next; callback = tokenCallback; }
        if (callback) callback(next);
    }
    GUnixFDList* descriptors = nullptr;
    GVariantBuilder empty; g_variant_builder_init(&empty, G_VARIANT_TYPE_VARDICT);
    Variant remote(g_dbus_connection_call_with_unix_fd_list_sync(bus_, service, object, screencast,
        "OpenPipeWireRemote", g_variant_new("(oa{sv})", session_.c_str(), &empty), G_VARIANT_TYPE("(h)"),
        G_DBUS_CALL_FLAGS_NONE, 30000, nullptr, &descriptors, cancel, &error), g_variant_unref);
    if (!remote) throw Error(error);
    gint index = -1; g_variant_get(remote.get(), "(h)", &index);
    fd_ = g_unix_fd_list_get(descriptors, index, &error); g_object_unref(descriptors);
    if (fd_ < 0) throw Error(error);
}
} // namespace flash

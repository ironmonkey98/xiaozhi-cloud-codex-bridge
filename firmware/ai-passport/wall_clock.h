#pragma once
#include <atomic>
#include <cstdint>
#include <ctime>

// XiaoZhi's existing screen clock stores local civil time as its epoch value.
// Preserve that UI convention, but compare network deadlines against UTC.
namespace WallClock {
inline std::atomic<int> timezone_offset_minutes{0};
inline int64_t ToUtcMilliseconds(int64_t local_ms, int offset_minutes) {
    return local_ms - static_cast<int64_t>(offset_minutes) * 60 * 1000;
}
inline int64_t UtcMilliseconds() {
    return ToUtcMilliseconds(static_cast<int64_t>(std::time(nullptr)) * 1000,
                             timezone_offset_minutes.load());
}
}  // namespace WallClock

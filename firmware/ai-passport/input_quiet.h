#pragma once
#include <cstddef>
#include <cstdint>
namespace InputQuiet {
// Non-silence detection, not speech recognition. Ignore DC offset.
// 240 PCM RMS leaves margin above the measured ES8311 quiet-input floor (~100).
inline uint32_t SoundVariance(const int16_t* samples, size_t size, size_t channels) {
    if (!samples || !size || !channels)
        return 0;
    int64_t sum = 0, squares = 0, count = 0;
    for (size_t i = 0; i < size; i += channels) {
        int64_t value = samples[i];
        sum += value;
        squares += value * value;
        ++count;
    }
    return count ? (squares * count - sum * sum) / (count * count) : 0;
}
inline bool HasSoundActivity(const int16_t* samples, size_t size, size_t channels) {
    return SoundVariance(samples, size, channels) >= 240U * 240U;
}
inline bool CanYield(uint32_t now, uint32_t started, uint32_t seen, uint32_t sound,
                     bool waiting_for_reply, bool manual, bool playback_idle) {
    return !waiting_for_reply && !manual && playback_idle && seen != 0 &&
           uint32_t(now - seen) < 300 && uint32_t(now - started) >= 15000 &&
           uint32_t(now - sound) >= 15000;
}
}  // namespace InputQuiet

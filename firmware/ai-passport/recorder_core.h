#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <new>

namespace Recorder {
// Call from one thread, or use a caller-owned lock. Times are monotonic milliseconds.
using Id = std::array<uint8_t, 16>;
inline constexpr auto CrcTable() noexcept {
    std::array<uint32_t, 256> table{};
    for (uint32_t i = 0; i < 256; ++i) {
        uint32_t c = i;
        for (int j = 0; j < 8; ++j) c = (c >> 1) ^ ((c & 1) ? 0xedb88320U : 0U);
        table[i] = c;
    }
    return table;
}
inline constexpr auto kCrcTable = CrcTable();
inline uint32_t Crc32(const uint8_t* data, size_t size) noexcept {
    uint32_t c = 0xffffffffU;
    for (size_t i = 0; i < size; ++i) c = kCrcTable[(c ^ data[i]) & 255] ^ (c >> 8);
    return c ^ 0xffffffffU;
}
inline void Put32(uint8_t* p, uint32_t n) noexcept {
    for (unsigned i = 0; i < 4; ++i) p[i] = static_cast<uint8_t>(n >> (8 * i));
}
inline uint32_t Get32(const uint8_t* p) noexcept {
    uint32_t n = 0;
    for (unsigned i = 0; i < 4; ++i) n |= uint32_t(p[i]) << (8 * i);
    return n;
}
struct PacketView { const uint8_t* data = nullptr; size_t size = 0; };
// Sink must not throw and must copy the view before return.
// False leaves the sealed packet for retry. After SinkFull, only call Flush().
using PacketSink = bool (*)(void*, PacketView);
enum class PackResult { Ok, InvalidFrame, SinkFull, Exhausted };
class Packetizer {
public:
    Packetizer(Id session, PacketSink sink, void* context, size_t max_packet_bytes = 768) noexcept
        : session_(session), sink_(sink), context_(context), limit_(max_packet_bytes) {}
    PackResult AddFrame(uint32_t index, const uint8_t* data, size_t len) noexcept {
        if (limit_ < 38 || limit_ > 768 || len > 1275 || len + 38 > limit_ ||
            (len && !data) || (have_frame_ && uint64_t(index) < next_frame_))
            return PackResult::InvalidFrame;
        if (count_ && (uint64_t(index) != next_frame_ || count_ == 16 || size_ + len + 2 > limit_)) {
            const auto r = Flush();
            if (r != PackResult::Ok) return r;
        }
        if (next_seq_ > UINT32_MAX) return PackResult::Exhausted;
        if (!count_) first_ = index;
        bytes_[size_++] = static_cast<uint8_t>(len);
        bytes_[size_++] = static_cast<uint8_t>(len >> 8);
        if (len) std::memcpy(bytes_.data() + size_, data, len);
        size_ += len;
        ++count_;
        next_frame_ = uint64_t(index) + 1;
        have_frame_ = true;
        return PackResult::Ok;
    }
    PackResult Flush() noexcept {
        if (!count_) return PackResult::Ok;
        std::memcpy(bytes_.data(), "APR1", 4);
        std::memcpy(bytes_.data() + 4, session_.data(), 16);
        Put32(bytes_.data() + 20, static_cast<uint32_t>(next_seq_));
        Put32(bytes_.data() + 24, first_);
        bytes_[28] = count_;
        bytes_[29] = bytes_[30] = bytes_[31] = 0;
        Put32(bytes_.data() + 32, Crc32(bytes_.data() + 36, size_ - 36));
        // Sealed sequence includes a packet rejected by the window.
        highest_sealed_ = static_cast<int64_t>(next_seq_);
        if (!sink_ || !sink_(context_, {bytes_.data(), size_})) return PackResult::SinkFull;
        ++next_seq_;
        count_ = 0;
        size_ = 36;
        return PackResult::Ok;
    }
    int64_t highest_sealed_seq() const noexcept { return highest_sealed_; }
private:
    std::array<uint8_t, 768> bytes_{};
    Id session_;
    PacketSink sink_;
    void* context_;
    size_t limit_, size_ = 36;
    uint64_t next_seq_ = 0, next_frame_ = 0;
    int64_t highest_sealed_ = -1;
    uint32_t first_ = 0;
    uint8_t count_ = 0;
    bool have_frame_ = false;
};

class SendWindow {
public:
    // Capacity includes a two-byte length per packet. At most 64 KiB is allocated.
    explicit SendWindow(size_t capacity = 12 * 1024, uint64_t retransmit_ms = 3000) noexcept
        : capacity_(capacity >= 40 && capacity <= 65536 ? capacity : 0),
          storage_(capacity_ ? new (std::nothrow) uint8_t[capacity_] : nullptr),
          retransmit_ms_(retransmit_ms) {}
    bool valid() const noexcept { return storage_ != nullptr; }
    bool Push(PacketView p) noexcept {
        if (!valid() || !p.data || p.size < 38 || p.size > 768 ||
            std::memcmp(p.data, "APR1", 4) != 0) return false;
        const uint32_t seq = Get32(p.data + 20);
        if (int64_t(seq) != highest_ + 1 || p.size + 2 > capacity_ - used_) return false;
        const size_t tail = (head_ + used_) % capacity_;
        Write(tail, static_cast<uint8_t>(p.size));
        Write(tail + 1, static_cast<uint8_t>(p.size >> 8));
        for (size_t i = 0; i < p.size; ++i) Write(tail + 2 + i, p.data[i]);
        used_ += p.size + 2;
        bytes_ += p.size;
        highest_ = seq;
        return true;
    }
    // Ignore impossible ACKs as well as old ACKs. now_ms refreshes the ACK timer.
    void OnAck(int64_t seq, uint64_t now_ms) noexcept {
        if (seq <= acked_ || seq > sent_highest_) return;
        while (used_ && HeadSeq() <= seq) {
            const size_t n = Length(head_);
            head_ = (head_ + n + 2) % capacity_;
            used_ -= n + 2;
            bytes_ -= n;
        }
        acked_ = seq;
        if (next_ <= seq) next_ = seq + 1;
        progress_ = now_ms;
        timed_ = used_ != 0 && acked_ < sent_highest_;
    }
    // View lasts until the next Next(). Calling Next commits a send attempt.
    // Do not call while disconnected. MQTT must copy the returned bytes.
    PacketView Next(uint64_t now_ms) noexcept {
        if (!used_) return {};
        if (timed_ && now_ms - progress_ >= retransmit_ms_) {
            next_ = acked_ + 1;
            progress_ = now_ms;
        }
        size_t offset = 0;
        while (offset < used_) {
            const size_t pos = (head_ + offset) % capacity_;
            const size_t n = Length(pos);
            uint8_t seq_bytes[4];
            for (size_t i = 0; i < 4; ++i) seq_bytes[i] = Read(pos + 22 + i);
            const int64_t seq = Get32(seq_bytes);
            if (seq == next_) {
                for (size_t i = 0; i < n; ++i) scratch_[i] = Read(pos + 2 + i);
                if (seq <= sent_highest_) ++retransmissions_;
                else sent_highest_ = seq;
                ++next_;
                if (!timed_) { timed_ = true; progress_ = now_ms; }
                return {scratch_.data(), n};
            }
            offset += n + 2;
        }
        return {};
    }
    int64_t acknowledged_seq() const noexcept { return acked_; }
    int64_t highest_sealed_seq() const noexcept { return highest_; }
    size_t in_flight_bytes() const noexcept { return bytes_; }
    size_t storage_bytes() const noexcept { return used_; }
    uint64_t retransmissions() const noexcept { return retransmissions_; }
private:
    uint8_t Read(size_t p) const noexcept { return storage_[p % capacity_]; }
    void Write(size_t p, uint8_t v) noexcept { storage_[p % capacity_] = v; }
    size_t Length(size_t p) const noexcept { return size_t(Read(p)) | (size_t(Read(p + 1)) << 8); }
    int64_t HeadSeq() const noexcept {
        uint8_t b[4];
        for (size_t i = 0; i < 4; ++i) b[i] = Read(head_ + 22 + i);
        return Get32(b);
    }
    size_t capacity_, head_ = 0, used_ = 0, bytes_ = 0;
    std::unique_ptr<uint8_t[]> storage_;
    std::array<uint8_t, 768> scratch_{};
    uint64_t retransmit_ms_, progress_ = 0, retransmissions_ = 0;
    int64_t highest_ = -1, sent_highest_ = -1, acked_ = -1, next_ = 0;
    bool timed_ = false;
};

enum class State { Idle, StartRequested, Recording, Finishing, Saved, Partial, Failed };
enum class Reason { User, MaxDuration, QueueOverflow, Network, Error };
enum class AckType { Start, Chunk, Finish, Error };
enum class FinishState { Saved, Partial, Failed };
enum class ErrorCode { Busy, BadRequest, NoSpace, Unavailable, UnknownSession, TooLong };
struct Ack {
    AckType type = AckType::Start;
    Id request_id{}, session_id{};
    bool has_request = false, has_session = false;
    size_t max_packet_bytes = 768;
    int64_t persisted_seq = -1;
    uint64_t frames = 0;
    FinishState state = FinishState::Failed;
    ErrorCode code = ErrorCode::BadRequest;
};
struct Actions {
    bool send_start = false, flush_and_stop = false, apply_ack = false, display = false;
    int64_t persisted_seq = -1;
    State state = State::Idle;
    Reason reason = Reason::User;
    ErrorCode error = ErrorCode::BadRequest;
};
struct JsonText { std::array<char, 512> data{}; size_t size = 0; };
inline void Hex(const Id& id, char* out) noexcept {
    constexpr char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < 16; ++i) { out[2*i] = digits[id[i] >> 4]; out[2*i+1] = digits[id[i] & 15]; }
    out[32] = '\0';
}
inline const char* ReasonText(Reason r) noexcept {
    switch (r) {
        case Reason::User: return "user";
        case Reason::MaxDuration: return "max_duration";
        case Reason::QueueOverflow: return "queue_overflow";
        case Reason::Network: return "network";
        case Reason::Error: return "error";
    }
    return "error";
}
class RecorderState {
public:
    explicit RecorderState(uint64_t network_timeout_ms = 10000, uint32_t max_duration_s = 7200) noexcept
        : network_timeout_(network_timeout_ms), max_duration_(max_duration_s >= 1 && max_duration_s <= 14400 ? max_duration_s : 7200) {}
    Actions Toggle(uint64_t now_ms, Id random_bytes = {}) noexcept {
        if (state_ == State::Idle) {
            request_ = random_bytes;
            reason_ = Reason::User;
            frames_ = dropped_ = duration_ = 0;
            since_ = now_ms;
            state_ = State::StartRequested;
            auto a = View(); a.send_start = a.display = true; return a;
        }
        if (state_ == State::Recording) return Stop(Reason::User, now_ms);
        if (state_ == State::Saved || state_ == State::Partial || state_ == State::Failed) {
            state_ = State::Idle; auto a = View(); a.display = true; return a;
        }
        return View();
    }
    Actions OnAck(const Ack& ack, uint64_t now_ms) noexcept {
        const auto timeout = Tick(now_ms);
        if (timeout.display) return timeout;
        if (ack.type == AckType::Start && state_ == State::StartRequested &&
            ack.has_request && ack.request_id == request_ && ack.has_session) {
            if (ack.max_packet_bytes < 38 || ack.max_packet_bytes > 768) return Result(State::Failed);
            session_ = ack.session_id; limit_ = ack.max_packet_bytes;
            since_ = now_ms;
            if (!online_) disconnected_ = now_ms;
            return Result(State::Recording);
        }
        if (ack.type == AckType::Error) {
            const bool match = state_ == State::StartRequested
                ? ack.has_request && ack.request_id == request_
                : ack.has_session && ack.session_id == session_;
            if (!match) return View();
            if (state_ == State::Recording) { auto a = Stop(Reason::Error, now_ms); a.error = ack.code; return a; }
            if (state_ == State::StartRequested || state_ == State::Finishing) {
                auto a = Result(State::Failed); a.error = ack.code; return a;
            }
        }
        if (!ack.has_session || ack.session_id != session_) return View();
        if (ack.type == AckType::Chunk && (state_ == State::Recording || state_ == State::Finishing)) {
            auto a = View(); a.apply_ack = true; a.persisted_seq = ack.persisted_seq; return a;
        }
        if (ack.type == AckType::Finish && state_ == State::Finishing) {
            return Result(ack.state == FinishState::Saved ?
                          (reason_ == Reason::QueueOverflow ? State::Partial : State::Saved) :
                          ack.state == FinishState::Partial ? State::Partial : State::Failed);
        }
        return View();
    }
    Actions Overflow(uint64_t now_ms) noexcept { return Stop(Reason::QueueOverflow, now_ms); }
    Actions Network(bool online, uint64_t now_ms) noexcept {
        const auto action = Tick(now_ms);
        if (online_ && !online) disconnected_ = now_ms;
        online_ = online;
        return action;
    }
    Actions Tick(uint64_t now_ms) noexcept {
        if (state_ == State::StartRequested && now_ms - since_ >= 5000) return Result(State::Failed);
        // A timeout cannot prove that the server saved a playable file.
        if (state_ == State::Finishing && now_ms - since_ >= 30000) return Result(State::Failed);
        if (state_ == State::Recording) {
            if (!online_ && now_ms - disconnected_ >= network_timeout_) return Stop(Reason::Network, now_ms);
            if (now_ms - since_ >= uint64_t(max_duration_) * 1000) return Stop(Reason::MaxDuration, now_ms);
        }
        return View();
    }
    // Call once for each accepted frame. Report upstream drops separately.
    bool Frame(uint32_t index) noexcept {
        if (state_ != State::Recording || (uint64_t(index) + 1) * 60 <= duration_) return false;
        ++frames_; duration_ = (uint64_t(index) + 1) * 60; return true;
    }
    void Dropped(uint32_t count) noexcept { if (state_ == State::Recording) dropped_ += count; }
    JsonText StartJson() const noexcept {
        JsonText out; char id[33]; Hex(request_, id);
        const int n = std::snprintf(out.data.data(), out.data.size(),
            "{\"v\":1,\"type\":\"start\",\"request_id\":\"%s\",\"format\":{\"codec\":\"opus\",\"sample_rate\":16000,\"channels\":1,\"frame_ms\":60,\"dtx\":true},\"max_duration_s\":%u}", id, unsigned(max_duration_));
        if (n > 0 && size_t(n) < out.data.size()) out.size = size_t(n);
        return out;
    }
    // On flush_and_stop: stop input, Flush(), then pass Packetizer::highest_sealed_seq().
    // Keep the window alive and call Next()/OnAck() while Finishing. Retry this same
    // stop JSON after reconnect. A failed Flush must not hide its last sequence.
    JsonText StopJson(int64_t last_seq) const noexcept {
        JsonText out; char id[33]; Hex(session_, id);
        if (state_ != State::Finishing || last_seq < -1 || last_seq > UINT32_MAX) return out;
        const int n = std::snprintf(out.data.data(), out.data.size(),
            "{\"v\":1,\"type\":\"stop\",\"session_id\":\"%s\",\"last_seq\":%lld,\"frames\":%llu,\"duration_ms\":%llu,\"dropped_frames\":%llu,\"reason\":\"%s\"}",
            id, static_cast<long long>(last_seq), static_cast<unsigned long long>(frames_),
            static_cast<unsigned long long>(duration_), static_cast<unsigned long long>(dropped_), ReasonText(reason_));
        if (n > 0 && size_t(n) < out.data.size()) out.size = size_t(n);
        return out;
    }
    State state() const noexcept { return state_; }
    Id session_id() const noexcept { return session_; }
    size_t max_packet_bytes() const noexcept { return limit_; }
    uint64_t frames() const noexcept { return frames_; }
    uint64_t duration_ms() const noexcept { return duration_; }
    uint64_t dropped_frames() const noexcept { return dropped_; }
private:
    Actions View() const noexcept { Actions a; a.state = state_; a.reason = reason_; return a; }
    Actions Result(State state) noexcept { state_ = state; auto a = View(); a.display = true; return a; }
    Actions Stop(Reason reason, uint64_t now_ms) noexcept {
        if (state_ != State::Recording) return View();
        reason_ = reason; since_ = now_ms;
        auto a = Result(State::Finishing); a.flush_and_stop = true; return a;
    }
    State state_ = State::Idle;
    Reason reason_ = Reason::User;
    Id request_{}, session_{};
    uint64_t network_timeout_, since_ = 0, disconnected_ = 0;
    uint64_t frames_ = 0, dropped_ = 0, duration_ = 0;
    uint32_t max_duration_;
    size_t limit_ = 768;
    bool online_ = true;
};
}  // namespace Recorder

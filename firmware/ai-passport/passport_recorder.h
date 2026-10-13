#pragma once
// Online recording for the AI Passport: OK long press starts/stops, Opus frames
// go to the cloud recording-ingest over the notification MQTT/WSS connection.
// Protocol: docs/RECORDING_PROTOCOL.md in xiaozhi-cloud-codex-bridge.
//
// Threads: the main task feeds audio and handles the button; the MQTT task
// delivers ACKs and connection changes; a sender task publishes audio. One
// mutex guards all recorder state. The send window (RAM) exists only while a
// session is active.
#include <esp_log.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <cJSON.h>
#include <mqtt_client.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "application.h"
#include "board.h"
#include "display.h"
#include "recorder_core.h"

class PassportRecorder {
public:
    // Bytes of unacknowledged audio the device may hold (~3-4 s at 16-24 kbps).
    // 8 KiB after measuring a 18 KB heap minimum with 12 KiB (2026-10-13).
    static constexpr size_t kWindowBytes = 8 * 1024;
    static constexpr uint64_t kControlRetryMs = 3000;

    explicit PassportRecorder(const char* device_id)
        : request_topic_(std::string("devices/") + device_id + "/recording/request"),
          audio_topic_(std::string("devices/") + device_id + "/recording/audio"),
          ack_topic_(std::string("devices/") + device_id + "/recording/ack") {}

    const std::string& ack_topic() const { return ack_topic_; }

    enum class Result { None, Saved, Partial, Failed };
    struct UiSnapshot {
        Recorder::State state = Recorder::State::Idle;
        uint64_t duration_ms = 0;      // captured on the device
        uint64_t acked_ms = 0;         // persisted on the server (chunk_ack frames)
        bool connected = false;
        Result result = Result::None;  // last finished session
        uint64_t result_at_ms = 0, result_duration_ms = 0;
    };
    // Any task. Never call while holding the display lock's opposite order:
    // the recorder never takes the display lock while holding its own mutex.
    UiSnapshot Snapshot() {
        std::lock_guard<std::mutex> lock(mutex_);
        UiSnapshot s;
        s.state = state_.state();
        s.duration_ms = state_.duration_ms();
        s.acked_ms = acked_frames_ * 60;
        s.connected = connected_;
        s.result = result_;
        s.result_at_ms = result_at_;
        s.result_duration_ms = result_duration_;
        return s;
    }

    // MQTT task.
    void OnConnected(esp_mqtt_client_handle_t client) {
        std::lock_guard<std::mutex> lock(mutex_);
        client_ = client;
        connected_ = true;
        esp_mqtt_client_subscribe(client, ack_topic_.c_str(), 1);
        Apply(state_.Network(true, NowMs()));
        last_control_ = 0;  // resend start/stop right away
        EnsureSender();
    }

    void OnDisconnected() {
        std::lock_guard<std::mutex> lock(mutex_);
        connected_ = false;
        Apply(state_.Network(false, NowMs()));
    }

    void OnAckMessage(const char* data, int len) {
        Recorder::Ack ack;
        if (!ParseAck(data, len, ack)) {
            return;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        if (ack.type == Recorder::AckType::Chunk && ack.has_session && ack.session_id == state_.session_id() &&
            ack.frames > acked_frames_) {
            acked_frames_ = ack.frames;
        }
        Apply(state_.OnAck(ack, NowMs()));
    }

    // Main task (OK long press).
    void Toggle() {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& app = Application::GetInstance();
        if (state_.state() == Recorder::State::Idle) {
            if (!connected_) {
                Show("录音服务未连接");
                return;
            }
            if (!app.EnterRecording([this](std::unique_ptr<AudioStreamPacket> p) { OnPacket(std::move(p)); })) {
                Show("忙，稍后再录音");
                return;
            }
            Recorder::Id request;
            esp_fill_random(request.data(), request.size());
            Apply(state_.Toggle(NowMs(), request));
            return;
        }
        Apply(state_.Toggle(NowMs()));
    }

private:
    std::mutex mutex_;
    Recorder::RecorderState state_;
    std::unique_ptr<Recorder::SendWindow> window_;
    std::optional<Recorder::Packetizer> packer_;
    esp_mqtt_client_handle_t client_ = nullptr;
    bool connected_ = false;
    TaskHandle_t sender_ = nullptr;
    const std::string request_topic_, audio_topic_, ack_topic_;
    std::string pending_control_;  // start or stop JSON, resent until answered
    uint64_t last_control_ = 0, last_display_ = 0;
    uint32_t next_frame_ = 0, drops_seen_ = 0;
    uint64_t acked_frames_ = 0, result_at_ = 0, result_duration_ = 0;
    Result result_ = Result::None;
    bool stop_sent_ = false;

    static uint64_t NowMs() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }

    static void Show(const char* text) {
        std::string copy(text);
        Application::GetInstance().Schedule([copy]() {
            if (auto display = Board::GetInstance().GetDisplay()) display->SetStatus(copy.c_str());
        });
    }

    static bool ParseId(cJSON* item, Recorder::Id& id) {
        if (!cJSON_IsString(item) || std::strlen(item->valuestring) != 32) return false;
        for (size_t i = 0; i < 16; i++) {
            unsigned v;
            if (std::sscanf(item->valuestring + 2 * i, "%2x", &v) != 1) return false;
            id[i] = static_cast<uint8_t>(v);
        }
        return true;
    }

    static bool ParseAck(const char* data, int len, Recorder::Ack& ack) {
        if (len <= 0 || len > 512) return false;
        cJSON* root = cJSON_ParseWithLength(data, len);
        if (!root) return false;
        bool ok = false;
        cJSON* type = cJSON_GetObjectItemCaseSensitive(root, "type");
        cJSON* v = cJSON_GetObjectItemCaseSensitive(root, "v");
        if (cJSON_IsNumber(v) && v->valueint == 1 && cJSON_IsString(type)) {
            const std::string t = type->valuestring;
            ack.has_request = ParseId(cJSON_GetObjectItemCaseSensitive(root, "request_id"), ack.request_id);
            ack.has_session = ParseId(cJSON_GetObjectItemCaseSensitive(root, "session_id"), ack.session_id);
            ok = true;
            if (t == "start_ack") {
                ack.type = Recorder::AckType::Start;
                cJSON* max = cJSON_GetObjectItemCaseSensitive(root, "max_packet_bytes");
                ack.max_packet_bytes = cJSON_IsNumber(max) ? static_cast<size_t>(max->valuedouble) : 0;
            } else if (t == "chunk_ack") {
                ack.type = Recorder::AckType::Chunk;
                cJSON* seq = cJSON_GetObjectItemCaseSensitive(root, "persisted_seq");
                cJSON* frames = cJSON_GetObjectItemCaseSensitive(root, "frames");
                ok = cJSON_IsNumber(seq) && cJSON_IsNumber(frames);
                if (ok) {
                    ack.persisted_seq = static_cast<int64_t>(seq->valuedouble);
                    ack.frames = static_cast<uint64_t>(frames->valuedouble);
                }
            } else if (t == "finish_ack") {
                ack.type = Recorder::AckType::Finish;
                cJSON* st = cJSON_GetObjectItemCaseSensitive(root, "state");
                const std::string s = cJSON_IsString(st) ? st->valuestring : "";
                ack.state = s == "saved" ? Recorder::FinishState::Saved
                          : s == "partial" ? Recorder::FinishState::Partial : Recorder::FinishState::Failed;
            } else if (t == "error") {
                ack.type = Recorder::AckType::Error;
                cJSON* code = cJSON_GetObjectItemCaseSensitive(root, "code");
                const std::string c = cJSON_IsString(code) ? code->valuestring : "";
                ack.code = c == "busy" ? Recorder::ErrorCode::Busy
                         : c == "no_space" ? Recorder::ErrorCode::NoSpace
                         : c == "unavailable" ? Recorder::ErrorCode::Unavailable
                         : c == "unknown_session" ? Recorder::ErrorCode::UnknownSession
                         : c == "too_long" ? Recorder::ErrorCode::TooLong : Recorder::ErrorCode::BadRequest;
            } else {
                ok = false;
            }
        }
        cJSON_Delete(root);
        return ok;
    }

    // Main task: one encoded 60 ms frame. Frames that arrive outside Recording are dropped.
    void OnPacket(std::unique_ptr<AudioStreamPacket> packet) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_.state() != Recorder::State::Recording || !packer_) return;
        // Frames the encoder queue dropped still advance the timeline.
        uint32_t drops = Application::GetInstance().AudioSendQueueDropped();
        if (drops != drops_seen_) {
            state_.Dropped(drops - drops_seen_);
            next_frame_ += drops - drops_seen_;
            drops_seen_ = drops;
        }
        uint32_t index = next_frame_++;
        state_.Frame(index);
        auto r = packer_->AddFrame(index, packet->payload.data(), packet->payload.size());
        if (r == Recorder::PackResult::SinkFull) {
            Apply(state_.Overflow(NowMs()));
        } else if (r != Recorder::PackResult::Ok) {
            ESP_LOGW("Recorder", "frame %u rejected (%d bytes)", unsigned(index), int(packet->payload.size()));
        }
    }

    static bool PushPacket(void* self, Recorder::PacketView view) {
        return static_cast<PassportRecorder*>(self)->window_->Push(view);
    }

    void SetControl(const Recorder::JsonText& json) {
        pending_control_.assign(json.data.data(), json.size);
        last_control_ = 0;
    }

    // Holds mutex_. Side effects on the application run on the main task.
    void Apply(const Recorder::Actions& a) {
        auto& app = Application::GetInstance();
        if (a.send_start) {
            SetControl(state_.StartJson());
            stop_sent_ = false;
            EnsureSender();
        }
        if (a.apply_ack && window_) {
            window_->OnAck(a.persisted_seq, NowMs());
        }
        if (!a.display) return;
        switch (a.state) {
            case Recorder::State::StartRequested:
                Show("录音连接中…");
                break;
            case Recorder::State::Recording:
                window_.reset(new Recorder::SendWindow(kWindowBytes));
                if (!window_->valid()) {
                    window_.reset();
                    Show("内存不足，无法录音");
                    pending_control_.clear();
                    app.Schedule([&app]() { app.LeaveRecording(); });
                    state_ = Recorder::RecorderState();
                    return;
                }
                packer_.emplace(state_.session_id(), &PushPacket, this, state_.max_packet_bytes());
                next_frame_ = 0;
                acked_frames_ = 0;
                result_ = Result::None;
                drops_seen_ = app.AudioSendQueueDropped();
                pending_control_.clear();
                last_display_ = 0;
                app.Schedule([&app]() { app.StartRecordingAudio(); });
                break;
            case Recorder::State::Finishing: {
                if (a.flush_and_stop) {
                    app.Schedule([&app]() { app.StopRecordingAudio(); });
                    if (packer_) packer_->Flush();
                    int64_t last = packer_ ? packer_->highest_sealed_seq() : -1;
                    SetControl(state_.StopJson(last));
                    stop_sent_ = true;
                }
                Show("正在保存…");
                break;
            }
            case Recorder::State::Saved:
            case Recorder::State::Partial:
            case Recorder::State::Failed: {
                const char* text = a.state == Recorder::State::Saved ? "录音已保存"
                                 : a.state == Recorder::State::Partial ? "录音部分保存" : "录音失败";
                ESP_LOGI("Recorder", "%s: frames=%llu dropped=%llu retrans=%llu", text,
                         (unsigned long long)state_.frames(), (unsigned long long)state_.dropped_frames(),
                         (unsigned long long)(window_ ? window_->retransmissions() : 0));
                result_ = a.state == Recorder::State::Saved ? Result::Saved
                        : a.state == Recorder::State::Partial ? Result::Partial : Result::Failed;
                result_at_ = NowMs();
                result_duration_ = state_.duration_ms();
                pending_control_.clear();
                packer_.reset();
                window_.reset();
                state_.Toggle(NowMs());  // back to Idle
                std::string copy(text);
                app.Schedule([&app, copy]() {
                    app.LeaveRecording();
                    if (auto display = Board::GetInstance().GetDisplay()) display->ShowNotification(copy, 4000);
                });
                break;
            }
            default:
                break;
        }
    }

    void EnsureSender() {
        if (sender_ != nullptr) return;
        xTaskCreate([](void* arg) { static_cast<PassportRecorder*>(arg)->SenderLoop(); },
                    "recorder-tx", 3072, this, 3, &sender_);
    }

    // Sender task: timeouts, control retries, audio publishing. Publishing blocks
    // on the socket, so it runs here and never on the main or audio tasks.
    void SenderLoop() {
        uint8_t packet[768];
        while (true) {
            size_t size = 0;
            std::string control;
            esp_mqtt_client_handle_t client;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                uint64_t now = NowMs();
                Apply(state_.Tick(now));
                client = client_;
                if (connected_ && !pending_control_.empty() && now - last_control_ >= kControlRetryMs) {
                    control = pending_control_;
                    last_control_ = now;
                }
                if (connected_ && window_ && (state_.state() == Recorder::State::Recording ||
                                              state_.state() == Recorder::State::Finishing)) {
                    auto view = window_->Next(now);
                    if (view.data && view.size <= sizeof(packet)) {
                        std::memcpy(packet, view.data, view.size);
                        size = view.size;
                    }
                }
                if (state_.state() == Recorder::State::Recording && now - last_display_ >= 1000) {
                    last_display_ = now;
                    uint64_t s = state_.duration_ms() / 1000;
                    char text[32];
                    std::snprintf(text, sizeof(text), "REC %02u:%02u", unsigned(s / 60), unsigned(s % 60));
                    Show(text);
                }
            }
            if (!control.empty() && client) {
                esp_mqtt_client_enqueue(client, request_topic_.c_str(), control.data(), control.size(), 1, 0, true);
            }
            if (size > 0 && client) {
                esp_mqtt_client_publish(client, audio_topic_.c_str(), reinterpret_cast<const char*>(packet),
                                        size, 0, 0);
                continue;  // drain the window quickly
            }
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
};

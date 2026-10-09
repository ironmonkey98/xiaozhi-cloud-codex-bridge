#pragma once
#include <esp_log.h>
#if __has_include("codex_notify_private.h")
#include <esp_crt_bundle.h>
#include <esp_log.h>
#include <cJSON.h>
#include <mqtt_client.h>
#include <atomic>
#include <ctime>
#include <mutex>
#include "application.h"
#include "codex_notify_private.h"
#include "codex_query_audio.h"
#include "settings.h"
#include "wall_clock.h"

// Independent, bounded control channel. It carries IDs, never audio or executable instructions.
class CodexNotify {
    esp_mqtt_client_handle_t client_ = nullptr;
    esp_timer_handle_t timer_ = nullptr;
    std::mutex mutex_;
    std::string pending_event_, pending_task_, last_event_, active_event_;
    int64_t retry_after_ = 0;
    bool query_served_ = false;
    int64_t expires_at_ = 0;
    std::atomic<bool> tick_queued_{false};
    static bool Digits(const std::string& s, size_t start) {
        return s.find_first_not_of("0123456789", start) == std::string::npos;
    }
    void Ack(const std::string& event, const char* stage) {
        std::string payload = "{\"event_id\":\"" + event + "\",\"stage\":\"" + stage +
                              "\",\"receiver\":\"firmware\"}";
        esp_mqtt_client_enqueue(client_, CODEX_NOTIFY_ACK_TOPIC, payload.c_str(), payload.size(), 1,
                                0, true);
    }
    void Receive(esp_mqtt_event_handle_t e) {
        if (e->data_len <= 0 || e->data_len > 512 || e->data_len != e->total_data_len ||
            e->current_data_offset != 0)
            return;
        auto root = cJSON_ParseWithLength(e->data, e->data_len);
        if (!root)
            return;
        auto version = cJSON_GetObjectItemCaseSensitive(root, "v");
        auto type = cJSON_GetObjectItemCaseSensitive(root, "type");
        auto event = cJSON_GetObjectItemCaseSensitive(root, "event_id");
        auto task = cJSON_GetObjectItemCaseSensitive(root, "task_id");
        auto expiry = cJSON_GetObjectItemCaseSensitive(root, "expires_at");
        bool valid = cJSON_IsObject(root) && cJSON_GetArraySize(root) == 5 &&
                     cJSON_IsNumber(version) && version->valuedouble == 1 && cJSON_IsString(type) &&
                     (std::string(type->valuestring) == "result_ready" ||
                      std::string(type->valuestring) == "query_served") &&
                     cJSON_IsString(event) && cJSON_IsString(task) && cJSON_IsNumber(expiry);
        if (valid) {
            std::string id(event->valuestring), task_id(task->valuestring);
            int64_t now = WallClock::UtcMilliseconds();
            valid = id.size() == 32 &&
                    id.find_first_not_of("0123456789abcdef") == std::string::npos &&
                    task_id.size() >= 3 && task_id.size() <= 14 && task_id.substr(0, 2) == "T-" &&
                    Digits(task_id, 2) &&
                    std::string(e->topic, e->topic_len) ==
                        std::string(CODEX_NOTIFY_TOPIC_PREFIX) + id &&
                    now > 1700000000000LL && expiry->valuedouble > now &&
                    expiry->valuedouble <= now + 86401000;
            if (valid) {
                bool repeated;
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    repeated = id == last_event_;
                    if (std::string(type->valuestring) == "query_served" && active_event_ == id) {
                        query_served_ = true;
                        ESP_LOGI("CodexNotify", "gateway query receipt confirmed");
                    }
                    if (!repeated && (pending_event_.empty() || pending_event_ == id)) {
                        pending_event_ = id;
                        pending_task_ = task_id;
                        expires_at_ = static_cast<int64_t>(expiry->valuedouble);
                    }
                }
                Ack(id, repeated ? "playback_completed" : "signal_received");
                ESP_LOGI("CodexNotify", "result_ready received: %s", task_id.c_str());
            }
        }
        cJSON_Delete(root);
    }
    void Tick() {
        tick_queued_ = false;
        std::string event, task;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (pending_event_.empty() || !active_event_.empty() ||
                WallClock::UtcMilliseconds() < retry_after_)
                return;
            if (WallClock::UtcMilliseconds() >= expires_at_) {
                pending_event_.clear();
                pending_task_.clear();
                return;
            }
            event = pending_event_;
            task = pending_task_;
        }
        bool started = Application::GetInstance().RequestNotificationQuery(
            kCodexQueryAudio, sizeof(kCodexQueryAudio), [this, event](bool success) {
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    success = success && query_served_;
                    active_event_.clear();
                    if (success) {
                        last_event_ = event;
                        if (pending_event_ == event) {
                            pending_event_.clear();
                            pending_task_.clear();
                        }
                    } else {
                        retry_after_ = WallClock::UtcMilliseconds() + 120000;
                    }
                }
                if (success) {
                    Settings settings("codex_notify", true);
                    settings.SetString("last_played", event);
                }
                Ack(event, success ? "playback_completed" : "query_failed");
                ESP_LOGI("CodexNotify", "notification audio %s",
                         success ? "drained" : "failed/interrupted");
            });
        if (started) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                active_event_ = event;
                query_served_ = false;
            }
            Ack(event, "query_started");
            ESP_LOGI("CodexNotify", "query started for %s", task.c_str());
        }
    }

    void Initialize() {
        Settings settings("codex_notify", false);
        last_event_ = settings.GetString("last_played");
        esp_mqtt_client_config_t config = {};
        config.broker.address.uri = CODEX_NOTIFY_URL;
        config.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
        config.credentials.username = CODEX_NOTIFY_USERNAME;
        config.credentials.client_id = CODEX_NOTIFY_CLIENT_ID;
        config.credentials.authentication.password = CODEX_NOTIFY_PASSWORD;
        config.session.keepalive = 60;
        config.buffer.size = 1024;
        config.buffer.out_size = 512;
        config.outbox.limit = 2048;
        client_ = esp_mqtt_client_init(&config);
        if (!client_) {
            ESP_LOGE("CodexNotify", "client initialization failed");
            return;
        }
        esp_mqtt_client_register_event(
            client_, MQTT_EVENT_ANY,
            [](void* arg, esp_event_base_t, int32_t event_id, void* data) {
                auto self = static_cast<CodexNotify*>(arg);
                if (event_id == MQTT_EVENT_CONNECTED) {
                    ESP_LOGI("CodexNotify", "notification channel connected");
                    esp_mqtt_client_subscribe(self->client_, CODEX_NOTIFY_SUB_TOPIC, 1);
                } else if (event_id == MQTT_EVENT_DATA) {
                    self->Receive(static_cast<esp_mqtt_event_handle_t>(data));
                } else if (event_id == MQTT_EVENT_DISCONNECTED) {
                    ESP_LOGW("CodexNotify", "notification channel disconnected; reconnecting");
                }
            },
            this);
        esp_mqtt_client_start(client_);
        esp_timer_create_args_t timer = {};
        timer.name = "codex-notify";
        timer.arg = this;
        timer.callback = [](void* arg) {
            auto self = static_cast<CodexNotify*>(arg);
            if (!self->tick_queued_.exchange(true))
                Application::GetInstance().Schedule([self]() { self->Tick(); });
        };
        if (esp_timer_create(&timer, &timer_) == ESP_OK)
            esp_timer_start_periodic(timer_, 2000000);
    }

public:
    void Start() {
        // StartNetwork invokes this after Application initialization.
        xTaskCreate(
            [](void* arg) {
                vTaskDelay(pdMS_TO_TICKS(1000));
                static_cast<CodexNotify*>(arg)->Initialize();
                vTaskDelete(nullptr);
            },
            "notify-init", 4096, this, 2, nullptr);
    }
};

#else
class CodexNotify {
public:
    void Start() {
        ESP_LOGW("CodexNotify",
                 "Notification credentials not configured; voice and UI remain available");
    }
};
#endif

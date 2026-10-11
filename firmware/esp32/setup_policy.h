#pragma once
#include "network_settings.h"

namespace lpmas {
constexpr uint32_t SETUP_WINDOW_MS = 300000;
constexpr uint32_t SETUP_FAILURE_DISPLAY_MS = 10000;
constexpr uint32_t WIFI_RETRY_MS = 30000;
constexpr uint32_t WIFI_OFFLINE_SETUP_MS = 60000;

// One action per continuous hold, including across millis() rollover.
class SetupButton {
 public:
  bool update(bool pressed, uint32_t now) {
    if (pressed && !down_) { at_ = now; handled_ = false; }
    down_ = pressed;
    if (!pressed || handled_ || !elapsed(now, at_, 5000)) return false;
    handled_ = true;
    return true;
  }
 private:
  bool down_ = false, handled_ = false;
  uint32_t at_ = 0;
};
}

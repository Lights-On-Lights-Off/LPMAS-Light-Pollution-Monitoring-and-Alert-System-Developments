#pragma once
#include <WiFiManager.h>
#include <Preferences.h>
#include <time.h>
#include "network_settings.h"

#ifndef LPMAS_SETUP_PASSWORD
#define LPMAS_SETUP_PASSWORD ""
#endif

class WifiSetup {
 public:
  void begin(const char* provisionedPassword, const char* deviceKey);
  void tick();
  bool configuring() { return manager_.getConfigPortalActive(); }
  bool connected() const { return started_ && WiFi.status() == WL_CONNECTED && !pendingChange_; }
 private:
  static constexpr uint32_t RETRY_INTERVAL = 30000;
  WiFiManager manager_;
  Preferences store_;
  lpmas::NetworkSettings saved_;
  bool storageReady_ = false, haveSaved_ = false, started_ = false, pendingChange_ = false;
  bool wasConnected_ = false, buttonDown_ = false, buttonHandled_ = false;
  uint32_t portalAt_ = 0, retryAt_ = 0, offlineAt_ = 0, buttonAt_ = 0;
  String apName_, apPassword_, csrf_, customHead_;
  void openPortal();
  void securePortal();
  void rememberNetwork();
  void restoreNetwork();
};

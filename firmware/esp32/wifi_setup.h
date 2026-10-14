#pragma once
#include <WiFi.h>
#include <Preferences.h>
#include <atomic>
#include <time.h>
#include "network_settings.h"
#include "setup_policy.h"

#ifndef LPMAS_SETUP_PASSWORD
#define LPMAS_SETUP_PASSWORD ""
#endif

class WifiSetup {
 public:
  void begin(const char* setupCode, const char* deviceKey);
  void tick();
  bool configuring() const { return active_; }
  bool connected() const { return started_ && !active_ && !restorePending_ && WiFi.status() == WL_CONNECTED; }
 private:
  Preferences store_;
  lpmas::NetworkSettings saved_;
  lpmas::SetupButton button_;
  bool storageReady_ = false, haveSaved_ = false, started_ = false;
  bool active_ = false, closing_ = false, verified_ = false, failed_ = false;
  bool restorePending_ = false;
  bool wasConnected_ = false;
  uint32_t setupAt_ = 0, failureAt_ = 0, retryAt_ = 0, offlineAt_ = 0;
  String serviceName_, setupCode_;
  // Arduino event callbacks run on another task. Only these bits cross tasks;
  // Preferences, Wi-Fi operations and session state belong to loop().
  std::atomic<uint32_t> events_{0};
  void openSetup();
  bool rememberNetwork();
  void restoreNetwork();
};

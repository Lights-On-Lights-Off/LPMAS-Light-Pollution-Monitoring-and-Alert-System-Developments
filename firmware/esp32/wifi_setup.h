#pragma once
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <time.h>
#include "network_settings.h"

// Optional private, per-device setup password. Otherwise generated once in NVS.
#ifndef LPMAS_SETUP_PASSWORD
#define LPMAS_SETUP_PASSWORD ""
#endif

class WifiSetup {
 public:
  void begin(const char* provisionedPassword = "");
  void tick();
  bool configuring() const { return portal_; }
  bool connected() const { return WiFi.status() == WL_CONNECTED && !testing_; }
 private:
  static constexpr uint32_t CONNECT_TIMEOUT = 30000;
  static constexpr uint32_t PORTAL_TIMEOUT = 300000;
  static constexpr uint32_t RETRY_INTERVAL = 30000;
  static constexpr uint8_t BUTTON_PIN = 0;
  WebServer server_{IPAddress(192, 168, 4, 1), 80};
  DNSServer dns_;
  Preferences store_;
  lpmas::NetworkSettings saved_, candidate_;
  bool storageReady_ = false, haveSaved_ = false, portal_ = false, manual_ = false;
  bool connecting_ = false, testing_ = false, wasConnected_ = false;
  bool buttonDown_ = false, buttonHandled_ = false, closePending_ = false;
  uint32_t connectAt_ = 0, portalAt_ = 0, retryAt_ = 0, offlineAt_ = 0, buttonAt_ = 0, closeAt_ = 0;
  String apName_, apPassword_, csrf_, state_ = "ready";
  void openPortal(bool manual);
  void closePortal();
  void connect(const lpmas::NetworkSettings& value);
  void submit();
  void status();
  void networks();
  void page();
  void send(int code, const char* type, const String& body);
  bool localClient();
  static String randomSecret(size_t bytes);
  static String jsonString(const String& value);
};

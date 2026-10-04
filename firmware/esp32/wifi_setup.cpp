#include "wifi_setup.h"
#include "portal_policy.h"
#include <esp_mac.h>
#include <esp_wifi.h>
#include <esp_system.h>
#include <mbedtls/md.h>

void WifiSetup::begin(const char* provisionedPassword, const char* deviceKey) {
  Serial.println("[WIFI] Loading saved configuration");
  pinMode(0, INPUT_PULLUP);
  storageReady_ = store_.begin("lpmas-network", false);
  if (storageReady_ && store_.getBytesLength("wifi") == sizeof(saved_)) {
    store_.getBytes("wifi", &saved_, sizeof(saved_)); haveSaved_ = lpmas::validStoredNetwork(saved_);
  }
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char name[32]; snprintf(name, sizeof(name), "LPMAS-Setup-%02X%02X%02X", mac[3], mac[4], mac[5]); apName_ = name;
  apPassword_ = provisionedPassword;
  if (apPassword_.isEmpty() && storageReady_) apPassword_ = store_.getString("setup-password");
  if (apPassword_.isEmpty()) {
    // Derive an independent setup password without enabling Wi-Fi for entropy.
    // The device key is never shown in the portal or serial output.
    if (!deviceKey || strlen(deviceKey) < 32) { Serial.println("[WIFI] Provision a device key before startup"); return; }
    const String context = "lpmas-setup:" + apName_;
    unsigned char hash[32];
    if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
        reinterpret_cast<const unsigned char*>(deviceKey), strlen(deviceKey),
        reinterpret_cast<const unsigned char*>(context.c_str()), context.length(), hash)) return;
    for (size_t i = 0; i < 16; ++i) { char hex[3]; snprintf(hex, sizeof(hex), "%02x", hash[i]); apPassword_ += hex; }
    if (storageReady_) store_.putString("setup-password", apPassword_);
  }
  if (apPassword_.length() < 12 || apPassword_.length() > 63 ||
      !lpmas::validNetwork("setup", 5, apPassword_.c_str(), apPassword_.length())) {
    Serial.println("[WIFI] Setup password must contain 12–63 printable ASCII characters"); return;
  }
  manager_.setDebugOutput(false); // WiFiManager verbose debugging can expose router passwords.
  manager_.setConfigPortalBlocking(false);
  manager_.setConnectTimeout(20); manager_.setSaveConnectTimeout(30);
  manager_.setConfigPortalTimeout(300); manager_.setAPClientCheck(false); manager_.setWebPortalClientCheck(false);
  manager_.setBreakAfterConfig(false); manager_.setCleanConnect(true);
  manager_.setWiFiAutoReconnect(true); manager_.setRestorePersistent(false);
  const char* menu[] = {"wifi", "exit"}; manager_.setMenu(menu, 2);
  manager_.setWebServerCallback([this] { securePortal(); });
  manager_.setSaveConfigCallback([this] { rememberNetwork(); });
  manager_.setAPCallback([this](WiFiManager*) {
    portalAt_ = millis();
    Serial.printf("[WIFI SETUP] Network: %s\n[WIFI SETUP] Password: %s\n[WIFI SETUP] Open http://192.168.4.1\n", apName_.c_str(), apPassword_.c_str());
  });
  // Also migrates the validated backup created by the previous firmware.
  if (haveSaved_) manager_.preloadWiFi(saved_.ssid, saved_.password);
  Serial.println("[WIFI] Starting WiFiManager (connection attempt: up to 20 seconds)");
  const bool online = manager_.autoConnect(apName_.c_str(), apPassword_.c_str());
  started_ = true; retryAt_ = offlineAt_ = millis();
  if (online) rememberNetwork();
  Serial.println(online ? "[WIFI] Connected" : "[WIFI] WiFiManager ready; configure the setup network");
}

void WifiSetup::securePortal() {
  // WiFiManager starts Wi-Fi before this callback, so esp_random has RF entropy.
  csrf_ = "";
  for (size_t i = 0; i < 16; ++i) { char hex[3]; snprintf(hex, sizeof(hex), "%02x", static_cast<unsigned>(esp_random() & 255)); csrf_ += hex; }
  customHead_ = "<script>addEventListener('DOMContentLoaded',function(){"
    "var f=document.querySelector('form[action=\"wifisave\"]');if(f){"
    "var t=document.createElement('input');t.type='hidden';t.name='lpmas_token';t.value='" + csrf_ +
    "';f.appendChild(t);}});</script>";
  manager_.setCustomHeadElement(customHead_.c_str());
  const char* headers[] = {"Origin", "Sec-Fetch-Site"}; manager_.server->collectHeaders(headers, 2);
  manager_.server->addMiddleware([this](WebServer& server, Middleware::Callback next) {
    server.sendHeader("Cache-Control", "no-store"); server.sendHeader("X-Frame-Options", "DENY");
    server.sendHeader("X-Content-Type-Options", "nosniff"); server.sendHeader("Referrer-Policy", "no-referrer");
    const String origin = server.header("Origin"), uri = server.uri();
    const String fetchSite = server.header("Sec-Fetch-Site"), token = server.arg("lpmas_token");
    const auto access = lpmas::portalAccess(server.client().localIP() == WiFi.softAPIP(), origin.c_str(),
      fetchSite.c_str(), uri.c_str(), server.method() == HTTP_POST, token.c_str(), csrf_.c_str());
    if (access == lpmas::PortalAccess::forbidden) {
      server.send(403, "text/plain", "Connect to the protected setup Wi-Fi first."); return true;
    }
    if (access == lpmas::PortalAccess::unavailable) {
      server.send(404, "text/plain", "Not available"); return true;
    }
    if (uri == "/wifisave") {
      const String ssid = server.arg("s"), password = server.arg("p");
      if (!lpmas::validNetwork(ssid.c_str(), ssid.length(), password.c_str(), password.length())) {
        server.send(400, "text/plain", "Enter a valid network name and Wi-Fi password."); return true;
      }
      if (!storageReady_) { server.send(503, "text/plain", "Device storage is unavailable; restart and retry."); return true; }
      pendingChange_ = true;
    }
    return next();
  });
}

void WifiSetup::rememberNetwork() {
  if (WiFi.status() != WL_CONNECTED) return;
  // Read bounded SDK buffers; a full 32-byte SSID or 64-byte PSK need not end in NUL.
  wifi_config_t config{};
  if (esp_wifi_get_config(WIFI_IF_STA, &config) != ESP_OK) return;
  lpmas::NetworkSettings value;
  memcpy(value.ssid, config.sta.ssid, 32); memcpy(value.password, config.sta.password, 64);
  if (!lpmas::validStoredNetwork(value)) return;
  if (!storageReady_ || store_.putBytes("wifi", &value, sizeof(value)) != sizeof(value)) {
    Serial.println("[WIFI] Could not update the last-working-network backup"); return;
  }
  saved_ = value; haveSaved_ = true; pendingChange_ = false;
  Serial.println("[WIFI] Connection verified; working network saved");
}

void WifiSetup::restoreNetwork() {
  WiFi.disconnect(false, false, 1000);
  WiFi.persistent(true);
  if (haveSaved_) WiFi.begin(saved_.ssid, saved_.password, 0, nullptr, false);
  else WiFi.disconnect(false, true);
  WiFi.persistent(false); pendingChange_ = false; retryAt_ = millis();
  Serial.println("[WIFI] New connection failed; previous saved configuration restored");
}

void WifiSetup::openPortal() {
  if (configuring()) return;
  manager_.startConfigPortal(apName_.c_str(), apPassword_.c_str());
}

void WifiSetup::tick() {
  if (!started_) return;
  const bool wasPortal = configuring();
  manager_.process();
  // Successful saves clear the flag in the callback; failed saves must not replace the backup.
  if (pendingChange_) restoreNetwork();
  uint32_t now = millis();
  const bool pressed = digitalRead(0) == LOW;
  if (pressed && !buttonDown_) { buttonAt_ = now; buttonHandled_ = false; }
  if (pressed && !buttonHandled_ && lpmas::elapsed(now, buttonAt_, 5000)) { openPortal(); buttonHandled_ = true; }
  buttonDown_ = pressed;
  const bool up = connected();
  if (up && !wasConnected_) { configTime(0, 0, "pool.ntp.org", "time.google.com"); Serial.println("[WIFI] Time synchronization started"); }
  if (!up && wasConnected_) offlineAt_ = now;
  if (wasPortal && !configuring()) { offlineAt_ = now; retryAt_ = now - RETRY_INTERVAL; }
  if (configuring()) {
    // Enforce a fixed window even if library client activity extends its timeout.
    if (lpmas::elapsed(now, portalAt_, 300000)) manager_.stopConfigPortal();
  } else if (!up) {
    if (lpmas::elapsed(now, retryAt_, RETRY_INTERVAL)) { WiFi.reconnect(); retryAt_ = now; }
    if (lpmas::elapsed(now, offlineAt_, 60000)) openPortal();
  }
  wasConnected_ = up;
}

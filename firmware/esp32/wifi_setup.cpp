#include "wifi_setup.h"
#ifdef ARDUINO
// Register direct SDK BLE use before initArduino() can permanently release
// controller memory. Arduino's BLE wrappers normally include this hook.
#include <esp32-hal-bt-mem.h>
#endif
#include <esp_mac.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <network_provisioning/manager.h>
#include <network_provisioning/scheme_ble.h>

#if !CONFIG_IDF_TARGET_ESP32
#error "This LPMAS board profile targets the original ESP32 with BLE and BOOT on GPIO0."
#endif
#if ARDUHAL_LOG_LEVEL >= 5
#error "Disable Verbose core logging: the Arduino provisioning event logger prints Wi-Fi passwords."
#endif

namespace {
constexpr uint32_t RECEIVED = 1, SUCCESS = 2, AUTH_FAILED = 4, AP_FAILED = 8, ENDED = 16;
// Espressif's provisioning app service UUID (little endian).
uint8_t serviceUuid[16] = {0xb4, 0xdf, 0x5a, 0x1c, 0x3f, 0x6b, 0xf4, 0xbf,
                          0xea, 0x4a, 0x82, 0x03, 0x04, 0x90, 0x1a, 0x02};
bool readNetwork(lpmas::NetworkSettings& value) {
  wifi_config_t config{};
  if (esp_wifi_get_config(WIFI_IF_STA, &config) != ESP_OK) return false;
  value = {};
  // SDK fields can fill their entire buffers without a trailing NUL.
  memcpy(value.ssid, config.sta.ssid, 32);
  memcpy(value.password, config.sta.password, 64);
  return lpmas::validStoredNetwork(value);
}
}

void WifiSetup::begin(const char* setupCode, const char* deviceKey) {
  pinMode(0, INPUT_PULLUP);
  storageReady_ = store_.begin("lpmas-network", false);
  if (!storageReady_) { Serial.println("[WIFI] Device storage unavailable; restart before setup"); return; }
  if (store_.getBytesLength("wifi") == sizeof(saved_)) {
    store_.getBytes("wifi", &saved_, sizeof(saved_));
    haveSaved_ = lpmas::validStoredNetwork(saved_);
  }
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char name[32]; snprintf(name, sizeof(name), "PROV_LPMAS_%02X%02X%02X", mac[3], mac[4], mac[5]);
  serviceName_ = name;
  // Keep the former per-device setup password as the BLE proof of possession.
  // Its original derivation context lets existing device labels stay valid.
  setupCode_ = setupCode ? setupCode : "";
  if (setupCode_.isEmpty()) setupCode_ = store_.getString("setup-password");
  if (setupCode_.isEmpty()) {
    if (!deviceKey || strlen(deviceKey) < 32) { Serial.println("[WIFI] Provision a device key before startup"); return; }
    snprintf(name, sizeof(name), "LPMAS-Setup-%02X%02X%02X", mac[3], mac[4], mac[5]);
    const String context = String("lpmas-setup:") + name;
    unsigned char hash[32];
    if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
        reinterpret_cast<const unsigned char*>(deviceKey), strlen(deviceKey),
        reinterpret_cast<const unsigned char*>(context.c_str()), context.length(), hash)) return;
    for (size_t i = 0; i < 16; ++i) { char hex[3]; snprintf(hex, sizeof(hex), "%02x", hash[i]); setupCode_ += hex; }
  }
  if (setupCode_.length() < 12 || setupCode_.length() > 63 ||
      !lpmas::validNetwork("setup", 5, setupCode_.c_str(), setupCode_.length())) {
    Serial.println("[WIFI] Setup code must contain 12-63 printable ASCII characters"); return;
  }
  if (store_.putString("setup-password", setupCode_) != setupCode_.length()) {
    Serial.println("[WIFI] Could not save setup code; restart before setup"); return;
  }
  WiFi.onEvent([this](arduino_event_id_t event, arduino_event_info_t info) {
    uint32_t bit = 0;
    switch (event) {
      case ARDUINO_EVENT_PROV_CRED_RECV: bit = RECEIVED; break;
      case ARDUINO_EVENT_PROV_CRED_SUCCESS: bit = SUCCESS; break;
      case ARDUINO_EVENT_PROV_CRED_FAIL:
        bit = info.prov_fail_reason == NETWORK_PROV_WIFI_STA_AUTH_ERROR ? AUTH_FAILED : AP_FAILED;
        break;
      // Arduino core 3.3.8 deinitializes the manager before dispatching END.
      case ARDUINO_EVENT_PROV_END: bit = ENDED; break;
      default: break;
    }
    events_.fetch_or(bit);
  });
  WiFi.persistent(true);
  WiFi.setAutoReconnect(false);
  if (!WiFi.STA.begin(false)) { Serial.println("[WIFI] Could not initialize radio"); return; }
  started_ = true;
  retryAt_ = offlineAt_ = millis();
  lpmas::NetworkSettings existing;
  if (haveSaved_) restoreNetwork();
  else if (!store_.getBool("setup-pending", false) && readNetwork(existing)) {
    // Migration from firmware that only stored credentials in the Wi-Fi SDK.
    WiFi.begin();
    WiFi.setAutoReconnect(true);
  } else openSetup();
  Serial.println("[WIFI] Hold BOOT for 5 seconds to configure Wi-Fi over Bluetooth");
}

void WifiSetup::openSetup() {
  if (active_ || !started_) return;
  offlineAt_ = millis(); // Back off even when storage or BLE initialization fails.
  // Save this marker before the SDK can persist unverified credentials. After
  // power loss, begin() selects the working backup (or starts fresh setup).
  if (store_.putBool("setup-pending", true) != 1) {
    Serial.println("[WIFI SETUP] Storage write failed; setup not started"); return;
  }
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false, 1000);
  network_prov_mgr_config_t config{};
  config.scheme = network_prov_scheme_ble;
  // Do not release BTDM memory permanently: BOOT must reopen BLE without reboot.
  config.scheme_event_handler = NETWORK_PROV_EVENT_HANDLER_NONE;
  config.app_event_handler = NETWORK_PROV_EVENT_HANDLER_NONE;
  if (network_prov_mgr_init(config) != ESP_OK) {
    Serial.println("[WIFI SETUP] Bluetooth initialization failed");
    restoreNetwork(); offlineAt_ = millis(); return;
  }
  events_.store(0);
  active_ = true; closing_ = verified_ = failed_ = false; setupAt_ = millis();
  const esp_err_t uuidResult = network_prov_scheme_ble_set_service_uuid(serviceUuid);
  if (uuidResult != ESP_OK || network_prov_mgr_start_provisioning(
      NETWORK_PROV_SECURITY_1, setupCode_.c_str(), serviceName_.c_str(), nullptr) != ESP_OK) {
    network_prov_mgr_deinit();
    active_ = false;
    Serial.println("[WIFI SETUP] Could not start Bluetooth; retry with BOOT");
    restoreNetwork(); offlineAt_ = millis(); return;
  }
  Serial.printf("[WIFI SETUP] Bluetooth device: %s\n[WIFI SETUP] Setup code (proof of possession): %s\n",
                serviceName_.c_str(), setupCode_.c_str());
  Serial.println("[WIFI SETUP] Open ESP BLE Prov, select this device, and enter the setup code.");
  Serial.println("[WIFI SETUP] Choose your 2.4 GHz Wi-Fi and enter its password. Setup closes after 5 minutes.");
}

bool WifiSetup::rememberNetwork() {
  lpmas::NetworkSettings value;
  if (WiFi.status() != WL_CONNECTED || !readNetwork(value)) return false;
  if (store_.putBytes("wifi", &value, sizeof(value)) != sizeof(value)) {
    Serial.println("[WIFI] Could not save working network"); return false;
  }
  saved_ = value; haveSaved_ = true; restorePending_ = false;
  store_.putBool("setup-pending", false);
  Serial.println("[WIFI] Connection verified; working network saved");
  return true;
}

void WifiSetup::restoreNetwork() {
  restorePending_ = true;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false, 1000);
  // Restore only Wi-Fi station settings; never erase device keys or other NVS.
  wifi_config_t config{};
  config.sta.threshold.rssi = -127;
  if (haveSaved_) {
    memcpy(config.sta.ssid, saved_.ssid, 32);
    memcpy(config.sta.password, saved_.password, 64);
  }
  if (esp_wifi_set_storage(WIFI_STORAGE_FLASH) != ESP_OK ||
      esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK) {
    Serial.println("[WIFI] Failed to restore network; restart to recover backup");
    retryAt_ = millis(); return;
  }
  store_.putBool("setup-pending", false);
  restorePending_ = false;
  if (haveSaved_) { WiFi.begin(); WiFi.setAutoReconnect(true); }
  retryAt_ = millis();
}

void WifiSetup::tick() {
  if (!started_) return;
  const uint32_t now = millis();
  const uint32_t events = events_.exchange(0);
  if (active_) {
    if (events & RECEIVED) { failed_ = false; Serial.println("[WIFI SETUP] Credentials received; testing connection"); }
    if (events & (AUTH_FAILED | AP_FAILED)) {
      failed_ = true; failureAt_ = now;
      Serial.println(events & AUTH_FAILED ? "[WIFI SETUP] Wi-Fi password rejected. Retry in 10 seconds."
                                         : "[WIFI SETUP] Wi-Fi unavailable. Check 2.4 GHz network/range and retry in 10 seconds.");
    }
    if (events & SUCCESS) {
      verified_ = rememberNetwork(); failed_ = false;
      if (!verified_) Serial.println("[WIFI SETUP] Network could not be saved; previous network will be restored");
    }
    if (events & ENDED) {
      active_ = closing_ = failed_ = false;
      if (!verified_) restoreNetwork();
      else WiFi.setAutoReconnect(true);
      offlineAt_ = now; retryAt_ = now;
      Serial.println(verified_ ? "[WIFI SETUP] Bluetooth setup complete" : "[WIFI SETUP] Setup closed; previous configuration retained");
    } else if (!closing_) {
      if (lpmas::elapsed(now, setupAt_, lpmas::SETUP_WINDOW_MS)) {
        closing_ = true;
        network_prov_mgr_stop_provisioning();
      } else if (failed_ && lpmas::elapsed(now, failureAt_, lpmas::SETUP_FAILURE_DISPLAY_MS)) {
        // Leave time for the phone to read the failure before accepting a retry.
        if (network_prov_mgr_reset_wifi_sm_state_on_failure() == ESP_OK) {
          failed_ = false;
          Serial.println("[WIFI SETUP] Ready to retry; reconnect to the device in ESP BLE Prov");
        } else { closing_ = true; network_prov_mgr_stop_provisioning(); }
      }
    }
  }
  if (button_.update(digitalRead(0) == LOW, now)) openSetup();
  const bool up = connected();
  if (up && !wasConnected_) {
    if (!verified_) rememberNetwork();
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.println("[WIFI] Connected; time synchronization started");
  }
  if (!up && wasConnected_) offlineAt_ = now;
  if (!active_ && !up) {
    if ((haveSaved_ || restorePending_) && lpmas::elapsed(now, retryAt_, lpmas::WIFI_RETRY_MS)) {
      if (restorePending_) restoreNetwork();
      else WiFi.reconnect();
      retryAt_ = now;
    }
    if (lpmas::elapsed(now, offlineAt_, lpmas::WIFI_OFFLINE_SETUP_MS)) openSetup();
  }
  wasConnected_ = up;
}

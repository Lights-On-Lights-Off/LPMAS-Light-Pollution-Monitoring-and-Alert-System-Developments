#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>

TwoWire I2C_1 = TwoWire(0);
TwoWire I2C_2 = TwoWire(1);

#define SDA1_PIN 18
#define SCL1_PIN 19

#define SDA2_PIN 21
#define SCL2_PIN 22

#define BH1750_ADDRESS 0x23

// Copy ESP32-config.example.h to ESP32-config.h and provision locally.
#include "ESP32-config.h"
#include "root-certificates.h"
#include "wifi_setup.h"
#ifndef LPMAS_LOCAL_PI_URL
#define LPMAS_LOCAL_PI_URL ""
#endif
#ifndef LPMAS_LOCAL_NTP_HOST
#define LPMAS_LOCAL_NTP_HOST ""
#endif

WifiSetup networkSetup;

// Permanent Vercel URL. Used to look up the Pi's current tunnel address,
// since that address rotates and can no longer be hardcoded.
const char* VERCEL_PI_URL_ENDPOINT = "https://lpmas-light-pollution-monitoring-an-sage.vercel.app/api/pi-url";

const char* SENSOR_1_ID = "SENSOR_01";
const char* SENSOR_2_ID = "SENSOR_02";

String cachedPiBaseUrl = "";
unsigned long piUrlCachedAt = 0;
const unsigned long PI_URL_CACHE_MS = 5UL * 60UL * 1000UL;

void initializeClockFromBuild() {
  if (time(nullptr) >= 1704067200) return;
  // Approximate UTC bootstrap for HTTPS when NTP is unavailable. Build this
  // firmware with a correctly dated computer; background NTP can refine it.
  char month[4];
  struct tm built = {};
  int year, day, hour, minute, second;
  if (sscanf(__DATE__ " " __TIME__, "%3s %d %d %d:%d:%d",
      month, &day, &year, &hour, &minute, &second) != 6) return;
  const char* months = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char* match = strstr(months, month);
  if (!match) return;
  built.tm_mon = (match - months) / 3;
  built.tm_year = year - 1900;
  built.tm_mday = day;
  built.tm_hour = hour;
  built.tm_min = minute;
  built.tm_sec = second;
  setenv("TZ", "UTC0", 1);
  tzset();
  struct timeval clock = {};
  clock.tv_sec = mktime(&built);
  if (clock.tv_sec >= 1704067200 && settimeofday(&clock, nullptr) == 0) {
    Serial.println("[TIME] Using approximate firmware build time; delivery will not wait for NTP");
  }
}

bool localMode() { return strlen(LPMAS_LOCAL_PI_URL) > 0; }

bool validLocalPiUrl(const String &url) {
  if (!url.startsWith("http://") || !url.endsWith(":5001")) return false;
  String host = url.substring(7, url.length()-5);
  IPAddress address;
  if (!address.fromString(host)) return false;
  return address[0] == 10 || (address[0] == 172 && address[1] >= 16 && address[1] <= 31) ||
    (address[0] == 192 && address[1] == 168);
}

void checkTimeSync(bool connected) {
  if (localMode()) {
    static bool configured = false;
    if (!connected) { configured = false; return; }
    if (!configured && strlen(LPMAS_LOCAL_NTP_HOST) > 0) {
      configTime(0, 0, LPMAS_LOCAL_NTP_HOST);
      configured = true;
    }
    return; // Pi timestamps local measurements; no public NTP/DNS dependency.
  }
  static bool wasConnected = false;
  static bool reportedReady = false;
  static unsigned long lastAttempt = 0;
  static unsigned int nextServer = 0;
  const char* servers[] = {"time.google.com", "time.cloudflare.com", "pool.ntp.org"};

  if (!connected) {
    wasConnected = false;
    reportedReady = false;
    return;
  }
  if (!wasConnected) {
    wasConnected = true;
    lastAttempt = millis();
    nextServer = 0;
    Serial.print("[NETWORK] SSID=");
    Serial.print(WiFi.SSID());
    Serial.print(" | IP=");
    Serial.print(WiFi.localIP());
    Serial.print(" | Gateway=");
    Serial.print(WiFi.gatewayIP());
    Serial.print(" | DNS=");
    Serial.println(WiFi.dnsIP());
  }

  const time_t now = time(nullptr);
  if (now >= 1704067200) {
    if (!reportedReady) {
      struct tm utc;
      gmtime_r(&now, &utc);
      char timestamp[32];
      strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc);
      Serial.print("[TIME] Clock ready: ");
      Serial.println(timestamp);
      reportedReady = true;
    }
    return;
  }
  if (!lpmas::elapsed(millis(), lastAttempt, 30000)) return;

  // Restart a stalled initial request and rotate the first server on each retry.
  const char* server = servers[nextServer];
  nextServer = (nextServer + 1) % 3;
  Serial.print("[TIME] Clock still unset; checking DNS for ");
  Serial.println(server);
  IPAddress address;
  if (WiFi.hostByName(server, address) == 1) {
    Serial.print("[TIME] DNS OK: ");
    Serial.print(server);
    Serial.print(" -> ");
    Serial.println(address);
    Serial.println("[TIME] Retrying NTP; waiting for a time-server reply");
  } else {
    Serial.println("[TIME] DNS FAILED: check this Wi-Fi network's DNS/internet access");
  }
  configTime(0, 0, server, servers[nextServer], servers[(nextServer + 1) % 3]);
  lastAttempt = millis();
}

void startBH1750(TwoWire &bus) {
  bus.beginTransmission(BH1750_ADDRESS);
  bus.write(0x01);
  bus.endTransmission();

  bus.beginTransmission(BH1750_ADDRESS);
  bus.write(0x10);
  bus.endTransmission();
}

float readBH1750(TwoWire &bus) {
  bus.requestFrom(BH1750_ADDRESS, 2);

  if (bus.available() == 2) {
    uint16_t value = bus.read() << 8;
    value |= bus.read();
    return value / 1.2;
  }

  return -1;
}

// Extracts a "field":"value" string from a small flat JSON response.
// Only needs to handle the exact shape /api/pi-url returns.
bool extractJsonStringField(const String &json, const char* fieldName, String &out) {
  String needle = String("\"") + fieldName + "\":\"";
  int start = json.indexOf(needle);
  if (start < 0) return false;

  start += needle.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return false;

  out = json.substring(start, end);
  return true;
}

bool fetchPiUrlFromVercel(String &out) {
  WiFiClientSecure client;
  client.setCACert(LPMAS_ROOT_CA);

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);

  if (!http.begin(client, VERCEL_PI_URL_ENDPOINT)) {
    Serial.println("Failed to begin HTTPS request to Vercel");
    return false;
  }

  int responseCode = http.GET();

  if (responseCode != 200) {
    Serial.print("pi-url lookup failed, HTTP ");
    Serial.println(responseCode);
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  String url;

  if (!extractJsonStringField(body, "url", url) || url.length() == 0) {
    Serial.println("pi-url response missing url field");
    return false;
  }

  const String prefix = "https://";
  const String suffix = ".trycloudflare.com";
  bool trustedOrigin = url.startsWith(prefix) && url.endsWith(suffix);
  String hostLabel = url.substring(prefix.length(), url.length() - suffix.length());
  trustedOrigin = trustedOrigin && hostLabel.length() > 0;
  for (unsigned int i = 0; i < hostLabel.length(); i++) {
    char c = hostLabel[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) trustedOrigin = false;
  }
  if (!trustedOrigin) {
    Serial.println("Refusing untrusted Pi tunnel address");
    return false;
  }
  out = url;
  return true;
}

// Resolves the Pi's current base URL, using a cached value when fresh.
// Returns false only if no URL is available at all (fresh or cached).
bool resolvePiBaseUrl(bool forceRefresh) {
  if (localMode()) {
    if (!validLocalPiUrl(LPMAS_LOCAL_PI_URL)) {
      Serial.println("Local Pi URL must be http://<reserved-private-IPv4>:5001");
      return false;
    }
    cachedPiBaseUrl = LPMAS_LOCAL_PI_URL;
    return true;
  }
  bool isFresh = cachedPiBaseUrl.length() > 0 && (millis() - piUrlCachedAt) < PI_URL_CACHE_MS;

  if (isFresh && !forceRefresh) return true;

  String freshUrl;

  if (fetchPiUrlFromVercel(freshUrl)) {
    cachedPiBaseUrl = freshUrl;
    piUrlCachedAt = millis();
    Serial.print("Resolved Pi base URL: ");
    Serial.println(cachedPiBaseUrl);
    return true;
  }

  if (cachedPiBaseUrl.length() > 0) {
    Serial.println("pi-url refresh failed, reusing previously cached URL");
    return true;
  }

  Serial.println("No Pi base URL available yet");
  return false;
}

int postReadingOnce(const String &baseUrl, const String &payload) {
  WiFiClientSecure client;
  WiFiClient localClient;
  client.setCACert(LPMAS_ROOT_CA);

  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  String url = baseUrl + "/api/readings";

  bool began = localMode() ? (validLocalPiUrl(baseUrl) && http.begin(localClient, url)) : http.begin(client, url);
  if (!began) {
    Serial.println("Failed to begin HTTPS request to Pi");
    return -1;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-LPMAS-Device-Key", LPMAS_DEVICE_KEY);
  http.setTimeout(5000);
  int responseCode = http.POST(payload);
  http.end();

  return responseCode;
}

void printDeliveryStatus(const char* sensorId, const char* status, int responseCode = 0) {
  Serial.print("[DELIVERY] Wi-Fi=");
  Serial.print(networkSetup.connected() ? "CONNECTED" : "DISCONNECTED");
  Serial.print(" | Pi URL=");
  Serial.print(cachedPiBaseUrl.length() > 0 ? cachedPiBaseUrl : String("UNRESOLVED"));
  Serial.print(" | ");
  Serial.print(sensorId);
  Serial.print(" | ");
  Serial.print(status);
  if (responseCode != 0) {
    Serial.print(" | HTTP=");
    Serial.print(responseCode);
    if (responseCode < 0) {
      Serial.print(" (");
      Serial.print(HTTPClient::errorToString(responseCode));
      Serial.print(")");
    }
  }
  Serial.println();
}

void sendReading(const char* sensorId, float lux) {
  if (!networkSetup.connected()) {
    printDeliveryStatus(sensorId, "NOT SENT: Wi-Fi unavailable");
    return;
  }
  if (!localMode() && time(nullptr) < 1704067200) {
    printDeliveryStatus(sensorId, "NOT SENT: waiting for time synchronization");
    return;
  }

  if (lux < 0) {
    printDeliveryStatus(sensorId, "NOT SENT: sensor is not reading");
    return;
  }

  if (!resolvePiBaseUrl(false)) {
    printDeliveryStatus(sensorId, "NOT SENT: Pi URL lookup failed");
    return;
  }

  uint8_t id[16];
  for (int i = 0; i < 16; i += 4) { uint32_t word = esp_random(); memcpy(id + i, &word, 4); }
  id[6] = (id[6] & 0x0f) | 0x40; id[8] = (id[8] & 0x3f) | 0x80;
  char readingId[37];
  snprintf(readingId, sizeof(readingId), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    id[0],id[1],id[2],id[3],id[4],id[5],id[6],id[7],id[8],id[9],id[10],id[11],id[12],id[13],id[14],id[15]);
  // The same UUID is reused on every retry of this captured measurement.
  String payload = "{\"reading_id\":\"";
  payload += readingId;
  payload += "\",\"sensor_id\":\"";
  payload += sensorId;
  payload += "\",\"lux\":";
  payload += String(lux, 2);
  payload += "}";

  int responseCode = postReadingOnce(cachedPiBaseUrl, payload);

  if (responseCode <= 0 || responseCode == 429 || responseCode >= 500) {
    Serial.println("POST failed, refreshing Pi address and retrying once");
    if (resolvePiBaseUrl(true)) {
      responseCode = postReadingOnce(cachedPiBaseUrl, payload);
    }
  }

  printDeliveryStatus(sensorId,
    responseCode == 201 ? "SAVED ON PI" :
    responseCode == 200 ? "ALREADY SAVED ON PI" : "SEND FAILED",
    responseCode);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  if (!localMode()) initializeClockFromBuild();

  I2C_1.begin(SDA1_PIN, SCL1_PIN, 100000);
  I2C_2.begin(SDA2_PIN, SCL2_PIN, 100000);

  delay(200);

  startBH1750(I2C_1);
  startBH1750(I2C_2);

  delay(200);

  Serial.println();
  Serial.println("ESP32 + 2x BH1750");
  Serial.println("I2C Bus 1: SDA D18 / SCL D19");
  Serial.println("I2C Bus 2: SDA D21 / SCL D22");
  Serial.println();

  networkSetup.begin(LPMAS_SETUP_PASSWORD, LPMAS_DEVICE_KEY);

  Serial.println();
  Serial.println("LPMAS hardware monitoring started");
  Serial.println("Sampling interval: 10 seconds");
  Serial.println();
}

void loop() {
  networkSetup.tick();
  static unsigned long lastSample = 0;
  static bool previouslyConnected = false;
  const bool connected = networkSetup.connected();
  checkTimeSync(connected);
  if (connected && !previouslyConnected) { cachedPiBaseUrl = ""; piUrlCachedAt = 0; }
  previouslyConnected = connected;
  if (networkSetup.configuring() || !lpmas::elapsed(millis(), lastSample, 10000)) { delay(10); return; }
  lastSample = millis();
  float light1 = readBH1750(I2C_1);
  float light2 = readBH1750(I2C_2);

  Serial.println("------------------------------");

  Serial.print(SENSOR_1_ID);
  Serial.print(": ");

  if (light1 >= 0) {
    Serial.print(light1, 2);
    Serial.println(" lux");
  } else {
    Serial.println("NOT READING");
  }

  Serial.print(SENSOR_2_ID);
  Serial.print(": ");

  if (light2 >= 0) {
    Serial.print(light2, 2);
    Serial.println(" lux");
  } else {
    Serial.println("NOT READING");
  }

  Serial.println();

  sendReading(SENSOR_1_ID, light1);
  sendReading(SENSOR_2_ID, light2);

  Serial.println("Next reading in 10 seconds...");
  if (!connected) Serial.println("Wi-Fi unavailable; reconnecting in the background");
  else if (!localMode() && time(nullptr) < 1704067200) Serial.println("Waiting for time synchronization before HTTPS delivery");
}

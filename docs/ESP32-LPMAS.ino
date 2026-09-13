#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

TwoWire I2C_1 = TwoWire(0);
TwoWire I2C_2 = TwoWire(1);

#define SDA1_PIN 18
#define SCL1_PIN 19

#define SDA2_PIN 21
#define SCL2_PIN 22

#define BH1750_ADDRESS 0x23

const char* WIFI_SSID = "NBSC-WiFi";
const char* WIFI_PASSWORD = "Nb$c@2k25";

// Permanent Vercel URL. Used to look up the Pi's current tunnel address,
// since that address rotates and can no longer be hardcoded.
const char* VERCEL_PI_URL_ENDPOINT = "https://lpmas-light-pollution-monitoring-an-sage.vercel.app/api/pi-url";

const char* SENSOR_1_ID = "SENSOR_01";
const char* SENSOR_2_ID = "SENSOR_02";

String cachedPiBaseUrl = "";
unsigned long piUrlCachedAt = 0;
const unsigned long PI_URL_CACHE_MS = 5UL * 60UL * 1000UL;

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

void connectWiFi() {
  Serial.print("Connecting to WiFi");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
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
  client.setInsecure();

  HTTPClient http;

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

  out = url;
  return true;
}

// Resolves the Pi's current base URL, using a cached value when fresh.
// Returns false only if no URL is available at all (fresh or cached).
bool resolvePiBaseUrl(bool forceRefresh) {
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
  client.setInsecure();

  HTTPClient http;
  String url = baseUrl + "/api/readings";

  if (!http.begin(client, url)) {
    Serial.println("Failed to begin HTTPS request to Pi");
    return -1;
  }

  http.addHeader("Content-Type", "application/json");
  int responseCode = http.POST(payload);
  http.end();

  return responseCode;
}

void sendReading(const char* sensorId, float lux) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected");
    connectWiFi();
  }

  if (lux < 0) {
    Serial.print(sensorId);
    Serial.println(" not sending because sensor is not reading");
    return;
  }

  if (!resolvePiBaseUrl(false)) {
    Serial.print(sensorId);
    Serial.println(" not sending, Pi address unavailable");
    return;
  }

  String payload = "{\"sensor_id\":\"";
  payload += sensorId;
  payload += "\",\"lux\":";
  payload += String(lux, 2);
  payload += "}";

  int responseCode = postReadingOnce(cachedPiBaseUrl, payload);

  if (responseCode <= 0) {
    Serial.println("POST failed, refreshing Pi address and retrying once");
    if (resolvePiBaseUrl(true)) {
      responseCode = postReadingOnce(cachedPiBaseUrl, payload);
    }
  }

  Serial.print("Sending ");
  Serial.print(sensorId);
  Serial.print(" | ");
  Serial.print(lux, 2);
  Serial.print(" lux | HTTP ");

  if (responseCode > 0) {
    Serial.println(responseCode);
  } else {
    Serial.println("FAILED");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

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

  connectWiFi();
  resolvePiBaseUrl(true);

  Serial.println();
  Serial.println("LPMAS hardware monitoring started");
  Serial.println("Sampling interval: 10 seconds");
  Serial.println();
}

void loop() {
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
  delay(10000);
}
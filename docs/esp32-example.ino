/*
  LPMAS — ESP32 + BH1750 example
  --------------------------------
  Posts raw lux readings to the Raspberry Pi's Flask server on the LOCAL
  network. Classification (safe/warning/violation) happens on the Pi,
  not here — this sketch only reads and uploads.
*/

#include <Wire.h>
#include <BH1750.h>
#include <WiFi.h>
#include <HTTPClient.h>

BH1750 lightMeter;

const int SDA_PIN = 21;
const int SCL_PIN = 22;

const char* ssid = "YOUR_WIFI_SSID";       // must be 2.4GHz — ESP32 does not support 5GHz
const char* password = "YOUR_WIFI_PASSWORD";

// Point this at the Pi's local IP (check with `hostname -I` on the Pi)
const char* serverUrl = "http://192.168.100.142:5000/api/readings";

const char* sensorId = "sensor1"; // change per unit: sensor1, sensor2, sensor3

void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(SDA_PIN, SCL_PIN);
  if (!lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    Serial.println("BH1750 initialization FAILED. Check wiring and I2C address.");
  }

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected. IP: " + WiFi.localIP().toString());
}

void loop() {
  float lux = lightMeter.readLightLevel();
  Serial.print("Lux: ");
  Serial.println(lux);

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String payload = "{\"sensor_id\":\"" + String(sensorId) + "\",\"lux\":" + String(lux) + "}";
    int httpResponseCode = http.POST(payload);

    if (httpResponseCode > 0) {
      Serial.println("Server response: " + http.getString());
    } else {
      Serial.println("HTTP POST failed, error: " + String(httpResponseCode));
    }
    http.end();
  } else {
    Serial.println("WiFi not connected — skipping upload.");
  }

  delay(5000);
}

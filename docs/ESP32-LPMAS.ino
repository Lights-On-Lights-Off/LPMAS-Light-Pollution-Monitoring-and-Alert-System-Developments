#include <Wire.h>

TwoWire I2C_1 = TwoWire(0);
TwoWire I2C_2 = TwoWire(1);

#define SDA1_PIN 21
#define SCL1_PIN 22

#define SDA2_PIN 18
#define SCL2_PIN 19

#define BH1750_ADDRESS 0x23

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
  Serial.println("I2C Bus 1: SDA D21 / SCL D22");
  Serial.println("I2C Bus 2: SDA D18 / SCL D19");
  Serial.println();
}

void loop() {
  float light1 = readBH1750(I2C_1);
  float light2 = readBH1750(I2C_2);

  Serial.print("BH1750 #1: ");

  if (light1 >= 0) {
    Serial.print(light1);
    Serial.println(" lux");
  } else {
    Serial.println("NOT READING");
  }

  Serial.print("BH1750 #2: ");

  if (light2 >= 0) {
    Serial.print(light2);
    Serial.println(" lux");
  } else {
    Serial.println("NOT READING");
  }

  Serial.println("------------------------------");

  delay(1000);
}
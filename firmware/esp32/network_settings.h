#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace lpmas {
struct NetworkSettings {
  uint8_t version = 1;
  char ssid[33] = {};
  char password[65] = {};
};
inline bool validNetwork(const char* ssid, size_t ssidLength, const char* password, size_t passwordLength) {
  if (!ssidLength || ssidLength > 32 || passwordLength > 64) return false;
  for (size_t i = 0; i < ssidLength; ++i) if (static_cast<unsigned char>(ssid[i]) < 32 || ssid[i] == 127) return false;
  if (passwordLength == 64) {
    for (size_t i = 0; i < passwordLength; ++i) {
      const char c = password[i];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
  }
  // Open networks are explicit; WPA passphrases contain 8–63 printable ASCII bytes.
  if (passwordLength && passwordLength < 8) return false;
  for (size_t i = 0; i < passwordLength; ++i) if (password[i] < 32 || password[i] > 126) return false;
  return true;
}
inline bool validStoredNetwork(const NetworkSettings& value) {
  const size_t ssidLength = strnlen(value.ssid, sizeof(value.ssid));
  const size_t passwordLength = strnlen(value.password, sizeof(value.password));
  return value.version == 1 && ssidLength < sizeof(value.ssid) && passwordLength < sizeof(value.password) &&
    validNetwork(value.ssid, ssidLength, value.password, passwordLength);
}
inline bool elapsed(uint32_t now, uint32_t started, uint32_t duration) {
  return static_cast<uint32_t>(now - started) >= duration;
}
}

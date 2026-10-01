#include "../esp32/network_settings.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <string>

int main() {
  using namespace lpmas;
  const auto valid = [](const std::string& ssid, const std::string& password) {
    return validNetwork(ssid.data(), ssid.size(), password.data(), password.size());
  };
  assert(valid("Router", "correct-password"));
  assert(valid("Phone hotspot", "12345678"));
  assert(valid("Hidden network", ""));
  assert(valid(std::string(32, 'n'), std::string(63, 'p')));
  assert(valid("Router", std::string(64, 'a')));
  assert(valid("Caf\xc3\xa9", "wifi-passphrase"));
  assert(!valid("", "12345678"));
  assert(!valid(std::string(33, 'n'), "12345678"));
  assert(!valid("Router", "short"));
  assert(!valid("Router", std::string(65, 'a')));
  assert(!valid("Router", std::string(64, 'z')));
  assert(!valid("Router", "has\nnewline"));
  assert(!valid("has\nnewline", "12345678"));
  assert(!valid(std::string("null\0ssid", 9), "12345678"));
  assert(!valid("Router", std::string("null\0password", 13)));
  NetworkSettings stored;
  std::strcpy(stored.ssid, "Router"); std::strcpy(stored.password, "12345678");
  assert(validStoredNetwork(stored));
  stored.version = 2; assert(!validStoredNetwork(stored)); stored.version = 1;
  std::memset(stored.ssid, 's', sizeof(stored.ssid)); assert(!validStoredNetwork(stored));
  std::strcpy(stored.ssid, "Router");
  std::memset(stored.password, 'p', sizeof(stored.password)); assert(!validStoredNetwork(stored));
  stored = {}; assert(!validStoredNetwork(stored));
  assert(!elapsed(29999, 0, 30000)); assert(elapsed(30000, 0, 30000));
  // millis() wrapping at 49 days must not disable recovery, setup expiry or BOOT.
  assert(!elapsed(10, UINT32_MAX - 10, 22)); assert(elapsed(11, UINT32_MAX - 10, 22));
  assert(elapsed(5000, UINT32_MAX - 100, 5000));
  std::cout << "Firmware settings: network validation, corrupt storage and timer rollover passed.\n";
}

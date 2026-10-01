#pragma once
// Copy to ESP32-config.h locally. Never commit the provisioned file.
// Wi-Fi is configured from a nearby phone; network credentials stay in device NVS.
const char* LPMAS_DEVICE_KEY = "PROVISION_THE_SAME_RANDOM_KEY_AS_THE_PI";
// Optional unique setup Wi-Fi password, 12–63 printable ASCII characters.
// Leave empty to generate one once and show it in Serial Monitor at 115200 baud.
#define LPMAS_SETUP_PASSWORD ""

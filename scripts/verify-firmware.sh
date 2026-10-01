#!/usr/bin/env bash
# Native checks for firmware policies; compile/flash the sketch with Arduino separately.
set -euo pipefail
cd "$(dirname "$0")/.."
firmware_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/lpmas-firmware-tests.XXXXXX")
trap 'rm -f "$firmware_test_dir/network-settings"; rmdir "$firmware_test_dir"' EXIT
"${CXX:-g++}" -std=c++17 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined \
  firmware/tests/network_settings.test.cpp -o "$firmware_test_dir/network-settings"
"$firmware_test_dir/network-settings"

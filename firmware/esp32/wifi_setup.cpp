#include "wifi_setup.h"
#include <esp_wifi.h>

namespace {
const char SETUP_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LPMAS Wi-Fi setup</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6f5;color:#17382c;font:16px system-ui,sans-serif}
main{max-width:440px;margin:8vh auto;padding:28px;background:#fff;border-radius:20px;box-shadow:0 8px 30px #17382c12}
h1{font-size:26px;margin:6px 0 12px}p{line-height:1.5;color:#52635d}label{display:block;margin:18px 0 7px;font-weight:600}
input:not([type=checkbox]),select,button{width:100%;padding:13px;border:1px solid #bac9c1;border-radius:9px;font:inherit}
button{margin-top:22px;background:#176c46;color:white;border:0;font-weight:600;cursor:pointer}button:disabled{opacity:.6}
.check{font-weight:400;font-size:14px}#status{min-height:48px;padding:12px;background:#eef5f0;border-radius:9px}
small{display:block;color:#52635d;margin-top:8px}@media(max-width:480px){main{margin:20px 12px}}
</style></head><body><main><small>LPMAS SENSOR DEVICE</small><h1>Connect to Wi-Fi</h1>
<p>Choose your router or phone hotspot. Use a 2.4 GHz network. Your current saved network stays available if the new connection fails.</p>
<form id="wifi" action="/connect" method="post"><input type="hidden" name="token" value="{{TOKEN}}">
<label for="nearby">Nearby networks</label><select id="nearby"><option value="">Scanning… or enter a network below</option></select>
<label for="ssid">Network name (SSID)</label><input id="ssid" name="ssid" maxlength="32" required autocomplete="off" autocapitalize="none" spellcheck="false">
<label for="password">Network password</label><input id="password" name="password" type="password" maxlength="64" autocomplete="new-password">
<small>Leave blank only for an open network.</small><label class="check"><input id="show" type="checkbox"> Show password</label>
<button id="save" type="submit">Connect and save</button></form>
<p id="status" role="status" aria-live="polite">Ready. Setup closes after five minutes; hold BOOT for five seconds after startup to reopen it.</p>
<small>Sensor delivery pauses during setup and resumes when setup closes. Only a successful connection is saved.</small></main>
<script>
const form=document.getElementById('wifi'),button=document.getElementById('save'),status=document.getElementById('status');
const password=document.getElementById('password'),nearby=document.getElementById('nearby');let submitting=false,done=false;
document.getElementById('show').onchange=e=>password.type=e.target.checked?'text':'password';
nearby.onchange=()=>{if(nearby.value)document.getElementById('ssid').value=nearby.value;};
const messages={ready:'Ready. Enter your Wi-Fi details.',connecting:'Connecting… this can take up to 30 seconds.',
error:'Could not connect. Check the network name, password and signal, then try again. Your previous saved network is unchanged.',
storage_error:'Could not save settings. Your previous saved network is unchanged. Restart the device and try again.',
saved:'Connected and saved. Setup Wi-Fi will close shortly. Reconnect your phone to your normal network.'};
async function poll(){if(done)return;try{const r=await fetch('/status',{cache:'no-store'});const s=await r.json();
if(s.state!=='ready'||submitting)status.textContent=messages[s.state]||messages.ready;
if(s.state==='error'||s.state==='storage_error'){submitting=false;button.disabled=false;}
if(s.state==='saved'){done=true;password.value='';button.disabled=true;}
}catch(e){if(submitting)status.textContent='The device may be switching Wi-Fi channels. Stay on the LPMAS setup network to check the result.';}
if(!done)setTimeout(poll,1000);}
form.onsubmit=async e=>{e.preventDefault();if(submitting)return;button.disabled=true;submitting=true;
status.textContent=messages.connecting;try{const r=await fetch('/connect',{method:'POST',body:new URLSearchParams(new FormData(form))});
if(!r.ok){submitting=false;button.disabled=false;status.textContent=await r.text();}}
catch(e){status.textContent='Stay connected to the LPMAS setup network while the connection is tested.';}};
async function scan(){try{const r=await fetch('/networks',{cache:'no-store'}),list=await r.json();if(list.scanning){setTimeout(scan,1500);return;}
nearby.replaceChildren(new Option('Choose a network, or enter a hidden network below',''));
for(const name of list.networks)nearby.add(new Option(name,name));}catch(e){nearby.options[0].text='Enter your network name below';}}
poll();scan();
</script></body></html>)HTML";
}

String WifiSetup::randomSecret(size_t bytes) {
  String value;
  for (size_t i = 0; i < bytes; ++i) { char hex[3]; snprintf(hex, sizeof(hex), "%02x", static_cast<unsigned>(esp_random() & 255)); value += hex; }
  return value;
}
String WifiSetup::jsonString(const String& value) {
  String result = "\"";
  for (size_t i = 0; i < value.length(); ++i) {
    const unsigned char c = value[i];
    if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 32) { char escaped[7]; snprintf(escaped, sizeof(escaped), "\\u%04x", c); result += escaped; }
    else result += static_cast<char>(c);
  }
  return result + '"';
}
void WifiSetup::begin(const char* provisionedPassword) {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  WiFi.persistent(false); WiFi.setAutoReconnect(false); WiFi.mode(WIFI_STA);
  storageReady_ = store_.begin("lpmas-network", false);
  if (storageReady_ && store_.getBytesLength("wifi") == sizeof(saved_)) {
    store_.getBytes("wifi", &saved_, sizeof(saved_)); haveSaved_ = lpmas::validStoredNetwork(saved_);
  }
  apPassword_ = provisionedPassword;
  if (apPassword_.isEmpty() && storageReady_) apPassword_ = store_.getString("setup-password");
  if (apPassword_.length() < 12 || apPassword_.length() > 63 || !lpmas::validNetwork("setup", 5, apPassword_.c_str(), apPassword_.length())) {
    apPassword_ = randomSecret(8);
    if (storageReady_) store_.putString("setup-password", apPassword_);
  }
  String suffix = WiFi.macAddress(); suffix.replace(":", ""); apName_ = "LPMAS-Setup-" + suffix.substring(6);
  const char* headers[] = {"Origin", "Content-Length"}; server_.collectHeaders(headers, 2);
  server_.on("/", HTTP_GET, [this] { page(); });
  server_.on("/connect", HTTP_POST, [this] { submit(); });
  server_.on("/status", HTTP_GET, [this] { status(); });
  server_.on("/networks", HTTP_GET, [this] { networks(); });
  server_.onNotFound([this] {
    if (!localClient()) return;
    server_.sendHeader("Location", "http://192.168.4.1/", true); send(302, "text/plain", "Open Wi-Fi setup");
  });
  offlineAt_ = millis(); retryAt_ = millis();
  if (haveSaved_) connect(saved_); else openPortal(false);
}
void WifiSetup::connect(const lpmas::NetworkSettings& value) {
  if (WiFi.scanComplete() == WIFI_SCAN_RUNNING) esp_wifi_scan_stop();
  WiFi.disconnect(false, false, 1000);
  // Never mistake an old association for successful verification of new credentials.
  if (WiFi.status() == WL_CONNECTED) {
    connecting_ = false; testing_ = false; candidate_ = {}; state_ = "error"; retryAt_ = millis(); return;
  }
  WiFi.begin(value.ssid, value.password);
  connecting_ = true; connectAt_ = millis(); retryAt_ = connectAt_;
}
void WifiSetup::openPortal(bool manual) {
  if (portal_) return;
  // Let the initial scan finish before retrying a saved network in the background.
  if (connecting_) { WiFi.disconnect(false, false); connecting_ = false; retryAt_ = millis(); }
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
  if (!WiFi.softAP(apName_.c_str(), apPassword_.c_str(), 1, false, 2)) { Serial.println("[WIFI] Setup access point could not start"); return; }
  portal_ = true; manual_ = manual; portalAt_ = millis(); closePending_ = false;
  state_ = "ready"; csrf_ = randomSecret(16);
  dns_.start(53, "*", WiFi.softAPIP()); server_.begin();
  WiFi.scanNetworks(true);
  Serial.printf("[WIFI SETUP] Network: %s\n[WIFI SETUP] Password: %s\n[WIFI SETUP] Open http://192.168.4.1\n", apName_.c_str(), apPassword_.c_str());
}
void WifiSetup::closePortal() {
  server_.stop(); dns_.stop(); WiFi.scanDelete(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA);
  portal_ = false; closePending_ = false; csrf_ = ""; retryAt_ = millis(); offlineAt_ = millis();
}
void WifiSetup::send(int code, const char* type, const String& body) {
  server_.sendHeader("Cache-Control", "no-store"); server_.sendHeader("X-Content-Type-Options", "nosniff");
  server_.sendHeader("X-Frame-Options", "DENY"); server_.sendHeader("Referrer-Policy", "no-referrer");
  server_.sendHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'");
  server_.send(code, type, body);
}
bool WifiSetup::localClient() {
  if (!portal_ || server_.client().localIP() != WiFi.softAPIP()) { send(403, "text/plain", "Connect to the protected setup Wi-Fi first."); return false; }
  return true;
}
void WifiSetup::page() {
  if (!localClient()) return;
  if (server_.hostHeader() != "192.168.4.1" && server_.hostHeader() != "192.168.4.1:80") {
    server_.sendHeader("Location", "http://192.168.4.1/", true); send(302, "text/plain", "Open Wi-Fi setup"); return;
  }
  String html = FPSTR(SETUP_PAGE); html.replace("{{TOKEN}}", csrf_); send(200, "text/html; charset=utf-8", html);
}
void WifiSetup::submit() {
  if (!localClient()) return;
  const String origin = server_.header("Origin");
  if ((!origin.isEmpty() && origin != "http://192.168.4.1") || server_.arg("token") != csrf_) {
    send(403, "text/plain", "Reload the setup page and try again."); return;
  }
  if (!storageReady_) { send(503, "text/plain", "Device storage is unavailable. Restart and try again."); return; }
  if (testing_ || closePending_) { send(409, "text/plain", "A connection test is already in progress."); return; }
  const String ssid = server_.arg("ssid"), password = server_.arg("password");
  if (!lpmas::validNetwork(ssid.c_str(), ssid.length(), password.c_str(), password.length())) {
    send(400, "text/plain", "Use a network name of 1–32 bytes and a valid Wi-Fi password (8–63 characters, 64 hex digits, or blank for open Wi-Fi)."); return;
  }
  candidate_ = {}; memcpy(candidate_.ssid, ssid.c_str(), ssid.length()); memcpy(candidate_.password, password.c_str(), password.length());
  testing_ = true; manual_ = true; portalAt_ = millis(); state_ = "connecting";
  send(202, "text/plain", "Testing connection. Settings will be saved only after a successful connection.");
  WiFi.scanDelete(); connect(candidate_);
}
void WifiSetup::status() {
  if (localClient()) send(200, "application/json", "{\"state\":" + jsonString(state_) + "}");
}
void WifiSetup::networks() {
  if (!localClient()) return;
  const int count = WiFi.scanComplete();
  if (count == WIFI_SCAN_RUNNING) { send(200, "application/json", "{\"scanning\":true}"); return; }
  String json = "{\"scanning\":false,\"networks\":[";
  bool first = true;
  for (int i = 0; i < count && i < 20; ++i) {
    const String ssid = WiFi.SSID(i); if (ssid.isEmpty()) continue;
    if (!first) json += ','; first = false; json += jsonString(ssid);
  }
  send(200, "application/json", json + "]}");
}
void WifiSetup::tick() {
  const uint32_t now = millis();
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;
  if (pressed && !buttonDown_) { buttonAt_ = now; buttonHandled_ = false; }
  if (pressed && !buttonHandled_ && lpmas::elapsed(now, buttonAt_, 5000)) { openPortal(true); buttonHandled_ = true; }
  buttonDown_ = pressed;
  if (portal_) { dns_.processNextRequest(); server_.handleClient(); }
  const bool up = WiFi.status() == WL_CONNECTED && (!testing_ || WiFi.SSID() == candidate_.ssid);
  if (up) {
    connecting_ = false;
    if (!wasConnected_) configTime(0, 0, "pool.ntp.org", "time.google.com");
    if (testing_) {
      testing_ = false;
      if (store_.putBytes("wifi", &candidate_, sizeof(candidate_)) == sizeof(candidate_)) {
        saved_ = candidate_; haveSaved_ = true; state_ = "saved"; closePending_ = true; closeAt_ = now;
        Serial.println("[WIFI] New network connected and saved");
      } else { state_ = "storage_error"; WiFi.disconnect(false, false); }
      candidate_ = {};
    } else if (portal_ && !manual_ && !closePending_ && state_ != "storage_error") {
      closePending_ = true; closeAt_ = now;
    }
  } else {
    if (wasConnected_) offlineAt_ = now;
    if (connecting_ && lpmas::elapsed(now, connectAt_, CONNECT_TIMEOUT)) {
      connecting_ = false; WiFi.disconnect(false, false);
      if (testing_) { testing_ = false; candidate_ = {}; state_ = "error"; }
    }
    if (!testing_ && !connecting_ && haveSaved_ && lpmas::elapsed(now, retryAt_, RETRY_INTERVAL)) connect(saved_);
    if (!portal_ && lpmas::elapsed(now, offlineAt_, haveSaved_ ? 60000 : RETRY_INTERVAL)) openPortal(false);
  }
  wasConnected_ = WiFi.status() == WL_CONNECTED;
  if (portal_ && ((closePending_ && lpmas::elapsed(now, closeAt_, 5000)) || (!testing_ && lpmas::elapsed(now, portalAt_, PORTAL_TIMEOUT)))) closePortal();
}

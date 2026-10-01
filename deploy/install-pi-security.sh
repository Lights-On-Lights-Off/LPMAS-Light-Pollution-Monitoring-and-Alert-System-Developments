#!/usr/bin/env bash
# Run on the Pi after provisioning the matching ESP32 firmware:
# sudo bash deploy/install-pi-security.sh <service-user> <private-security.json>
set -euo pipefail
if [[ $EUID != 0 || $# != 2 ]]; then
  echo 'Usage: sudo bash deploy/install-pi-security.sh <service-user> <private-security.json>' >&2
  exit 1
fi
pi_user=$1
security_source=$(realpath "$2")
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
pi_home=$(getent passwd "$pi_user" | cut -d: -f6)
[[ -n "$pi_home" && "$pi_user" != root ]] || { echo 'Use a non-root Pi account.' >&2; exit 1; }
command -v cloudflared >/dev/null
python3 - "$security_source" <<'PY'
import json, pathlib, sys
from urllib.parse import urlsplit
path = pathlib.Path(sys.argv[1])
if path.stat().st_mode & 0o077: raise SystemExit('Private configuration must have mode 600.')
value = json.loads(path.read_text())
for key in ('device_key', 'pi_token'):
    if not isinstance(value.get(key), str) or len(value[key]) < 32:
        raise SystemExit('Missing or weak device/cloud credential.')
origins = value.get('allowed_origins')
if not isinstance(origins, list) or not origins: raise SystemExit('Configure allowed web origins.')
for origin in origins:
    u = urlsplit(origin)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
        raise SystemExit('Web origins must be exact HTTPS origins.')
PY
pi_group=$(id -gn "$pi_user")
install -d -m 700 -o "$pi_user" -g "$pi_group" "$pi_home/.config/lpmas" "$pi_home/.local/share/lpmas"
venv_path="$pi_home/.local/share/lpmas/venv"
runuser -u "$pi_user" -- python3 -m venv "$venv_path"
runuser -u "$pi_user" -- "$venv_path/bin/pip" install -r "$repo_dir/pi-server/requirements.txt"
# Check the credential against the deployed gateway before changing services.
runuser -u "$pi_user" -- "$venv_path/bin/python" - "$repo_dir/pi-server" "$security_source" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import app
from cloud_gateway import gateway_request
config = json.load(open(sys.argv[2]))
snapshot = gateway_request(app.EDGE_FUNCTION_URL, config['pi_token'], 'configuration')
if not isinstance(snapshot, dict) or 'sensor_list' not in snapshot:
    raise SystemExit('Cloud configuration check failed.')
print('Scoped cloud access verified.')
PY
install -m 600 -o "$pi_user" -g "$pi_group" "$security_source" "$pi_home/.config/lpmas/security.json"
python3 - "$repo_dir" "$pi_user" "$venv_path" <<'PY'
import pathlib, sys
repo, user, venv = sys.argv[1:]
# Quote systemd values and escape specifiers, including paths containing spaces.
def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
for name, module in [('lpmas-app', 'app.py'), ('lpmas-tunnel', 'tunnel_sync.py')]:
    content = (pathlib.Path(repo) / 'deploy' / (name + '.service')).read_text()
    content = content.replace('User=pi', 'User=' + user)
    content = content.replace('WorkingDirectory=/home/pi/lpmas/pi-server', 'WorkingDirectory=' + quote(repo + '/pi-server'))
    content = content.replace('ExecStart=/usr/bin/python3 /home/pi/lpmas/pi-server/' + module,
                              'ExecStart=' + quote(venv + '/bin/python') + ' ' + quote(repo + '/pi-server/' + module))
    pathlib.Path('/etc/systemd/system/' + name + '.service').write_text(content)
PY
systemctl daemon-reload
systemctl enable lpmas-app.service lpmas-tunnel.service
systemctl restart lpmas-app.service lpmas-tunnel.service
systemctl is-active --quiet lpmas-app.service lpmas-tunnel.service
echo 'Services restarted. Confirm fresh authenticated sensor readings before removing old Supabase administrator credentials from the Pi.'

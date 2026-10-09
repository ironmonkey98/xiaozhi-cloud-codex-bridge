#!/usr/bin/env bash
# Run on the cloud host from the directory containing these files and hashed passwords.
set -euo pipefail
cd "$(dirname "$0")"
SITE="${NGINX_NOTIFY_SITE:?Set NGINX_NOTIFY_SITE to an existing HTTPS site file}"
test -f "$SITE"
test -f passwords
BACKUP="${SITE}.before-xiaozhi-notify-$(date +%Y%m%d%H%M%S)"
sudo install -m 0640 -o root -g mosquitto passwords /etc/mosquitto/passwd-xiaozhi-notify
sudo install -m 0640 -o root -g mosquitto acl /etc/mosquitto/acl-xiaozhi-notify
sudo install -m 0644 mosquitto.conf /etc/mosquitto/conf.d/xiaozhi-notify.conf
sudo install -m 0644 nginx.conf /etc/nginx/snippets/xiaozhi-notify.conf
sudo cp -p "$SITE" "$BACKUP"
sudo python3 - "$SITE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
line = '    include /etc/nginx/snippets/xiaozhi-notify.conf;\n'
if line not in s:
    marker = '    ssl_certificate '
    if s.count(marker) != 1:
        raise SystemExit('Expected exactly one HTTPS server; refusing ambiguous edit')
    s = s.replace(marker, line + marker, 1)
    p.write_text(s)
PY
if ! sudo nginx -t; then
    sudo cp -p "$BACKUP" "$SITE"
    exit 1
fi
sudo systemctl restart mosquitto
sudo systemctl reload nginx
sudo systemctl enable mosquitto >/dev/null
sudo systemctl is-active mosquitto nginx
rm -f passwords

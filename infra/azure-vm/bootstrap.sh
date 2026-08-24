#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/raw-html-maxxing
APP_USER=rawhtml
APP_HOME=/var/lib/raw-html-maxxing
APP_HOST=raw-html-maxxing-dd899e.centralus.cloudapp.azure.com
REPO_URL=https://github.com/Monzingo89/raw-html-maxxing.git

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https gnupg git fluxbox x11vnc xvfb

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list

apt-get update
apt-get install -y caddy google-chrome-stable

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
fi

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone --branch main --single-branch "$REPO_URL" "$APP_DIR"
fi

npm --prefix "$APP_DIR" ci --omit=dev
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP_HOME/browser-profile"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cat > /etc/systemd/system/raw-html-display.service <<'UNIT'
[Unit]
Description=Raw HTML Maxxing virtual display
After=network.target

[Service]
Type=simple
User=rawhtml
ExecStart=/usr/bin/Xvfb :99 -screen 0 1600x1200x24 -nolisten tcp -ac
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/raw-html-window-manager.service <<'UNIT'
[Unit]
Description=Raw HTML Maxxing window manager
After=raw-html-display.service
Requires=raw-html-display.service

[Service]
Type=simple
User=rawhtml
Environment=DISPLAY=:99
ExecStart=/usr/bin/fluxbox
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/raw-html-vnc.service <<'UNIT'
[Unit]
Description=Private VNC access for eBay verification
After=raw-html-display.service
Requires=raw-html-display.service

[Service]
Type=simple
User=rawhtml
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -rfbauth /etc/raw-html-vnc.pass -rfbport 5900
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

if [[ ! -s /etc/raw-html-vnc.pass ]]; then
  if [[ -z "${VNC_PASSWORD:-}" ]]; then
    echo "Set VNC_PASSWORD when bootstrapping a new VM." >&2
    exit 1
  fi
  x11vnc -storepasswd "${VNC_PASSWORD}" /etc/raw-html-vnc.pass
fi
chown rawhtml:rawhtml /etc/raw-html-vnc.pass
chmod 600 /etc/raw-html-vnc.pass

cat > /etc/systemd/system/raw-html-maxxing.service <<'UNIT'
[Unit]
Description=Raw HTML Maxxing capture API
After=network-online.target raw-html-display.service raw-html-window-manager.service
Wants=network-online.target
Requires=raw-html-display.service

[Service]
Type=simple
User=rawhtml
WorkingDirectory=/opt/raw-html-maxxing
Environment=NODE_ENV=production
Environment=DISPLAY=:99
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=HEADLESS=false
Environment=BROWSER_CHANNEL=chrome
Environment=USER_DATA_DIR=/var/lib/raw-html-maxxing/browser-profile
Environment=CORS_ORIGIN=https://monzingo89.github.io
Environment=ALLOW_HOSTS=ebay.com,www.ebay.com
Environment=RATE_LIMIT_MAX=30
Environment=RATE_LIMIT_WINDOW_MS=3600000
Environment=NAV_TIMEOUT_MS=90000
Environment=SETTLE_MS=1000
ExecStart=/usr/bin/node /opt/raw-html-maxxing/src/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
${APP_HOST} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }
}
CADDY

systemctl daemon-reload
systemctl enable --now raw-html-display.service raw-html-window-manager.service raw-html-vnc.service raw-html-maxxing.service caddy.service
systemctl restart caddy.service raw-html-maxxing.service

echo "Bootstrap complete for ${APP_HOST}"

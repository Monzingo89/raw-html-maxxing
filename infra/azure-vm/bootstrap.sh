#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/raw-html-maxxing
APP_USER=rawhtml
APP_HOME=/var/lib/raw-html-maxxing
APP_HOST=${APP_HOST:-raw-html-maxxing-dd899e.centralus.cloudapp.azure.com}
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
  # The checkout is owned by the service account after the first bootstrap.
  # Run Git as that same account so repeat deployments do not trip Git's
  # dubious-ownership protection.
  runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch origin main
  runuser -u "$APP_USER" -- git -C "$APP_DIR" reset --hard origin/main
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
StartLimitIntervalSec=0

[Service]
Type=simple
User=rawhtml
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -rfbauth /etc/raw-html-vnc.pass -rfbport 5900
Restart=always
RestartSec=1

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
Environment=RATE_LIMIT_MAX=10000
Environment=RATE_LIMIT_WINDOW_MS=86400000
Environment=GLOBAL_RATE_LIMIT_MAX=10000
Environment=GLOBAL_RATE_LIMIT_WINDOW_MS=86400000
Environment=DAILY_RATE_LIMIT_MAX=10000
Environment=DAILY_RATE_LIMIT_WINDOW_MS=86400000
Environment=CAPTURE_DAILY_RATE_LIMIT_MAX=10000
Environment=RATE_LIMIT_STATE_FILE=/var/lib/raw-html-maxxing/rate-limit-state.json
Environment=CACHE_DIR=/var/lib/raw-html-maxxing/capture-cache
Environment=CACHE_TTL_MS=172800000
Environment=CAPTURE_DELAY_MIN_MS=4640
Environment=CAPTURE_DELAY_MAX_MS=5640
Environment=BATCH_DIR=/var/lib/raw-html-maxxing/batches
Environment=BATCH_MAX_URLS=10000
Environment=BATCH_REQUEST_MAX_BYTES=33554432
Environment=BATCH_START_INTERVAL_MS=8640
Environment=BATCH_MINIMUM_SLEEP_MS=4640
Environment=RETRY_QUEUE_FILE=/var/lib/raw-html-maxxing/retry-queue.json
Environment=RETRY_BASE_DELAY_MS=30000
Environment=RETRY_MAX_DELAY_MS=900000
Environment=RETRY_SAME_ERROR_THRESHOLD=3
Environment=RETRY_CIRCUIT_DELAY_MS=300000
Environment=LOGIN_RETRY_DELAY_MS=180000
Environment=LOGIN_STATE_FILE=/var/lib/raw-html-maxxing/login-state.json
Environment=ALERT_STATE_FILE=/var/lib/raw-html-maxxing/alert-state.json
Environment=ALERT_COOLDOWN_MS=3600000
Environment=INSTANCE_NAME=%H
EnvironmentFile=-/etc/raw-html-alert.env
EnvironmentFile=-/etc/raw-html-admin.env
Environment=NAV_TIMEOUT_MS=90000
Environment=SETTLE_MS=1000
Environment=VERIFICATION_TIMEOUT_MS=0
ExecStart=/usr/bin/node /opt/raw-html-maxxing/src/server.mjs
Restart=on-failure
RestartSec=5
KillMode=control-group
TasksMax=512
MemoryHigh=5G
MemoryMax=6G
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

# Remove the pre-batch rate-limit drop-in used by older deployments. Its
# Environment entries override the canonical values in the service above.
rm -f /etc/systemd/system/raw-html-maxxing.service.d/limits.conf

systemctl daemon-reload

mkdir -p /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/raw-html-limits.conf <<'JOURNAL'
[Journal]
SystemMaxUse=256M
RuntimeMaxUse=64M
RateLimitIntervalSec=30s
RateLimitBurst=1000
JOURNAL
systemctl restart systemd-journald
systemctl enable --now raw-html-display.service raw-html-window-manager.service raw-html-vnc.service raw-html-maxxing.service caddy.service
systemctl restart caddy.service raw-html-maxxing.service

echo "Bootstrap complete for ${APP_HOST}"

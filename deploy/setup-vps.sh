#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot setup for an Ubuntu 22.04 / 24.04 VPS.
# Installs Node 20, nginx, certbot; deploys the app to /opt/checkout; wires up
# systemd; obtains a Let's Encrypt certificate for checkout.ninjjakoffe.site.
#
# BEFORE RUNNING:
#   1. Create an A record:  checkout.ninjjakoffe.site -> <this server's public IP>
#   2. Wait for DNS to propagate:  dig +short checkout.ninjjakoffe.site
#   3. Have your .env values ready (Chargebee API key + publishable key)
#
# RUN:
#   sudo bash setup-vps.sh
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="checkout.ninjjakoffe.site"
APP_DIR="/opt/checkout"
APP_USER="www-data"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo -e "\n\033[1;34m==> $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root:  sudo bash setup-vps.sh" >&2
  exit 1
fi

# --- 0. sanity-check DNS before we ask Let's Encrypt for a cert -------------
log "Checking DNS for $DOMAIN"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo unknown)"
RESOLVED_IP="$(dig +short "$DOMAIN" A | tail -1 || echo none)"
echo "  server public IP : $SERVER_IP"
echo "  $DOMAIN resolves to: ${RESOLVED_IP:-none}"
if [[ "$RESOLVED_IP" != "$SERVER_IP" ]]; then
  echo
  echo "  WARNING: DNS does not point at this server yet."
  echo "  Add an A record for '$DOMAIN' -> $SERVER_IP, wait for propagation,"
  echo "  then re-run. Continuing anyway in 15s (Ctrl+C to abort)..."
  sleep 15
fi

# --- 1. packages -----------------------------------------------------------
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx certbot python3-certbot-nginx dnsutils

log "Installing Node.js 20"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  node $(node -v) / npm $(npm -v)"

# --- 2. deploy the app -----------------------------------------------------
log "Deploying application to $APP_DIR"
mkdir -p "$APP_DIR"
# Copy source without node_modules / .env / .git
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude .env --exclude .git \
    --exclude agent-transcripts --exclude '*.log' \
    "$SRC_DIR/" "$APP_DIR/"
else
  cp -r "$SRC_DIR/." "$APP_DIR/"
  rm -rf "$APP_DIR/node_modules" "$APP_DIR/.env" "$APP_DIR/.git"
fi

cd "$APP_DIR"
log "Installing production dependencies"
npm ci --omit=dev

# --- 3. .env ---------------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  log "Creating $APP_DIR/.env from .env.production.example"
  cp "$APP_DIR/.env.production.example" "$APP_DIR/.env"
  echo
  echo "  !! You must now edit $APP_DIR/.env and fill in your keys.  !!"
  echo "     sudo nano $APP_DIR/.env"
  echo
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- 4. systemd ------------------------------------------------------------
log "Installing systemd service"
cp "$APP_DIR/deploy/checkout.service" /etc/systemd/system/checkout.service
systemctl daemon-reload
systemctl enable checkout
systemctl restart checkout
sleep 3
systemctl is-active --quiet checkout && echo "  checkout service: active" || {
  echo "  checkout service failed to start. Logs:"
  journalctl -u checkout -n 30 --no-pager
  exit 1
}
curl -fsS --max-time 10 http://127.0.0.1:3000/healthz && echo "  local health check OK"

# --- 5. nginx --------------------------------------------------------------
log "Configuring nginx"
mkdir -p /var/www/certbot
cp "$APP_DIR/deploy/nginx-checkout.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# --- 6. TLS ----------------------------------------------------------------
log "Requesting Let's Encrypt certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --register-unsafely-without-email --redirect || {
    echo "  certbot failed — DNS probably isn't pointed here yet."
    echo "  Re-run once DNS is correct:  sudo certbot --nginx -d $DOMAIN"
  }

# --- 7. firewall -----------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Opening firewall for 80/443"
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow OpenSSH >/dev/null
fi

log "Done"
cat <<EOF

  App dir   : $APP_DIR
  Service   : systemctl status checkout   (logs: journalctl -u checkout -f)
  Test      : curl -s https://$DOMAIN/healthz
  Checkout  : https://$DOMAIN/checkout

  Next: if you haven't yet, edit $APP_DIR/.env with your Chargebee keys and run
        sudo systemctl restart checkout

EOF

#!/bin/bash
# ==============================================================================
# 🔒 GOPAY MERCHANT GATEWAY - SSL & DOMAIN MANAGER (Certbot & Nginx)
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}❌ Harap jalankan skrip ini sebagai root (gunakan: sudo bash setup-ssl.sh)${NC}"
    exit 1
fi

echo -e "${GREEN}${BOLD}"
echo "======================================================================"
echo "    🔒 SETUP / RENEW SSL CERTIFICATE (LET'S ENCRYPT)"
echo "======================================================================"
echo -e "${NC}"

read -p "🌐 Masukkan Nama Domain / Subdomain (contoh: gateway.tokoanda.com): " DOMAIN_NAME
DOMAIN_NAME=$(echo "$DOMAIN_NAME" | tr '[:upper:]' '[:lower:]' | xargs)

if [ -z "$DOMAIN_NAME" ]; then
    echo -e "${RED}❌ Nama domain tidak boleh kosong!${NC}"
    exit 1
fi

read -p "📧 Masukkan Email Admin: " SSL_EMAIL
SSL_EMAIL=${SSL_EMAIL:-"admin@$DOMAIN_NAME"}

echo -e "\n${CYAN}⏳ Mengonfigurasi Nginx dan mengajukan SSL HTTPS ke Let's Encrypt...${NC}"

# Update Nginx Host
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN_NAME"
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN_NAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 90;
    }
}
EOF

ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN_NAME"
nginx -t
systemctl reload nginx

# Request SSL
if certbot --nginx -d "$DOMAIN_NAME" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect; then
    echo -e "\n${GREEN}✓ SSL HTTPS Berhasil Diaktifkan untuk https://$DOMAIN_NAME/${NC}"
    echo -e "${GREEN}✓ Auto-renewal sertifikat aktif secara otomatis.${NC}\n"
else
    echo -e "\n${RED}❌ Gagal memasang SSL. Pastikan DNS A-Record domain '$DOMAIN_NAME' sudah mengarah ke IP server ini.${NC}\n"
fi

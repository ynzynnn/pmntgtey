#!/bin/bash
# ==============================================================================
# 🚀 GOPAY MERCHANT PAYMENT GATEWAY - AUTO SETUP & DEPLOYMENT SCRIPT (VPS)
# ==============================================================================
# Mendukung: Ubuntu 20.04 / 22.04 / 24.04 & Debian 11 / 12
# Fitur: Node.js 20 LTS, Nginx, Let's Encrypt SSL Gratis, PM2 Process Manager, UFW
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear
echo -e "${GREEN}${BOLD}"
echo "======================================================================"
echo "    🚀 GOPAY MERCHANT API GATEWAY - AUTO INSTALLER VPS"
echo "======================================================================"
echo -e "${NC}"
echo -e "${CYAN}Skrip ini akan mengonfigurasi Gateway dengan Domain & SSL HTTPS secara otomatis.${NC}\n"

# 1. Pastikan dijalankan sebagai root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}❌ Harap jalankan skrip ini sebagai root (gunakan: sudo bash deploy.sh)${NC}"
    exit 1
fi

# 2. Input Konfigurasi dari Pengguna
read -p "🌐 Masukkan Nama Domain / Subdomain Anda (contoh: gateway.tokoanda.com): " DOMAIN_NAME
DOMAIN_NAME=$(echo "$DOMAIN_NAME" | tr '[:upper:]' '[:lower:]' | xargs)

if [ -z "$DOMAIN_NAME" ]; then
    echo -e "${RED}❌ Nama domain tidak boleh kosong!${NC}"
    exit 1
fi

read -p "📧 Masukkan Alamat Email Anda (untuk notifikasi SSL Let's Encrypt): " SSL_EMAIL
SSL_EMAIL=$(echo "$SSL_EMAIL" | xargs)

if [ -z "$SSL_EMAIL" ]; then
    SSL_EMAIL="admin@$DOMAIN_NAME"
fi

read -p "🔌 Port Lokal Gateway (Tekan Enter untuk default 3000): " APP_PORT
APP_PORT=${APP_PORT:-3000}

PROJECT_DIR=$(pwd)

echo -e "\n${YELLOW}📋 Ringkasan Konfigurasi:${NC}"
echo -e "   - Domain       : ${GREEN}$DOMAIN_NAME${NC}"
echo -e "   - Email SSL    : ${GREEN}$SSL_EMAIL${NC}"
echo -e "   - Port Internal: ${GREEN}$APP_PORT${NC}"
echo -e "   - Folder Kerja : ${GREEN}$PROJECT_DIR${NC}\n"

read -p "Apakah data di atas sudah benar? (y/n): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${RED}Instalasi dibatalkan.${NC}"
    exit 1
fi

# 3. Update Sistem & Install Paket Dasar
echo -e "\n${BLUE}⏳ [1/6] Memperbarui sistem dan menginstal dependensi dasar...${NC}"
apt-get update -y
apt-get install -y curl wget git ufw software-properties-common apt-transport-https ca-certificates gnupg

# 4. Install Node.js 20 LTS
echo -e "\n${BLUE}⏳ [2/6] Memeriksa & Menginstal Node.js 20 LTS...${NC}"
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 18 ]]; then
    echo "Mengunduh NodeSource repository..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt-get install -y nodejs
fi

echo -e "${GREEN}✓ Node.js terinstal: $(node -v)${NC}"
echo -e "${GREEN}✓ NPM terinstal    : $(npm -v)${NC}"

# 5. Install Dependencies Proyek & PM2
echo -e "\n${BLUE}⏳ [3/6] Menginstal dependensi proyek dan PM2 Process Manager...${NC}"
cd "$PROJECT_DIR"
npm install --production

if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi

# 6. Install Nginx & Certbot
echo -e "\n${BLUE}⏳ [4/6] Menginstal Nginx Web Server & Certbot SSL...${NC}"
apt-get install -y nginx certbot python3-certbot-nginx

# Buat konfigurasi Nginx Reverse Proxy
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN_NAME"

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN_NAME;

    # Redirect HTTP ke HTTPS nantinya ditangani oleh Certbot
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
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

# Aktifkan konfigurasi di Nginx
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN_NAME"
# Hapus default site jika ada
rm -f /etc/nginx/sites-enabled/default

# Test Nginx config & reload
nginx -t
systemctl restart nginx

# 7. Konfigurasi Firewall UFW
echo -e "\n${BLUE}⏳ [5/6] Mengonfigurasi Firewall Server (UFW)...${NC}"
ufw allow 'Nginx Full'
ufw allow 22/tcp
ufw --force enable

# 8. Pasang SSL Let's Encrypt Otomatis (dengan Auto-Detection Akun Let's Encrypt)
echo -e "\n${BLUE}⏳ [6/6] Memasang Sertifikat SSL Gratis (Let's Encrypt)...${NC}"
echo -e "${YELLOW}Pastikan DNS A-Record domain '$DOMAIN_NAME' sudah mengarah ke IP VPS ini!${NC}"

ACCOUNT_DIR="/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory"
ACCOUNT_FLAG=""
if [ -d "$ACCOUNT_DIR" ]; then
    DETECTED_ACC=$(ls -1 "$ACCOUNT_DIR" 2>/dev/null | head -n 1)
    if [ -n "$DETECTED_ACC" ]; then
        ACCOUNT_FLAG="--account $DETECTED_ACC"
    fi
fi

if certbot --nginx -d "$DOMAIN_NAME" --agree-tos -m "$SSL_EMAIL" --redirect $ACCOUNT_FLAG --non-interactive; then
    echo -e "${GREEN}✓ Sertifikat SSL HTTPS berhasil dipasang dan auto-renewal aktif!${NC}"
else
    echo -e "${YELLOW}⚠️ Non-interactive Certbot memerlukan pemilihan akun. Menjalankan Certbot interaktif...${NC}"
    certbot --nginx -d "$DOMAIN_NAME" --agree-tos --redirect || true
fi

# 9. Jalankan Gateway dengan PM2
echo -e "\n${BLUE}⏳ Menjalankan GoPay Gateway dengan PM2...${NC}"
pm2 stop gopay-gateway 2>/dev/null || true
pm2 delete gopay-gateway 2>/dev/null || true
pm2 start server.js --name "gopay-gateway" --env production
pm2 startup | tail -n 1 | bash 2>/dev/null || true
pm2 save

echo -e "\n${GREEN}${BOLD}======================================================================"
echo "🎉 INSTALASI & SETUP SELESAI DENGAN SUKSES!"
echo "======================================================================"
echo -e "${NC}"
echo -e "🌐 Base URL API Gateway       : ${CYAN}${BOLD}https://$DOMAIN_NAME/${NC}"
echo -e "📊 Status API Health          : ${CYAN}https://$DOMAIN_NAME/health${NC}"
echo -e "⚡ Endpoint Create QRIS       : ${CYAN}POST https://$DOMAIN_NAME/create-qris${NC}"
echo -e "🔍 Endpoint Check Payment     : ${CYAN}POST https://$DOMAIN_NAME/check-payment${NC}"
echo -e "🔑 Status Sesi GoBiz          : ${CYAN}https://$DOMAIN_NAME/token-status${NC}"
echo -e "📂 Direktori Proyek           : $PROJECT_DIR"
echo -e "⚙️ Kelola Layanan             : pm2 status / pm2 logs gopay-gateway / pm2 restart gopay-gateway"
echo -e "======================================================================\n"

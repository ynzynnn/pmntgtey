#!/bin/bash
# setup.sh - Script otomatisasi instalasi & setup GoPay Merchant Gateway

echo "======================================================"
echo "   🚀 GoPay Merchant Payment Gateway - Setup Script"
echo "======================================================"

# 1. Cek Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js belum terinstall. Silakan install Node.js v18 atau v20 terlebih dahulu."
    exit 1
fi

echo "📦 Menginstall dependencies (npm install)..."
npm install

# 2. Buat .env jika belum ada
if [ ! -f .env ]; then
    echo "📄 Menyalin .env.example ke .env..."
    cp .env.example .env
fi

echo ""
echo "✅ Instalasi dependencies selesai!"
echo "------------------------------------------------------"
echo "Langkah selanjutnya:"
echo "1. Sesuaikan variabel QRIS_STATIC dan API_KEY di file .env"
echo "2. Jalankan login OTP: node login.js"
echo "3. Jalankan server: npm start"
echo "======================================================"

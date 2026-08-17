# 🔌 GoPay / QRIS Realtime Gateway Extension for Paymenter

Ekstensi pembayaran otomatis **GoPay / QRIS Real-time** untuk **Paymenter Billing & Hosting Platform**.

---

## 📁 Struktur Folder

Letakkan file ekstensi di dalam folder instalasi Paymenter Anda:

```
paymenter/
└── app/
    └── Extensions/
        └── Gateways/
            └── GoPay/
                ├── GoPay.php
                └── views/
                    └── pay.blade.php
```

---

## 🚀 Cara Pemasangan di Paymenter

### 1. Salin Folder Ekstensi
Salin seluruh isi folder `paymenter-extension/` ke folder Paymenter Anda di:
`app/Extensions/Gateways/GoPay/`

### 2. Aktifkan di Admin Panel Paymenter
1. Buka **Admin Panel Paymenter** $\rightarrow$ Masuk ke menu **Extensions** $\rightarrow$ **Gateways**.
2. Cari gateway bernama **GoPay / QRIS Realtime Gateway**.
3. Klik tombol **Enable / Edit**.
4. Isi form konfigurasi:
   * **API Gateway Base URL :** `https://gateway.domainanda.com` *(atau `http://IP_VPS:3000`)*
   * **API Secret Key        :** `gopay_secret_api_key_123456` *(sesuai nilai `API_KEY` di `.env` gateway)*
5. Klik **Save**.

---

## ⚡ Alur Pembayaran di Paymenter

1. **User Checkout Invoice :** Pembeli memilih metode pembayaran **GoPay / QRIS** pada invoice Paymenter.
2. **Generate QRIS Instan :** Paymenter memanggil gateway Anda via `POST /create-qris`, menghasilkan QR Code dinamis sesuai total invoice Rupiah.
3. **Pembayaran & Verifikasi Real-time :**
   * Pembeli men-scan QRIS via GoPay / BCA / DANA / OVO / ShopeePay / Livin / BRImo, dll.
   * Gateway Anda mendeteksi uang masuk dari GoBiz dalam **< 7 detik**.
   * Gateway otomatis mengirimkan **HTTP POST Webhook Callback** ke Paymenter.
   * Status invoice di Paymenter otomatis berubah menjadi **PAID (Lunas)** dan layanan hosting / server pembeli langsung aktif secara otomatis! 🎉

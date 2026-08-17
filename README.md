# 🚀 GoPay Partner & Headless REST API Gateway

Gateway API mandiri murni (**Headless REST API / JSON-Only**) untuk otomatisasi mutasi pembayaran **GoPay / GoBiz** dan generator **QRIS Dinamis** berbasis standar nasional EMVCo Bank Indonesia.

---

## 🌟 Fitur Utama

- ⚡ **Headless REST API (JSON-Only):** Ringan, super cepat, tanpa web frontend/HTML, khusus untuk integrasi backend payment gateway.
- 🧾 **QRIS Dinamis Otomatis (EMVCo MPM):** Mengubah QRIS Statis toko menjadi QRIS Dinamis berapapun nominalnya dan menghitung ulang Checksum CRC-16 CCITT secara presisi.
- ⏱️ **Deteksi Pembayaran Real-Time (< 1 Detik):** Terhubung langsung ke API GoBiz Merchant Analytics untuk verifikasi uang masuk instan.
- 🛡️ **Lapisan Keamanan Berlapis (OWASP Standard):** Dilengkapi Rate Limiter in-memory, Anti-Spam OTP, Anti Brute-Force, Anti-SSRF, dan Anti-Tampering.
- 🔒 **Anti Dobel Klaim (Unique Claim Lock):** Satu mutasi dana masuk hanya dapat diklaim 1 kali per invoice/transaksi.
- 🔄 **Auto-Refresh Sesi GoBiz (Tiap 6 Jam):** Token sesi diperbarui secara otomatis di background tanpa perlu login berulang kali.
- 💾 **Persistent Session & Storage:** Transaksi dan sesi tersimpan permanen di disk sehingga aman dari reboot server.

---

## 🚀 Quickstart

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Login Akun GoBiz (Cukup 1x via Terminal)
```bash
npm run login
```
Masukkan nomor HP GoBiz Anda dan ketik 4 digit kode OTP yang diterima via SMS/WhatsApp. Profil toko dan QRIS statis akan otomatis tersinkronisasi.

### 3. Jalankan Server API
```bash
npm start
```
Server API akan aktif di port 3000 (`http://localhost:3000`).

---

## 📚 Spesifikasi Endpoint API (JSON)

Semua request dilindungi API Key via header `X-Api-Key: <API_KEY>` atau query `?api_key=<API_KEY>`.

### 1. Generate QRIS Dinamis
* **Endpoint:** `POST /create-qris`
* **Header:** `X-Api-Key: gopay_secret_api_key_123456`, `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "amount": 25000,
    "order_id": "INV-100234",
    "webhook_url": "https://tokoanda.com/api/gopay-webhook"
  }
  ```
* **Respon (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "qris_id": "8krlwm63",
      "trx_id": "TRX-7K9A2BC",
      "order_id": "INV-100234",
      "amount": 25000,
      "qris_code": "00020101021226610014COM.GO-JEK.WWW...540525000...6304ABCD",
      "qr_image_url": "http://localhost:3000/qr/8krlwm63?format=raw",
      "qr_image_base64": "data:image/png;base64,...",
      "expires_at": "2026-08-17T20:45:00.000Z",
      "expires_in_seconds": 300
    }
  }
  ```

---

### 2. Stream Raw Image PNG QRIS
* **Endpoint:** `GET /qr/:qris_id?format=raw`
* **Respon:** Direct binary PNG image stream (bisa langsung dijadikan tag `<img src="..." />`).

---

### 3. Public Status Check (Poller / Frontend)
* **Endpoint:** `GET /api/qr-status/:qris_id`
* **Respon:**
  ```json
  {
    "success": true,
    "paid": true,
    "status": "PAID",
    "transaction": {
      "transaction_id": "01a00fbe-d218-7000-a315-b9ebd63c2f22",
      "order_id": "QRIS-90323b24-288a-3987-860d-b6e739818763",
      "amount": 25000,
      "status": "SETTLEMENT",
      "payer_issuer": "GOPAY",
      "transaction_time": "2026-08-17T19:42:39+07:00"
    }
  }
  ```

---

### 4. Server-to-Server Check Payment
* **Endpoint:** `POST /check-payment`
* **Request:**
  ```json
  {
    "amount": 25000,
    "trx_id": "TRX-7K9A2BC"
  }
  ```

---

### 5. Ambil Riwayat Mutasi GoBiz
* **Endpoint:** `GET /transactions?pageSize=10`

---

## 💻 Contoh Integrasi Kode

### PHP (cURL)
```php
<?php
$apiKey = 'gopay_secret_api_key_123456';
$url = 'http://localhost:3000/create-qris';

$data = [
    'amount' => 50000,
    'order_id' => 'INV-' . time()
];

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'X-Api-Key: ' . $apiKey
]);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
// Ambil raw string QRIS atau URL gambar PNG QR
$qrCodeString = $result['data']['qris_code'];
$qrImageUrl   = $result['data']['qr_image_url'];
?>
```

---

## 🧪 Testing Suite
Jalankan pengujian otomatis untuk memvalidasi seluruh endpoint:
```bash
npm test
```

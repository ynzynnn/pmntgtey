/**
 * server.js
 * Headless Express.js API Gateway untuk GoPay Partner & GoBiz Merchant
 * Pure REST API / JSON-Only dengan Background Webhook / Callback Engine Otomatis,
 * HMAC-SHA256 Signature, Auto-Retry, Anti-Double Claim, dan Enterprise Security Layer.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const axios = require('axios');
require('dotenv').config();

const qrisHelper = require('./qrisHelper');
const sessionManager = require('./sessionManager');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

const MAX_LOGS = 150;
const QRIS_EXPIRY_MS = 5 * 60 * 1000; // 5 Menit
const CLAIMED_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24 Jam
const QRIS_STORE_FILE = path.join(__dirname, '.GOPAY_QRIS_STORE.json');

// In-Memory Storage dengan Disk Persistence
const qrisStore = new Map();
const claimedTransactions = new Map();
const activityLogs = [];

// ==============================================================================
// 🔒 SECURITY LAYER: RATE LIMITER
// ==============================================================================

const rateLimitStore = new Map();

function rateLimiter(bucketName, maxRequests, windowMs) {
    return (req, res, next) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                         req.socket.remoteAddress ||
                         '127.0.0.1';
        const key = `${bucketName}:${clientIp}`;
        const now = Date.now();

        let record = rateLimitStore.get(key);
        if (!record || now - record.startTime > windowMs) {
            record = { count: 1, startTime: now };
            rateLimitStore.set(key, record);
            return next();
        }

        if (record.count >= maxRequests) {
            const retryAfterSec = Math.ceil((record.startTime + windowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfterSec);
            logActivity('WARN', `Rate limit terpicu [${bucketName}] dari IP: ${clientIp}`);
            return res.status(429).json({
                success: false,
                message: `Terlalu banyak permintaan. Silakan tunggu ${retryAfterSec} detik lagi.`
            });
        }

        record.count++;
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore.entries()) {
        if (now - v.startTime > 30 * 60 * 1000) {
            rateLimitStore.delete(k);
        }
    }
}, 10 * 60 * 1000);

// ==============================================================================
// 🛡️ SECURITY HEADERS & CORE MIDDLEWARE
// ==============================================================================

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key']
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

function loadQRISStoreFromDisk() {
    try {
        if (fs.existsSync(QRIS_STORE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(QRIS_STORE_FILE, 'utf-8'));
            for (const [k, v] of Object.entries(raw)) {
                qrisStore.set(k, {
                    ...v,
                    createdAt: new Date(v.createdAt),
                    expiresAt: new Date(v.expiresAt)
                });
            }
            console.log(`[STORAGE] Berhasil memuat ${qrisStore.size} sesi QRIS dari disk.`);
        }
    } catch (e) {
        console.warn('[STORAGE] Gagal memuat QRIS store:', e.message);
    }
}

function saveQRISStoreToDisk() {
    try {
        const obj = {};
        for (const [k, v] of qrisStore.entries()) {
            // Simpan riwayat transaksi dan QRIS hingga 7 hari terakhir
            if (Date.now() - new Date(v.createdAt).getTime() < 7 * 24 * 3600 * 1000) {
                obj[k] = v;
            }
        }
        fs.writeFileSync(QRIS_STORE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[STORAGE] Gagal menyimpan QRIS store:', e.message);
    }
}

loadQRISStoreFromDisk();

function logActivity(type, message, details = null) {
    const timestamp = new Date().toISOString();
    const logObj = { id: Date.now(), timestamp, type, message, details };
    activityLogs.unshift(logObj);
    if (activityLogs.length > MAX_LOGS) {
        activityLogs.pop();
    }
    console.log(`[${timestamp}] [${type}] ${message}`);
}

setInterval(() => {
    const now = Date.now();
    for (const [txId, claim] of claimedTransactions.entries()) {
        if (now - claim.claimedAt > CLAIMED_CLEANUP_MS) {
            claimedTransactions.delete(txId);
        }
    }
    saveQRISStoreToDisk();
}, 30 * 60 * 1000);

// Background Task: Auto-refresh sesi GoBiz tiap 6 jam
setInterval(async () => {
    try {
        const session = sessionManager.loadSession();
        if (session && session.refresh_token) {
            if (sessionManager.isExpired(session)) {
                logActivity('INFO', 'Auto-Refresh: Token mendekati masa kedaluwarsa, memperbarui sesi...');
                await sessionManager.refreshSession();
                logActivity('INFO', 'Auto-Refresh: Sesi GoBiz berhasil diperbarui.');
            }
        }
    } catch (err) {
        logActivity('ERROR', `Auto-Refresh Sesi Gagal: ${err.message}`);
    }
}, 6 * 60 * 60 * 1000);

// ==============================================================================
// 🔔 AUTOMATED BACKGROUND CALLBACK / WEBHOOK DISPATCHER ENGINE
// ==============================================================================

/**
 * Generate HMAC-SHA256 Signature untuk verifikasi Webhook
 */
function generateSignature(payloadString, secretKey) {
    return crypto.createHmac('sha256', secretKey || 'gopay_secret_key').update(payloadString).digest('hex');
}

/**
 * Mengirim Webhook Callback ke Server Merchant dengan Retry Mechanism (Maks 3x)
 */
async function dispatchWebhook(qrisItem, matchedTransaction, attempt = 1) {
    const webhookUrl = qrisItem.webhookUrl || process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    const apiKey = process.env.API_KEY || 'gopay_secret_api_key_123456';
    const payload = {
        event: 'payment.settled',
        status: 'PAID',
        trx_id: qrisItem.trxId,
        order_id: qrisItem.orderId || '',
        amount: qrisItem.amount,
        payment_type: matchedTransaction.payment_type || 'QRIS',
        payer_issuer: matchedTransaction.payer_issuer || 'GOPAY',
        transaction_id: matchedTransaction.transaction_id || '',
        order_id_gobiz: matchedTransaction.order_id || '',
        settlement_time: matchedTransaction.transaction_time || new Date().toISOString(),
        created_at: qrisItem.createdAt.toISOString()
    };

    const payloadString = JSON.stringify(payload);
    const signature = generateSignature(payloadString, apiKey);

    try {
        logActivity('INFO', `Mengirim Callback Webhook (Percobaan #${attempt}) ke: ${webhookUrl} | TRX-ID: ${qrisItem.trxId}`);
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Callback-Signature': signature,
                'X-Callback-Event': 'payment.settled',
                'User-Agent': 'GoPay-Merchant-Gateway-Webhook/1.0'
            },
            timeout: 10000
        });

        logActivity('SUCCESS', `Callback Webhook Berhasil Diterima [HTTP ${response.status}] oleh ${webhookUrl}`);
        qrisItem.webhookDelivered = true;
        saveQRISStoreToDisk();
    } catch (err) {
        logActivity('WARN', `Callback Webhook Gagal (Percobaan #${attempt}): ${err.message}`);
        if (attempt < 3) {
            const delayMs = attempt * 3000; // Retry setelah 3s, 6s
            setTimeout(() => {
                dispatchWebhook(qrisItem, matchedTransaction, attempt + 1);
            }, delayMs);
        } else {
            logActivity('ERROR', `Callback Webhook Gagal Permanen setelah 3x percobaan ke ${webhookUrl}`);
        }
    }
}

/**
 * Background Engine: Otomatis Scan Mutasi GoBiz tiap 7 Detik & Tembak Callback
 */
setInterval(async () => {
    // Cari semua QRIS yang berstatus PENDING dan belum kedaluwarsa
    const now = Date.now();
    const pendingItems = [];
    for (const [qrisId, item] of qrisStore.entries()) {
        if (item.status === 'PENDING') {
            if (now > item.expiresAt.getTime()) {
                item.status = 'EXPIRED';
            } else {
                pendingItems.push({ qrisId, item });
            }
        }
    }

    if (pendingItems.length === 0) return;

    try {
        const startTime = new Date(now - 60 * 60 * 1000).toISOString();
        const transactions = await sessionManager.fetchTransactions({
            startTime,
            pageSize: 30
        });

        if (!transactions || transactions.length === 0) return;

        for (const { qrisId, item } of pendingItems) {
            const matched = transactions.find(tx => {
                if (tx.amount !== item.amount) return false;
                if (tx.status !== 'SETTLEMENT' && tx.status !== 'CAPTURE') return false;

                const existingClaim = claimedTransactions.get(tx.transaction_id);
                if (existingClaim && existingClaim.trxId !== item.trxId) return false;

                const txTime = new Date(tx.transaction_time).getTime();
                if (txTime < item.createdAt.getTime() - 10 * 60 * 1000) return false;

                return true;
            });

            if (matched) {
                claimedTransactions.set(matched.transaction_id, {
                    trxId: item.trxId,
                    qrisId,
                    amount: item.amount,
                    claimedAt: Date.now()
                });

                item.status = 'PAID';
                item.transactionData = matched;
                saveQRISStoreToDisk();

                logActivity('SUCCESS', `Auto-Detector: Pembayaran Masuk Terdeteksi! | TRX: ${item.trxId} | Nominal: ${formatRupiah(item.amount)}`);

                // Otomatis picu pengiriman callback
                await dispatchWebhook(item, matched);
            }
        }
    } catch (err) {
        console.warn(`[AUTO-DETECTOR] Gagal cek mutasi: ${err.message}`);
    }
}, 7000);

// Middleware Proteksi API Key
const apiKeyAuth = (req, res, next) => {
    const configuredKey = process.env.API_KEY;
    if (!configuredKey) {
        return next();
    }

    const clientKey = req.headers['x-api-key'] ||
                      req.query.api_key ||
                      req.query.apikey ||
                      req.body?.api_key;

    if (!clientKey || clientKey !== configuredKey) {
        logActivity('WARN', `Akses ditolak: API Key tidak valid dari IP ${req.ip}`);
        return res.status(401).json({
            success: false,
            message: 'Autentikasi Gagal: API Key tidak valid atau tidak disertakan.'
        });
    }
    next();
};

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

function getActiveStaticQRIS() {
    const envQR = process.env.QRIS_STATIC;
    if (envQR && envQR.startsWith('000201')) {
        return envQR;
    }
    const session = sessionManager.loadSession();
    return session?.qris_static || envQR || null;
}

function isValidWebhookUrl(urlStr) {
    if (!urlStr) return true;
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        const hostname = parsed.hostname.toLowerCase();
        if (process.env.NODE_ENV === 'production') {
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
                return false;
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ==============================================================================
// 1. ROOT & HEALTH INFO (PURE JSON ONLY)
// ==============================================================================


app.get('/', (req, res) => {
    const session = sessionManager.loadSession();

    // JSON hanya untuk client dengan API Key
    if (req.query.format === 'json' || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'))) {
        return res.json({ service: 'Payment Gateway API', status: 'RUNNING', version: '1.0.0' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SeptaCloud Payment Gateway</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px}
.card{width:100%;max-width:380px;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:32px 24px;text-align:center}
h1{font-size:20px;font-weight:700;color:#111;margin-bottom:8px}
p{font-size:13px;color:#666;line-height:1.5;margin-bottom:20px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#16a34a;background:#f0fdf4;border:1px solid #bbf7d0;padding:4px 12px;border-radius:20px;font-weight:600;margin-bottom:16px}
.dot{width:6px;height:6px;border-radius:50%;background:#16a34a}
.note{font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px}
</style>
</head>
<body>
<div class="card">
    <div class="badge"><span class="dot"></span> Sistem Aktif</div>
    <h1>SeptaCloud Gateway</h1>
    <p>Layanan pemrosesan pembayaran QRIS private. Integrasi API khusus merchant terdaftar.</p>
    <div class="note">&copy; ${new Date().getFullYear()} SeptaCloud &bull; All rights reserved.</div>
</div>
</body>
</html>`);
});

app.get('/health', (req, res) => {
    const session = sessionManager.loadSession();
    res.json({
        status: 'OK',
        service: 'GoPay Merchant API Gateway',
        timestamp: new Date().toISOString(),
        has_session: !!session,
        session_expires_at: session?.expires_at ? new Date(session.expires_at).toISOString() : null,
        merchant_name: session?.merchant_name || 'Belum Login',
        merchant_id: session?.merchant_id || null,
        uptime_seconds: Math.floor(process.uptime())
    });
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Layanan API GoPay Berfungsi Normal', timestamp: new Date() });
});

// ==========================================
// 2. TOKEN STATUS & SESSION CHECK
// ==========================================

app.get('/token-status', apiKeyAuth, async (req, res) => {
    const headers = await sessionManager.getValidHeaders();
    if (!headers) {
        return res.json({
            success: false,
            data: {
                token_status: 'invalid',
                message: 'Sesi belum login. Jalankan `npm run login` di terminal.'
            }
        });
    }

    try {
        const txList = await sessionManager.fetchTransactions({ pageSize: 1 });
        const session = sessionManager.loadSession();
        res.json({
            success: true,
            data: {
                token_status: 'valid',
                message: 'Token dan Sesi GoPay Merchant Aktif',
                merchant_name: session?.merchant_name || 'GoPay Merchant',
                merchant_id: session?.merchant_id || null,
                expires_at: session?.expires_at ? new Date(session.expires_at).toISOString() : null
            }
        });
    } catch (err) {
        res.json({
            success: false,
            data: {
                token_status: 'invalid',
                message: err.message
            }
        });
    }
});

// ==========================================
// 📱 REMOTE GOBIZ LOGIN PORTAL (HP / BROWSER)
// ==========================================

app.get('/admin/login', (req, res) => {
    const session = sessionManager.loadSession();
    const isSessValid = session && !sessionManager.isExpired(session);
    const expDate = session?.expires_at ? new Date(session.expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-';
    const merchantName = session?.merchant_name || 'Belum Terhubung';
    const defaultPhone = session?.phone_number || '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote GoBiz Login — SeptaCloud</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px 16px}
.card{width:100%;max-width:400px;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:28px 22px}
h1{font-size:18px;font-weight:700;color:#111;margin-bottom:4px}
.sub{font-size:12px;color:#777;margin-bottom:16px}
.status-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;margin-bottom:18px}
.status-ok{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
.status-bad{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.dot{width:6px;height:6px;border-radius:50%}
.status-ok .dot{background:#16a34a}
.status-bad .dot{background:#dc2626}
.field{margin-bottom:14px;text-align:left}
label{display:block;font-size:12px;font-weight:600;color:#444;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-size:14px;color:#111;outline:none}
input:focus{border-color:#111}
.btn{display:block;width:100%;padding:11px;background:#111;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px}
.btn:hover{background:#333}
.btn:disabled{background:#bbb;cursor:not-allowed}
.msg{margin-top:12px;font-size:12px;min-height:16px;text-align:center}
.msg.ok{color:#16a34a}
.msg.err{color:#dc2626}
.step-box{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:12px;margin-top:14px}
.hidden{display:none}
.meta-box{font-size:11.5px;color:#666;background:#f9f9f9;padding:10px 12px;border-radius:6px;margin-bottom:14px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
    <div class="status-pill ${isSessValid ? 'status-ok' : 'status-bad'}">
        <span class="dot"></span> ${isSessValid ? 'Sesi GoBiz Aktif' : 'Sesi Mati / Perlu Login'}
    </div>
    <h1>Remote Login GoBiz</h1>
    <div class="sub">Hubungkan akun GoBiz merchant dari browser tanpa buka SSH terminal.</div>

    <div class="meta-box">
        <strong>Toko:</strong> ${merchantName}<br>
        <strong>Kedaluwarsa:</strong> ${expDate}
    </div>

    <div class="field">
        <label>Admin Secret Key</label>
        <input type="password" id="secretKey" placeholder="Kunci API / Admin Key" autocomplete="off" />
    </div>

    <!-- Step 1: Input Nomor HP -->
    <div id="step1">
        <div class="field">
            <label>Nomor HP GoBiz</label>
            <input type="tel" id="phoneNumber" placeholder="Contoh: 083847274233" value="${defaultPhone}" />
        </div>
        <button class="btn" id="btnReqOtp" onclick="requestOtp()">Minta Kode OTP (SMS/WA)</button>
    </div>

    <!-- Step 2: Input OTP (Muncul setelah request OTP berhasil) -->
    <div id="step2" class="step-box hidden">
        <div class="field">
            <label>Kode OTP (4 Digit)</label>
            <input type="text" id="otpCode" maxlength="6" placeholder="Masukkan 4 digit OTP" autocomplete="one-time-code" />
        </div>
        <button class="btn" id="btnVerOtp" onclick="verifyOtp()">Verifikasi & Aktifkan Sesi</button>
    </div>

    <div class="msg" id="alertMsg"></div>
    <div style="margin-top:16px;border-top:1px solid #eee;padding-top:12px;text-align:center">
        <a href="/admin/logs" style="font-size:12px;color:#333;text-decoration:none;font-weight:600">📊 Buka Log Pembayaran & QRIS &rarr;</a>
    </div>
</div>

<script>
let curOtpToken = '';
let curUniqueId = '';

async function requestOtp() {
    const secret = document.getElementById('secretKey').value.trim();
    const phone = document.getElementById('phoneNumber').value.trim();
    const btn = document.getElementById('btnReqOtp');
    const msg = document.getElementById('alertMsg');

    if (!secret) {
        msg.className = 'msg err'; msg.textContent = 'Harap isi Admin Secret Key.'; return;
    }
    if (!phone) {
        msg.className = 'msg err'; msg.textContent = 'Harap isi nomor HP GoBiz.'; return;
    }

    btn.disabled = true; btn.textContent = 'Mengirim OTP...';
    msg.className = 'msg'; msg.textContent = '';

    try {
        const res = await fetch('/api/admin/otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, phone })
        });
        const json = await res.json();

        if (json.success) {
            curOtpToken = json.otp_token;
            curUniqueId = json.unique_id;
            document.getElementById('step2').classList.remove('hidden');
            msg.className = 'msg ok';
            msg.textContent = json.message || 'OTP berhasil dikirim ke WhatsApp/SMS!';
            document.getElementById('otpCode').focus();
        } else {
            msg.className = 'msg err';
            msg.textContent = json.message || 'Gagal mengirim OTP.';
        }
    } catch (e) {
        msg.className = 'msg err'; msg.textContent = 'Gagal menghubungi server.';
    } finally {
        btn.disabled = false; btn.textContent = 'Minta Kode OTP Lagi';
    }
}

async function verifyOtp() {
    const secret = document.getElementById('secretKey').value.trim();
    const phone = document.getElementById('phoneNumber').value.trim();
    const otp = document.getElementById('otpCode').value.trim();
    const btn = document.getElementById('btnVerOtp');
    const msg = document.getElementById('alertMsg');

    if (!otp) {
        msg.className = 'msg err'; msg.textContent = 'Harap masukkan 4 digit kode OTP.'; return;
    }

    btn.disabled = true; btn.textContent = 'Memverifikasi...';

    try {
        const res = await fetch('/api/admin/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, phone, otp, otp_token: curOtpToken, unique_id: curUniqueId })
        });
        const json = await res.json();

        if (json.success) {
            msg.className = 'msg ok';
            msg.textContent = '🎉 ' + (json.message || 'Login GoBiz Berhasil! Memuat ulang...');
            setTimeout(() => { window.location.reload(); }, 2000);
        } else {
            msg.className = 'msg err';
            msg.textContent = json.message || 'Kode OTP salah atau kedaluwarsa.';
        }
    } catch (e) {
        msg.className = 'msg err'; msg.textContent = 'Gagal memverifikasi OTP.';
    } finally {
        btn.disabled = false; btn.textContent = 'Verifikasi & Aktifkan Sesi';
    }
}
</script>
</body>
</html>`);
});

app.post('/api/admin/otp/request', rateLimiter('admin-otp-req', 6, 10 * 60 * 1000), async (req, res) => {
    const { secret, phone } = req.body || {};
    const configuredKey = process.env.API_KEY || 'gopay_secret_api_key_123456';

    if (!secret || secret !== configuredKey) {
        return res.status(401).json({ success: false, message: 'Admin Secret Key tidak valid.' });
    }

    if (!phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP GoBiz wajib diisi.' });
    }

    try {
        logActivity('INFO', `Remote Admin: Meminta OTP GoBiz untuk nomor ${phone}`);
        const result = await sessionManager.requestOTP(phone);
        res.json({
            success: true,
            otp_token: result.otp_token,
            unique_id: result.unique_id,
            expires_in: result.expires_in,
            message: result.message
        });
    } catch (err) {
        logActivity('WARN', `Remote Admin: Gagal minta OTP: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/otp/verify', rateLimiter('admin-otp-ver', 8, 10 * 60 * 1000), async (req, res) => {
    const { secret, phone, otp, otp_token, unique_id } = req.body || {};
    const configuredKey = process.env.API_KEY || 'gopay_secret_api_key_123456';

    if (!secret || secret !== configuredKey) {
        return res.status(401).json({ success: false, message: 'Admin Secret Key tidak valid.' });
    }

    if (!phone || !otp || !otp_token) {
        return res.status(400).json({ success: false, message: 'Data verifikasi OTP tidak lengkap.' });
    }

    try {
        logActivity('INFO', `Remote Admin: Memverifikasi OTP GoBiz untuk nomor ${phone}`);
        const sessionObj = await sessionManager.verifyOTP(phone, otp, otp_token, unique_id);
        logActivity('SUCCESS', `Remote Admin: Login GoBiz Berhasil! Toko: ${sessionObj.merchant_name} (${sessionObj.merchant_id})`);
        res.json({
            success: true,
            message: `Login berhasil! Toko ${sessionObj.merchant_name} aktif.`,
            session: {
                merchant_name: sessionObj.merchant_name,
                merchant_id: sessionObj.merchant_id,
                owner_name: sessionObj.owner_name,
                expires_at: new Date(sessionObj.expires_at).toISOString()
            }
        });
    } catch (err) {
        logActivity('ERROR', `Remote Admin: Verifikasi OTP gagal: ${err.message}`);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 📊 FITUR LOG PEMBAYARAN & QRIS DIBUAT
// ==========================================

function getLogsData() {
    const allQris = [];
    const payments = [];
    let totalRevenue = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let totalExpired = 0;

    const now = Date.now();

    for (const [qrisId, item] of qrisStore.entries()) {
        const isExpired = item.status === 'PENDING' && now > new Date(item.expiresAt).getTime();
        const displayStatus = isExpired ? 'EXPIRED' : item.status;

        const qrisRecord = {
            qris_id: qrisId,
            trx_id: item.trxId,
            order_id: item.orderId || '-',
            amount: item.amount,
            status: displayStatus,
            created_at: item.createdAt,
            expires_at: item.expiresAt,
            pay_url: `/pay/${qrisId}`,
            webhook_url: item.webhookUrl || null,
            webhook_delivered: !!item.webhookDelivered
        };
        allQris.push(qrisRecord);

        if (item.status === 'PAID') {
            totalRevenue += item.amount;
            totalPaid++;
            payments.push({
                qris_id: qrisId,
                trx_id: item.trxId,
                order_id: item.orderId || '-',
                amount: item.amount,
                settled_at: item.transactionData?.settlement_time || item.transactionData?.transaction_time || item.createdAt,
                payer_issuer: item.transactionData?.payer_issuer || item.transactionData?.payment_method || 'QRIS',
                transaction_id: item.transactionData?.transaction_id || '-',
                payment_type: item.transactionData?.payment_type || 'QRIS',
                webhook_delivered: !!item.webhookDelivered,
                webhook_url: item.webhookUrl || null
            });
        } else if (displayStatus === 'PENDING') {
            totalPending++;
        } else {
            totalExpired++;
        }
    }

    allQris.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    payments.sort((a, b) => new Date(b.settled_at) - new Date(a.settled_at));

    return {
        summary: {
            total_revenue: totalRevenue,
            total_paid: totalPaid,
            total_pending: totalPending,
            total_expired: totalExpired,
            total_qris: allQris.length
        },
        payments,
        qris: allQris
    };
}

// 1. API Endpoint JSON untuk Log
app.get('/api/admin/logs', rateLimiter('admin-logs-api', 60, 60 * 1000), (req, res) => {
    const configuredKey = process.env.API_KEY || 'gopay_secret_api_key_123456';
    const clientKey = req.headers['x-api-key'] || req.query.secret || req.query.api_key;

    if (!clientKey || clientKey !== configuredKey) {
        return res.status(401).json({ success: false, message: 'Admin Secret Key tidak valid atau tidak disertakan.' });
    }

    const data = getLogsData();
    res.json({ success: true, data });
});

// 2. Web Portal Dashboard Log (Tampilan Polosan & Minimalis)
app.get('/admin/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Log Pembayaran & QRIS — SeptaCloud</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#222;padding:20px 16px;min-height:100vh}
.container{max-width:880px;margin:0 auto}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.brand{font-size:18px;font-weight:700;color:#111}
.nav-links{display:flex;gap:10px;font-size:12px}
.nav-links a{color:#555;text-decoration:none;padding:6px 12px;background:#fff;border:1px solid #e0e0e0;border-radius:6px}
.nav-links a:hover{color:#000;border-color:#bbb}

/* Auth Card */
.auth-box{background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:24px;text-align:center;max-width:400px;margin:40px auto}
.auth-box input{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-size:14px;margin:12px 0;outline:none}
.auth-box button{width:100%;padding:10px;background:#111;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.auth-box button:hover{background:#333}

/* Stats Cards */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:16px;text-align:left}
.stat-card .lbl{font-size:11px;color:#777;text-transform:uppercase;font-weight:600;margin-bottom:4px}
.stat-card .val{font-size:20px;font-weight:800;color:#111}
.stat-card.green .val{color:#16a34a}
.stat-card.yellow .val{color:#d97706}

/* Toolbar & Tabs */
.toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px}
.tabs{display:flex;gap:8px}
.tab-btn{padding:8px 14px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;color:#555}
.tab-btn.active{background:#111;color:#fff;border-color:#111}
.actions{display:flex;align-items:center;gap:10px}
.btn-refresh{padding:8px 12px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;color:#333}
.btn-refresh:hover{background:#f9f9f9}
.auto-poll{font-size:11.5px;color:#666;display:flex;align-items:center;gap:5px;cursor:pointer}

/* Table / Card List */
.data-card{background:#fff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px;text-align:left}
th{background:#fafafa;padding:12px 14px;font-weight:600;color:#555;border-bottom:1px solid #eee}
td{padding:12px 14px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}

/* Badges */
.badge{display:inline-block;padding:3px 8px;border-radius:12px;font-size:10.5px;font-weight:700}
.badge-paid{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
.badge-pending{background:#fefce8;color:#ca8a04;border:1px solid #fef08a}
.badge-expired{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.badge-issuer{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;font-weight:600}
.badge-wh-ok{background:#f0fdf4;color:#16a34a}
.badge-wh-fail{background:#fef2f2;color:#dc2626}

.empty-state{padding:40px;text-align:center;color:#888;font-size:13px}
.link-btn{color:#111;text-decoration:none;font-weight:600;font-size:11.5px;padding:4px 8px;border:1px solid #ddd;border-radius:4px;display:inline-block}
.link-btn:hover{background:#eee}
.hidden{display:none}
</style>
</head>
<body>

<div class="container">
    <div class="header">
        <div class="brand">⚡ SeptaCloud Gateway — Log Transaksi</div>
        <div class="nav-links">
            <a href="/admin/login">📱 Remote GoBiz Login</a>
            <a href="/">🏠 Home</a>
            <a href="#" onclick="logout()">Keluar</a>
        </div>
    </div>

    <!-- Login View (Jika Belum Auth) -->
    <div id="authView" class="auth-box">
        <h2 style="font-size:16px;margin-bottom:6px">Kunci Akses Admin</h2>
        <p style="font-size:12px;color:#777">Masukkan Admin Secret Key untuk membuka log pembayaran dan QRIS.</p>
        <input type="password" id="secretInput" placeholder="Masukkan API Key / Secret" />
        <button onclick="loginWithSecret()">Buka Log Transaksi</button>
        <div id="authMsg" style="font-size:12px;color:#dc2626;margin-top:10px"></div>
    </div>

    <!-- Main Dashboard View -->
    <div id="dashboardView" class="hidden">
        <!-- Stats Grid -->
        <div class="stats-grid">
            <div class="stat-card green">
                <div class="lbl">Total Omset (Lunas)</div>
                <div class="val" id="statRevenue">Rp 0</div>
            </div>
            <div class="stat-card green">
                <div class="lbl">Transaksi Lunas</div>
                <div class="val" id="statPaid">0</div>
            </div>
            <div class="stat-card yellow">
                <div class="lbl">QRIS Pending</div>
                <div class="val" id="statPending">0</div>
            </div>
            <div class="stat-card">
                <div class="lbl">Total QRIS Dibuat</div>
                <div class="val" id="statTotalQris">0</div>
            </div>
        </div>

        <!-- Toolbar -->
        <div class="toolbar">
            <div class="tabs">
                <button class="tab-btn active" id="tabPayments" onclick="switchTab('payments')">💰 Pembayaran Masuk (<span id="countPayments">0</span>)</button>
                <button class="tab-btn" id="tabQris" onclick="switchTab('qris')">📱 QRIS Dibuat (<span id="countQris">0</span>)</button>
            </div>
            <div class="actions">
                <label class="auto-poll">
                    <input type="checkbox" id="autoPollCheck" onchange="toggleAutoPoll()" checked /> Auto-Refresh (8s)
                </label>
                <button class="btn-refresh" onclick="fetchLogs()">🔄 Refresh</button>
            </div>
        </div>

        <!-- Tab 1: Pembayaran Masuk -->
        <div id="panelPayments" class="data-card">
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Waktu (WIB)</th>
                            <th>Nominal</th>
                            <th>Order ID</th>
                            <th>Metode / E-Wallet</th>
                            <th>ID Transaksi GoBiz</th>
                            <th>Webhook Callback</th>
                        </tr>
                    </thead>
                    <tbody id="tbodyPayments"></tbody>
                </table>
            </div>
            <div id="emptyPayments" class="empty-state hidden">Belum ada pembayaran masuk yang lunas.</div>
        </div>

        <!-- Tab 2: QRIS Dibuat -->
        <div id="panelQris" class="data-card hidden">
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Waktu Dibuat</th>
                            <th>Nominal</th>
                            <th>Order / TRX ID</th>
                            <th>Status</th>
                            <th>Kedaluwarsa</th>
                            <th>Aksi</th>
                        </tr>
                    </thead>
                    <tbody id="tbodyQris"></tbody>
                </table>
            </div>
            <div id="emptyQris" class="empty-state hidden">Belum ada riwayat QRIS yang dibuat.</div>
        </div>
    </div>
</div>

<script>
let currentTab = 'payments';
let pollInterval = null;

function getSavedSecret() {
    return localStorage.getItem('gopay_admin_secret') || new URLSearchParams(window.location.search).get('secret') || '';
}

function formatRupiah(num) {
    return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

function formatDate(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    return d.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) + ' WIB';
}

function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tabPayments').classList.toggle('active', tab === 'payments');
    document.getElementById('tabQris').classList.toggle('active', tab === 'qris');
    document.getElementById('panelPayments').classList.toggle('hidden', tab !== 'payments');
    document.getElementById('panelQris').classList.toggle('hidden', tab !== 'qris');
}

function loginWithSecret() {
    const val = document.getElementById('secretInput').value.trim();
    if (!val) {
        document.getElementById('authMsg').textContent = 'Kunci akses wajib diisi.';
        return;
    }
    localStorage.setItem('gopay_admin_secret', val);
    fetchLogs();
}

function logout() {
    localStorage.removeItem('gopay_admin_secret');
    if (pollInterval) clearInterval(pollInterval);
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');
}

async function fetchLogs() {
    const secret = getSavedSecret();
    if (!secret) {
        document.getElementById('dashboardView').classList.add('hidden');
        document.getElementById('authView').classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/admin/logs?secret=' + encodeURIComponent(secret));
        const json = await res.json();

        if (!json.success) {
            document.getElementById('authView').classList.remove('hidden');
            document.getElementById('dashboardView').classList.add('hidden');
            document.getElementById('authMsg').textContent = json.message || 'Secret Key salah.';
            return;
        }

        document.getElementById('authView').classList.add('hidden');
        document.getElementById('dashboardView').classList.remove('hidden');

        renderDashboard(json.data);
    } catch (e) {
        console.error('Gagal mengambil log:', e);
    }
}

function renderDashboard(data) {
    const sum = data.summary || {};
    document.getElementById('statRevenue').textContent = formatRupiah(sum.total_revenue);
    document.getElementById('statPaid').textContent = sum.total_paid || 0;
    document.getElementById('statPending').textContent = sum.total_pending || 0;
    document.getElementById('statTotalQris').textContent = sum.total_qris || 0;

    const payments = data.payments || [];
    document.getElementById('countPayments').textContent = payments.length;
    const tbodyP = document.getElementById('tbodyPayments');
    tbodyP.innerHTML = '';

    if (payments.length === 0) {
        document.getElementById('emptyPayments').classList.remove('hidden');
    } else {
        document.getElementById('emptyPayments').classList.add('hidden');
        payments.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = \`
                <td style="color:#666">\${formatDate(p.settled_at)}</td>
                <td style="font-weight:700;color:#16a34a">\${formatRupiah(p.amount)}</td>
                <td style="font-weight:600">\${p.order_id}</td>
                <td><span class="badge badge-issuer">\${p.payer_issuer}</span></td>
                <td style="font-family:monospace;font-size:11px;color:#555">\${p.transaction_id}</td>
                <td>
                    \${p.webhook_delivered 
                        ? '<span class="badge badge-paid">✅ Terkirim</span>' 
                        : (p.webhook_url ? '<span class="badge badge-pending">⏳ Belum Terkirim</span>' : '<span style="color:#999">-</span>')}
                </td>
            \`;
            tbodyP.appendChild(tr);
        });
    }

    const qrisList = data.qris || [];
    document.getElementById('countQris').textContent = qrisList.length;
    const tbodyQ = document.getElementById('tbodyQris');
    tbodyQ.innerHTML = '';

    if (qrisList.length === 0) {
        document.getElementById('emptyQris').classList.remove('hidden');
    } else {
        document.getElementById('emptyQris').classList.add('hidden');
        qrisList.forEach(q => {
            const badgeClass = q.status === 'PAID' ? 'badge-paid' : (q.status === 'PENDING' ? 'badge-pending' : 'badge-expired');
            const tr = document.createElement('tr');
            tr.innerHTML = \`
                <td style="color:#666">\${formatDate(q.created_at)}</td>
                <td style="font-weight:700">\${formatRupiah(q.amount)}</td>
                <td><strong>\${q.order_id}</strong><br><span style="font-size:10.5px;color:#888">\${q.trx_id}</span></td>
                <td><span class="badge \${badgeClass}">\${q.status}</span></td>
                <td style="font-size:11.5px;color:#777">\${formatDate(q.expires_at)}</td>
                <td><a href="\${q.pay_url}" target="_blank" class="link-btn">Lihat QR ↗</a></td>
            \`;
            tbodyQ.appendChild(tr);
        });
    }
}

function toggleAutoPoll() {
    const isChecked = document.getElementById('autoPollCheck').checked;
    if (isChecked) {
        if (!pollInterval) pollInterval = setInterval(fetchLogs, 8000);
    } else {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }
}

// Inisialisasi awal
const saved = getSavedSecret();
if (saved) {
    fetchLogs();
    toggleAutoPoll();
} else {
    document.getElementById('authView').classList.remove('hidden');
}
</script>
</body>
</html>`);
});

// ==========================================
// 3. CREATE DYNAMIC QRIS (DENGAN WEBHOOK / CALLBACK SUPPORT)
// ==========================================

app.all('/create-qris', apiKeyAuth, rateLimiter('api-create-qris', 60, 60 * 1000), async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const customTrxId = req.body?.trx_id || req.query?.trx_id;
    const orderId = req.body?.order_id || req.query?.order_id || '';
    const webhookUrl = req.body?.webhook_url || req.query?.webhook_url || process.env.WEBHOOK_URL || '';
    const returnUrl = req.body?.return_url || req.query?.return_url || '';

    const parsedAmount = parseInt(amount, 10);
    if (!amount || isNaN(parsedAmount) || parsedAmount < 100 || parsedAmount > 500000000) {
        return res.status(400).json({
            success: false,
            message: 'Nominal pembayaran tidak valid (Minimal Rp 100 s/d Rp 500.000.000)'
        });
    }

    if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
        return res.status(400).json({
            success: false,
            message: 'Webhook URL tidak valid atau mengarah ke subnet internal yang tidak diizinkan.'
        });
    }

    const staticTemplate = getActiveStaticQRIS();
    if (!staticTemplate) {
        return res.status(500).json({
            success: false,
            message: 'QRIS_STATIC belum dikonfigurasi. Jalankan `npm run login` di terminal.'
        });
    }

    const dynamicCode = qrisHelper.generateDynamicQRIS(staticTemplate, parsedAmount);
    if (!dynamicCode) {
        return res.status(500).json({
            success: false,
            message: 'Gagal meng-generate QRIS Dinamis dari template QRIS_STATIC'
        });
    }

    let qrBase64 = '';
    try {
        qrBase64 = await QRCode.toDataURL(dynamicCode, { width: 350, margin: 2 });
    } catch (e) {}

    const qrisId = Math.random().toString(36).substring(2, 10);
    const cleanTrxId = customTrxId ? String(customTrxId).replace(/[^a-zA-Z0-9_-]/g, '') : ('TRX-' + Math.random().toString(36).substring(2, 10).toUpperCase());
    const cleanOrderId = orderId ? String(orderId).replace(/[^\w\s-]/gi, '') : '';
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + QRIS_EXPIRY_MS);

    qrisStore.set(qrisId, {
        qrisCode: dynamicCode,
        amount: parsedAmount,
        trxId: cleanTrxId,
        orderId: cleanOrderId,
        createdAt,
        expiresAt,
        status: 'PENDING',
        transactionData: null,
        webhookUrl,
        webhookDelivered: false,
        returnUrl
    });

    saveQRISStoreToDisk();

    const host = req.get('host');
    const protocol = req.protocol;
    const qrImageUrl = `${protocol}://${host}/qr/${qrisId}?format=raw`;
    const payUrl = `${protocol}://${host}/pay/${qrisId}`;

    logActivity('INFO', `QRIS Dinamis dibuat | TRX-ID: ${cleanTrxId} | Nominal: ${formatRupiah(parsedAmount)}${webhookUrl ? ' | Callback: ' + webhookUrl : ''}`);

    res.json({
        success: true,
        data: {
            qris_id: qrisId,
            trx_id: cleanTrxId,
            order_id: cleanOrderId,
            amount: parsedAmount,
            qris_code: dynamicCode,
            qr_image_url: qrImageUrl,
            qr_image_base64: qrBase64,
            pay_url: payUrl,
            webhook_url: webhookUrl || null,
            expires_at: expiresAt.toISOString(),
            expires_in_seconds: 300
        }
    });
});

// ==========================================
// 4. HALAMAN PEMBAYARAN CHECKOUT (/pay/:id)
// ==========================================

app.get('/pay/:id', (req, res) => {
    const qrisId = req.params.id;
    const qrisItem = qrisStore.get(qrisId);

    if (!qrisItem) {
        return res.status(404).json({ success: false, message: 'QRIS ID tidak ditemukan atau sudah kedaluwarsa.' });
    }

    const now = Date.now();
    const remaining = Math.max(0, Math.floor((qrisItem.expiresAt.getTime() - now) / 1000));
    const amountFormatted = new Intl.NumberFormat('id-ID').format(qrisItem.amount);
    const qrImageUrl = `${req.protocol}://${req.get('host')}/qr/${qrisId}?format=raw`;
    const statusUrl = `${req.protocol}://${req.get('host')}/api/qr-status/${qrisId}`;
    const returnUrl = qrisItem.returnUrl || '';

    if (qrisItem.status === 'PAID') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pembayaran Berhasil</title>${returnUrl ? `<meta http-equiv="refresh" content="2;url=${returnUrl}">` : ''}<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;display:flex;justify-content:center;min-height:100vh;padding:24px 16px;color:#222}.card{width:100%;max-width:380px;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:32px 24px;text-align:center;height:fit-content}.check{width:56px;height:56px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}.check svg{width:28px;height:28px;stroke:#fff;stroke-width:3;fill:none}h2{font-size:18px;font-weight:700;margin-bottom:4px}p{font-size:13px;color:#888}</style></head><body><div class="card"><div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><h2>Pembayaran Berhasil</h2><p>Rp ${amountFormatted}</p>${returnUrl ? '<p style="margin-top:8px">Mengalihkan...</p>' : ''}</div>${returnUrl ? `<script>setTimeout(function(){window.location.href='${returnUrl}'},2000)</script>` : ''}</body></html>`);
    }

    if (qrisItem.status === 'EXPIRED' || remaining <= 0) {
        qrisItem.status = 'EXPIRED';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pembayaran Kedaluwarsa</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;display:flex;justify-content:center;min-height:100vh;padding:24px 16px;color:#222}.card{width:100%;max-width:380px;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:32px 24px;text-align:center;height:fit-content}h2{font-size:18px;font-weight:700;margin-bottom:4px;color:#dc2626}p{font-size:13px;color:#888}</style></head><body><div class="card"><h2>Waktu Habis</h2><p>Sesi pembayaran QRIS ini sudah kedaluwarsa.</p></div></body></html>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bayar Rp ${amountFormatted}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f5f5f5;
            color: #222;
            display: flex;
            justify-content: center;
            min-height: 100vh;
            padding: 24px 16px;
        }
        .card {
            width: 100%;
            max-width: 380px;
            background: #fff;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 28px 24px;
            text-align: center;
            height: fit-content;
        }
        .label {
            font-size: 13px;
            color: #888;
            margin-bottom: 2px;
        }
        .amount {
            font-size: 28px;
            font-weight: 700;
            color: #111;
            margin-bottom: 20px;
        }
        .qr-box {
            background: #fff;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 12px;
            display: inline-block;
            margin-bottom: 16px;
        }
        .qr-box img {
            display: block;
            width: 220px;
            height: 220px;
        }
        .timer {
            font-size: 13px;
            color: #666;
            margin-bottom: 16px;
        }
        .timer span {
            font-weight: 600;
            color: #333;
        }
        .info {
            font-size: 12px;
            color: #999;
            line-height: 1.5;
            margin-bottom: 20px;
        }
        .btn {
            display: block;
            width: 100%;
            padding: 12px;
            background: #222;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn:hover { background: #444; }
        .btn:disabled { background: #ccc; cursor: default; }
        .msg {
            margin-top: 10px;
            font-size: 12px;
            color: #888;
            min-height: 16px;
        }
        .paid-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.4);
            justify-content: center;
            align-items: center;
            z-index: 10;
        }
        .paid-overlay.show { display: flex; }
        .paid-box {
            background: #fff;
            border-radius: 12px;
            padding: 32px 28px;
            text-align: center;
            max-width: 320px;
            width: 90%;
        }
        .paid-box .check {
            width: 48px;
            height: 48px;
            background: #16a34a;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 12px;
        }
        .paid-box .check svg {
            width: 24px;
            height: 24px;
            stroke: #fff;
            stroke-width: 3;
            fill: none;
        }
        .paid-box p {
            font-size: 15px;
            font-weight: 600;
            color: #111;
        }
        .paid-box .sub {
            font-size: 12px;
            color: #888;
            margin-top: 4px;
            font-weight: 400;
        }
    </style>
</head>
<body>
    <div class="card">
        ${qrisItem.orderId ? `<div class="label">${qrisItem.orderId}</div>` : ''}
        <div class="amount">Rp ${amountFormatted}</div>

        <div class="qr-box">
            <img src="${qrImageUrl}" alt="QRIS" />
        </div>

        <div class="timer">Sisa waktu: <span id="cd">${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}</span></div>

        <div class="info">
            Scan QR di atas menggunakan GoPay, DANA, OVO, ShopeePay, BCA Mobile, BRImo, Livin, LinkAja, atau aplikasi bank lainnya.
        </div>

        <button class="btn" id="btn" onclick="mc()">Cek Status Pembayaran</button>
        <div class="msg" id="msg"></div>
    </div>

    <div class="paid-overlay" id="po">
        <div class="paid-box">
            <div class="check">
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p>Pembayaran Berhasil</p>
            <p class="sub">Rp ${amountFormatted}</p>
            ${returnUrl ? '<p class="sub" style="margin-top:4px">Mengalihkan ke invoice...</p>' : ''}
        </div>
    </div>

    <script>
        let r=${remaining},p=null;
        function tick(){
            if(r<=0){document.getElementById('cd').textContent='Habis';document.getElementById('btn').disabled=true;if(p)clearInterval(p);return}
            document.getElementById('cd').textContent=String(Math.floor(r/60)).padStart(2,'0')+':'+String(r%60).padStart(2,'0');
            r--;
        }
        setInterval(tick,1000);

        let ru='${returnUrl}';
        async function cs(m){
            const b=document.getElementById('btn'),g=document.getElementById('msg');
            if(m){b.disabled=true;b.textContent='Memeriksa...';g.textContent='';}
            try{
                const x=await fetch('${statusUrl}');
                const j=await x.json();
                if(j.success&&j.paid){
                    if(p)clearInterval(p);
                    document.getElementById('po').classList.add('show');
                    if(ru){setTimeout(function(){window.location.href=ru;},2000);}
                }else if(m){
                    g.textContent='Belum terdeteksi. Pastikan sudah transfer.';
                    setTimeout(()=>{g.textContent='';},4000);
                }
            }catch(e){if(m)g.textContent='Gagal menghubungi server.';}
            finally{if(m){b.disabled=false;b.textContent='Cek Status Pembayaran';}}
        }
        function mc(){cs(true);}
        p=setInterval(()=>cs(false),6000);
    </script>
</body>
</html>`);
});

// ==========================================
// 4. QR CODE RAW IMAGE / JSON STATUS (/qr/:id)
// ==========================================

app.get('/qr/:id', (req, res) => {
    const qrisId = req.params.id;
    const qrisItem = qrisStore.get(qrisId);

    if (!qrisItem) {
        return res.status(404).json({ success: false, message: 'QRIS ID tidak ditemukan' });
    }

    // ?format=raw → gambar QR mentah (PNG)
    if (req.query.format === 'raw' || req.query.raw === '1') {
        res.setHeader('Content-Type', 'image/png');
        return QRCode.toFileStream(res, qrisItem.qrisCode, {
            width: 400,
            margin: 2
        });
    }

    // ?format=json atau Accept: application/json → response JSON
    if (req.query.format === 'json' || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'))) {
        return res.json({
            success: true,
            data: {
                qris_id: qrisId,
                trx_id: qrisItem.trxId,
                order_id: qrisItem.orderId,
                amount: qrisItem.amount,
                status: qrisItem.status,
                qris_code: qrisItem.qrisCode,
                qr_image_url: `${req.protocol}://${req.get('host')}/qr/${qrisId}?format=raw`,
                pay_url: `${req.protocol}://${req.get('host')}/pay/${qrisId}`,
                expires_at: qrisItem.expiresAt.toISOString()
            }
        });
    }

    // Default (browser) → redirect ke halaman checkout /pay/:id
    return res.redirect(`/pay/${qrisId}`);
});

// ==========================================
// 5. PUBLIC STATUS CHECK (/api/qr-status/:id)
// ==========================================

app.get('/api/qr-status/:id', rateLimiter('status-check', 120, 60 * 1000), async (req, res) => {
    const qrisId = req.params.id;
    let qrisItem = qrisStore.get(qrisId);

    if (!qrisItem) {
        return res.status(404).json({ success: false, message: 'QRIS ID tidak ditemukan' });
    }

    if (qrisItem.status === 'PAID') {
        return res.json({
            success: true,
            paid: true,
            status: 'PAID',
            transaction: qrisItem.transactionData
        });
    }

    const now = Date.now();
    if (now > qrisItem.expiresAt.getTime()) {
        qrisItem.status = 'EXPIRED';
        saveQRISStoreToDisk();
        return res.json({
            success: true,
            paid: false,
            status: 'EXPIRED',
            message: 'Waktu pembayaran QRIS telah habis (Expired)'
        });
    }

    try {
        const startTime = new Date(now - 30 * 60 * 1000).toISOString();
        const transactions = await sessionManager.fetchTransactions({
            startTime,
            pageSize: 30
        });

        const matched = transactions.find(tx => {
            if (tx.amount !== qrisItem.amount) return false;
            if (tx.status !== 'SETTLEMENT' && tx.status !== 'CAPTURE') return false;

            const existingClaim = claimedTransactions.get(tx.transaction_id);
            if (existingClaim && existingClaim.trxId !== qrisItem.trxId) {
                return false;
            }

            const txTime = new Date(tx.transaction_time).getTime();
            if (txTime < qrisItem.createdAt.getTime() - 10 * 60 * 1000) {
                return false;
            }

            return true;
        });

        if (matched) {
            claimedTransactions.set(matched.transaction_id, {
                trxId: qrisItem.trxId,
                qrisId,
                amount: qrisItem.amount,
                claimedAt: Date.now()
            });

            qrisItem.status = 'PAID';
            qrisItem.transactionData = matched;
            saveQRISStoreToDisk();

            logActivity('SUCCESS', `Pembayaran LUNAS! | TRX-ID: ${qrisItem.trxId} | Nominal: ${formatRupiah(qrisItem.amount)}`);

            // Kirim Callback Webhook dan tunggu hingga diterima Paymenter
            await dispatchWebhook(qrisItem, matched);

            return res.json({
                success: true,
                paid: true,
                status: 'PAID',
                transaction: matched
            });
        }

        const remainingSeconds = Math.max(0, Math.floor((qrisItem.expiresAt.getTime() - now) / 1000));
        return res.json({
            success: true,
            paid: false,
            status: 'PENDING',
            remaining_seconds: remainingSeconds
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Gagal memeriksa mutasi GoBiz: ${err.message}`
        });
    }
});

// ==========================================
// 6. SERVER-TO-SERVER CHECK PAYMENT (/check-payment)
// ==========================================

app.all('/check-payment', apiKeyAuth, rateLimiter('api-check-payment', 60, 60 * 1000), async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const trxId = req.body?.trx_id || req.query?.trx_id;
    const startTimeParam = req.body?.startTime || req.query?.startTime || req.query?.start_time;

    const parsedAmount = parseInt(amount, 10);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Parameter amount wajib diisi dan berupa angka valid (contoh: 25000)'
        });
    }

    try {
        const now = new Date();
        const startTime = startTimeParam ? new Date(startTimeParam) : new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const transactions = await sessionManager.fetchTransactions({
            startTime: startTime.toISOString(),
            pageSize: 30
        });

        const matched = transactions.find(tx => {
            if (tx.amount !== parsedAmount) return false;
            if (tx.status !== 'SETTLEMENT' && tx.status !== 'CAPTURE') return false;

            const existingClaim = claimedTransactions.get(tx.transaction_id);
            if (existingClaim && trxId && existingClaim.trxId !== trxId) {
                return false;
            }

            return true;
        });

        if (matched) {
            if (trxId) {
                claimedTransactions.set(matched.transaction_id, {
                    trxId,
                    amount: parsedAmount,
                    claimedAt: Date.now()
                });
            }

            return res.json({
                success: true,
                paid: true,
                transaction: matched
            });
        }

        return res.json({
            success: true,
            paid: false,
            message: 'Pembayaran belum ditemukan di mutasi GoPay'
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Gagal memproses pengecekan mutasi: ${err.message}`
        });
    }
});

// ==========================================
// 7. TRANSACTIONS MUTATION LIST (/transactions)
// ==========================================

app.get('/transactions', apiKeyAuth, rateLimiter('api-transactions', 30, 60 * 1000), async (req, res) => {
    const startTime = req.query.startTime || req.query.start_time;
    const endTime = req.query.endTime || req.query.end_time;
    const pageSize = req.query.pageSize || req.query.page_size || req.query.size || 20;

    try {
        const transactions = await sessionManager.fetchTransactions({
            startTime,
            endTime,
            pageSize
        });

        res.json({
            success: true,
            count: transactions.length,
            data: transactions
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: `Gagal mengambil riwayat mutasi: ${err.message}`
        });
    }
});

// ==========================================
// 8. LOGS ENDPOINT (/api/logs)
// ==========================================

app.get('/api/logs', apiKeyAuth, (req, res) => {
    res.json({
        success: true,
        count: activityLogs.length,
        logs: activityLogs
    });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
    const session = sessionManager.loadSession();
    console.log('\n======================================================');
    console.log(`🚀 GoPay Headless REST API Gateway aktif di port ${PORT}`);
    console.log(`🔔 Webhook Callback : Auto-Detector & HMAC-SHA256 Active (7s interval)`);
    console.log(`🛡️ Mode             : Pure JSON Backend API (No Web Frontend)`);
    if (session) {
        console.log(`🏪 Toko             : ${session.merchant_name || 'SEPTACLOUD, Digital & Kreatif'}`);
        console.log(`🆔 Merchant ID       : ${session.merchant_id || 'G010890245'}`);
        console.log(`👤 Pemilik          : ${session.owner_name || 'AAS ASIAH'}`);
    } else {
        console.log(`⚠️ Sesi GoBiz       : Belum login. Jalankan: npm run login`);
    }
    console.log('======================================================\n');
    logActivity('INFO', `Server dijalankan pada port ${PORT} (Headless & Callback Engine Aktif)`);
});

module.exports = app;

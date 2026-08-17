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
            if (Date.now() - new Date(v.createdAt).getTime() < 24 * 3600 * 1000) {
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
        const startTime = new Date(now - 15 * 60 * 1000).toISOString();
        const transactions = await sessionManager.fetchTransactions({
            startTime,
            pageSize: 20
        });

        if (!transactions || transactions.length === 0) return;

        for (const { qrisId, item } of pendingItems) {
            const matched = transactions.find(tx => {
                if (tx.amount !== item.amount) return false;
                if (tx.status !== 'SETTLEMENT' && tx.status !== 'CAPTURE') return false;

                const existingClaim = claimedTransactions.get(tx.transaction_id);
                if (existingClaim && existingClaim.trxId !== item.trxId) return false;

                const txTime = new Date(tx.transaction_time).getTime();
                if (txTime < item.createdAt.getTime() - 5 * 60 * 1000) return false;

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
                dispatchWebhook(item, matched);
            }
        }
    } catch (err) {
        // Silent error agar log tidak penuh saat offline
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
    res.json({
        service: 'GoPay Partner & Merchant API Gateway',
        status: 'RUNNING',
        version: '1.0.0',
        merchant_name: session?.merchant_name || 'SEPTACLOUD, Digital & Kreatif',
        merchant_id: session?.merchant_id || 'G010890245',
        features: {
            dynamic_qris: true,
            realtime_detection: true,
            automated_webhook_callback: true,
            hmac_sha256_signature: true
        },
        endpoints: {
            create_qris: 'POST /create-qris',
            check_payment: 'POST /check-payment',
            qr_status: 'GET /api/qr-status/:qris_id',
            transactions: 'GET /transactions',
            health: 'GET /health',
            token_status: 'GET /token-status'
        }
    });
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
// 3. CREATE DYNAMIC QRIS (DENGAN WEBHOOK / CALLBACK SUPPORT)
// ==========================================

app.all('/create-qris', apiKeyAuth, rateLimiter('api-create-qris', 60, 60 * 1000), async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const customTrxId = req.body?.trx_id || req.query?.trx_id;
    const orderId = req.body?.order_id || req.query?.order_id || '';
    const webhookUrl = req.body?.webhook_url || req.query?.webhook_url || process.env.WEBHOOK_URL || '';

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
        webhookDelivered: false
    });

    saveQRISStoreToDisk();

    const host = req.get('host');
    const protocol = req.protocol;
    const qrImageUrl = `${protocol}://${host}/qr/${qrisId}?format=raw`;

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
            webhook_url: webhookUrl || null,
            expires_at: expiresAt.toISOString(),
            expires_in_seconds: 300
        }
    });
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

    if (req.query.format === 'raw' || req.query.raw === '1' || req.headers.accept?.includes('image/')) {
        res.setHeader('Content-Type', 'image/png');
        return QRCode.toFileStream(res, qrisItem.qrisCode, {
            width: 400,
            margin: 2
        });
    }

    res.json({
        success: true,
        data: {
            qris_id: qrisId,
            trx_id: qrisItem.trxId,
            order_id: qrisItem.orderId,
            amount: qrisItem.amount,
            status: qrisItem.status,
            qris_code: qrisItem.qrisCode,
            qr_image_url: `${req.protocol}://${req.get('host')}/qr/${qrisId}?format=raw`,
            expires_at: qrisItem.expiresAt.toISOString()
        }
    });
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
            if (txTime < qrisItem.createdAt.getTime() - 5 * 60 * 1000) {
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

            // Kirim Callback Webhook
            dispatchWebhook(qrisItem, matched);

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

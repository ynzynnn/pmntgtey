/**
 * sessionManager.js
 * Manajemen Sesi GoBiz / GoPay Merchant, Auto-Refresh Token, dan Fetch Mutasi Transaksi
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const SESSION_FILE = path.join(__dirname, '.GOPAY_SESI_JANGAN_DIHAPUS.json');
const CACHE_FILE = path.join(__dirname, '.gopay_cache.json');

// GoBiz & Gojek API Endpoints
const GOBIZ_AUTH_URL = 'https://api.gobiz.co.id/goid';
const GOBIZ_API_URL = 'https://api.gobiz.co.id/v1';
const GOJEK_TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';

/**
 * Format nomor HP menjadi nomor lokal tanpa awalan 0 atau 62 (contoh: "83847274233")
 * @param {string} phone 
 * @returns {{ cleanNumber: string, fullPhone: string }}
 */
function normalizePhone(phone) {
    if (!phone) return { cleanNumber: '', fullPhone: '' };
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('62')) {
        clean = clean.substring(2);
    } else if (clean.startsWith('0')) {
        clean = clean.substring(1);
    }
    return {
        cleanNumber: clean,
        fullPhone: '+62' + clean
    };
}

/**
 * Buat random UUID v4
 */
function generateUUID() {
    return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Membaca sesi aktif dari file JSON
 * @returns {object|null}
 */
function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        }
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        }
    } catch (err) {
        console.error('[GOPAY-SESSION] Gagal membaca sesi:', err.message);
    }
    return null;
}

/**
 * Menyimpan sesi ke file JSON permanen
 * @param {object} sessionData 
 */
function saveSession(sessionData) {
    try {
        const payload = {
            ...sessionData,
            updated_at: new Date().toISOString()
        };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf-8');
        return true;
    } catch (err) {
        console.error('[GOPAY-SESSION] Gagal menyimpan sesi:', err.message);
        return false;
    }
}

/**
 * Memeriksa apakah access_token mendekati masa kedaluwarsa (buffer 15 menit)
 * @param {object} session 
 * @returns {boolean}
 */
function isExpired(session) {
    if (!session || !session.access_token) return true;
    if (!session.expires_at) return false;
    return Date.now() >= (session.expires_at - 15 * 60 * 1000);
}

/**
 * Header standar web GoBiz Merchant
 * @param {object} session 
 * @param {string} [customUserAgent] 
 * @returns {object}
 */
function getHeaders(session = {}, customUserAgent = null) {
    const uniqueId = session.unique_id || generateUUID();
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'id',
        'authentication-type': 'go-id',
        'content-type': 'application/json',
        'gojek-country-code': 'ID',
        'gojek-timezone': 'Asia/Jakarta',
        'origin': 'https://portal.gofoodmerchant.co.id',
        'referer': 'https://portal.gofoodmerchant.co.id/',
        'user-agent': customUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'x-appid': 'go-biz-web-dashboard',
        'x-appversion': 'platform-v3.111.0-1708bc9a',
        'x-deviceos': 'Web',
        'x-phonemake': 'Windows 10 64-bit',
        'x-phonemodel': 'Chrome on Windows 10 64-bit',
        'x-platform': 'Web',
        'x-uniqueid': uniqueId,
        'x-user-locale': 'en-GB',
        'x-user-type': 'merchant'
    };

    if (session && session.access_token) {
        headers['authorization'] = `Bearer ${session.access_token}`;
    }

    return headers;
}

/**
 * Ambil detail profil merchant secara real-time dari GoBiz
 * @param {string} accessToken 
 * @param {string} uniqueId 
 * @returns {Promise<{merchant_id: string, merchant_name: string, owner_name: string, qris_static: string, merchant_city: string}>}
 */
async function fetchMerchantProfileLive(accessToken, uniqueId) {
    const headers = getHeaders({ access_token: accessToken, unique_id: uniqueId });
    const profile = {
        merchant_id: '',
        merchant_name: 'GoPay Merchant',
        owner_name: '',
        qris_static: '',
        merchant_city: ''
    };

    try {
        // 1. Ambil info user me
        const userRes = await axios.get(`${GOBIZ_API_URL}/users/me`, { headers, timeout: 10000 });
        const userData = userRes.data?.user || userRes.data;
        if (userData) {
            profile.merchant_id = userData.merchant_id || '';
            profile.owner_name = userData.full_name || '';
        }

        // 2. Ambil detail merchant dan QRIS statis
        if (profile.merchant_id) {
            const merchantRes = await axios.get(`${GOBIZ_API_URL}/merchants/${profile.merchant_id}`, { headers, timeout: 10000 });
            const merchantData = merchantRes.data;
            if (merchantData) {
                profile.merchant_name = merchantData.aspi?.merchant_name_50 ||
                                        merchantData.vtweb_settings?.display_name ||
                                        merchantData.name ||
                                        'GoPay Merchant';
                profile.merchant_city = merchantData.aspi?.merchant_city?.replace(/^6007/, '') || merchantData.city || '';

                // Ambil string QRIS Statis dari POP aktif
                const activePop = merchantData.pops?.find(p => p.status === 'active' && p.gopay?.aspi_qr_string) ||
                                  merchantData.pops?.[0];
                if (activePop && activePop.gopay?.aspi_qr_string) {
                    profile.qris_static = activePop.gopay.aspi_qr_string;
                }
            }
        }
    } catch (err) {
        console.warn('[GOPAY-SESSION] Gagal fetch detail merchant live:', err.message);
    }

    return profile;
}

/**
 * Request OTP via SMS/WA ke GoBiz Portal
 * @param {string} rawPhone - Nomor HP (contoh: 083847274233)
 * @returns {Promise<{otp_token: string, phone_number: string, expires_in: number, message: string}>}
 */
async function requestOTP(rawPhone) {
    const { cleanNumber, fullPhone } = normalizePhone(rawPhone);
    if (!cleanNumber || cleanNumber.length < 7) {
        throw new Error('Nomor HP tidak valid. Masukkan nomor HP Indonesia yang aktif.');
    }

    const uniqueId = generateUUID();
    const headers = getHeaders({ unique_id: uniqueId });

    const payload = {
        client_id: 'go-biz-web-new',
        phone_number: cleanNumber,
        country_code: '62'
    };

    try {
        const response = await axios.post(`${GOBIZ_AUTH_URL}/login/request`, payload, {
            headers,
            timeout: 15000
        });

        const resData = response.data?.data || response.data;
        const otpToken = resData?.otp_token;
        const otpExpiresIn = resData?.otp_expires_in || 720;
        const state = resData?.next_state?.state || 'SMS';

        if (!otpToken) {
            throw new Error('Respon GoBiz tidak memuat otp_token.');
        }

        return {
            success: true,
            otp_token: otpToken,
            phone_number: fullPhone,
            clean_number: cleanNumber,
            unique_id: uniqueId,
            expires_in: otpExpiresIn,
            state,
            message: `Kode OTP (4 digit) berhasil dikirim via ${state.toUpperCase()} ke nomor ${fullPhone}`
        };
    } catch (err) {
        const errMsg = err.response?.data?.errors?.[0]?.message ||
                       err.response?.data?.message ||
                       err.message;
        throw new Error(`Gagal mengirim OTP: ${errMsg}`);
    }
}

/**
 * Verifikasi Kode OTP dari SMS/WhatsApp
 * @param {string} rawPhone 
 * @param {string} otpCode 
 * @param {string} otpToken 
 * @param {string} uniqueId 
 * @returns {Promise<object>}
 */
async function verifyOTP(rawPhone, otpCode, otpToken, uniqueId = null) {
    const { fullPhone } = normalizePhone(rawPhone);
    const devUniqueId = uniqueId || generateUUID();
    const headers = getHeaders({ unique_id: devUniqueId });

    const payload = {
        client_id: 'go-biz-web-new',
        grant_type: 'otp',
        data: {
            otp: otpCode.toString().trim(),
            otp_token: otpToken
        }
    };

    try {
        const response = await axios.post(`${GOBIZ_AUTH_URL}/token`, payload, {
            headers,
            timeout: 15000
        });

        const resData = response.data?.data || response.data;
        const accessToken = resData?.access_token;
        const refreshToken = resData?.refresh_token || '';
        const expiresIn = resData?.expires_in || (86400 * 30); // Default 30 hari
        const expiresAt = Date.now() + (expiresIn * 1000);

        if (!accessToken) {
            throw new Error('Verifikasi berhasil tetapi access_token tidak ditemukan dalam respon.');
        }

        // Ambil profil merchant & QRIS statis secara real-time
        const liveProfile = await fetchMerchantProfileLive(accessToken, devUniqueId);

        const sessionObj = {
            phone_number: fullPhone,
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            unique_id: devUniqueId,
            merchant_id: liveProfile.merchant_id || process.env.GOPAY_MERCHANT_ID || '',
            merchant_name: liveProfile.merchant_name || 'GoPay Merchant',
            owner_name: liveProfile.owner_name || '',
            merchant_city: liveProfile.merchant_city || '',
            qris_static: liveProfile.qris_static || ''
        };

        saveSession(sessionObj);
        return sessionObj;
    } catch (err) {
        const errMsg = err.response?.data?.errors?.[0]?.message ||
                       err.response?.data?.message ||
                       err.message;
        throw new Error(`Verifikasi OTP Gagal: ${errMsg}`);
    }
}

/**
 * Auto-refresh access_token menggunakan refresh_token
 * @returns {Promise<object>}
 */
async function refreshSession() {
    const session = loadSession();
    if (!session || !session.refresh_token) {
        throw new Error('Tidak ada refresh_token yang tersimpan di sesi.');
    }

    const headers = getHeaders(session);
    const payload = {
        client_id: 'go-biz-web-new',
        grant_type: 'refresh_token',
        data: {
            refresh_token: session.refresh_token
        }
    };

    try {
        const response = await axios.post(`${GOBIZ_AUTH_URL}/token`, payload, {
            headers,
            timeout: 15000
        });

        const resData = response.data?.data || response.data;
        const newAccessToken = resData?.access_token;
        const newRefreshToken = resData?.refresh_token || session.refresh_token;
        const expiresIn = resData?.expires_in || (86400 * 30);

        if (!newAccessToken) {
            throw new Error('Gagal memperbarui access token dari respon GoBiz.');
        }

        session.access_token = newAccessToken;
        session.refresh_token = newRefreshToken;
        session.expires_at = Date.now() + (expiresIn * 1000);

        const liveProfile = await fetchMerchantProfileLive(newAccessToken, session.unique_id);
        if (liveProfile.merchant_name && liveProfile.merchant_name !== 'GoPay Merchant') {
            session.merchant_name = liveProfile.merchant_name;
            session.merchant_id = liveProfile.merchant_id;
            session.qris_static = liveProfile.qris_static || session.qris_static;
        }

        saveSession(session);
        console.log('[GOPAY-SESSION] Token GoBiz berhasil diperbarui.');
        return session;
    } catch (err) {
        console.error('[GOPAY-SESSION] Gagal me-refresh token:', err.response?.data || err.message);
        throw err;
    }
}

/**
 * Mengambil headers yang valid (otomatis me-refresh token jika basi)
 * @param {string} [customUserAgent] 
 * @returns {Promise<object|null>}
 */
async function getValidHeaders(customUserAgent = null) {
    let session = loadSession();
    if (!session || !session.access_token) {
        return null;
    }

    if (isExpired(session) && session.refresh_token) {
        try {
            session = await refreshSession();
        } catch (e) {
            console.warn('[GOPAY-SESSION] Token basi & gagal di-refresh, mencoba menggunakan token lama...');
        }
    }

    return getHeaders(session, customUserAgent);
}

/**
 * Mengambil daftar transaksi settlement GoPay / GoBiz
 * @param {object} options 
 * @returns {Promise<Array<object>>}
 */
async function fetchTransactions({ startTime, endTime, pageSize = 20, merchantId = null } = {}) {
    const activeHeaders = await getValidHeaders();
    if (!activeHeaders) {
        throw new Error('Sesi belum terkonfigurasi. Jalankan `node login.js` terlebih dahulu.');
    }

    const session = loadSession();
    const targetMerchantId = merchantId || process.env.GOPAY_MERCHANT_ID || session?.merchant_id || '';

    const now = new Date();
    const defaultStartTime = new Date(now.getTime() - 24 * 3600 * 1000);

    const startISO = startTime ? new Date(startTime).toISOString() : defaultStartTime.toISOString();
    const endISO = endTime ? new Date(endTime).toISOString() : now.toISOString();

    const params = {
        from: 0,
        size: parseInt(pageSize, 10) || 20,
        statuses: 'SETTLEMENT,CAPTURE',
        payment_types: 'QRIS,GOPAY',
        start_time: startISO,
        end_time: endISO
    };

    if (targetMerchantId) {
        params.merchant_ids = targetMerchantId;
    }

    const response = await axios.get(GOJEK_TRANSACTIONS_URL, {
        headers: activeHeaders,
        params,
        timeout: 12000
    });

    const rawList = response.data?.data || response.data?.transactions || response.data || [];
    if (!Array.isArray(rawList)) {
        return [];
    }

    return rawList.map(tx => {
        const txId = tx.id || tx.wallstreet_transaction_id || tx.transaction_id || tx.order_id || '';
        const orderId = tx.order_id || tx.wallstreet_transaction_id || tx.order_no || txId;
        
        // PENTING: Gojek Merchant Analytics API menyimpan nominal dalam format sen (dikali 100)
        // Contoh: Transaksi Rp 1.000 dikirim sebagai 100000, Rp 100 dikirim sebagai 10000
        const rawAmount = parseInt(tx.gross_amount ?? tx.amount ?? tx.real_gross_amount ?? tx.total_amount ?? 0, 10);
        const amount = Math.round(rawAmount / 100);

        const status = (tx.transaction_status || tx.status || 'SETTLEMENT').toUpperCase();
        const payerIssuer = tx.qris_provider_aspi_issuer || tx.payer_issuer || tx.payment_method || tx.payment_type || 'QRIS';
        const paymentType = tx.payment_type || 'QRIS';
        const txTime = tx.settlement_time || tx.transaction_time || tx.created_at || new Date().toISOString();

        return {
            transaction_id: txId,
            order_id: orderId,
            amount,
            raw_amount: rawAmount,
            status,
            payer_issuer: payerIssuer,
            payment_type: paymentType,
            transaction_time: txTime,
            raw: tx
        };
    });
}

module.exports = {
    SESSION_FILE,
    loadSession,
    saveSession,
    isExpired,
    getHeaders,
    getValidHeaders,
    requestOTP,
    verifyOTP,
    refreshSession,
    fetchTransactions,
    fetchMerchantProfileLive,
    normalizePhone
};

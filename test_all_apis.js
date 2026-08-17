/**
 * test_all_apis.js
 * Comprehensive Integration Test Suite untuk Headless REST API Gateway GoPay
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
const API_KEY = 'gopay_secret_api_key_123456';

const results = [];

function recordResult(testName, passed, details = '') {
    results.push({ testName, passed, details });
    const icon = passed ? '✅' : '❌';
    console.log(`${icon} [${passed ? 'PASS' : 'FAIL'}] ${testName} ${details ? '- ' + details : ''}`);
}

async function runAllTests() {
    console.log('======================================================');
    console.log('   🧪 MENJALANKAN PENGUJIAN HEADLESS API REST GATEWAY');
    console.log('======================================================\n');

    let createdQrisId = '';

    // 1. Test GET / (Root JSON API Info)
    try {
        const res = await axios.get(`${BASE_URL}/`);
        const isJson = typeof res.data === 'object' && res.data.service;
        recordResult('GET / (Headless JSON Info)', res.status === 200 && isJson, `Service: ${res.data.service}`);
    } catch (e) {
        recordResult('GET / (Headless JSON Info)', false, e.message);
    }

    // 2. Test GET /health
    try {
        const res = await axios.get(`${BASE_URL}/health`);
        recordResult('GET /health (Healthcheck)', res.status === 200 && res.data.has_session === true, `Merchant: ${res.data.merchant_name}`);
    } catch (e) {
        recordResult('GET /health (Healthcheck)', false, e.message);
    }

    // 3. Test GET /api/health
    try {
        const res = await axios.get(`${BASE_URL}/api/health`);
        recordResult('GET /api/health (API Status)', res.status === 200 && res.data.success === true, `Msg: ${res.data.message}`);
    } catch (e) {
        recordResult('GET /api/health (API Status)', false, e.message);
    }

    // 4. Test GET /token-status (Auth Protected)
    try {
        const res = await axios.get(`${BASE_URL}/token-status?api_key=${API_KEY}`);
        recordResult('GET /token-status (GoBiz Session Valid)', res.status === 200 && res.data.success === true && res.data.data.token_status === 'valid', `Status: ${res.data.data.token_status} (${res.data.data.merchant_name})`);
    } catch (e) {
        recordResult('GET /token-status (GoBiz Session Valid)', false, e.message);
    }

    // 5. Test Auth Protection Check (Tanpa API Key)
    try {
        await axios.get(`${BASE_URL}/token-status`);
        recordResult('Auth Protection Check (Tanpa API Key)', false, 'Harusnya 401 Unauthorized');
    } catch (e) {
        recordResult('Auth Protection Check (Tanpa API Key)', e.response?.status === 401, 'Berhasil dicekal 401 Unauthorized');
    }

    // 6. Test GET /create-qris (Generate Dynamic QR Rp 25.000)
    try {
        const res = await axios.get(`${BASE_URL}/create-qris?amount=25000&api_key=${API_KEY}`);
        createdQrisId = res.data.data?.qris_id;
        const hasValidQR = res.data.data?.qris_code?.startsWith('000201010212');
        recordResult('GET /create-qris (Generate Dynamic QR Rp 25.000)', res.status === 200 && hasValidQR, `QRIS ID: ${createdQrisId}, Dynamic Tag: ${hasValidQR ? '010212 Valid' : 'Invalid'}`);
    } catch (e) {
        recordResult('GET /create-qris (Generate Dynamic QR Rp 25.000)', false, e.message);
    }

    // 7. Test POST /create-qris (Generate Dynamic QR Rp 50.000 via JSON)
    try {
        const res = await axios.post(`${BASE_URL}/create-qris`, {
            amount: 50000,
            order_id: 'INV-TEST-001'
        }, {
            headers: { 'X-Api-Key': API_KEY }
        });
        const hasValidQR = res.data.data?.qris_code?.startsWith('000201010212');
        recordResult('POST /create-qris (Generate Dynamic QR Rp 50.000 via JSON)', res.status === 200 && hasValidQR, `TRX ID: ${res.data.data?.trx_id}`);
    } catch (e) {
        recordResult('POST /create-qris (Generate Dynamic QR Rp 50.000 via JSON)', false, e.message);
    }

    // 8. Test GET /qr/:id (JSON Info)
    if (createdQrisId) {
        try {
            const res = await axios.get(`${BASE_URL}/qr/${createdQrisId}`);
            const isJson = typeof res.data === 'object' && res.data.data?.qris_code;
            recordResult(`GET /qr/${createdQrisId} (JSON Details)`, res.status === 200 && isJson, 'JSON Data Valid');
        } catch (e) {
            recordResult(`GET /qr/${createdQrisId} (JSON Details)`, false, e.message);
        }

        // 9. Test GET /qr/:id?format=raw (Stream PNG Image)
        try {
            const res = await axios.get(`${BASE_URL}/qr/${createdQrisId}?format=raw`, { responseType: 'arraybuffer' });
            const isPNG = res.headers['content-type'] === 'image/png';
            recordResult(`GET /qr/${createdQrisId}?format=raw (Stream PNG Image)`, res.status === 200 && isPNG, `Content-Type: ${res.headers['content-type']}, Size: ${res.data.length} bytes`);
        } catch (e) {
            recordResult(`GET /qr/${createdQrisId}?format=raw (Stream PNG Image)`, false, e.message);
        }

        // 10. Test GET /api/qr-status/:id (Public Status Check)
        try {
            const res = await axios.get(`${BASE_URL}/api/qr-status/${createdQrisId}`);
            recordResult(`GET /api/qr-status/${createdQrisId} (Public Status Check)`, res.status === 200 && res.data.success === true, `Status: ${res.data.status} (Remaining: ${res.data.remaining_seconds}s)`);
        } catch (e) {
            recordResult(`GET /api/qr-status/${createdQrisId} (Public Status Check)`, false, e.message);
        }
    }

    // 11. Test GET /check-payment (Cek Mutasi Masuk Rp 1.000)
    try {
        const res = await axios.get(`${BASE_URL}/check-payment?amount=1000&api_key=${API_KEY}`);
        recordResult('GET /check-payment (Cek Mutasi Masuk Rp 1.000)', res.status === 200 && res.data.paid === true, `Paid: ${res.data.paid}, Order: ${res.data.transaction?.order_id}`);
    } catch (e) {
        recordResult('GET /check-payment (Cek Mutasi Masuk Rp 1.000)', false, e.message);
    }

    // 12. Test POST /check-payment (Cek Mutasi Masuk Rp 12.000 via DANA)
    try {
        const res = await axios.post(`${BASE_URL}/check-payment`, {
            amount: 12000
        }, {
            headers: { 'X-Api-Key': API_KEY }
        });
        recordResult('POST /check-payment (Cek Mutasi Masuk Rp 12.000)', res.status === 200 && res.data.paid === true, `Paid: ${res.data.paid}, Issuer: ${res.data.transaction?.payer_issuer}`);
    } catch (e) {
        recordResult('POST /check-payment (Cek Mutasi Masuk Rp 12.000)', false, e.message);
    }

    // 13. Test GET /transactions (Riwayat Mutasi Real-Time dari GoBiz)
    try {
        const res = await axios.get(`${BASE_URL}/transactions?pageSize=5&api_key=${API_KEY}`);
        recordResult('GET /transactions (Ambil Mutasi GoBiz)', res.status === 200 && Array.isArray(res.data.data), `Ditemukan: ${res.data.count} Transaksi`);
    } catch (e) {
        recordResult('GET /transactions (Ambil Mutasi GoBiz)', false, e.message);
    }

    // 14. Test GET /api/logs (Log Aktivitas Gateway)
    try {
        const res = await axios.get(`${BASE_URL}/api/logs?api_key=${API_KEY}`);
        recordResult('GET /api/logs (Gateway Activity Logs)', res.status === 200 && Array.isArray(res.data.logs), `Total Logs: ${res.data.count}`);
    } catch (e) {
        recordResult('GET /api/logs (Gateway Activity Logs)', false, e.message);
    }

    console.log('\n======================================================');
    const passedCount = results.filter(r => r.passed).length;
    const totalCount = results.length;
    console.log(`📊 HASIL PENGUJIAN: ${passedCount} / ${totalCount} Endpoint Berhasil (${Math.round(passedCount/totalCount*100)}%)`);
    console.log('======================================================\n');
}

runAllTests().catch(console.error);

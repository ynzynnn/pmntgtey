/**
 * login.js
 * CLI Terminal Interaktif untuk Login OTP Akun GoBiz / GoPay Merchant
 */

const readline = require('readline');
const sessionManager = require('./sessionManager');

function createInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

function promptQuestion(rl, query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function runLogin() {
    console.log('\n======================================================');
    console.log('   🚀 GoPay / GoBiz Merchant Gateway - Login OTP');
    console.log('======================================================\n');

    const existingSession = sessionManager.loadSession();
    if (existingSession && existingSession.access_token) {
        console.log('ℹ️ Sesi aktif ditemukan:');
        console.log(`   - Nomor HP        : ${existingSession.phone_number}`);
        console.log(`   - Nama Merchant   : ${existingSession.merchant_name || 'Toko GoPay'}`);
        console.log(`   - Kedaluwarsa     : ${new Date(existingSession.expires_at).toLocaleString()}`);
        console.log('------------------------------------------------------\n');
    }

    const rl = createInterface();

    try {
        const phoneInput = await promptQuestion(
            rl,
            '📱 Masukkan Nomor HP GoBiz (contoh: 083847274233 atau 0851...): '
        );

        if (!phoneInput || phoneInput.trim().length < 8) {
            console.log('❌ Nomor HP tidak valid!');
            rl.close();
            process.exit(1);
        }

        console.log('\n⏳ Mengirim permintaan kode OTP ke server GoBiz...');
        const otpReq = await sessionManager.requestOTP(phoneInput.trim());

        console.log(`\n✅ ${otpReq.message}`);
        console.log(`⏱️ Kode OTP berlaku selama ${otpReq.expires_in || 720} detik.\n`);

        const otpCode = await promptQuestion(
            rl,
            '🔑 Masukkan Kode OTP (4 digit): '
        );

        if (!otpCode || otpCode.trim().length === 0) {
            console.log('❌ Kode OTP tidak boleh kosong!');
            rl.close();
            process.exit(1);
        }

        console.log('\n⏳ Memverifikasi OTP dan membuat sesi permanen...');
        const session = await sessionManager.verifyOTP(
            phoneInput.trim(),
            otpCode.trim(),
            otpReq.otp_token,
            otpReq.unique_id
        );

        console.log('\n======================================================');
        console.log('🎉 LOGIN BERHASIL & SESI DISIMPAN!');
        console.log('======================================================');
        console.log(`   - Toko / Merchant : ${session.merchant_name || 'GoPay Merchant'}`);
        console.log(`   - Merchant ID     : ${session.merchant_id || '(Otomatis)'}`);
        console.log(`   - Nomor HP        : ${session.phone_number}`);
        console.log(`   - File Sesi       : ${sessionManager.SESSION_FILE}`);
        console.log('======================================================');
        console.log('💡 Langkah Selanjutnya:');
        console.log('   Jalankan gateway dengan perintah: npm start');
        console.log('======================================================\n');

        rl.close();
    } catch (err) {
        console.error('\n❌ Terjadi Kesalahan:', err.message);
        console.log('Silakan coba kembali dengan menjalankan: node login.js\n');
        rl.close();
        process.exit(1);
    }
}

if (require.main === module) {
    runLogin();
}

module.exports = runLogin;

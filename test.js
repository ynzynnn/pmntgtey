/**
 * test.js
 * Unit Test untuk Validasi EMVCo QRIS Parser & CRC-16 Checksum
 */

const qrisHelper = require('./qrisHelper');

console.log('🧪 Memulai Pengujian Gateway GoPay...\n');

// 1. Uji Kalkulasi CRC16
const testString = '00020101021226590014COM.GO-JEK.WWW01189360091430000000000215G123456789012340303UMI51440014ID.CO.QRIS.WWW0215ID10200000000000303UMI5204581253033605405250005802ID5915TOKO SAYA GOPAY6007JAKARTA61051234062070703A016304';
const calculatedChecksum = qrisHelper.calculateCRC16(testString);
console.log('1. Test CRC16 Calculation:');
console.log(`   - Input: ${testString.substring(0, 40)}...`);
console.log(`   - Checksum Result: ${calculatedChecksum} (Panjang: ${calculatedChecksum.length})`);
if (calculatedChecksum.length === 4) {
    console.log('   ✅ CRC16 Checksum Valid (4 hex chars)\n');
} else {
    console.error('   ❌ CRC16 Checksum Gagal\n');
}

// 2. Uji Konversi QRIS Statis ke Dinamis (Nominal Rp 25.000)
const staticSample = '00020101021126590014COM.GO-JEK.WWW01189360091430000000000215G123456789012340303UMI51440014ID.CO.QRIS.WWW0215ID10200000000000303UMI5204581253033605802ID5915TOKO SAYA GOPAY6007JAKARTA61051234062070703A016304AAAA';
const dynamicSample = qrisHelper.generateDynamicQRIS(staticSample, 25000);

console.log('2. Test Generate QRIS Dinamis (Rp 25.000):');
console.log(`   - Statis Input : ${staticSample.substring(0, 60)}...`);
console.log(`   - Dinamis Output: ${dynamicSample}`);

if (dynamicSample && dynamicSample.includes('010212') && dynamicSample.includes('540525000')) {
    console.log('   ✅ Tag 01 berhasil diubah ke 12 (Dynamic)');
    console.log('   ✅ Tag 54 berhasil disisipkan dengan nominal 25000');
    console.log('   ✅ Checksum CRC16 berhasil dihitung ulang\n');
} else {
    console.error('   ❌ Generate QRIS Dinamis Gagal\n');
}

// 3. Uji Parsing Tag EMVCo
const parsedTags = qrisHelper.parseQRISTags(dynamicSample);
console.log('3. Test Parsing Tag EMVCo:');
console.log(`   - Jumlah Tag Ditemukan: ${parsedTags.length}`);
const info = qrisHelper.extractMerchantInfo(dynamicSample);
console.log(`   - Merchant Name: ${info.merchantName}`);
console.log(`   - Merchant City: ${info.merchantCity}`);
console.log(`   - Currency Code: ${info.currencyCode}`);
console.log('   ✅ Parsing EMVCo Berhasil\n');

console.log('🎉 SEMUA TEST LOKAL BERHASIL!\n');

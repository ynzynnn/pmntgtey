/**
 * qrisHelper.js
 * EMVCo QRIS TLV Parser & CRC-16/CCITT Generator
 * 
 * Standar QRIS Bank Indonesia berbasis EMVCo MPM (Merchant Presented Mode)
 */

/**
 * Menghitung Checksum CRC16 CCITT-FALSE (Polynomial 0x1021, Initial 0xFFFF)
 * @param {string} payload - String QRIS tanpa tag checksum atau dengan prefix "6304"
 * @returns {string} 4-karakter Hexadecimal Uppercase (contoh: "A1B2")
 */
function calculateCRC16(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= (payload.charCodeAt(i) << 8);
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Mengurai string QRIS menjadi array objek TLV (Tag-Length-Value)
 * @param {string} qrisString 
 * @returns {Array<{tag: string, length: number, val: string}>}
 */
function parseQRISTags(qrisString) {
    if (!qrisString || typeof qrisString !== 'string') return [];
    let payload = qrisString.trim();

    // Hapus Tag 63 (CRC) lama jika ada di akhir
    const idx63 = payload.indexOf('6304');
    if (idx63 !== -1) {
        payload = payload.substring(0, idx63);
    }

    const tags = [];
    let i = 0;
    while (i < payload.length) {
        if (i + 4 > payload.length) break;
        const tag = payload.substring(i, i + 2);
        const lenStr = payload.substring(i + 2, i + 4);
        const length = parseInt(lenStr, 10);
        if (isNaN(length) || length < 0 || i + 4 + length > payload.length) {
            break;
        }
        const val = payload.substring(i + 4, i + 4 + length);
        tags.push({ tag, length, val });
        i += 4 + length;
    }
    return tags;
}

/**
 * Menghasilkan string QRIS Dinamis dari QRIS Statis dengan nominal tertentu
 * @param {string} staticQRIS - String QRIS Statis Merchant (EMVCo)
 * @param {number|string} amount - Nominal transaksi (Rupiah bulat, contoh: 25000)
 * @returns {string|null} String QRIS Dinamis siap scan
 */
function generateDynamicQRIS(staticQRIS, amount) {
    if (!staticQRIS) return null;
    
    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return null;
    }
    const amountStr = parsedAmount.toString();

    const tags = parseQRISTags(staticQRIS);
    if (tags.length === 0) return null;

    const newTags = [];
    let hasTag54 = false;

    for (const item of tags) {
        if (item.tag === '01') {
            // Ubah Point of Initiation Method: Static (11) -> Dynamic (12)
            newTags.push({ tag: '01', val: '12' });
        } else if (item.tag === '54') {
            // Ganti nominal jika Tag 54 sudah ada
            newTags.push({ tag: '54', val: amountStr });
            hasTag54 = true;
        } else if (item.tag === '58' && !hasTag54) {
            // Sisipkan Tag 54 sebelum Tag 58 (Country Code) jika belum ada
            newTags.push({ tag: '54', val: amountStr });
            hasTag54 = true;
            newTags.push(item);
        } else {
            newTags.push(item);
        }
    }

    if (!hasTag54) {
        newTags.push({ tag: '54', val: amountStr });
    }

    // Bangun string TLV kembali
    let result = '';
    for (const item of newTags) {
        const lenStr = item.val.length.toString().padStart(2, '0');
        result += `${item.tag}${lenStr}${item.val}`;
    }

    // Tambahkan Tag 63 untuk Checksum CRC16
    result += '6304';
    const checksum = calculateCRC16(result);
    return result + checksum;
}

/**
 * Ekstrak informasi merchant dari string QRIS (Nama Merchant, Kota, dsb)
 * @param {string} qrisString 
 * @returns {object}
 */
function extractMerchantInfo(qrisString) {
    const tags = parseQRISTags(qrisString);
    const info = {
        pointOfInitiation: '11', // 11=Static, 12=Dynamic
        merchantName: '',
        merchantCity: '',
        postalCode: '',
        currencyCode: '360',
        countryCode: 'ID'
    };

    for (const item of tags) {
        if (item.tag === '01') info.pointOfInitiation = item.val;
        if (item.tag === '53') info.currencyCode = item.val;
        if (item.tag === '58') info.countryCode = item.val;
        if (item.tag === '59') info.merchantName = item.val;
        if (item.tag === '60') info.merchantCity = item.val;
        if (item.tag === '61') info.postalCode = item.val;
    }

    return info;
}

module.exports = {
    calculateCRC16,
    parseQRISTags,
    generateDynamicQRIS,
    extractMerchantInfo
};

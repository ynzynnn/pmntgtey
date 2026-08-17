<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pembayaran QRIS Invoice #{{ $invoice->id }} - Rp {{ number_format($total, 0, ',', '.') }}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
            background-color: #0b0f19;
            color: #f1f5f9;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 16px;
        }
        .container {
            width: 100%;
            max-width: 440px;
            background: #151d2f;
            border: 1px solid #23314d;
            border-radius: 24px;
            padding: 26px;
            box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7);
            text-align: center;
            position: relative;
        }
        .header-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(0, 170, 19, 0.12);
            color: #00e024;
            font-size: 12px;
            font-weight: 700;
            padding: 6px 14px;
            border-radius: 100px;
            margin-bottom: 16px;
            border: 1px solid rgba(0, 224, 36, 0.25);
        }
        .invoice-title {
            font-size: 14px;
            color: #94a3b8;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .amount-display {
            font-size: 32px;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -0.5px;
            margin-bottom: 16px;
        }
        .timer-box {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: #1c273e;
            border: 1px solid #2d3e63;
            border-radius: 12px;
            padding: 10px;
            font-size: 13px;
            color: #cbd5e1;
            margin-bottom: 18px;
        }
        .timer-value {
            font-weight: 700;
            color: #f59e0b;
        }
        .qr-wrapper {
            background: #ffffff;
            border-radius: 18px;
            padding: 14px;
            display: inline-block;
            margin-bottom: 16px;
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
        }
        .qr-image {
            display: block;
            width: 250px;
            height: 250px;
            max-width: 100%;
        }
        .supported-apps {
            font-size: 11.5px;
            color: #64748b;
            margin-bottom: 20px;
            line-height: 1.4;
        }
        .btn-check {
            width: 100%;
            background: #00aa13;
            color: #ffffff;
            border: none;
            border-radius: 14px;
            padding: 14px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 14px rgba(0, 170, 19, 0.4);
            text-decoration: none;
        }
        .btn-check:hover {
            background: #00c416;
            transform: translateY(-1px);
        }
        .btn-cancel {
            display: block;
            margin-top: 14px;
            font-size: 12.5px;
            color: #94a3b8;
            text-decoration: none;
            font-weight: 600;
        }
        .btn-cancel:hover { color: #fff; }
        .toast-msg {
            margin-top: 12px;
            font-size: 12px;
            color: #f59e0b;
            min-height: 18px;
        }
        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: #ffffff;
            animation: spin 0.8s ease-in-out infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-badge">
            <span>●</span> QRIS GO-PAY / SEMUA E-WALLET
        </div>
        <div class="invoice-title">Invoice #{{ $invoice->id }}</div>
        <div class="amount-display">Rp {{ number_format($total, 0, ',', '.') }}</div>

        <div class="timer-box">
            <span>⏳ Batas Waktu Bayar:</span>
            <span class="timer-value" id="countdown">05:00</span>
        </div>

        <div class="qr-wrapper">
            @if($qr_image_base64)
                <img src="{{ $qr_image_base64 }}" alt="QRIS Code" class="qr-image" />
            @else
                <img src="{{ $qr_image_url }}" alt="QRIS Code" class="qr-image" />
            @endif
        </div>

        <div class="supported-apps">
            Bisa di-scan dari <strong>GoPay, BCA Mobile, DANA, OVO, ShopeePay, Mandiri Livin, BRImo, LinkAja</strong>, dan seluruh aplikasi perbankan berstandar QRIS.
        </div>

        <button id="btnCheckManual" class="btn-check" onclick="checkStatusManual()">
            <span>🔄 Cek Status Pembayaran</span>
        </button>

        <div id="toastMessage" class="toast-msg"></div>

        <a href="{{ $return_url }}" class="btn-cancel">← Kembali ke Detail Invoice</a>
    </div>

    <script>
        const qrisId = "{{ $qris_id }}";
        const apiUrl = "{{ $api_url }}";
        const returnUrl = "{{ $return_url }}";
        let remainingSeconds = 300;
        let pollInterval = null;

        function updateTimer() {
            if (remainingSeconds <= 0) {
                document.getElementById('countdown').textContent = 'Kedaluwarsa';
                document.getElementById('countdown').style.color = '#ef4444';
                document.getElementById('btnCheckManual').disabled = true;
                if (pollInterval) clearInterval(pollInterval);
                return;
            }
            const mins = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
            const secs = (remainingSeconds % 60).toString().padStart(2, '0');
            document.getElementById('countdown').textContent = mins + ':' + secs;
            remainingSeconds--;
        }
        setInterval(updateTimer, 1000);

        async function checkStatus(isManual = false) {
            const btn = document.getElementById('btnCheckManual');
            const toast = document.getElementById('toastMessage');

            if (isManual && btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> <span>Memeriksa Mutasi...</span>';
                if (toast) toast.textContent = 'Menghubungi server GoPay...';
            }

            try {
                const res = await fetch(apiUrl + '/api/qr-status/' + qrisId);
                const json = await res.json();

                if (json.success && json.paid) {
                    if (pollInterval) clearInterval(pollInterval);
                    if (toast) {
                        toast.style.color = '#00e024';
                        toast.textContent = '🎉 Pembayaran Berhasil! Mengalihkan ke invoice...';
                    }
                    setTimeout(() => {
                        window.location.href = returnUrl;
                    }, 1500);
                } else {
                    if (isManual && toast) {
                        toast.textContent = '⏳ Pembayaran belum terdeteksi. Silakan transfer terlebih dahulu.';
                        setTimeout(() => { if (toast) toast.textContent = ''; }, 4000);
                    }
                }
            } catch (e) {
                if (isManual && toast) toast.textContent = '⚠️ Gagal terhubung ke gateway.';
            } finally {
                if (isManual && btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>🔄 Cek Status Pembayaran</span>';
                }
            }
        }

        function checkStatusManual() {
            checkStatus(true);
        }

        // Auto poll setiap 6 detik
        pollInterval = setInterval(() => checkStatus(false), 6000);
    </script>
</body>
</html>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bayar Invoice #{{ $invoice->id }}</title>
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
        .back {
            display: block;
            margin-top: 12px;
            font-size: 13px;
            color: #888;
            text-decoration: none;
        }
        .back:hover { color: #222; }
        .msg {
            margin-top: 10px;
            font-size: 12px;
            color: #888;
            min-height: 16px;
        }
        .msg.ok { color: #16a34a; }
        .msg.err { color: #dc2626; }

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
        <div class="label">Invoice #{{ $invoice->id }}</div>
        <div class="amount">Rp {{ number_format($total, 0, ',', '.') }}</div>

        <div class="qr-box">
            @if($qr_image_base64)
                <img src="{{ $qr_image_base64 }}" alt="QRIS" />
            @else
                <img src="{{ $qr_image_url }}" alt="QRIS" />
            @endif
        </div>

        <div class="timer">Sisa waktu: <span id="countdown">05:00</span></div>

        <div class="info">
            Scan QR di atas menggunakan GoPay, DANA, OVO, ShopeePay, BCA Mobile, BRImo, Livin, LinkAja, atau aplikasi bank lainnya.
        </div>

        <button class="btn" id="btnCheck" onclick="manualCheck()">Cek Status Pembayaran</button>
        <div class="msg" id="msg"></div>

        <a href="{{ $return_url }}" class="back">Kembali</a>
    </div>

    <div class="paid-overlay" id="paidOverlay">
        <div class="paid-box">
            <div class="check">
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p>Pembayaran Berhasil</p>
            <p class="sub">Mengalihkan...</p>
        </div>
    </div>

    <script>
        const qrisId = "{{ $qris_id }}";
        const apiUrl = "{{ $api_url }}";
        const returnUrl = "{{ $return_url }}";
        let remaining = 300;
        let poll = null;

        function tick() {
            if (remaining <= 0) {
                document.getElementById('countdown').textContent = 'Habis';
                document.getElementById('btnCheck').disabled = true;
                if (poll) clearInterval(poll);
                return;
            }
            const m = String(Math.floor(remaining / 60)).padStart(2, '0');
            const s = String(remaining % 60).padStart(2, '0');
            document.getElementById('countdown').textContent = m + ':' + s;
            remaining--;
        }
        setInterval(tick, 1000);

        async function checkStatus(manual) {
            const btn = document.getElementById('btnCheck');
            const msg = document.getElementById('msg');

            if (manual) {
                btn.disabled = true;
                btn.textContent = 'Memeriksa...';
                msg.className = 'msg';
                msg.textContent = '';
            }

            try {
                const r = await fetch(apiUrl + '/api/qr-status/' + qrisId);
                const j = await r.json();

                if (j.success && j.paid) {
                    if (poll) clearInterval(poll);
                    document.getElementById('paidOverlay').classList.add('show');
                    setTimeout(() => { window.location.href = returnUrl; }, 1500);
                } else if (manual) {
                    msg.className = 'msg';
                    msg.textContent = 'Belum terdeteksi. Pastikan sudah transfer.';
                    setTimeout(() => { msg.textContent = ''; }, 4000);
                }
            } catch (e) {
                if (manual) {
                    msg.className = 'msg err';
                    msg.textContent = 'Gagal menghubungi server.';
                }
            } finally {
                if (manual) {
                    btn.disabled = false;
                    btn.textContent = 'Cek Status Pembayaran';
                }
            }
        }

        function manualCheck() { checkStatus(true); }

        poll = setInterval(() => checkStatus(false), 6000);
    </script>
</body>
</html>

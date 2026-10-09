<?php

namespace Paymenter\Extensions\Gateways\GoPay;

use App\Classes\Extension\Gateway;
use App\Helpers\ExtensionHelper;
use App\Models\Gateway as GatewayModel;
use App\Models\Invoice;
use Exception;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class GoPay extends Gateway
{
    public function boot()
    {
        require __DIR__ . '/routes.php';
    }

    /**
     * Clean and sanitize the Gateway API Base URL (auto-fixes missing colons, duplicate schemas, etc.)
     */
    public function getCleanApiUrl(): string
    {
        $url = trim($this->getSetting('api_url', 'https://gateway.septacloud.net'));

        // Fix typos like https// or http// (missing colon)
        $url = preg_replace('#^https?//#i', 'https://', $url);
        if (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . ltrim($url, '/');
        }

        // Clean any duplicate protocols
        $url = preg_replace('#^(https?://)+#i', '$1', $url);

        return rtrim($url, '/');
    }

    /**
     * Reliably retrieve configuration settings for this Gateway (supports Collection, Array, or DB query)
     */
    public function getSetting($key, $default = null)
    {
        // 1. Check if $this->config is a Collection of models
        if (!empty($this->config) && (is_iterable($this->config) || $this->config instanceof \Illuminate\Support\Collection)) {
            foreach ($this->config as $setting) {
                if (is_object($setting) && isset($setting->key) && $setting->key === $key) {
                    return $setting->value ?? $default;
                }
                if (is_array($setting) && isset($setting['key']) && $setting['key'] === $key) {
                    return $setting['value'] ?? $default;
                }
                if (is_array($this->config) && isset($this->config[$key])) {
                    return $this->config[$key];
                }
            }
        }

        // 2. Query Gateway model directly from Database
        try {
            $gateway = GatewayModel::where('extension', 'GoPay')->first();
            if ($gateway && $gateway->settings) {
                foreach ($gateway->settings as $setting) {
                    if ($setting->key === $key) {
                        return $setting->value ?? $default;
                    }
                }
            }
        } catch (Exception $e) {
            // DB fallback failed
        }

        return $default;
    }

    public function getConfig($values = []): array
    {
        return [
            [
                'name' => 'api_url',
                'label' => 'GoPay Gateway API URL (ahmadzakiyox/gopay-api-gateaway)',
                'type' => 'text',
                'default' => 'https://gateway.septacloud.net',
                'placeholder' => 'https://gateway.septacloud.net atau http://IP_VPS:3000',
                'description' => 'URL instalasi server GoPay API Gateway Anda (Node.js Express). Contoh: https://gateway.septacloud.net',
                'required' => true,
            ],
            [
                'name' => 'api_key',
                'label' => 'API Secret Key (X-Api-Key)',
                'type' => 'password',
                'placeholder' => 'gopay_secret_api_key_xxxxxxxx',
                'encrypted' => true,
                'description' => 'API Key yang terdaftar pada file .env server GoPay Gateway.',
                'required' => true,
            ],
            [
                'name' => 'expiry_minutes',
                'label' => 'Batas Waktu QRIS Dinamis (Menit)',
                'type' => 'number',
                'default' => 5,
                'description' => 'Masa berlaku QRIS dinamis sebelum kedaluwarsa (standar: 5 menit).',
                'required' => true,
            ],
        ];
    }

    /**
     * Start payment and get gateway qris_url directly
     */
    public function pay(Invoice $invoice, $total)
    {
        $qrisUrl = $this->createQrisSession($invoice, $total);
        if (!empty($qrisUrl)) {
            return $qrisUrl;
        }

        return route('extensions.gateways.gopay.pay', $invoice);
    }

    /**
     * Helper to create Dynamic QRIS Session and retrieve gateway's hosted qris_url
     */
    public function createQrisSession(Invoice $invoice, $total = null)
    {
        $nominal = (int) round($total ?: $invoice->remaining);
        $apiUrl = $this->getCleanApiUrl();
        $apiKey = trim($this->getSetting('api_key', ''));
        $webhookUrl = route('extensions.gateways.gopay.webhook');
        $redirectUrl = route('invoices.show', $invoice);

        if (empty($apiUrl) || empty($apiKey)) {
            Log::warning("GoPay Gateway: API URL [{$apiUrl}] atau API Key kosong di setting.");
            return null;
        }

        try {
            // Send request with both Header & Query Param for 100% gateway compatibility
            $response = Http::withHeaders([
                'X-Api-Key' => $apiKey,
                'Accept' => 'application/json',
                'Content-Type' => 'application/json',
            ])->timeout(12)->post("{$apiUrl}/create-qris?api_key={$apiKey}&amount={$nominal}", [
                'amount' => $nominal,
                'order_id' => 'INV-' . $invoice->id,
                'webhook_url' => $webhookUrl,
                'callback_url' => $webhookUrl,
                'redirect_url' => $redirectUrl,
                'return_url' => $redirectUrl,
            ]);

            if ($response->successful()) {
                $json = $response->json();
                $data = $json['data'] ?? [];

                $qrisUrl = $data['qris_url'] ?? null;
                $qrisId = $data['qris_id'] ?? null;
                $trxId = $data['trx_id'] ?? null;
                $qrisCode = $data['qris_code'] ?? ($data['qr_string'] ?? ($data['qris_string'] ?? null));

                // If qris_url is relative (e.g. /qr/abc), prepend base API URL
                if (!empty($qrisUrl) && !str_starts_with($qrisUrl, 'http')) {
                    $qrisUrl = $apiUrl . (str_starts_with($qrisUrl, '/') ? '' : '/') . $qrisUrl;
                } elseif (empty($qrisUrl) && !empty($qrisId)) {
                    $qrisUrl = "{$apiUrl}/qr/{$qrisId}";
                }

                // Cache session for status checker & webhook verification
                $cacheKey = "gopay_invoice_{$invoice->id}";
                Cache::put($cacheKey, [
                    'nominal' => $nominal,
                    'trx_id' => $trxId,
                    'qris_id' => $qrisId,
                    'qris_url' => $qrisUrl,
                    'qris_code' => $qrisCode,
                    'created_at' => now()->timestamp,
                ], 3600);

                if (!empty($qrisUrl)) {
                    Log::info("GoPay Gateway: Sesi berhasil dibuat untuk Invoice #{$invoice->id}, QRIS URL: {$qrisUrl}");
                    return $qrisUrl;
                }
            } else {
                Log::warning("GoPay Gateway /create-qris Error [{$response->status()}]: " . $response->body());
            }
        } catch (Exception $e) {
            Log::error("GoPay Gateway Exception on createQrisSession: " . $e->getMessage());
        }

        return null;
    }

    /**
     * Dedicated redirect route: Automatically forwards to the gateway's hosted QRIS page
     */
    public function paymentPage(Invoice $invoice)
    {
        if ($invoice->status === 'paid') {
            return redirect()->route('invoices.show', $invoice);
        }

        $cacheKey = "gopay_invoice_{$invoice->id}";
        $cached = Cache::get($cacheKey);

        $qrisUrl = $cached['qris_url'] ?? null;
        if (empty($qrisUrl)) {
            $qrisUrl = $this->createQrisSession($invoice, $invoice->remaining);
        }

        // If qris_url from gateway is ready, immediately redirect away!
        if (!empty($qrisUrl)) {
            return redirect()->away($qrisUrl);
        }

        // Fallback only if gateway server is offline
        $nominal = (int) round($invoice->remaining);
        $qrCodeUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=350x350&margin=10&data=' . urlencode('GOPAY.SEPTACLOUD.' . $invoice->id . '.' . $nominal);
        $remainingSeconds = 300;
        $trxId = 'INV-' . $invoice->id;

        return view()->file(__DIR__ . '/views/payment.blade.php', compact(
            'invoice', 'nominal', 'qrCodeUrl', 'remainingSeconds', 'trxId'
        ));
    }

    /**
     * Check payment status via GoPay API Gateway (/check-payment & /api/qr-status/:qris_id)
     * Mendukung pemanggilan via AJAX maupun klik langsung di browser oleh pembeli
     */
    public function checkStatus(Invoice $invoice)
    {
        $isWeb = !request()->wantsJson() && !request()->ajax();

        if ($invoice->status === 'paid') {
            if ($isWeb) {
                return redirect()->route('invoices.show', $invoice)->with('success', 'Pembayaran terkonfirmasi! Invoice ini telah lunas.');
            }
            return response()->json([
                'status' => 'paid',
                'paid' => true,
                'redirect' => route('invoices.show', $invoice),
            ]);
        }

        // Security: Ownership verification
        if (\Illuminate\Support\Facades\Auth::check()) {
            $authUser = \Illuminate\Support\Facades\Auth::user();
            if ($authUser->id !== $invoice->user_id && !$authUser->is_admin) {
                if ($isWeb) {
                    return redirect()->route('invoices.show', $invoice)->with('error', 'Akses ditolak.');
                }
                return response()->json(['error' => 'Unauthorized access to invoice.'], 403);
            }
        }

        $cacheKey = "gopay_invoice_{$invoice->id}";
        $cached = Cache::get($cacheKey);

        $nominal = $cached['nominal'] ?? (int) round($invoice->remaining);
        $trxId = $cached['trx_id'] ?? ('INV-' . $invoice->id);
        $qrisId = $cached['qris_id'] ?? null;
        $apiUrl = $this->getCleanApiUrl();
        $apiKey = trim($this->getSetting('api_key', ''));

        if (!empty($apiKey)) {
            try {
                $isPaid = false;
                $matchedTxId = null;

                // 1. Check via POST /check-payment (ahmadzakiyox standard)
                $response = Http::withHeaders([
                    'X-Api-Key' => $apiKey,
                    'Accept' => 'application/json',
                    'Content-Type' => 'application/json',
                ])->timeout(8)->post("{$apiUrl}/check-payment?api_key={$apiKey}", [
                    'amount' => $nominal,
                    'trx_id' => $trxId,
                    'qris_id' => $qrisId,
                    'order_id' => 'INV-' . $invoice->id,
                ]);

                if ($response->successful()) {
                    $json = $response->json();
                    // KRUSIAL: Wajib cek $json['paid'] === true, JANGAN cek $json['success'] karena success: true hanya status respon HTTP!
                    if (!empty($json['paid']) && $json['paid'] === true) {
                        $isPaid = true;
                        $matchedTxId = $json['data']['trx_id'] ?? ($json['trx_id'] ?? ($cached['trx_id'] ?? $trxId));
                    }
                }

                // 2. Fallback: Check /api/qr-status/:qris_id if qrisId available
                if (!$isPaid && !empty($qrisId)) {
                    $res2 = Http::withHeaders([
                        'X-Api-Key' => $apiKey,
                        'Accept' => 'application/json',
                    ])->timeout(6)->get("{$apiUrl}/api/qr-status/{$qrisId}?api_key={$apiKey}");

                    if ($res2->successful()) {
                        $json2 = $res2->json();
                        // KRUSIAL: Wajib cek paid === true dan status === PAID (jangan terima jika PENDING atau EXPIRED)
                        if (!empty($json2['paid']) && $json2['paid'] === true && (($json2['status'] ?? '') === 'PAID' || ($json2['data']['status'] ?? '') === 'PAID')) {
                            $isPaid = true;
                            $matchedTxId = $json2['data']['trx_id'] ?? ($json2['trx_id'] ?? ($cached['trx_id'] ?? $trxId));
                        }
                    }
                }

                // Format ID transaksi selalu berawalan TRX- (contoh: TRX-DC4826NY)
                if ($isPaid) {
                    if (empty($matchedTxId) || !str_starts_with($matchedTxId, 'TRX-')) {
                        $matchedTxId = $cached['trx_id'] ?? ('TRX-' . strtoupper(substr(md5($invoice->id . time()), 0, 8)));
                    }
                }

                // Security: Anti-Replay Check
                if ($isPaid && !empty($matchedTxId)) {
                    $alreadyClaimed = \App\Models\InvoiceTransaction::where('transaction_id', (string) $matchedTxId)->exists();
                    if ($alreadyClaimed) {
                        Log::warning("GoPay Gateway: Transaction ID {$matchedTxId} already claimed by another invoice.");
                        $isPaid = false;
                    }
                }

                // 3. Mark Invoice as PAID in Paymenter upon confirmation
                if ($isPaid) {
                    ExtensionHelper::addPayment($invoice->id, 'GoPay', $nominal, transactionId: $matchedTxId);
                    Cache::forget($cacheKey);

                    if ($isWeb) {
                        return redirect()->route('invoices.show', $invoice)->with('success', 'Pembayaran berhasil diverifikasi! Invoice telah lunas.');
                    }

                    return response()->json([
                        'status' => 'paid',
                        'paid' => true,
                        'redirect' => route('invoices.show', $invoice),
                    ]);
                }
            } catch (Exception $e) {
                Log::warning("GoPay Gateway checkStatus Error: " . $e->getMessage());
            }
        }

        if ($isWeb) {
            return redirect()->route('invoices.show', $invoice)->with('info', 'Pembayaran belum terdeteksi di mutasi GoPay. Jika baru saja transfer, mohon tunggu 15-30 detik lalu klik Cek Pembayaran lagi.');
        }

        return response()->json([
            'status' => 'pending',
            'paid' => false,
            'nominal' => $nominal,
        ]);
    }

    /**
     * Webhook Callback handler for instant settlement
     */
    public function webhook(Request $request): JsonResponse
    {
        $payload = $request->all();
        $rawPayload = $request->getContent();
        $apiKey = trim($this->getSetting('api_key', ''));
        $signature = $request->header('X-Callback-Signature');

        Log::info('GoPay Gateway Webhook received: ' . json_encode($payload));

        // Security 1: Wajib Verifikasi HMAC-SHA256 Signature dari Server Gateway
        if (!empty($apiKey)) {
            if (empty($signature)) {
                Log::warning('GoPay Gateway Webhook Rejected: Missing X-Callback-Signature header.');
                return response()->json(['error' => 'Unauthorized: Missing callback signature'], 401);
            }

            $expectedSignature = hash_hmac('sha256', $rawPayload, $apiKey);
            if (!hash_equals($expectedSignature, $signature)) {
                Log::warning('GoPay Gateway Webhook Rejected: Invalid signature.');
                return response()->json(['error' => 'Unauthorized: Invalid signature'], 401);
            }
        }

        $orderId = $request->input('order_id') ?? ($request->input('data.order_id') ?? '');
        $status = strtoupper($request->input('status') ?? ($request->input('data.status') ?? ''));
        $amount = (int) preg_replace('/[^0-9]/', '', (string) ($request->input('amount') ?? ($request->input('data.amount') ?? 0)));
        
        // Prioritaskan trx_id berformat TRX-XXXXXX (contoh: TRX-DC4826NY)
        $txId = $request->input('trx_id') ?? ($request->input('data.trx_id') ?? null);

        $invoiceId = null;
        if (preg_match('/INV-(\d+)/i', $orderId, $matches)) {
            $invoiceId = $matches[1];
        } elseif ($request->has('invoice_id')) {
            $invoiceId = $request->input('invoice_id');
        }

        if ($invoiceId && ($status === 'PAID' || $status === 'SETTLED' || $request->input('event') === 'payment.settled')) {
            $invoice = Invoice::find($invoiceId);
            if ($invoice && $invoice->status !== 'paid') {
                if (empty($txId)) {
                    $cached = Cache::get("gopay_invoice_{$invoice->id}");
                    $txId = $cached['trx_id'] ?? null;
                }

                // Format wajib berawalan TRX- (contoh: TRX-DC4826NY)
                if (empty($txId) || !str_starts_with($txId, 'TRX-')) {
                    $txId = 'TRX-' . strtoupper(substr(md5($invoice->id . time()), 0, 8));
                }

                // Security 2: Anti-Replay Check
                $alreadyClaimed = \App\Models\InvoiceTransaction::where('transaction_id', (string) $txId)->exists();
                if ($alreadyClaimed) {
                    Log::warning("GoPay Gateway Webhook: Transaction ID {$txId} already claimed by another invoice.");
                    return response()->json(['success' => true, 'message' => 'Transaction already recorded']);
                }

                ExtensionHelper::addPayment($invoice->id, 'GoPay', $amount ?: $invoice->remaining, transactionId: $txId);
                Cache::forget("gopay_invoice_{$invoice->id}");
                return response()->json(['success' => true, 'message' => 'Invoice marked as paid']);
            }
        }

        return response()->json(['success' => true, 'message' => 'Acknowledged']);
    }
}

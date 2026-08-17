<?php

namespace App\Extensions\Gateways\GoPay;

use App\Classes\Extension\Gateway;
use App\Helpers\ExtensionHelper;
use App\Models\Invoice;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class GoPay extends Gateway
{
    /**
     * Metadata Informasi Ekstensi Gateway
     */
    public function getMetadata()
    {
        return [
            'display_name' => 'GoPay / QRIS Realtime Gateway',
            'version' => '1.0.0',
            'author' => 'Antigravity / GoPay Gateway',
            'website' => 'https://github.com',
        ];
    }

    /**
     * Form Konfigurasi di Admin Panel Paymenter
     */
    public function getConfig($values = [])
    {
        return [
            [
                'name' => 'api_url',
                'friendly_name' => 'API Gateway Base URL',
                'type' => 'text',
                'description' => 'URL server gateway GoPay Anda (contoh: https://gateway.domainanda.com atau http://localhost:3000)',
                'required' => true,
                'default' => 'http://localhost:3000'
            ],
            [
                'name' => 'api_key',
                'friendly_name' => 'API Secret Key',
                'type' => 'password',
                'description' => 'Kunci API rahasia yang tertera di file .env gateway Anda',
                'required' => true,
            ]
        ];
    }

    /**
     * Menangani Permintaan Pembayaran Invoice (Pay Hook)
     */
    public function pay($total, $invoice)
    {
        $apiUrl = rtrim(ExtensionHelper::getConfig('GoPay', 'api_url'), '/');
        $apiKey = ExtensionHelper::getConfig('GoPay', 'api_key');

        // Nominal invoice dalam Rupiah (dibulatkan tanpa desimal)
        $amount = (int) round($total);

        // URL Webhook Paymenter untuk menerima notifikasi otomatis
        $webhookUrl = route('extensions.gateways.gopay.webhook');

        try {
            $response = Http::withHeaders([
                'X-Api-Key' => $apiKey,
                'Content-Type' => 'application/json'
            ])->timeout(15)->post("{$apiUrl}/create-qris", [
                'amount' => $amount,
                'order_id' => "INV-{$invoice->id}",
                'trx_id' => "PAYMENTER-{$invoice->id}-" . time(),
                'webhook_url' => $webhookUrl
            ]);

            if ($response->successful()) {
                $data = $response->json()['data'] ?? [];
                
                // Render tampilan Blade checkout QRIS khusus di Paymenter
                return view('gateways::GoPay.pay', [
                    'invoice' => $invoice,
                    'total' => $amount,
                    'qris_id' => $data['qris_id'] ?? '',
                    'trx_id' => $data['trx_id'] ?? '',
                    'qr_image_base64' => $data['qr_image_base64'] ?? '',
                    'qr_image_url' => $data['qr_image_url'] ?? '',
                    'qris_code' => $data['qris_code'] ?? '',
                    'api_url' => $apiUrl,
                    'return_url' => route('invoices.show', $invoice->id)
                ]);
            }

            Log::error('GoPay Gateway Create QRIS Failed: ' . $response->body());
            return redirect()->route('invoices.show', $invoice->id)->with('error', 'Gagal membuat tagihan QRIS GoPay. Silakan hubungi admin.');
        } catch (\Exception $e) {
            Log::error('GoPay Gateway Error: ' . $e->getMessage());
            return redirect()->route('invoices.show', $invoice->id)->with('error', 'Koneksi ke gateway GoPay gagal: ' . $e->getMessage());
        }
    }

    /**
     * Menangani Callback Webhook dari Gateway Saat Pembeli Selesai Bayar
     */
    public function webhook(Request $request)
    {
        $apiKey = ExtensionHelper::getConfig('GoPay', 'api_key');
        $rawPayload = $request->getContent();
        $signature = $request->header('X-Callback-Signature');

        // 1. Verifikasi Signature HMAC-SHA256
        if ($apiKey && $signature) {
            $expectedSignature = hash_hmac('sha256', $rawPayload, $apiKey);
            if (!hash_equals($expectedSignature, $signature)) {
                Log::warning('GoPay Webhook: Invalid Signature');
                return response()->json(['error' => 'Invalid signature'], 401);
            }
        }

        $data = json_decode($rawPayload, true);
        if (!$data || ($data['status'] ?? '') !== 'PAID') {
            return response()->json(['status' => 'ignored'], 200);
        }

        // 2. Ambil Invoice ID dari format "INV-{id}" atau "PAYMENTER-{id}-..."
        $orderId = $data['order_id'] ?? '';
        $trxId = $data['trx_id'] ?? '';
        $invoiceId = null;

        if (preg_match('/INV-(\d+)/', $orderId, $matches)) {
            $invoiceId = (int) $matches[1];
        } elseif (preg_match('/PAYMENTER-(\d+)/', $trxId, $matches)) {
            $invoiceId = (int) $matches[1];
        }

        if (!$invoiceId) {
            Log::warning("GoPay Webhook: Invoice ID tidak ditemukan di order_id: {$orderId}");
            return response()->json(['error' => 'Invoice ID not found'], 400);
        }

        $invoice = Invoice::find($invoiceId);
        if (!$invoice) {
            Log::warning("GoPay Webhook: Invoice #{$invoiceId} tidak ditemukan di database Paymenter");
            return response()->json(['error' => 'Invoice not found in database'], 404);
        }

        if ($invoice->status === 'paid') {
            return response()->json(['status' => 'already_paid'], 200);
        }

        // 3. Tandai Invoice Lunas di Paymenter & Aktifkan Layanan Otomatis
        try {
            ExtensionHelper::paymentDone($invoice->id, 'GoPay', $data['transaction_id'] ?? $trxId);
            Log::info("GoPay Webhook: Invoice #{$invoiceId} berhasil dibayar lunas via GoPay / {$data['payer_issuer']}");
            return response()->json(['status' => 'success']);
        } catch (\Exception $e) {
            Log::error("GoPay Webhook PaymentDone Error: " . $e->getMessage());
            return response()->json(['error' => $e->getMessage()], 500);
        }
    }
}

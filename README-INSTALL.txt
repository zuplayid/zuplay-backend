ZU PLAY BACKEND - INSTALLATION

PENTING
- Jangan mengubah desain frontend.
- Secrets tetap di Cloudflare Variables & Secrets.
- Jangan memasukkan HAYBI_API_KEY atau DUITKU_API_KEY ke GitHub.
- Duitku boleh tetap belum aktif; integrasinya hanya payment-ready sampai credential aktif.

FILE
src/index.js       Cloudflare Worker backend
schema.sql         tabel D1 orders
wrangler.jsonc     contoh konfigurasi Wrangler

CLOUDFLARE SECRETS
HAYBI_API_KEY
HAYBI_USERNAME
ALLOWED_ORIGINS
DUITKU_MERCHANT_CODE
DUITKU_API_KEY
DUITKU_CALLBACK_URL
DUITKU_BASE_URL

FLOW
1. Customer membuat order.
2. Order disimpan UNPAID.
3. Backend membuat pembayaran Duitku.
4. Duitku callback sukses -> payment_status PAID.
5. Baru setelah PAID backend mengirim transaksi ke HAYBI.
6. HAYBI callback/status memperbarui topup_status.

DUITKU PRODUCTION BASE URL
https://passport.duitku.com

HAYBI BASE URL
https://haybi.id/api/h2h

Catatan:
- Callback HAYBI harus didaftarkan ke admin HAYBI.
- Callback Duitku harus berupa URL publik HTTPS.
- Sebelum live, lakukan testing callback, signature, idempotensi, dan transaksi.

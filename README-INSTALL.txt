ZuPlay Backend

File utama Worker: index.js
Konfigurasi Wrangler: wrangler.jsonc

Catatan:
- Secret HAYBI dan Duitku tetap disimpan di Cloudflare.
- Jangan memasukkan API key/secret ke GitHub.
- Build command Cloudflare: kosong / None.
- Deploy command: npx wrangler deploy.
- Callback HAYBI harus didaftarkan ke admin HAYBI.
- Callback Duitku harus berupa URL publik HTTPS.
- Sebelum live, lakukan testing callback, signature, idempotensi, dan transaksi.

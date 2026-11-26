const HAYBI_BASE_URL = "https://haybi.id/api/h2h";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGINS || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin",
  };
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("MD5", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function refId(prefix = "ZP") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function haybi(env, path, payload = {}) {
  const ref_id = payload.ref_id || refId("HAYBI");
  const sign = await md5Hex(`${env.HAYBI_USERNAME}${env.HAYBI_API_KEY}${ref_id}`);

  const body = {
    username: env.HAYBI_USERNAME,
    ref_id,
    ...payload,
    sign,
  };

  const res = await fetch(`${env.HAYBI_BASE_URL || HAYBI_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { httpStatus: res.status, data };
}

async function duitkuSignature(secret, value) {
  const bytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function createDuitkuPayment(env, order) {
  if (!env.DUITKU_MERCHANT_CODE || !env.DUITKU_API_KEY) {
    return { configured: false, message: "Duitku belum aktif/credential belum diisi." };
  }

  const base = env.DUITKU_BASE_URL || "https://passport.duitku.com";
  const endpoint = `${base}/webapi/api/merchant/v2/inquiry`;
  const signature = await duitkuSignature(
    env.DUITKU_API_KEY,
    `${env.DUITKU_MERCHANT_CODE}${order.order_id}${order.amount}`
  );

  const payload = {
    merchantCode: env.DUITKU_MERCHANT_CODE,
    paymentAmount: Number(order.amount),
    merchantOrderId: order.order_id,
    productDetails: order.product_name,
    email: order.email || "customer@zuplay.local",
    paymentMethod: order.payment_method,
    merchantUserInfo: order.customer_id || "",
    customerVaName: "ZuPlay Customer",
    phoneNumber: order.phone || "",
    returnUrl: env.DUITKU_RETURN_URL || env.DUITKU_CALLBACK_URL,
    callbackUrl: env.DUITKU_CALLBACK_URL,
    signature,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { configured: true, httpStatus: res.status, data };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return withCors(json({ ok: true, service: "zuplay-backend" }), env);
      }

      if (url.pathname === "/api/haybi/balance" && request.method === "GET") {
        const result = await haybi(env, "/cek-saldo");
        return withCors(json(result.data, result.httpStatus), env);
      }

      if (url.pathname === "/api/haybi/products" && request.method === "GET") {
        const category = url.searchParams.get("kategori");
        const operator = url.searchParams.get("operator");
        const result = await haybi(env, "/produk", {
          ...(category ? { kategori: category } : {}),
          ...(operator ? { operator } : {}),
        });
        return withCors(json(result.data, result.httpStatus), env);
      }

      if (url.pathname === "/api/haybi/status" && request.method === "GET") {
        const ref_id = url.searchParams.get("ref_id");
        if (!ref_id) return withCors(json({ error: "ref_id wajib diisi" }, 400), env);
        const result = await haybi(env, "/cek-status", { ref_id });
        return withCors(json(result.data, result.httpStatus), env);
      }

      if (url.pathname === "/api/payment/create" && request.method === "POST") {
        const order = await request.json();

        if (!order.order_id || !order.amount || !order.product_name || !order.payment_method) {
          return withCors(json({ error: "Data pembayaran belum lengkap." }, 400), env);
        }

        // Simpan order sebagai UNPAID sebelum meminta payment.
        if (env.DB) {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO orders
            (order_id, product_code, product_name, customer_id, amount, payment_method, payment_status, topup_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'UNPAID', 'WAITING_PAYMENT', datetime('now'))
          `).bind(
            order.order_id,
            order.product_code || null,
            order.product_name,
            order.customer_id || null,
            Number(order.amount),
            order.payment_method
          ).run();
        }

        const payment = await createDuitkuPayment(env, order);
        return withCors(json({ ok: true, payment }, 200), env);
      }

      if (url.pathname === "/api/payment/callback" && request.method === "POST") {
        const form = await request.formData();
        const merchantCode = form.get("merchantCode") || "";
        const amount = form.get("amount") || "";
        const merchantOrderId = form.get("merchantOrderId") || "";
        const resultCode = form.get("resultCode") || "";
        const reference = form.get("reference") || "";
        const signature = form.get("signature") || "";

        const expected = await duitkuSignature(
          env.DUITKU_API_KEY || "",
          `${merchantCode}${amount}${merchantOrderId}`
        );

        if (!signature || signature.toLowerCase() !== expected.toLowerCase()) {
          return new Response("Invalid signature", { status: 403 });
        }

        if (!env.DB) return new Response("OK", { status: 200 });

        const paid = resultCode === "00";
        await env.DB.prepare(`
          UPDATE orders
          SET payment_status = ?, duitku_reference = ?, updated_at = datetime('now')
          WHERE order_id = ?
        `).bind(paid ? "PAID" : "FAILED", reference, merchantOrderId).run();

        // HAYBI is triggered ONLY after confirmed payment.
        if (paid) {
          const order = await env.DB.prepare(`
            SELECT * FROM orders WHERE order_id = ?
          `).bind(merchantOrderId).first();

          if (order && order.product_code && order.customer_id) {
            const hb = await haybi(env, "/transaksi", {
              ref_id: merchantOrderId,
              produk: order.product_code,
              no_tujuan: order.customer_id,
            });

            await env.DB.prepare(`
              UPDATE orders
              SET topup_status = ?, haybi_response = ?, updated_at = datetime('now')
              WHERE order_id = ?
            `).bind(
              hb.data?.rc === "00" ? "SUCCESS" : "PENDING",
              JSON.stringify(hb.data),
              merchantOrderId
            ).run();
          }
        }

        return new Response("OK", { status: 200 });
      }

      if (url.pathname === "/api/haybi/callback" && request.method === "POST") {
        const payload = await request.json();
        const ref_id = payload.ref_id || "";
        const sign = payload.sign || "";
        const expected = await md5Hex(`${ref_id}${env.HAYBI_API_KEY || ""}`);

        if (!sign || sign.toLowerCase() !== expected.toLowerCase()) {
          return new Response("Invalid signature", { status: 403 });
        }

        if (env.DB && ref_id) {
          const status =
            payload.rc === "00" ? "SUCCESS" :
            payload.rc === "02" ? "FAILED" : "PENDING";

          await env.DB.prepare(`
            UPDATE orders
            SET topup_status = ?, haybi_response = ?, updated_at = datetime('now')
            WHERE order_id = ?
          `).bind(status, JSON.stringify(payload), ref_id).run();
        }

        return new Response("OK", { status: 200 });
      }

      return withCors(json({ error: "Not found" }, 404), env);
    } catch (error) {
      return withCors(json({
        error: "Internal server error",
        message: error?.message || "Unknown error"
      }, 500), env);
    }
  }
};

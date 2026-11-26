
const HAYBI_DEFAULT_URL = "https://haybi.id/api/h2h";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

async function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;

  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(
    paddedLength - 4,
    Math.floor(bitLength / 4294967296),
    true
  );

  const shifts = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
  ];

  const K = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const M = [];

    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0, b = b0, c = c0, d = d0;

    for (let i = 0; i < 64; i++) {
      let f, g;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (a + f + K[i] + M[g]) >>> 0;
      const rotated =
        (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
      const nextB = (b + rotated) >>> 0;

      a = d;
      d = c;
      c = b;
      b = nextB;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(n =>
    [0, 8, 16, 24].map(s =>
      ((n >>> s) & 255).toString(16).padStart(2, "0")
    ).join("")
  ).join("");
}

function makeRefId(prefix = "ZP") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [
    "https://zuplay-site.zuplay-id.workers.dev",
    ...(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
  ];

  const permitted = !origin || allowed.includes(origin);

  return {
    permitted,
    headers: {
      "Access-Control-Allow-Origin": origin && permitted
        ? origin
        : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }
  };
}

async function haybiRequest(env, path, extra = {}, refId = null) {
  const username = env.HAYBI_USERNAME;
  const apiKey = env.HAYBI_API_KEY;
  const baseUrl = (
    env.HAYBI_BASE_URL || HAYBI_DEFAULT_URL
  ).replace(/\/+$/, "");

  if (!username || !apiKey) {
    throw new Error("Konfigurasi HAYBI belum lengkap.");
  }

  const requestId = refId || makeRefId("ZP");
  const sign = await md5Hex(username + apiKey + requestId);

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      username,
      ref_id: requestId,
      ...extra,
      sign
    })
  });

  const text = await response.text();

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Respons HAYBI bukan JSON yang valid.");
  }

  if (!response.ok) {
    throw new Error(`HAYBI HTTP ${response.status}`);
  }

  return result;
}

// Sinkronisasi produk HAYBI ke D1.
// Produk lama tidak dihapus saat sinkronisasi.
async function syncHaybiProducts(env) {
  const result = await haybiRequest(env, "/produk");

  if (
    !result ||
    result.rc !== "00" ||
    !Array.isArray(result.data) ||
    result.data.length === 0
  ) {
    throw new Error(
      "Data produk HAYBI tidak valid atau kosong. Sinkronisasi dihentikan."
    );
  }

  const db = env.DB;
  if (!db) {
    throw new Error("Binding D1 DB belum tersedia.");
  }

  const providerId = "haybi";
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO providers
      (id, name, code, type, base_url, is_active)
    VALUES (?, 'HAYBI', 'HAYBI', 'h2h', ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      code = excluded.code,
      type = excluded.type,
      base_url = excluded.base_url,
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    providerId,
    env.HAYBI_BASE_URL || HAYBI_DEFAULT_URL
  ).run();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of result.data) {
    const code = String(item.kode_produk || "").trim();
    const name = String(item.nama_produk || "").trim();

    if (!code || !name) {
      skipped++;
      continue;
    }

    const rawPrice = item.harga_jual;
    const parsedPrice = Number(rawPrice);

    const costPrice =
      rawPrice !== null &&
      rawPrice !== undefined &&
      String(rawPrice).trim() !== "" &&
      Number.isFinite(parsedPrice)
        ? Math.round(parsedPrice)
        : null;

    const raw = JSON.stringify(item);

    const existing = await db.prepare(`
      SELECT id
      FROM provider_products
      WHERE provider_id = ?
        AND provider_product_code = ?
      LIMIT 1
    `).bind(providerId, code).first();

    if (existing) {
      await db.prepare(`
        UPDATE provider_products
        SET provider_product_name = ?,
            provider_cost_price = ?,
            raw_metadata = ?,
            is_active = 1,
            synced_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        name,
        costPrice,
        raw,
        now,
        existing.id
      ).run();

      updated++;
    } else {
      await db.prepare(`
        INSERT INTO provider_products (
          id,
          provider_id,
          provider_product_code,
          provider_product_name,
          provider_cost_price,
          raw_metadata,
          is_active,
          synced_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).bind(
        crypto.randomUUID(),
        providerId,
        code,
        name,
        costPrice,
        raw,
        now
      ).run();

      inserted++;
    }
  }

  return {
    total_dari_haybi: result.data.length,
    produk_baru: inserted,
    diperbarui: updated,
    dilewati: skipped
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (!cors.permitted) {
      return json({
        success: false,
        message: "Origin tidak diizinkan."
      }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors.headers
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/health") {
        return json({
          success: true,
          service: "ZU PLAY Backend",
          status: "online"
        }, 200, cors.headers);
      }

      // Endpoint sinkronisasi khusus admin.
      if (
        request.method === "POST" &&
        path === "/api/haybi/sync"
      ) {
        if (!env.HAYBI_SYNC_TOKEN) {
          return json({
            success: false,
            message: "HAYBI_SYNC_TOKEN belum dikonfigurasi."
          }, 503, cors.headers);
        }

        const token = request.headers.get("X-Admin-Token");

        if (token !== env.HAYBI_SYNC_TOKEN) {
          return json({
            success: false,
            message: "Akses ditolak."
          }, 401, cors.headers);
        }

        const summary = await syncHaybiProducts(env);

        return json({
          success: true,
          message: "Sinkronisasi katalog selesai.",
          data: summary
        }, 200, cors.headers);
      }

      if (request.method !== "GET") {
        return json({
          success: false,
          message: "Method tidak diizinkan."
        }, 405, cors.headers);
      }

      if (path === "/api/haybi/products") {
        const extra = {};

        const kategori = url.searchParams.get("kategori");
        const operator = url.searchParams.get("operator");

        if (kategori) extra.kategori = kategori;
        if (operator) extra.operator = operator;

        const result = await haybiRequest(
          env,
          "/produk",
          extra
        );

        return json({
          success: true,
          data: result
        }, 200, cors.headers);
      }

      if (path === "/api/haybi/balance") {
        if (!env.ADMIN_API_TOKEN) {
          return json({
            success: false,
            message: "ADMIN_API_TOKEN belum dikonfigurasi."
          }, 503, cors.headers);
        }

        const token = request.headers.get("X-Admin-Token");

        if (token !== env.ADMIN_API_TOKEN) {
          return json({
            success: false,
            message: "Akses ditolak."
          }, 401, cors.headers);
        }

        const result = await haybiRequest(
          env,
          "/cek-saldo"
        );

        return json({
          success: true,
          data: result
        }, 200, cors.headers);
      }

      if (path === "/api/haybi/status") {
        const refId = url.searchParams.get("ref_id");

        if (!refId || refId.length > 150) {
          return json({
            success: false,
            message: "ref_id wajib diisi."
          }, 400, cors.headers);
        }

        const result = await haybiRequest(
          env,
          "/cek-status",
          {},
          refId
        );

        return json({
          success: true,
          data: result
        }, 200, cors.headers);
      }

      return json({
        success: false,
        message: "Endpoint tidak ditemukan."
      }, 404, cors.headers);

    } catch (error) {
      return json({
        success: false,
        message: error.message ||
          "Terjadi kesalahan pada backend."
      }, 500, cors.headers);
    }
  }
};
                   

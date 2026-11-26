CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  product_code TEXT,
  product_name TEXT NOT NULL,
  customer_id TEXT,
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  topup_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  duitku_reference TEXT,
  haybi_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_topup_status ON orders(topup_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

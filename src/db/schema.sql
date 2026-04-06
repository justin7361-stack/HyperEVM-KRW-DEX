-- HyperKRW DEX — PostgreSQL Schema (O-1)
-- Run: psql $DATABASE_URL -f schema.sql
-- All financial values stored as TEXT (bigint precision preserved).

-- ─── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT        PRIMARY KEY,
  maker           TEXT        NOT NULL,
  taker           TEXT        NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  base_token      TEXT        NOT NULL,
  quote_token     TEXT        NOT NULL,
  price           TEXT        NOT NULL,   -- bigint as decimal string
  amount          TEXT        NOT NULL,
  is_buy          BOOLEAN     NOT NULL,
  nonce           TEXT        NOT NULL,
  expiry          TEXT        NOT NULL,
  signature       TEXT        NOT NULL,
  submitted_at    BIGINT      NOT NULL,
  filled_amount   TEXT        NOT NULL DEFAULT '0',
  status          TEXT        NOT NULL DEFAULT 'open',  -- open | filled | cancelled | expired
  maker_ip        TEXT,
  order_type      TEXT        NOT NULL DEFAULT 'limit',
  time_in_force   TEXT,
  reduce_only     BOOLEAN     NOT NULL DEFAULT FALSE,
  leverage        TEXT,
  margin_mode     TEXT,
  stp_mode        TEXT,
  pair_id         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_maker_idx    ON orders(maker);
CREATE INDEX IF NOT EXISTS orders_pair_id_idx  ON orders(pair_id);
CREATE INDEX IF NOT EXISTS orders_status_idx   ON orders(status);

-- ─── Trades ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              TEXT        PRIMARY KEY,
  pair_id         TEXT        NOT NULL,
  price           TEXT        NOT NULL,
  amount          TEXT        NOT NULL,
  is_buyer_maker  BOOLEAN     NOT NULL,
  traded_at       BIGINT      NOT NULL,
  maker_order_id  TEXT,
  taker_order_id  TEXT,
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_pair_id_idx ON trades(pair_id);
CREATE INDEX IF NOT EXISTS trades_traded_at_idx ON trades(traded_at DESC);

-- ─── Candles ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candles (
  pair_id     TEXT    NOT NULL,
  resolution  TEXT    NOT NULL,  -- '1m'|'5m'|'15m'|'1h'|'4h'|'1d'
  open_time   BIGINT  NOT NULL,
  open        TEXT    NOT NULL,
  high        TEXT    NOT NULL,
  low         TEXT    NOT NULL,
  close       TEXT    NOT NULL,
  volume      TEXT    NOT NULL DEFAULT '0',
  PRIMARY KEY (pair_id, resolution, open_time)
);

CREATE INDEX IF NOT EXISTS candles_lookup_idx ON candles(pair_id, resolution, open_time DESC);

-- ─── Positions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  maker       TEXT    NOT NULL,
  pair_id     TEXT    NOT NULL,
  size        TEXT    NOT NULL DEFAULT '0',
  margin      TEXT    NOT NULL DEFAULT '0',
  mode        TEXT    NOT NULL DEFAULT 'cross',
  updated_at  BIGINT  NOT NULL,
  PRIMARY KEY (maker, pair_id)
);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL   PRIMARY KEY,
  ts         BIGINT      NOT NULL,
  action     TEXT        NOT NULL,
  maker      TEXT        NOT NULL,
  order_id   TEXT,
  pair_id    TEXT,
  amount     TEXT,
  price      TEXT,
  ip         TEXT,
  reason     TEXT,
  tx_hash    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_maker_idx  ON audit_log(maker);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx     ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);

-- ─── Funding Payments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_payments (
  id          BIGSERIAL   PRIMARY KEY,
  maker       TEXT        NOT NULL,
  pair_id     TEXT        NOT NULL,
  amount      TEXT        NOT NULL,  -- signed bigint (positive=received, negative=paid)
  rate        NUMERIC     NOT NULL,  -- human-readable rate for display
  settled_at  BIGINT      NOT NULL,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS funding_maker_idx ON funding_payments(maker);
CREATE INDEX IF NOT EXISTS funding_pair_idx  ON funding_payments(pair_id);

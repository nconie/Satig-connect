// db.js
// Sets up a local SQLite database file and creates tables if they don't exist yet.
// SQLite is used here because it needs zero setup (no separate DB server to install)
// which makes it perfect for getting a real backend running fast. When Satig Connect
// grows and needs multiple servers, this can be swapped for Postgres/MySQL later
// without changing much outside this file, since all queries are isolated here.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'satig.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- USERS TABLE ---
// Shared by both clients and providers. `role` tells them apart.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('client', 'provider')),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    lat REAL,
    lng REAL,
    last_profile_edit_at TEXT,
    profile_edit_count INTEGER NOT NULL DEFAULT 0,
    start_code TEXT,
    completion_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- PROVIDER PROFILES ---
// Extra fields that only providers need. One-to-one with a users row where role='provider'.
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    primary_service TEXT NOT NULL,
    service_area TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    rating REAL NOT NULL DEFAULT 5.0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    jobs_completed INTEGER NOT NULL DEFAULT 0,
    lat REAL,
    lng REAL,
    profile_photo_url TEXT,
    id_verified INTEGER NOT NULL DEFAULT 0,
    id_document_name TEXT,
    date_of_birth TEXT
  );
`);

// --- ORDERS TABLE ---
// One row per service request a client makes, whichever provider ends up taking it.
// payment_status tracks online payments specifically: 'unpaid' until Stripe
// confirms the charge actually succeeded, then 'paid'. Cash orders stay
// 'unpaid' in this column since there's no online transaction to confirm -
// payment_method is what tells the two apart.
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    description TEXT,
    location TEXT NOT NULL,
    lat REAL,
    lng REAL,
    status TEXT NOT NULL DEFAULT 'requested'
      CHECK (status IN ('requested','matched','en_route','completed','cancelled')),
    total_cents INTEGER,
    payment_method TEXT CHECK (payment_method IN ('cash','online')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid'
      CHECK (payment_status IN ('unpaid','paid','refunded')),
    rating INTEGER,
    rating_comment TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- PAYMENTS TABLE ---
// One row per Stripe PaymentIntent created for an order. We keep this
// separate from orders so we have a full, permanent record of every payment
// attempt (including failed ones), not just the latest status.
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stripe_payment_intent_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','succeeded','failed','refunded')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;

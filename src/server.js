// server.js
// Entry point. Wires up middleware and routes, then starts listening.
// Uses a raw http server (instead of app.listen directly) so we can attach
// the WebSocket server for real-time provider notifications on the same port.

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const providerRoutes = require('./routes/providers');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const { initRealtime } = require('./realtime');

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in your .env file. Copy .env.example to .env and set one before starting.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// The Stripe webhook route needs the raw, unparsed request body to verify
// Stripe's signature, so it's mounted here BEFORE express.json() with its
// own raw-body parser. Every other route below uses normal JSON parsing.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);

// Catch-all for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Basic error handler so unexpected errors return JSON instead of crashing silently
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(PORT, () => {
  console.log(`Satig Connect backend running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint for providers: ws://localhost:${PORT}/ws?token=<jwt>`);
});

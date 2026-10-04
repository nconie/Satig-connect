// routes/payments.js
// Handles online payments for orders using Stripe. The flow is:
//   1. Client's app calls POST /api/payments/create-intent for an order.
//      We create a Stripe "PaymentIntent" and return its client_secret.
//   2. The client's app uses that client_secret with Stripe's own SDK on
//      their device to actually collect and charge the card - we (this
//      backend) never see or touch raw card numbers, which is both safer
//      and keeps us out of a lot of regulatory burden (PCI compliance).
//   3. Stripe calls our webhook (POST /api/payments/webhook) the moment the
//      payment truly succeeds or fails. That webhook is the only place we
//      actually mark an order as paid - never the client telling us "I paid",
//      since that could be faked. This is the standard, secure way to do it.

const express = require('express');
const Stripe = require('stripe');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyClientOfOrderUpdate } = require('../realtime');

const router = express.Router();
// Only construct the Stripe client if a key is actually configured - Stripe's
// SDK throws immediately on an empty key, which would crash the whole server
// at startup before anyone even tries to pay. Instead we construct it lazily
// (or leave it null) and return a clean error from the routes that need it.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function serializeOrder(o) {
  return {
    id: o.id,
    clientId: o.client_id,
    providerId: o.provider_id,
    category: o.category,
    description: o.description,
    location: o.location,
    status: o.status,
    totalCents: o.total_cents,
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    createdAt: o.created_at
  };
}

// --- CREATE PAYMENT INTENT (client only, for their own order) ---
router.post('/create-intent', requireAuth, async (req, res) => {
  // Validate the request and check ownership FIRST, before ever touching
  // Stripe - a bad or unauthorized request should fail fast with a precise
  // reason rather than a generic "payments not configured" error.
  if (req.user.role !== 'client') {
    return res.status(403).json({ error: 'Only clients can pay for an order.' });
  }

  const { orderId, amountCents } = req.body;
  if (!orderId || !amountCents || amountCents < 50) {
    return res.status(400).json({ error: 'orderId and amountCents (at least 50, i.e. $0.50) are required.' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your order.' });
  }
  if (order.payment_status === 'paid') {
    return res.status(409).json({ error: 'This order has already been paid.' });
  }

  if (!stripe) {
    return res.status(500).json({ error: 'Payments are not configured on this server yet (missing STRIPE_SECRET_KEY).' });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      metadata: { orderId: String(order.id), clientId: String(req.user.id) },
      automatic_payment_methods: { enabled: true }
    });

    db.prepare(`
      INSERT INTO payments (order_id, stripe_payment_intent_id, amount_cents, currency, status)
      VALUES (?, ?, ?, 'usd', 'pending')
    `).run(order.id, intent.id, amountCents);

    db.prepare(`
      UPDATE orders SET total_cents = ?, payment_method = 'online' WHERE id = ?
    `).run(amountCents, order.id);

    res.status(201).json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id
    });
  } catch (err) {
    console.error('Stripe error creating payment intent:', err.message);
    res.status(502).json({ error: 'Could not start payment with Stripe. Please try again.' });
  }
});

// --- STRIPE WEBHOOK ---
// Stripe calls this endpoint directly (not the client app) whenever a
// payment's status changes. This route needs the raw request body (not
// JSON-parsed) to verify Stripe's signature, which is why it's mounted with
// express.raw() in server.js rather than the normal express.json() parser.
router.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payments are not configured on this server yet (missing STRIPE_SECRET_KEY).' });
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      // Local/dev fallback if no webhook secret is configured yet.
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const newStatus = event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';

    const payment = db.prepare('SELECT * FROM payments WHERE stripe_payment_intent_id = ?').get(intent.id);
    if (payment) {
      db.prepare(`UPDATE payments SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(newStatus, payment.id);

      if (newStatus === 'succeeded') {
        db.prepare(`UPDATE orders SET payment_status = 'paid' WHERE id = ?`).run(payment.order_id);
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
        notifyClientOfOrderUpdate(order.client_id, serializeOrder(order));
      }
    }
  }

  res.json({ received: true });
});

// --- GET PAYMENT STATUS FOR AN ORDER ---
router.get('/order/:orderId', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const isOwner = order.client_id === req.user.id || order.provider_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'Not your order.' });

  const payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC').all(order.id);

  res.json({
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    totalCents: order.total_cents,
    payments: payments.map(p => ({
      id: p.id,
      stripePaymentIntentId: p.stripe_payment_intent_id,
      amountCents: p.amount_cents,
      status: p.status,
      createdAt: p.created_at
    }))
  });
});

module.exports = router;

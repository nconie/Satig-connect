// routes/orders.js
// Handles the core job lifecycle: a client creates an order (a service
// request), and it moves through statuses as work happens - requested,
// matched (a provider accepted), en_route, then completed. Providers can
// also see and act on orders assigned to them.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { findMatchingProviders } = require('../matching');
const { notifyProvidersOfNewOrder, notifyClientOfOrderUpdate } = require('../realtime');

const router = express.Router();

function serializeOrder(o) {
  return {
    id: o.id,
    clientId: o.client_id,
    providerId: o.provider_id,
    category: o.category,
    description: o.description,
    location: o.location,
    lat: o.lat,
    lng: o.lng,
    status: o.status,
    totalCents: o.total_cents,
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    rating: o.rating,
    ratingComment: o.rating_comment,
    createdAt: o.created_at
  };
}

// --- CREATE ORDER (client only) ---
// A client submits a request. It starts life as 'requested' with no provider yet.
// The moment it's saved, we find matching available providers and push a
// real-time notification to whichever of them are currently connected.
router.post('/', requireAuth, (req, res) => {
  if (req.user.role !== 'client') {
    return res.status(403).json({ error: 'Only clients can create orders.' });
  }

  const { category, description, location, lat, lng } = req.body;
  if (!category || !location) {
    return res.status(400).json({ error: 'category and location are required.' });
  }

  const insert = db.prepare(`
    INSERT INTO orders (client_id, category, description, location, lat, lng, status)
    VALUES (?, ?, ?, ?, ?, ?, 'requested')
  `);
  const result = insert.run(
    req.user.id, category, description || null, location,
    typeof lat === 'number' ? lat : null,
    typeof lng === 'number' ? lng : null
  );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  const serialized = serializeOrder(order);

  const matches = findMatchingProviders(order);
  const notifiedCount = notifyProvidersOfNewOrder(matches.map(m => m.id), serialized);

  res.status(201).json({
    order: serialized,
    matchedProviders: matches.length,
    notifiedLive: notifiedCount
  });
});

// --- LIST MY ORDERS (client sees their own, provider sees jobs assigned to them) ---
router.get('/mine', requireAuth, (req, res) => {
  const rows = req.user.role === 'client'
    ? db.prepare('SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC').all(req.user.id)
    : db.prepare('SELECT * FROM orders WHERE provider_id = ? ORDER BY created_at DESC').all(req.user.id);

  res.json({ orders: rows.map(serializeOrder) });
});

// --- LIST OPEN ORDERS FOR A CATEGORY (providers browse unclaimed jobs) ---
router.get('/open', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only providers can browse open jobs.' });
  }

  const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(req.user.id);
  if (!profile) return res.status(400).json({ error: 'Provider profile not found.' });

  const rows = db.prepare(`
    SELECT * FROM orders WHERE status = 'requested' AND category = ? ORDER BY created_at ASC
  `).all(profile.primary_service);

  res.json({ orders: rows.map(serializeOrder) });
});

// --- GET SINGLE ORDER (must be the client or provider on it) ---
router.get('/:id', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const isOwner = order.client_id === req.user.id || order.provider_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'Not your order.' });

  res.json({ order: serializeOrder(order) });
});

// --- ACCEPT ORDER (provider claims an open job) ---
router.post('/:id/accept', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only providers can accept orders.' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'requested') {
    return res.status(409).json({ error: 'This order has already been taken or is no longer open.' });
  }

  // A provider can only work one job at a time. If they already have a job
  // in 'matched' or 'en_route' (i.e. accepted but not yet completed), block
  // this new accept until that one is finished - same as a taxi driver
  // can't pick up a second rider mid-trip.
  const activeJob = db.prepare(`
    SELECT id FROM orders WHERE provider_id = ? AND status IN ('matched', 'en_route')
  `).get(req.user.id);
  if (activeJob) {
    return res.status(409).json({
      error: `You already have an active job (order #${activeJob.id}). Finish or complete that one before accepting another.`
    });
  }

  db.prepare(`
    UPDATE orders SET provider_id = ?, status = 'matched' WHERE id = ?
  `).run(req.user.id, order.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const serialized = serializeOrder(updated);

  // Push the match live to the client watching this order.
  notifyClientOfOrderUpdate(updated.client_id, serialized);

  res.json({ order: serialized });
});

// --- UPDATE ORDER STATUS: CANCEL (either side) ---
// Note: moving to 'en_route' and 'completed' are no longer done through
// this generic endpoint - both now require the client's permanent start
// code / completion code (see below), so a provider can't start or finish
// a job without the client genuinely being there to confirm it in person.
router.patch('/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: `status must be 'cancelled' here. Starting or finishing a job needs the client's code instead.`
    });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const isOwner = order.client_id === req.user.id || order.provider_id === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'Not your order.' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const serialized = serializeOrder(updated);

  notifyClientOfOrderUpdate(updated.client_id, serialized);

  res.json({ order: serialized });
});

// --- START JOB (provider only, needs the client's permanent start code) ---
// When the provider physically arrives, they ask the client for their
// start code (the same 4-digit code the client has had since they signed
// up) and enter it here. This moves the order from 'matched' to 'en_route'
// and proves the provider genuinely showed up before the clock starts.
router.post('/:id/start', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only the assigned provider can start this job.' });
  }
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code is required - ask the client for their start code." });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.provider_id !== req.user.id) return res.status(403).json({ error: 'Not your order.' });
  if (order.status !== 'matched') {
    return res.status(409).json({ error: 'This job is not awaiting start (it may already be en route or finished).' });
  }

  const client = db.prepare('SELECT start_code FROM users WHERE id = ?').get(order.client_id);
  if (String(code).trim() !== client.start_code) {
    return res.status(400).json({ error: "That code doesn't match the client's start code. Please double check with them." });
  }

  db.prepare(`UPDATE orders SET status = 'en_route', started_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), order.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const serialized = serializeOrder(updated);
  notifyClientOfOrderUpdate(updated.client_id, serialized);

  res.json({ order: serialized });
});

// --- COMPLETE JOB (provider only, needs the client's permanent completion code) ---
// Same idea, but with the client's other fixed code, asked for once the
// work is actually finished. Both codes never change, so this still works
// even if the client's phone loses signal or dies mid-job - they already
// know their own codes.
router.post('/:id/complete', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only the assigned provider can complete this order.' });
  }
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code is required - ask the client for their completion code." });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.provider_id !== req.user.id) return res.status(403).json({ error: 'Not your order.' });
  if (order.status !== 'en_route') {
    return res.status(409).json({ error: 'This job is not currently en route.' });
  }

  const client = db.prepare('SELECT completion_code FROM users WHERE id = ?').get(order.client_id);
  if (String(code).trim() !== client.completion_code) {
    return res.status(400).json({ error: "That code doesn't match the client's completion code. Please double check with them." });
  }

  db.prepare(`UPDATE orders SET status = 'completed' WHERE id = ?`).run(order.id);

  // The moment a job is confirmed completed, count it against the
  // provider's running total - shows up as "42 jobs completed" on profile.
  db.prepare('UPDATE provider_profiles SET jobs_completed = jobs_completed + 1 WHERE user_id = ?')
    .run(order.provider_id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  const serialized = serializeOrder(updated);
  notifyClientOfOrderUpdate(updated.client_id, serialized);

  res.json({ order: serialized });
});

// --- RATE A COMPLETED ORDER (client only, once) ---
// After a job is marked completed, the client can leave a 1-5 star rating
// and an optional comment. This immediately recalculates the provider's
// running average rating and how many ratings it's based on - the same
// numbers shown on their public profile (e.g. "4.8 stars, 112 ratings").
router.post('/:id/rate', requireAuth, (req, res) => {
  const { rating, comment } = req.body;
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'rating must be a whole number from 1 to 5.' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the client on this order can rate it.' });
  }
  if (order.status !== 'completed') {
    return res.status(409).json({ error: 'You can only rate a job after it is completed.' });
  }
  if (order.rating != null) {
    return res.status(409).json({ error: 'This order has already been rated.' });
  }
  if (!order.provider_id) {
    return res.status(409).json({ error: 'This order has no provider to rate.' });
  }

  const applyRating = db.transaction(() => {
    db.prepare('UPDATE orders SET rating = ?, rating_comment = ? WHERE id = ?')
      .run(stars, comment || null, order.id);

    const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(order.provider_id);
    const newCount = profile.rating_count + 1;
    const newAverage = ((profile.rating * profile.rating_count) + stars) / newCount;

    db.prepare('UPDATE provider_profiles SET rating = ?, rating_count = ? WHERE user_id = ?')
      .run(newAverage, newCount, order.provider_id);
  });
  applyRating();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: serializeOrder(updated) });
});

// --- SET PAYMENT (marks how the order total will be / was paid) ---
router.patch('/:id/payment', requireAuth, (req, res) => {
  const { totalCents, paymentMethod } = req.body;
  if (!totalCents || !['cash', 'online'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'totalCents (number) and paymentMethod (cash|online) are required.' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the client on this order can set payment.' });
  }

  db.prepare('UPDATE orders SET total_cents = ?, payment_method = ? WHERE id = ?')
    .run(totalCents, paymentMethod, order.id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: serializeOrder(updated) });
});

module.exports = router;

// realtime.js
// A lightweight WebSocket layer for two things:
//   1. Pushing "a new job just came in" to matching providers (built in
//      phase 3 - unchanged here).
//   2. Live location tracking: a provider who is en route to a job streams
//      their position, and we relay it instantly to the client watching
//      that specific order.
//
// Both clients and providers connect the same way: after logging in and
// getting a JWT, they open a WebSocket to ws://<server>/ws?token=<their JWT>.
// We verify that token the same way the regular HTTP routes do. From then
// on the connection is used to push events down to them in real time.

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { URL } = require('url');
const db = require('./db');

// Maps a provider's user id -> Set of their open WebSocket connections
// (a Set, not a single socket, in case they have the app open on two devices).
const providerSockets = new Map();

// Maps a client's user id -> Set of their open WebSocket connections.
const clientSockets = new Map();

function addSocket(map, userId, ws) {
  if (!map.has(userId)) map.set(userId, new Set());
  map.get(userId).add(ws);
}

function removeSocket(map, userId, ws) {
  const set = map.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(userId);
}

function initRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      ws.close(4001, 'Invalid or missing token');
      return;
    }

    ws.userId = payload.id;
    ws.role = payload.role;

    if (payload.role === 'provider') {
      addSocket(providerSockets, payload.id, ws);
      ws.send(JSON.stringify({ type: 'connected', message: 'Listening for new jobs.' }));
    } else if (payload.role === 'client') {
      addSocket(clientSockets, payload.id, ws);
      ws.send(JSON.stringify({ type: 'connected', message: 'Listening for live updates.' }));
    } else {
      ws.close(4003, 'Unknown role');
      return;
    }

    // Incoming messages: right now the only one we expect is a provider
    // sending their live location while working an order.
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return; // ignore malformed messages
      }

      if (msg.type === 'location_update' && ws.role === 'provider') {
        handleLocationUpdate(ws.userId, msg);
      }
    });

    ws.on('close', () => {
      if (payload.role === 'provider') removeSocket(providerSockets, payload.id, ws);
      else removeSocket(clientSockets, payload.id, ws);
    });
  });

  return wss;
}

// A provider says: "I'm working order X, and I'm currently at this lat/lng."
// We check that this provider is actually assigned to that order (so a
// random provider can't spoof another job's tracking), then relay the
// position straight to the client on that order, live.
function handleLocationUpdate(providerId, msg) {
  const { orderId, lat, lng } = msg;
  if (!orderId || typeof lat !== 'number' || typeof lng !== 'number') return;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.provider_id !== providerId) return; // not their job, ignore
  if (!['matched', 'en_route'].includes(order.status)) return; // job isn't active

  const payload = JSON.stringify({
    type: 'provider_location',
    orderId: order.id,
    lat,
    lng,
    at: new Date().toISOString()
  });

  const sockets = clientSockets.get(order.client_id);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Pushes a "new_job" event to a specific list of providers (whichever ones
// are currently connected - offline ones simply won't get a push, same as
// any real-time system).
function notifyProvidersOfNewOrder(providerIds, order) {
  const payload = JSON.stringify({ type: 'new_job', order });
  let notifiedCount = 0;

  for (const providerId of providerIds) {
    const sockets = providerSockets.get(providerId);
    if (!sockets) continue;
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
        notifiedCount++;
      }
    }
  }
  return notifiedCount;
}

// Lets other parts of the app (e.g. the orders route) push a status change
// (matched / en_route / completed / cancelled) to the client watching it.
function notifyClientOfOrderUpdate(clientId, order) {
  const sockets = clientSockets.get(clientId);
  if (!sockets) return 0;
  const payload = JSON.stringify({ type: 'order_update', order });
  let count = 0;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) { ws.send(payload); count++; }
  }
  return count;
}

function isProviderOnline(providerId) {
  return providerSockets.has(providerId) && providerSockets.get(providerId).size > 0;
}

module.exports = {
  initRealtime,
  notifyProvidersOfNewOrder,
  notifyClientOfOrderUpdate,
  isProviderOnline
};

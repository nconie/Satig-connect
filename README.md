# Satig Connect — Backend (Phase 1: Accounts + Database)

This is the real backend for Satig Connect. It's been tested end to end — signup,
login, protected routes, duplicate-email checks, and wrong-password rejection
all work exactly as expected.

It currently covers:
- Client accounts
- Provider accounts (with service type + service area)
- Secure password storage (bcrypt hashing — passwords are never stored in plain text)
- Login with JSON Web Tokens (JWT)
- A protected `/me` route that returns whoever the token belongs to
- A basic provider lookup by category (the foundation the real-time matching
  feature will build on top of later)

It does **not** yet include: real-time job matching/notifications, live GPS
tracking, or payments. Those are separate phases — see "What's next" below.

## 1. Requirements

- [Node.js](https://nodejs.org) version 18 or newer

## 2. Setup

```bash
cd satig-connect-backend
npm install
cp .env.example .env
```

Open `.env` and replace `change-this-to-a-long-random-string` with any long
random string of your own (this is what secures your login tokens — never
share it or commit it to GitHub).

## 3. Run it

```bash
npm start
```

You should see:

```
Satig Connect backend running on http://localhost:4000
```

A SQLite database file is created automatically at `data/satig.db` the first
time you run it — there's nothing else to install or configure.

## 4. Try it

**Health check**
```bash
curl http://localhost:4000/health
```

**Sign up a client**
```bash
curl -X POST http://localhost:4000/api/auth/signup/client \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Jane Doe","email":"jane@example.com","phone":"+1234567890","password":"somepassword"}'
```

**Sign up a provider**
```bash
curl -X POST http://localhost:4000/api/auth/signup/provider \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Jane the Plumber","email":"janeplumbs@example.com","phone":"+1234567890","password":"somepassword","primaryService":"plumbing","serviceArea":"Ludhiana"}'
```

Both return a `token` — save it and send it back as `Authorization: Bearer <token>`
on requests to protected routes like `/api/auth/me`.

**Log in**
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jane@example.com","password":"somepassword"}'
```

**Get the logged-in user**
```bash
curl http://localhost:4000/api/auth/me -H "Authorization: Bearer <token>"
```

**List available providers for a category**
```bash
curl "http://localhost:4000/api/providers?category=plumbing"
```

## 5. Project structure

```
satig-connect-backend/
├── src/
│   ├── server.js          # starts the app, wires up routes and the WebSocket server
│   ├── db.js              # database connection + table setup
│   ├── matching.js        # finds eligible providers for a new order
│   ├── realtime.js        # the WebSocket layer: new_job / order_update / provider_location
│   ├── middleware/
│   │   └── auth.js        # checks JWT tokens on protected routes
│   └── routes/
│       ├── auth.js        # signup / login / me
│       ├── providers.js   # provider lookup by category, single-provider lookup, availability toggle
│       ├── orders.js      # create/list/accept orders, update status and payment method
│       └── payments.js    # Stripe PaymentIntents + webhook
├── data/                  # satig.db lives here once you run it (not committed)
├── .env.example
├── .gitignore
└── package.json
```

## 6. Connecting the frontend prototype (done — here's how to run it)

The Satig Connect frontend (`satig-connect.html`) is now fully wired to this
backend — real signup/login, real order creation, real-time job matching,
live GPS tracking, and real payment calls. No more fake in-memory data.

To try it locally:

1. Start this backend (see sections 2–3 above) — it needs to be running on
   `http://localhost:4000` for the default setup to work.
2. Open `satig-connect.html` directly in a browser (or publish/host it
   anywhere) while the backend is running on the same machine. The page
   calls `http://localhost:4000` from your browser, so as long as the
   backend is up on your computer, it'll connect.
3. Sign up as a client in one browser tab/window and as a provider in
   another (or use two different browsers) to see the full flow: the client
   requests a job, the provider sees it appear live, accepts it, shares
   live location while "en route," and the client watches it update in
   real time.

A few things worth knowing:

- **Session persistence**: the frontend saves your login token in the
  browser's `localStorage`, so refreshing the page (or coming back later)
  keeps you logged in without re-entering credentials.
- **Changing the backend URL**: if you deploy this backend somewhere other
  than your own machine (see section 7), update the `API_BASE` constant
  near the top of the `<script>` tag in `satig-connect.html` to point at
  your deployed URL instead of `http://localhost:4000`.
- **Category matching**: the client's category picker and the provider's
  "Primary service" signup dropdown use identical text (e.g. `"Phone
  repair"`) on purpose — the backend matches on an exact string, so if you
  ever add a new category, add it with the same exact wording in both
  places in the HTML.
- **Online payments**: "Pay now" creates a real Stripe PaymentIntent on the
  backend (if you've set `STRIPE_SECRET_KEY` in `.env`), but there's no
  card-entry UI built into the frontend yet — that needs Stripe's own
  Payment Element script added with your Stripe *publishable* key, which is
  a small follow-up task. Cash payments work fully end-to-end already.
- **No real map**: the tracking screen's map is a styled mock (not a real
  map), so live GPS coordinates are shown as text under the map rather than
  plotted on it. Wiring in a real map (e.g. Mapbox or Google Maps) would be
  a good next step if you want the live dot to actually move on a map.
- **New endpoint behind the "Available for jobs" toggle**: the provider
  profile screen's availability switch calls a small endpoint added for
  this —`PATCH /api/providers/me/availability` *(provider only, requires
  auth)*, body `{ "available": true }`. See section 5 for where it lives.

## 7. Deploying this so it's live on the internet

Right now this only runs on your own machine. To make it reachable from a
real phone, you'd deploy it to a small hosting service such as
[Render](https://render.com), [Railway](https://railway.app), or
[Fly.io](https://fly.io) — all have free or very cheap tiers that work well
for a project at this stage. Note: SQLite works for one server instance, but
if you later deploy to a platform that wipes the filesystem between deploys
(some free tiers do), you'll want to move to a hosted Postgres database
instead — that's a small change, mostly confined to `db.js`.

## 8. What's next (not built yet)

1. ~~Real-time matching & notifications~~ — done, see section 10.
2. ~~Live location tracking~~ — done, see section 11 below.
3. ~~Payments~~ — done, see section 12 below.
4. ~~Order lifecycle endpoints~~ — done, see section 9.


## 9. Order lifecycle (Phase 2 — now built and tested)

Clients can now create real orders, and providers can browse, accept, and move
them through their full lifecycle. All of this has been tested end to end.

**Create an order (client only)**
```bash
curl -X POST http://localhost:4000/api/orders \
  -H "Authorization: Bearer <client_token>" \
  -H "Content-Type: application/json" \
  -d '{"category":"phone","description":"Screen replacement","location":"Ludhiana, Punjab"}'
```

**Browse open jobs in your category (provider only)**
```bash
curl http://localhost:4000/api/orders/open -H "Authorization: Bearer <provider_token>"
```

**Accept a job (provider only)**
```bash
curl -X POST http://localhost:4000/api/orders/1/accept -H "Authorization: Bearer <provider_token>"
```

**Move a job forward (provider or client on that order)**
```bash
curl -X PATCH http://localhost:4000/api/orders/1/status \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"en_route"}'
```
Valid status values: `en_route`, `completed`, `cancelled`.

**Set payment on an order (client only)**
```bash
curl -X PATCH http://localhost:4000/api/orders/1/payment \
  -H "Authorization: Bearer <client_token>" \
  -H "Content-Type: application/json" \
  -d '{"totalCents":3500,"paymentMethod":"cash"}'
```

**View your own orders (client sees theirs, provider sees jobs assigned to them)**
```bash
curl http://localhost:4000/api/orders/mine -H "Authorization: Bearer <token>"
```

Order status flow: `requested` → `matched` (once a provider accepts) →
`en_route` → `completed` (or `cancelled` at any point after matching).


## 10. Real-time matching (Phase 3 — now built and tested)

The moment a client creates an order, the backend automatically finds
available providers who do that category of work in a matching service
area, and pushes the job to them instantly over a live connection — no
refreshing or polling needed. This has been tested with two providers in
different cities: only the one in the matching area received the live
push.

**How a provider listens for new jobs**

After logging in and getting a token, the provider's app opens a WebSocket
connection to:

```
ws://localhost:4000/ws?token=<provider_token>
```

The very first message received confirms the connection:
```json
{"type":"connected","message":"Listening for new jobs."}
```

From then on, whenever a matching order comes in, the same connection
receives:
```json
{"type":"new_job","order":{ ... the order object ... }}
```

If the provider isn't connected at that moment (app closed, offline), they
simply won't get the push — but the job still shows up when they call
`GET /api/orders/open`, so nothing is lost, it just isn't instant.

**How matching works today**

A provider is considered a match for an order if all of these are true:
they offer the same category of service as the order, their profile is
marked available, and their service area text overlaps with the order's
location text. Matches are ranked by rating, highest first. This is
intentionally simple text matching for now — a natural next upgrade is
real coordinates and distance-based matching once live GPS (item 2 above)
is in place.

**What creating an order now returns**

```json
{
  "order": { "...": "..." },
  "matchedProviders": 1,
  "notifiedLive": 1
}
```
`matchedProviders` is how many providers matched the job at all.
`notifiedLive` is how many of those were actually online to receive the
push in that moment.

## 11. Live location tracking (Phase 4 — now built and tested)

Once a provider is on their way to a job, their live position streams
straight to the client watching that order — no refreshing, no polling.
This uses the same WebSocket connection built for matching, extended so
clients can connect too and so providers can send their position up.

This has been tested end to end: a client watched an order go from
"matched" to "en route" in real time, then received three live location
pings as the (simulated) provider moved. A security check was also
verified — a provider who is *not* assigned to an order cannot spoof a
location update for it; the backend checks the order's actual assigned
provider before relaying anything.

**How a client watches an order live**

After logging in, the client's app opens:
```
ws://localhost:4000/ws?token=<client_token>
```

It will then receive, as they happen:

```json
{"type":"order_update","order":{ "...": "status changed, e.g. to matched or en_route" }}
```

```json
{"type":"provider_location","orderId":1,"lat":30.9042,"lng":75.8601,"at":"2026-10-01T09:17:04.384Z"}
```

**How a provider sends their location**

The provider's app opens the same kind of connection:
```
ws://localhost:4000/ws?token=<provider_token>
```

Then, while working a job, sends messages like:
```json
{"type":"location_update","orderId":1,"lat":30.9042,"lng":75.8601}
```

The backend only relays this to the client if that provider is genuinely
the one assigned to that order and the order is currently `matched` or
`en_route` — anything else is silently dropped, so there's no way for a
provider to broadcast fake position data for jobs that aren't theirs.

**What's still simple here (room to grow)**

Right now a `lat`/`lng` pair is just numbers passed straight through — there's
no interpolation, no speed/ETA calculation, and no map rendering baked into
the backend (that's a frontend job, likely with a maps API like Mapbox or
Google Maps). This phase gives the frontend everything it needs to draw that
picture live.

## 12. Payments (Phase 5 — now built and tested)

Online payments ("pay now") are handled through Stripe. Cash orders keep
working exactly as before — this only adds a real path for paying by card.

**Why it's built this way**

The client's app never sees or touches a raw card number, and neither does
this backend. Instead:

1. The client's app calls `POST /api/payments/create-intent` for an order.
   This backend talks to Stripe and gets back a `client_secret`.
2. The client's app hands that `client_secret` to Stripe's own SDK on the
   device, which securely collects the card details and charges it. Card
   data goes straight to Stripe, never through our server.
3. Stripe then calls **our webhook** the moment the payment actually
   succeeds or fails. The webhook is the *only* place an order gets marked
   as paid — never because the client's app claims "I paid", since that
   could be faked. This is the standard, secure way payments are built.

This has been tested thoroughly: request validation, ownership checks (a
client can't pay for someone else's order), role checks (a provider can't
initiate a payment), and — most importantly — a simulated Stripe webhook
event was sent in, and confirmed to correctly mark the order as paid, record
the payment, and push a live update to the client over the WebSocket, all
automatically. Double-payment was also confirmed blocked once an order is
already paid.

**Setup required before this works for real**

You'll need a free Stripe account (https://dashboard.stripe.com) and two
things in your `.env`:

```
STRIPE_SECRET_KEY=sk_test_...       # from your Stripe dashboard, use the TEST key while developing
STRIPE_WEBHOOK_SECRET=whsec_...     # from setting up a webhook endpoint, or the Stripe CLI locally
```

Without `STRIPE_SECRET_KEY` set, the server still starts up fine — it just
returns a clear "payments not configured yet" error if someone tries to pay,
instead of crashing.

**Endpoints**

- `POST /api/payments/create-intent` *(client only, requires auth)*
  Body: `{ "orderId": 1, "amountCents": 5000 }`
  Returns a `clientSecret` for the client's app to use with Stripe's SDK.
  Blocked if: you're not a client, the order isn't yours, or it's already paid.

- `POST /api/payments/webhook` *(called by Stripe itself, not your app)*
  Stripe hits this automatically when a payment's status changes. You
  register this URL in your Stripe dashboard (or with the Stripe CLI while
  testing locally — run `stripe listen --forward-to localhost:4000/api/payments/webhook`).

- `GET /api/payments/order/:orderId` *(client or provider on that order)*
  Returns the order's current payment status and full payment history —
  useful for showing "Paid ✓" in the app, or a receipt.

**Testing it yourself locally**

The easiest way to test a real end-to-end payment without a live frontend is
the Stripe CLI:
```
stripe listen --forward-to localhost:4000/api/payments/webhook
stripe trigger payment_intent.succeeded
```


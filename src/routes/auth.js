// routes/auth.js
// Handles account creation and login for both clients and providers.
// Passwords are never stored directly - only a bcrypt hash of them.
// On successful signup/login we hand back a JWT the frontend stores and
// sends back on every future request (in the Authorization header).

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 10;

function issueToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Generates a permanent 4-digit code for a client to use when a provider
// arrives (start code) or finishes (completion code) a job. These are
// fixed per-client, not regenerated per order - that way they still work
// even if the client's phone dies or loses signal mid-job, since they
// already know their own codes by heart, same as a bank PIN.
function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function publicUser(user, providerProfile) {
  const base = {
    id: user.id,
    role: user.role,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    lat: user.lat,
    lng: user.lng,
    createdAt: user.created_at
  };
  // Only a client's own account response ever includes their codes - these
  // are shown to them once on signup/profile and never exposed to anyone
  // else (providers only ever verify a code against the backend, they
  // never get to read it from here).
  if (user.role === 'client') {
    base.startCode = user.start_code;
    base.completionCode = user.completion_code;
  }
  if (providerProfile) {
    base.provider = {
      primaryService: providerProfile.primary_service,
      serviceArea: providerProfile.service_area,
      available: !!providerProfile.available,
      rating: providerProfile.rating,
      ratingCount: providerProfile.rating_count,
      jobsCompleted: providerProfile.jobs_completed,
      lat: providerProfile.lat,
      lng: providerProfile.lng,
      profilePhotoUrl: providerProfile.profile_photo_url,
      idVerified: !!providerProfile.id_verified
    };
  }
  return base;
}

// --- SIGN UP: CLIENT ---
router.post('/signup/client', (req, res) => {
  const { fullName, email, phone, password, lat, lng } = req.body;

  if (!fullName || !email || !phone || !password) {
    return res.status(400).json({ error: 'fullName, email, phone and password are all required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  // Generate the client's permanent start/completion codes now, at signup -
  // two different random 4-digit codes, guaranteed not to clash with each other.
  let startCode = generateCode();
  let completionCode = generateCode();
  while (completionCode === startCode) completionCode = generateCode();

  const insert = db.prepare(`
    INSERT INTO users (role, full_name, email, phone, password_hash, lat, lng, start_code, completion_code)
    VALUES ('client', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    fullName, email.toLowerCase(), phone, passwordHash,
    typeof lat === 'number' ? lat : null,
    typeof lng === 'number' ? lng : null,
    startCode, completionCode
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const token = issueToken(user);

  res.status(201).json({ token, user: publicUser(user) });
});

// --- SIGN UP: PROVIDER ---
router.post('/signup/provider', (req, res) => {
  const { fullName, email, phone, password, primaryService, serviceArea, lat, lng } = req.body;

  if (!fullName || !email || !phone || !password || !primaryService || !serviceArea) {
    return res.status(400).json({
      error: 'fullName, email, phone, password, primaryService and serviceArea are all required.'
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const safeLat = typeof lat === 'number' ? lat : null;
  const safeLng = typeof lng === 'number' ? lng : null;

  const createUserAndProfile = db.transaction(() => {
    const insertUser = db.prepare(`
      INSERT INTO users (role, full_name, email, phone, password_hash, lat, lng)
      VALUES ('provider', ?, ?, ?, ?, ?, ?)
    `);
    const result = insertUser.run(fullName, email.toLowerCase(), phone, passwordHash, safeLat, safeLng);

    db.prepare(`
      INSERT INTO provider_profiles (user_id, primary_service, service_area, lat, lng)
      VALUES (?, ?, ?, ?, ?)
    `).run(result.lastInsertRowid, primaryService, serviceArea, safeLat, safeLng);

    return result.lastInsertRowid;
  });

  const userId = createUserAndProfile();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(userId);
  const token = issueToken(user);

  res.status(201).json({ token, user: publicUser(user, profile) });
});

// --- LOGIN (both roles) ---
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const profile = user.role === 'provider'
    ? db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(user.id)
    : null;

  const token = issueToken(user);
  res.json({ token, user: publicUser(user, profile) });
});

// --- CURRENT USER ---
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const profile = user.role === 'provider'
    ? db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(user.id)
    : null;

  res.json({ user: publicUser(user, profile) });
});

// --- EDIT MY PROFILE (both roles) ---
// Lets someone fix a mistake in their own details after signing up - name,
// phone, location, and for providers also their service area/category.
// Rate-limited on purpose: up to 2 edits are allowed freely, then a 14-day
// cooldown kicks in before they're allowed to edit again. This is an
// anti-abuse measure, since constantly changing identity details is a classic
// way people dodge verification or confuse clients about who they're dealing
// with - after this 14-day window passes, the 2-edit allowance resets.
const EDIT_COOLDOWN_DAYS = 14;
const EDITS_ALLOWED_BEFORE_COOLDOWN = 2;

router.patch('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.last_profile_edit_at) {
    const daysSinceFirstEdit =
      (Date.now() - new Date(user.last_profile_edit_at).getTime()) / (1000 * 60 * 60 * 24);

    if (user.profile_edit_count >= EDITS_ALLOWED_BEFORE_COOLDOWN && daysSinceFirstEdit < EDIT_COOLDOWN_DAYS) {
      const daysLeft = Math.ceil(EDIT_COOLDOWN_DAYS - daysSinceFirstEdit);
      return res.status(429).json({
        error: `You've used both profile edits for now. You can edit again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
      });
    }
  }

  const { fullName, phone, lat, lng, primaryService, serviceArea } = req.body;

  const userUpdates = [];
  const userValues = [];
  if (fullName) { userUpdates.push('full_name = ?'); userValues.push(fullName); }
  if (phone) { userUpdates.push('phone = ?'); userValues.push(phone); }
  if (typeof lat === 'number') { userUpdates.push('lat = ?'); userValues.push(lat); }
  if (typeof lng === 'number') { userUpdates.push('lng = ?'); userValues.push(lng); }

  // Figure out whether this edit starts a fresh cooldown window or just
  // counts as the 2nd edit within an existing one.
  const startingFreshWindow =
    !user.last_profile_edit_at ||
    (Date.now() - new Date(user.last_profile_edit_at).getTime()) / (1000 * 60 * 60 * 24) >= EDIT_COOLDOWN_DAYS;

  userUpdates.push('last_profile_edit_at = ?');
  userValues.push(new Date().toISOString());
  userUpdates.push('profile_edit_count = ?');
  userValues.push(startingFreshWindow ? 1 : user.profile_edit_count + 1);

  const applyEdit = db.transaction(() => {
    if (userUpdates.length) {
      userValues.push(user.id);
      db.prepare(`UPDATE users SET ${userUpdates.join(', ')} WHERE id = ?`).run(...userValues);
    }

    if (user.role === 'provider' && (primaryService || serviceArea || typeof lat === 'number' || typeof lng === 'number')) {
      const providerUpdates = [];
      const providerValues = [];
      if (primaryService) { providerUpdates.push('primary_service = ?'); providerValues.push(primaryService); }
      if (serviceArea) { providerUpdates.push('service_area = ?'); providerValues.push(serviceArea); }
      if (typeof lat === 'number') { providerUpdates.push('lat = ?'); providerValues.push(lat); }
      if (typeof lng === 'number') { providerUpdates.push('lng = ?'); providerValues.push(lng); }
      if (providerUpdates.length) {
        providerValues.push(user.id);
        db.prepare(`UPDATE provider_profiles SET ${providerUpdates.join(', ')} WHERE user_id = ?`).run(...providerValues);
      }
    }
  });
  applyEdit();

  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const updatedProfile = user.role === 'provider'
    ? db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(user.id)
    : null;

  res.json({ user: publicUser(updatedUser, updatedProfile) });
});

module.exports = router;

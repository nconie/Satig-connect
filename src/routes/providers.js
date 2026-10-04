// routes/providers.js
// Read-only endpoint the client app can call to see available providers for a
// category. This is the foundation the real-time matching feature (phase 2)
// will build on top of - for now it's a simple filtered list.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// --- GET A SINGLE PROVIDER (used by the client app to show who they've been
// matched with - name, rating, etc. - on the live tracking screen) ---
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT u.id, u.full_name, u.phone, p.primary_service, p.service_area, p.available, p.rating,
           p.rating_count, p.jobs_completed, p.profile_photo_url, p.id_verified, p.lat, p.lng
    FROM provider_profiles p
    JOIN users u ON u.id = p.user_id
    WHERE u.id = ?
  `).get(req.params.id);

  if (!row) return res.status(404).json({ error: 'Provider not found.' });

  res.json({
    provider: {
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      primaryService: row.primary_service,
      serviceArea: row.service_area,
      available: !!row.available,
      rating: row.rating,
      ratingCount: row.rating_count,
      jobsCompleted: row.jobs_completed,
      profilePhotoUrl: row.profile_photo_url,
      idVerified: !!row.id_verified,
      lat: row.lat,
      lng: row.lng
    }
  });
});

// --- SET MY AVAILABILITY (provider only) ---
// Lets a provider toggle whether they currently show up in matching/browsing.
router.patch('/me/availability', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only providers have availability to set.' });
  }
  const { available } = req.body;
  if (typeof available !== 'boolean') {
    return res.status(400).json({ error: 'available (true/false) is required.' });
  }

  db.prepare('UPDATE provider_profiles SET available = ? WHERE user_id = ?')
    .run(available ? 1 : 0, req.user.id);

  res.json({ available });
});

router.get('/', (req, res) => {
  const { category } = req.query;

  const rows = category
    ? db.prepare(`
        SELECT u.id, u.full_name, u.phone, p.primary_service, p.service_area, p.available, p.rating, p.rating_count, p.jobs_completed, p.profile_photo_url, p.id_verified
        FROM provider_profiles p
        JOIN users u ON u.id = p.user_id
        WHERE p.primary_service = ? AND p.available = 1
      `).all(category)
    : db.prepare(`
        SELECT u.id, u.full_name, u.phone, p.primary_service, p.service_area, p.available, p.rating, p.rating_count, p.jobs_completed, p.profile_photo_url, p.id_verified
        FROM provider_profiles p
        JOIN users u ON u.id = p.user_id
        WHERE p.available = 1
      `).all();

  res.json({
    providers: rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      phone: r.phone,
      primaryService: r.primary_service,
      serviceArea: r.service_area,
      available: !!r.available,
      rating: r.rating,
      ratingCount: r.rating_count,
      jobsCompleted: r.jobs_completed,
      profilePhotoUrl: r.profile_photo_url,
      idVerified: !!r.id_verified
    }))
  });
});

// --- UPLOAD MY PROFILE PHOTO (provider only) ---
// Accepts a base64 data URL (e.g. "data:image/jpeg;base64,...") straight
// from a <input type="file"> read with FileReader in the browser - no extra
// file-upload library needed for a project at this stage. There's a 5MB
// cap so nobody can accidentally (or deliberately) send something huge.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

router.patch('/me/photo', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only providers have a profile photo here.' });
  }
  const { photoDataUrl } = req.body;
  if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'photoDataUrl must be a base64 image data URL.' });
  }
  if (photoDataUrl.length > MAX_PHOTO_BYTES * 1.4) { // base64 is ~33% bigger than raw bytes
    return res.status(400).json({ error: 'Photo is too large. Please use an image under 5MB.' });
  }

  db.prepare('UPDATE provider_profiles SET profile_photo_url = ? WHERE user_id = ?')
    .run(photoDataUrl, req.user.id);

  res.json({ profilePhotoUrl: photoDataUrl });
});

// --- SUBMIT ID VERIFICATION (provider only) ---
// Basic self-reported identity verification: full legal name (first, last,
// and optional middle name), date of birth, and a photo of their ID document.
// We do an automatic sanity check that the name they typed roughly matches
// their account name, and that the date of birth is a real, plausible date -
// catching obvious mismatches or fake entries automatically. This is NOT a
// substitute for real document-authenticity verification (checking a photo
// ID is genuine and unaltered needs a specialist third-party service - see
// the note in the README) - it's an honest first layer, not the final word.
router.post('/me/verify-id', requireAuth, (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(403).json({ error: 'Only providers go through ID verification.' });
  }
  const { firstName, middleName, lastName, dateOfBirth, idDocumentDataUrl } = req.body;

  if (!firstName || !lastName || !dateOfBirth || !idDocumentDataUrl) {
    return res.status(400).json({
      error: 'firstName, lastName, dateOfBirth and idDocumentDataUrl are all required.'
    });
  }
  if (!idDocumentDataUrl.startsWith('data:image/') && !idDocumentDataUrl.startsWith('data:application/pdf')) {
    return res.status(400).json({ error: 'idDocumentDataUrl must be an image or PDF data URL.' });
  }

  // Plausibility check on date of birth: must be a real date, and the
  // person must be at least 18 and realistically under 120.
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) {
    return res.status(400).json({ error: 'dateOfBirth is not a valid date.' });
  }
  const ageYears = (Date.now() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 18) {
    return res.status(400).json({ error: 'You must be at least 18 to register as a provider.' });
  }
  if (ageYears > 120) {
    return res.status(400).json({ error: 'That date of birth doesn\'t look right - please check it.' });
  }

  // Automatic name-match check: the typed first + last name should
  // reasonably match the account's full_name on file. This is a simple,
  // honest string comparison - not real document verification.
  const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.user.id);
  const typedFullName = `${firstName} ${middleName ? middleName + ' ' : ''}${lastName}`.toLowerCase().trim();
  const accountName = (user.full_name || '').toLowerCase().trim();
  const namesRoughlyMatch =
    accountName.includes(firstName.toLowerCase().trim()) &&
    accountName.includes(lastName.toLowerCase().trim());

  if (!namesRoughlyMatch) {
    return res.status(409).json({
      error: `The name you entered doesn't match the name on your account (${user.full_name}). Please make sure they match, or edit your account name first.`
    });
  }

  db.prepare(`
    UPDATE provider_profiles
    SET id_verified = 1, id_document_name = ?, date_of_birth = ?
    WHERE user_id = ?
  `).run(idDocumentDataUrl, dateOfBirth, req.user.id);

  res.json({ idVerified: true });
});

module.exports = router;

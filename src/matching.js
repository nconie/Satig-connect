// matching.js
// Finds the best available providers for a given order, and figures out who
// should be notified in real time when a new job comes in.
//
// Matching logic: a provider is a candidate if they do the right category of
// work and are currently marked available. If both the order and the
// provider have real GPS coordinates on file, distance is calculated with
// the Haversine formula (real-world kilometres over the Earth's curve) and
// only providers within MAX_RADIUS_KM are matched - closest first.
//
// If either side is missing coordinates (e.g. an older account from before
// this feature existed), we fall back to the original text-based service
// area match so nothing breaks for accounts created before this upgrade.

const db = require('./db');

const MAX_RADIUS_KM = 25;
const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Real distance in kilometres between two lat/lng points.
function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function findMatchingProviders(order, { limit = 10 } = {}) {
  const candidates = db.prepare(`
    SELECT u.id, u.full_name, u.phone, p.primary_service, p.service_area,
           p.rating, p.rating_count, p.jobs_completed, p.lat, p.lng, p.profile_photo_url
    FROM provider_profiles p
    JOIN users u ON u.id = p.user_id
    WHERE p.primary_service = ?
      AND p.available = 1
  `).all(order.category);

  const hasOrderCoords = order.lat != null && order.lng != null;

  let withDistance = candidates.map(r => {
    let distanceKmValue = null;
    if (hasOrderCoords && r.lat != null && r.lng != null) {
      distanceKmValue = distanceKm(order.lat, order.lng, r.lat, r.lng);
    }
    return { ...r, distanceKmValue };
  });

  // Providers with real coordinates get filtered strictly by radius.
  // Providers without coordinates on file (legacy accounts) fall back to
  // the old text-overlap match against the order's typed location, so they
  // still have a chance to appear rather than silently vanishing.
  withDistance = withDistance.filter(r => {
    if (r.distanceKmValue != null) {
      return r.distanceKmValue <= MAX_RADIUS_KM;
    }
    const loc = (order.location || '').toLowerCase();
    const area = (r.service_area || '').toLowerCase();
    return loc.includes(area) || area.includes(loc);
  });

  // Closest first; providers with unknown distance (legacy fallback) sort
  // after everyone with a real measured distance, ranked by rating instead.
  withDistance.sort((a, b) => {
    if (a.distanceKmValue != null && b.distanceKmValue != null) {
      return a.distanceKmValue - b.distanceKmValue;
    }
    if (a.distanceKmValue != null) return -1;
    if (b.distanceKmValue != null) return 1;
    return b.rating - a.rating;
  });

  return withDistance.slice(0, limit).map(r => ({
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    primaryService: r.primary_service,
    serviceArea: r.service_area,
    rating: r.rating,
    ratingCount: r.rating_count,
    jobsCompleted: r.jobs_completed,
    profilePhotoUrl: r.profile_photo_url,
    distanceKm: r.distanceKmValue != null ? Math.round(r.distanceKmValue * 10) / 10 : null
  }));
}

module.exports = { findMatchingProviders, distanceKm, MAX_RADIUS_KM };

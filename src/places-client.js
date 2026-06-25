// Client Google Places API (New) — SERVEUR uniquement (clé jamais exposée au front).
// Clé : process.env.GOOGLE_PLACES_API_KEY.
// ⚠️ Appels FORCÉS en IPv4 : la clé est restreinte à l'IPv4 sortante du VPS
// (65.21.146.193). En IPv6 Google verrait une autre IP → 403.
import https from 'node:https';

const KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

export function isPlacesConfigured() { return !!KEY; }

function request(method, url, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      agent: ipv4Agent,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Places API timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function asJson(r) {
  let j = {};
  try { j = JSON.parse(r.buf.toString('utf8')); } catch {}
  if (r.status >= 400) {
    const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.placesError = j && j.error;
    throw err;
  }
  return j;
}

// Champs ramenés par la recherche (liste de candidats).
const SEARCH_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress',
  'places.location', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.rating', 'places.userRatingCount', 'places.primaryTypeDisplayName', 'places.businessStatus',
].join(',');

export async function searchText(query, { max = 8 } = {}) {
  if (!KEY) throw new Error('GOOGLE_PLACES_API_KEY manquante');
  const r = await request('POST', 'https://places.googleapis.com/v1/places:searchText', {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': SEARCH_MASK },
    body: { textQuery: query, languageCode: 'fr', regionCode: 'FR', pageSize: Math.min(max, 20) },
  });
  return asJson(r).places || [];
}

// Champs ramenés par le détail (création d'un salon).
const DETAILS_MASK = [
  'id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'addressComponents',
  'location', 'nationalPhoneNumber', 'internationalPhoneNumber', 'rating', 'userRatingCount',
  'websiteUri', 'googleMapsUri', 'primaryTypeDisplayName', 'types', 'editorialSummary',
  'photos', 'businessStatus',
].join(',');

export async function placeDetails(placeId) {
  if (!KEY) throw new Error('GOOGLE_PLACES_API_KEY manquante');
  const r = await request('GET', `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=fr&regionCode=FR`, {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': DETAILS_MASK },
  });
  return asJson(r);
}

// Résout l'URL réelle d'une photo Places (skipHttpRedirect => JSON {photoUri}).
// photoName = "places/{id}/photos/{ref}" (champ `name` d'un élément de place.photos).
// Utilisé par la récupération de photos (étape 3). Le download de photoUri (googleusercontent)
// n'est PAS restreint par la clé → pas besoin d'IPv4 pour ce 2ᵉ appel.
export async function photoUri(photoName, { maxWidthPx = 1600 } = {}) {
  if (!KEY) throw new Error('GOOGLE_PLACES_API_KEY manquante');
  const r = await request('GET', `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`, {
    headers: { 'X-Goog-Api-Key': KEY },
  });
  return asJson(r).photoUri;
}

// Routes de création de salon « à l'unité » (onglet Nouveau salon).
// Montées DANS admin.js APRÈS requireAuth → tout est derrière le login admin.
//
//   GET  /api/salon-new/meta          → régions (groupes) + état config Places
//   POST /api/salon-new/search        → recherche Google Places ({query})
//   POST /api/salon-new/from-place    → crée un salon depuis un place_id
//   POST /api/salon-new/manual        → crée un salon en saisie manuelle
import express from 'express';
import db from '../db.js';
import { searchText, placeDetails, isPlacesConfigured } from '../places-client.js';
import { createSalon, mapPlaceToSalonData } from '../salon-creator.js';

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://maquickpage.fr').replace(/\/$/, '');

function urlsFor(slug, token) {
  const tk = token ? `?token=${encodeURIComponent(token)}` : '';
  return {
    preview_url: `${PUBLIC_BASE}/preview/${slug}${tk}`,
    admin_url: token ? `${PUBLIC_BASE}/admin/${slug}${tk}` : '',
  };
}

// Régions disponibles pour le sélecteur + savoir si Places est configuré.
router.get('/api/salon-new/meta', (req, res) => {
  const groups = db.prepare('SELECT id, name FROM salon_groups ORDER BY name').all();
  res.json({ groups, places_configured: isPlacesConfigured() });
});

// Recherche Google Places → liste de candidats.
router.post('/api/salon-new/search', async (req, res) => {
  const q = (req.body && req.body.query ? String(req.body.query) : '').trim();
  if (!q) return res.status(400).json({ error: 'query requis' });
  try {
    const places = await searchText(q, { max: 8 });
    res.json({
      results: places.map((p) => ({
        place_id: p.id,
        nom: (p.displayName && p.displayName.text) || '',
        adresse: p.shortFormattedAddress || p.formattedAddress || '',
        telephone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
        note: p.rating != null ? p.rating : null,
        nb_avis: p.userRatingCount != null ? p.userRatingCount : null,
        type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
        status: p.businessStatus || '',
        existing_slug: (db.prepare('SELECT slug FROM salons WHERE google_id = ? LIMIT 1').get(p.id) || {}).slug || null,
      })),
    });
  } catch (e) {
    const code = e.status === 403 ? 403 : 500;
    res.status(code).json({ error: e.message, places_error: e.placesError || null });
  }
});

// Création depuis un place_id (récupère les détails Google puis insère).
router.post('/api/salon-new/from-place', async (req, res) => {
  const placeId = (req.body && req.body.place_id ? String(req.body.place_id) : '').trim();
  const groupId = req.body && req.body.group_id ? (parseInt(req.body.group_id, 10) || null) : null;
  if (!placeId) return res.status(400).json({ error: 'place_id requis' });
  try {
    const existing = db.prepare('SELECT slug FROM salons WHERE google_id = ? LIMIT 1').get(placeId);
    if (existing) return res.status(409).json({ error: 'Ce salon existe déjà en base', slug: existing.slug, ...urlsFor(existing.slug, null) });

    const place = await placeDetails(placeId);
    const data = mapPlaceToSalonData(place);
    if (!data.nom) return res.status(422).json({ error: 'Nom introuvable pour ce lieu' });

    const r = createSalon(data, { csvSource: 'manuel', groupId });
    res.json({ ok: true, slug: r.slug, edit_token: r.edit_token, data, ...urlsFor(r.slug, r.edit_token) });
  } catch (e) {
    res.status(e.status === 403 ? 403 : 500).json({ error: e.message });
  }
});

// Création manuelle (sans Places) — au minimum un nom.
router.post('/api/salon-new/manual', (req, res) => {
  const b = req.body || {};
  if (!b.nom || !String(b.nom).trim()) return res.status(400).json({ error: 'nom requis' });
  const groupId = b.group_id ? (parseInt(b.group_id, 10) || null) : null;
  try {
    const data = {
      nom: String(b.nom).trim(),
      ville: b.ville || null,
      code_postal: b.code_postal || null,
      adresse: b.adresse || null,
      telephone: b.telephone || null,
      note_avis: b.note_avis ? parseFloat(String(b.note_avis).replace(',', '.')) : null,
      nb_avis: b.nb_avis || null,
      types: b.types || 'Salon de coiffure',
      site_internet_original: b.site_internet_original || null,
      lien_google_maps: b.lien_google_maps || null,
    };
    const r = createSalon(data, { csvSource: 'manuel', groupId });
    res.json({ ok: true, slug: r.slug, edit_token: r.edit_token, ...urlsFor(r.slug, r.edit_token) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

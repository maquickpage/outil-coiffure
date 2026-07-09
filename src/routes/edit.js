import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';
import { buildSalonView } from '../defaults.js';
import { uploadObject, deleteObject, isObjectStorageConfigured } from '../object-storage.js';
import { recaptureAsync } from '../screenshot-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Multer en memoire (pour traiter via sharp avant ecriture disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 } // 12 MB max upload (sera compresse cote serveur)
});

// Auth :
//   - Sites LIVE (Falkenstein, TENANT_ONLY=1) : cookie session SEULEMENT.
//     Pas de fallback edit_token URL — l'URL admin n'a plus de token permanent
//     depuis la migration Magic Link Only. Le cookie est posé par /admin/{slug}
//     après consommation d'un magic link single-use (24 h post-paiement ou
//     10 min via recovery form).
//   - Démos Helsinki (TENANT_ONLY=0) : cookie OU edit_token URL/header/body
//     (pour l'agence qui ouvre les démos avec un lien interne).
import { readSessionCookie } from '../admin-auth.js';

const TENANT_ONLY = process.env.TENANT_ONLY === '1';

function requireToken(req, res, next) {
  const slug = req.params.slug;
  if (!slug) return res.status(400).json({ error: 'Slug manquant' });

  // 1. Cookie session ?
  const cookieSlug = readSessionCookie(req);
  if (cookieSlug === slug) {
    const row = db.prepare('SELECT id, slug, edit_token FROM salons WHERE slug = ?').get(slug);
    if (!row) return res.status(404).json({ error: 'Salon introuvable' });
    req.salon = row;
    return next();
  }

  // 2. Sur Falkenstein, plus de fallback : 401 → l'UI demande un magic link.
  if (TENANT_ONLY) {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  // 3. Helsinki uniquement : edit_token URL/header/body (démos agence).
  const token = req.query.token || req.headers['x-edit-token'] || req.body?.token;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });

  const row = db.prepare('SELECT id, slug, edit_token FROM salons WHERE slug = ?').get(slug);
  if (!row) return res.status(404).json({ error: 'Salon introuvable' });
  if (!row.edit_token || row.edit_token !== token) return res.status(403).json({ error: 'Token invalide' });

  req.salon = row;
  next();
}

// GET /api/edit/:slug - retourne les donnees actuelles + structure pour l'admin
router.get('/edit/:slug', requireToken, (req, res) => {
  const row = db.prepare('SELECT * FROM salons WHERE id = ?').get(req.salon.id);
  const view = buildSalonView(row);
  res.json(view);
});

// PUT /api/edit/:slug - sauvegarde des overrides (JSON merge)
router.put('/edit/:slug', express.json({ limit: '2mb' }), requireToken, (req, res) => {
  const overrides = req.body?.overrides;
  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ error: 'overrides manquants' });
  }

  // Validation legere : taille raisonnable, types attendus
  if (overrides.services?.items && overrides.services.items.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 services' });
  }
  if (overrides.gallery?.images && overrides.gallery.images.length > 12) {
    return res.status(400).json({ error: 'Maximum 12 images dans la galerie' });
  }
  if (overrides.testimonials?.items && overrides.testimonials.items.length > 3) {
    return res.status(400).json({ error: 'Maximum 3 temoignages' });
  }

  db.prepare(`
    UPDATE salons
    SET overrides_json = ?, overrides_updated_at = datetime('now'), updated_at = datetime('now'),
        screenshot_path = NULL, screenshot_generated_at = NULL
    WHERE id = ?
  `).run(JSON.stringify(overrides), req.salon.id);

  // Le screenshot vient d'etre invalide (screenshot_path = NULL) : on relance
  // une capture automatique. Le hero (ou n'importe quel contenu) a pu changer,
  // donc l'apercu du salon doit se regenerer sans passer par un batch manuel.
  recaptureAsync(req.salon.slug);

  // Retourne la vue mergee pour confirmer
  const row = db.prepare('SELECT * FROM salons WHERE id = ?').get(req.salon.id);
  res.json({ ok: true, view: buildSalonView(row) });
});

// DELETE /api/edit/:slug/overrides - reinitialiser depuis CSV
router.delete('/edit/:slug/overrides', requireToken, (req, res) => {
  db.prepare(`
    UPDATE salons SET overrides_json = NULL, overrides_updated_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.salon.id);
  res.json({ ok: true });
});

// POST /api/edit/:slug/upload-image - upload une image (hero ou galerie)
// Body : champ "image" (file), champ "kind" ("hero" | "gallery")
// Stockage : Hetzner Object Storage si configuré, sinon disk local (fallback dev).
router.post('/edit/:slug/upload-image', upload.single('image'), requireToken, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucune image' });
  const kind = req.body?.kind;
  if (!['hero', 'gallery'].includes(kind)) {
    return res.status(400).json({ error: 'kind doit etre hero ou gallery' });
  }

  let filename;
  let pipeline;

  if (kind === 'hero') {
    filename = `hero-${Date.now()}.jpg`;
    // Hero : 1920x1080 cover, qualité 80, JPEG progressive → ~150-300 KB
    pipeline = sharp(req.file.buffer)
      .rotate()
      .resize(1920, 1080, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 80, progressive: true, mozjpeg: true });
  } else {
    filename = `gallery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
    // Galerie : 1024px max côté long, ratio natif, qualité 80 → ~80-180 KB
    pipeline = sharp(req.file.buffer)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true, mozjpeg: true });
  }

  try {
    const buffer = await pipeline.toBuffer();
    const key = `${req.salon.slug}/${filename}`;
    const url = await uploadObject(key, buffer, 'image/jpeg');
    res.json({
      ok: true,
      url,                                   // URL absolue si S3, /uploads/... si fallback disk
      kind,
      size: buffer.length,
      sizeKb: Math.round(buffer.length / 1024),
      storage: isObjectStorageConfigured() ? 's3' : 'disk',
    });
  } catch (e) {
    console.error('[upload-image]', e);
    res.status(500).json({ error: 'Erreur traitement image: ' + e.message });
  }
});

// DELETE /api/edit/:slug/upload-image?path=...
// Accepte URLs absolues (S3) OU paths /uploads/... (disk legacy)
router.delete('/edit/:slug/upload-image', requireToken, async (req, res) => {
  const path = req.query.path;
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path manquant' });

  // Sécurité : la path/URL doit contenir le slug du salon owner du token
  const slugFragment = `/${req.salon.slug}/`;
  if (!path.includes(slugFragment)) return res.status(403).json({ error: 'path non autorisé' });

  try {
    await deleteObject(path);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[upload-image DELETE]', err);
    return res.status(500).json({ error: 'Erreur suppression: ' + err.message });
  }
});

export default router;

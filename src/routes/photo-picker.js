// Routes du photo-picker (admin agence uniquement, Helsinki).
// Monté DANS src/routes/admin.js APRÈS router.use(requireAuth) → tout est
// derrière le login admin, y compris les fichiers images (/admin/photos-files/*).
//
//   GET  /photos-files/*                  → renditions _th/_lg (statique, authé)
//   GET  /api/picker/stats                → compteurs globaux
//   GET  /api/picker/criteria             → critères actifs
//   PUT  /api/picker/criteria             → nouvelle version active
//   POST /api/picker/batch?size=1|10|100  → scoring batch en arrière-plan → job_id
//   GET  /api/picker/batch/:id            → progression du job
//   GET  /api/picker/results              → liste scorings (filtre + pagination)
//   GET  /api/picker/results/:id          → détail scoring + photos
//   POST /api/picker/feedback             → 👍/👎/✏️ + commentaire (enrichit RAG)
//   POST /api/picker/apply-hero           → applique le choix IA d'un scoring en héro
//   POST /api/picker/import-index         → (ré)importe photos-index.json → salon_photos
//   GET  /api/picker/salon/:slug/photos   → photos d'un salon (modale stats.html)
//   POST /api/picker/salon/:slug/hero     → {photo_id, position} → héro
//   POST /api/picker/salon/:slug/gallery  → {photo_ids[]} → galerie

import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import db from '../db.js';
import { SALON_PHOTOS_DIR, dedupPhotosByPhash, describeAndEmbedPhoto, photoLgPath } from '../picker-core.js';
import { callEmbedding, isPickerAiConfigured } from '../picker-azure.js';
import { scoreSalonPhotos, pickNextUnscoredSalon, getActiveCriteria } from '../picker-scorer.js';
import { applyHero, applyGallery, resetImages } from '../photo-apply.js';

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

// --- Static renditions (authé car monté après requireAuth dans admin.js) ---
router.use('/photos-files', express.static(SALON_PHOTOS_DIR, {
  maxAge: '7d', immutable: true, fallthrough: false,
}));

// ---------------------------------------------------------------------------
// Import de l'index photos (photos-index.json → table salon_photos)
// ---------------------------------------------------------------------------
export function importPhotosIndex() {
  const indexPath = join(SALON_PHOTOS_DIR, 'photos-index.json');
  if (!existsSync(indexPath)) {
    return { ok: false, error: `Index introuvable: ${indexPath}` };
  }
  const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
  const upsert = db.prepare(`
    INSERT INTO salon_photos (google_id, dir, photo_id, kind, position, w, h, lowdef, lg_kb, th_kb, nom, ville, csv_source)
    VALUES (@google_id, @dir, @photo_id, @kind, @position, @w, @h, @lowdef, @lg_kb, @th_kb, @nom, @ville, @csv_source)
    ON CONFLICT(google_id, photo_id) DO UPDATE SET
      dir = excluded.dir, kind = excluded.kind, position = excluded.position,
      w = excluded.w, h = excluded.h, lowdef = excluded.lowdef,
      lg_kb = excluded.lg_kb, th_kb = excluded.th_kb
  `);
  let salons = 0, photos = 0;
  const tx = db.transaction((entries) => {
    for (const s of entries) {
      salons++;
      for (const p of (s.photos || [])) {
        photos++;
        upsert.run({
          google_id: s.google_id, dir: s.dir, photo_id: p.photo_id,
          kind: p.kind || null, position: p.position ?? null,
          w: p.w || null, h: p.h || null, lowdef: p.lowdef ? 1 : 0,
          lg_kb: p.lg_kb || null, th_kb: p.th_kb || null,
          nom: s.nom || null, ville: s.ville || null, csv_source: s.csv_source || null,
        });
      }
    }
  });
  tx(idx.salons || []);
  console.log(`[picker] import index: ${salons} salons, ${photos} photos`);
  return { ok: true, salons, photos };
}

// Auto-import au boot si la table est vide et que l'index est présent sur le volume.
setTimeout(() => {
  try {
    const c = db.prepare('SELECT COUNT(*) AS c FROM salon_photos').get().c;
    if (c === 0 && existsSync(join(SALON_PHOTOS_DIR, 'photos-index.json'))) {
      console.log('[picker] salon_photos vide + index présent → auto-import…');
      importPhotosIndex();
    }
  } catch (e) {
    console.warn('[picker] auto-import skip:', e.message);
  }
}, 3000);

router.post('/api/picker/import-index', (req, res) => {
  try {
    res.json(importPhotosIndex());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
router.get('/api/picker/stats', (req, res) => {
  const q = (sql) => db.prepare(sql).get().c;
  res.json({
    ai_configured: isPickerAiConfigured(),
    photos_total: q('SELECT COUNT(*) AS c FROM salon_photos'),
    salons_with_photos: q('SELECT COUNT(DISTINCT google_id) AS c FROM salon_photos'),
    salons_in_db_with_photos: q(`SELECT COUNT(*) AS c FROM salons s WHERE s.google_id IS NOT NULL AND s.google_id != '' AND EXISTS (SELECT 1 FROM salon_photos sp WHERE sp.google_id = s.google_id)`),
    scorings_total: q('SELECT COUNT(*) AS c FROM picker_scorings'),
    scorings_with_pick: q('SELECT COUNT(*) AS c FROM picker_scorings WHERE selected_photo_id IS NOT NULL'),
    scorings_no_suitable: q('SELECT COUNT(*) AS c FROM picker_scorings WHERE selected_photo_id IS NULL AND error IS NULL'),
    scorings_errors: q("SELECT COUNT(*) AS c FROM picker_scorings WHERE error IS NOT NULL AND error != 'no_photos'"),
    heroes_applied: q('SELECT COUNT(*) AS c FROM picker_scorings WHERE applied_hero_at IS NOT NULL'),
    feedback_total: q('SELECT COUNT(*) AS c FROM picker_feedback'),
    feedback_good: q("SELECT COUNT(*) AS c FROM picker_feedback WHERE rating = 'good'"),
    feedback_bad: q("SELECT COUNT(*) AS c FROM picker_feedback WHERE rating = 'bad'"),
    total_cost_eur: db.prepare('SELECT COALESCE(SUM(cost_eur), 0) AS c FROM picker_scorings').get().c,
  });
});

// ---------------------------------------------------------------------------
// Critères
// ---------------------------------------------------------------------------
router.get('/api/picker/criteria', (req, res) => {
  try {
    const c = getActiveCriteria();
    res.json(c);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.put('/api/picker/criteria', (req, res) => {
  const { label, rubric } = req.body || {};
  if (!Array.isArray(rubric) || rubric.length === 0) {
    return res.status(400).json({ error: 'rubric (array non vide) requis' });
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE picker_criteria SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('INSERT INTO picker_criteria (label, rubric_json, is_active) VALUES (?, ?, 1)')
      .run(label || `v${Date.now()}`, JSON.stringify(rubric));
  });
  tx();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Batch scoring (jobs en mémoire, fire-and-forget + poll)
// ---------------------------------------------------------------------------
const batchJobs = new Map();

router.post('/api/picker/batch', (req, res) => {
  if (!isPickerAiConfigured()) {
    return res.status(503).json({ error: 'Azure OpenAI non configuré (AZURE_OPENAI_KEY manquante)' });
  }
  const size = parseInt(req.query.size || '1', 10);
  if (![1, 10, 100].includes(size)) {
    return res.status(400).json({ error: 'size doit être 1, 10 ou 100' });
  }
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, size,
    started_at: new Date().toISOString(), finished_at: null,
    done: 0, success: 0, no_suitable: 0, no_photos: 0, errors: 0,
    exhausted: false, last_result: null, cost_total_eur: 0,
  };
  batchJobs.set(jobId, job);
  // Garde les 50 derniers jobs
  if (batchJobs.size > 50) batchJobs.delete(batchJobs.keys().next().value);

  (async () => {
    for (let i = 0; i < size; i++) {
      const next = pickNextUnscoredSalon();
      if (!next) { job.exhausted = true; break; }
      try {
        const r = await scoreSalonPhotos(next.google_id, { slug: next.slug || null });
        job.done++;
        job.last_result = { google_id: r.google_id, nom: next.nom, selected: !!r.selected_photo_id, error: r.error || null };
        if (r.no_photos) job.no_photos++;
        else if (r.error) job.errors++;
        else if (!r.selected_photo_id) job.no_suitable++;
        else job.success++;
        if (r.cost_eur) job.cost_total_eur += r.cost_eur;
      } catch (e) {
        job.done++;
        job.errors++;
        job.last_result = { error: e.message };
      }
    }
    job.finished_at = new Date().toISOString();
  })();

  res.json({ ok: true, job_id: jobId });
});

router.get('/api/picker/batch/:id', (req, res) => {
  const job = batchJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job introuvable' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------
function photoUrls(p) {
  return {
    th: `/admin/photos-files/${encodeURIComponent(p.dir)}/${encodeURIComponent(p.photo_id)}_th.jpg`,
    lg: `/admin/photos-files/${encodeURIComponent(p.dir)}/${encodeURIComponent(p.photo_id)}_lg.jpg`,
  };
}

router.get('/api/picker/results', async (req, res) => {
  const filter = req.query.filter || 'all';
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);

  let where = '1=1';
  if (filter === 'pick') where = 'sc.selected_photo_id IS NOT NULL AND sc.error IS NULL';
  else if (filter === 'no_suitable') where = 'sc.selected_photo_id IS NULL AND sc.error IS NULL';
  else if (filter === 'errors') where = "sc.error IS NOT NULL";
  else if (filter === 'feedback_pending')
    where = 'sc.error IS NULL AND NOT EXISTS (SELECT 1 FROM picker_feedback pf WHERE pf.scoring_id = sc.id)';
  else if (filter === 'applied') where = 'sc.applied_hero_at IS NOT NULL';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM picker_scorings sc WHERE ${where}`).get().c;
  const rows = db.prepare(`
    SELECT sc.id AS scoring_id, sc.google_id, sc.slug, sc.selected_photo_id, sc.overall_score,
           sc.reasoning, sc.per_photo_scores, sc.rag_examples_used, sc.cost_eur, sc.latency_ms, sc.created_at,
           sc.error, sc.applied_hero_at,
           (SELECT rating FROM picker_feedback pf WHERE pf.scoring_id = sc.id ORDER BY pf.id DESC LIMIT 1) AS feedback_rating
    FROM picker_scorings sc
    WHERE ${where}
    ORDER BY sc.created_at DESC, sc.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  for (const r of rows) {
    const meta = db.prepare('SELECT nom, ville FROM salon_photos WHERE google_id = ? LIMIT 1').get(r.google_id);
    r.nom = meta?.nom || r.google_id;
    r.ville = meta?.ville || '';
    const rawPhotos = db.prepare('SELECT id, photo_id, dir, lowdef FROM salon_photos WHERE google_id = ? ORDER BY COALESCE(position,99), id').all(r.google_id);
    const dedup = await dedupPhotosByPhash(rawPhotos, r.selected_photo_id);
    let perScores = {};
    try { for (const s of JSON.parse(r.per_photo_scores || '[]')) perScores[s.photo_id] = s.score; } catch {}
    r.photos = dedup.kept.slice(0, 15).map((p) => ({
      photo_id: p.photo_id, lowdef: !!p.lowdef, score: perScores[p.photo_id] ?? null, ...photoUrls(p),
    }));
    delete r.per_photo_scores;
    // slug live : si pas snapshotté au scoring, tente le match maintenant
    if (!r.slug) {
      const s = db.prepare("SELECT slug FROM salons WHERE google_id = ? LIMIT 1").get(r.google_id);
      r.slug = s?.slug || null;
    }
  }
  res.json({ total, limit, offset, rows });
});

router.get('/api/picker/results/:id', async (req, res) => {
  const r = db.prepare('SELECT * FROM picker_scorings WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!r) return res.status(404).json({ error: 'scoring introuvable' });
  const meta = db.prepare('SELECT nom, ville FROM salon_photos WHERE google_id = ? LIMIT 1').get(r.google_id);
  const rawPhotos = db.prepare('SELECT id, photo_id, dir, kind, lowdef, w, h FROM salon_photos WHERE google_id = ? ORDER BY COALESCE(position,99), id').all(r.google_id);
  const dedup = await dedupPhotosByPhash(rawPhotos, r.selected_photo_id);
  let perPhoto = [];
  try { perPhoto = JSON.parse(r.per_photo_scores || '[]'); } catch {}
  const feedback = db.prepare('SELECT id, rating, comment, corrected_photo_id, created_at FROM picker_feedback WHERE scoring_id = ? ORDER BY id DESC LIMIT 1').get(r.id);
  if (!r.slug) {
    const s = db.prepare('SELECT slug FROM salons WHERE google_id = ? LIMIT 1').get(r.google_id);
    r.slug = s?.slug || null;
  }
  res.json({
    scoring_id: r.id,
    google_id: r.google_id,
    slug: r.slug,
    nom: meta?.nom, ville: meta?.ville,
    selected_photo_id: r.selected_photo_id,
    overall_score: r.overall_score,
    reasoning: r.reasoning,
    per_photo: perPhoto,
    photos: dedup.kept.map((p) => ({ photo_id: p.photo_id, kind: p.kind, lowdef: !!p.lowdef, w: p.w, h: p.h, ...photoUrls(p) })),
    rag_examples_used: r.rag_examples_used,
    cost_eur: r.cost_eur, latency_ms: r.latency_ms,
    created_at: r.created_at, error: r.error,
    applied_hero_at: r.applied_hero_at,
    feedback,
  });
});

// ---------------------------------------------------------------------------
// Feedback humain → enrichit le RAG (embedding en arrière-plan, non bloquant)
// ---------------------------------------------------------------------------
router.post('/api/picker/feedback', (req, res) => {
  const { scoring_id, rating, comment, corrected_photo_id } = req.body || {};
  if (!scoring_id || !['good', 'bad', 'edit'].includes(rating)) {
    return res.status(400).json({ error: 'scoring_id + rating (good|bad|edit) requis' });
  }
  if (corrected_photo_id && rating !== 'edit') {
    return res.status(400).json({ error: 'corrected_photo_id réservé au rating=edit' });
  }
  const sc = db.prepare('SELECT google_id, selected_photo_id FROM picker_scorings WHERE id = ?').get(scoring_id);
  if (!sc) return res.status(404).json({ error: 'scoring introuvable' });

  const ins = db.prepare(`
    INSERT INTO picker_feedback (scoring_id, google_id, photo_id, rating, comment, corrected_photo_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scoring_id, sc.google_id, sc.selected_photo_id, rating, comment || null, corrected_photo_id || null);
  const feedbackId = ins.lastInsertRowid;

  (async () => {
    try {
      let embedding = null;
      if (sc.selected_photo_id) {
        const photo = db.prepare('SELECT id, dir, photo_id FROM salon_photos WHERE google_id = ? AND photo_id = ?').get(sc.google_id, sc.selected_photo_id);
        if (photo) {
          const p = photoLgPath(photo.dir, photo.photo_id);
          if (existsSync(p)) {
            const r = await describeAndEmbedPhoto(photo.id, p);
            embedding = r.embedding;
          }
        }
      }
      if (!embedding && comment) {
        const r = await callEmbedding(comment);
        embedding = r.vector;
      }
      if (embedding) {
        db.prepare('UPDATE picker_feedback SET embedding_json = ?, embedding_dims = ? WHERE id = ?')
          .run(JSON.stringify(embedding), embedding.length, feedbackId);
      }
    } catch (e) {
      console.warn(`[picker-feedback] embedding fail (non-bloquant): ${e.message}`);
    }
  })();

  res.json({ ok: true, feedback_id: feedbackId });
});

// ---------------------------------------------------------------------------
// Application héro depuis un scoring (bouton "Appliquer" de la page Photos IA)
// ---------------------------------------------------------------------------
router.post('/api/picker/apply-hero', async (req, res) => {
  const { scoring_id, photo_id, position } = req.body || {};
  if (!scoring_id) return res.status(400).json({ error: 'scoring_id requis' });
  const sc = db.prepare('SELECT id, google_id, slug, selected_photo_id FROM picker_scorings WHERE id = ?').get(scoring_id);
  if (!sc) return res.status(404).json({ error: 'scoring introuvable' });
  const usePhotoId = photo_id || sc.selected_photo_id;
  if (!usePhotoId) return res.status(400).json({ error: 'Aucune photo sélectionnée dans ce scoring' });

  let slug = sc.slug;
  if (!slug) {
    const s = db.prepare('SELECT slug FROM salons WHERE google_id = ? LIMIT 1').get(sc.google_id);
    slug = s?.slug;
  }
  if (!slug) return res.status(409).json({ error: 'Ce salon n\'existe pas dans la base des démos (pas de slug)' });

  try {
    const result = await applyHero({ slug, photoId: usePhotoId, position: position || 'centre', googleId: sc.google_id });
    db.prepare("UPDATE picker_scorings SET applied_hero_at = datetime('now'), slug = ? WHERE id = ?").run(slug, sc.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Photos d'un salon (modale 📷 de stats.html) + application directe
// ---------------------------------------------------------------------------
router.get('/api/picker/salon/:slug/photos', async (req, res) => {
  const salon = db.prepare('SELECT id, slug, google_id, overrides_json, edit_token FROM salons WHERE slug = ?').get(req.params.slug);
  if (!salon) return res.status(404).json({ error: 'Salon introuvable' });
  if (!salon.google_id) return res.json({ slug: salon.slug, google_id: null, photos: [], reason: 'Pas de google_id pour ce salon (CSV ancien ?)' });

  const rawPhotos = db.prepare('SELECT id, photo_id, dir, kind, lowdef, w, h FROM salon_photos WHERE google_id = ? ORDER BY COALESCE(position,99), id').all(salon.google_id);
  const dedup = await dedupPhotosByPhash(rawPhotos);

  // Choix IA le plus récent (pour le badge ⭐ dans la modale)
  const lastScoring = db.prepare(`
    SELECT id, selected_photo_id, reasoning, created_at FROM picker_scorings
    WHERE google_id = ? AND error IS NULL ORDER BY id DESC LIMIT 1
  `).get(salon.google_id);

  let heroCurrent = null;
  try { heroCurrent = JSON.parse(salon.overrides_json || '{}')?.hero?.backgroundImage || null; } catch {}

  res.json({
    slug: salon.slug,
    google_id: salon.google_id,
    edit_token: salon.edit_token,
    hero_current: heroCurrent,
    ai_pick: lastScoring ? { scoring_id: lastScoring.id, photo_id: lastScoring.selected_photo_id, reasoning: lastScoring.reasoning, created_at: lastScoring.created_at } : null,
    photos: dedup.kept.map((p) => ({ photo_id: p.photo_id, kind: p.kind, lowdef: !!p.lowdef, w: p.w, h: p.h, ...photoUrls(p) })),
  });
});

router.post('/api/picker/salon/:slug/hero', async (req, res) => {
  const { photo_id, position } = req.body || {};
  if (!photo_id) return res.status(400).json({ error: 'photo_id requis' });
  try {
    const result = await applyHero({ slug: req.params.slug, photoId: photo_id, position: position || 'centre' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/picker/salon/:slug/gallery', async (req, res) => {
  const { photo_ids, mode } = req.body || {};
  try {
    const result = await applyGallery({ slug: req.params.slug, photoIds: photo_ids, mode: mode === 'append' ? 'append' : 'replace' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Réinitialise héro + galerie aux images du mode démo (retire les photos Google)
router.post('/api/picker/salon/:slug/reset-images', (req, res) => {
  try {
    const result = resetImages({ slug: req.params.slug });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scorer UN salon précis à la demande (depuis la modale stats)
router.post('/api/picker/salon/:slug/score', async (req, res) => {
  if (!isPickerAiConfigured()) {
    return res.status(503).json({ error: 'Azure OpenAI non configuré' });
  }
  const salon = db.prepare('SELECT slug, google_id FROM salons WHERE slug = ?').get(req.params.slug);
  if (!salon) return res.status(404).json({ error: 'Salon introuvable' });
  if (!salon.google_id) return res.status(409).json({ error: 'Pas de google_id pour ce salon' });
  try {
    const r = await scoreSalonPhotos(salon.google_id, { slug: salon.slug });
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Sélection MANUELLE par région (onglet « Sélection manuelle » de photos.html)
//   GET /api/picker/groups        → régions (groupes salon_groups) + nb de salons avec photos
//   GET /api/picker/manual-salons → salons d'une région (group_id) + leurs photos dédupliquées
// ---------------------------------------------------------------------------
router.get('/api/picker/groups', (req, res) => {
  const rows = db.prepare(`
    SELECT g.id AS group_id, g.name,
      (SELECT COUNT(*) FROM salons s
        WHERE s.group_id = g.id AND s.google_id IS NOT NULL AND s.google_id != ''
          AND EXISTS (SELECT 1 FROM salon_photos sp WHERE sp.google_id = s.google_id)) AS salons
    FROM salon_groups g
    ORDER BY salons DESC
  `).all().filter((r) => r.salons > 0);
  res.json({ groups: rows });
});

router.get('/api/picker/manual-salons', async (req, res) => {
  const groupId = (req.query.group_id || '').toString();
  if (!groupId) return res.status(400).json({ error: 'group_id requis' });
  const limit = Math.min(parseInt(req.query.limit || '8', 10), 24);
  const offset = parseInt(req.query.offset || '0', 10);
  const isNone = groupId === 'none';
  const whereGrp = isNone ? 's.group_id IS NULL' : 's.group_id = ?';
  const grpParams = isNone ? [] : [parseInt(groupId, 10)];
  const baseWhere = `${whereGrp} AND s.google_id IS NOT NULL AND s.google_id != '' AND EXISTS (SELECT 1 FROM salon_photos sp WHERE sp.google_id = s.google_id)`;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM salons s WHERE ${baseWhere}`).get(...grpParams).c;
  const salons = db.prepare(`
    SELECT s.id, s.slug, s.nom, s.ville, s.google_id, s.overrides_json
    FROM salons s WHERE ${baseWhere}
    ORDER BY s.nom COLLATE NOCASE, s.id
    LIMIT ? OFFSET ?
  `).all(...grpParams, limit, offset);

  const out = [];
  for (const s of salons) {
    const rawPhotos = db.prepare('SELECT id, photo_id, dir, lowdef FROM salon_photos WHERE google_id = ? ORDER BY COALESCE(position,99), id').all(s.google_id);
    const dedup = await dedupPhotosByPhash(rawPhotos);
    const lastScoring = db.prepare("SELECT selected_photo_id FROM picker_scorings WHERE google_id = ? AND error IS NULL ORDER BY id DESC LIMIT 1").get(s.google_id);
    let heroApplied = false, galleryCount = 0;
    try {
      const ov = JSON.parse(s.overrides_json || '{}') || {};
      heroApplied = !!(ov.hero && ov.hero.backgroundImage);
      if (ov.gallery && ov.gallery.imagesSource === 'photo-picker' && Array.isArray(ov.gallery.images)) galleryCount = ov.gallery.images.length;
    } catch {}
    out.push({
      slug: s.slug, nom: s.nom, ville: s.ville,
      hero_applied: heroApplied, gallery_custom: galleryCount,
      ai_pick_photo_id: lastScoring ? lastScoring.selected_photo_id : null,
      photos: dedup.kept.slice(0, 15).map((p) => ({ photo_id: p.photo_id, lowdef: !!p.lowdef, ...photoUrls(p) })),
    });
  }
  res.json({ total, limit, offset, group_id: groupId, salons: out });
});

export default router;

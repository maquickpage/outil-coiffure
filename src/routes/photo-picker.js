// Routes du photo-picker (admin agence uniquement, Helsinki).
// Monté DANS src/routes/admin.js APRÈS router.use(requireAuth) → tout est
// derrière le login admin, y compris les fichiers images (/admin/photos-files/*).
//
//   GET  /photos-files/*                  → renditions _th/_lg (statique, authé)
//   GET  /api/picker/stats                → compteurs globaux
//   GET  /api/picker/criteria             → critères actifs
//   PUT  /api/picker/criteria             → nouvelle version active
//   GET  /api/picker/scope                → compte les salons du filtre courant
//   POST /api/picker/batch?size=1|10|100  → scoring batch en arrière-plan → job_id
//                                           (+ filtres group_id/csv_source/search/contact_status)
//   GET  /api/picker/batch/:id            → progression du job
//   GET  /api/picker/results              → liste scorings (filtre + pagination)
//   GET  /api/picker/results/:id          → détail scoring + photos
//   POST /api/picker/feedback             → 👍/👎/✏️ + commentaire (enrichit RAG)
//   POST /api/picker/apply-hero           → applique le choix IA d'un scoring en héro
//   POST /api/picker/import-index         → (ré)importe photos-index.json → salon_photos
//   GET  /api/picker/salon/:slug/photos   → photos d'un salon (modale stats.html)
//   POST /api/picker/salon/:slug/hero     → {photo_id, position} → héro
//   POST /api/picker/salon/:slug/gallery  → {photo_ids[]} → galerie
//   POST /api/picker/gallery-default      → lot : toutes les photos en galerie
//                                           pour les salons du filtre → job_id
//   GET  /api/picker/gallery-default/:id  → progression du lot galerie

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

// ---------------------------------------------------------------------------
// Filtre de salons partagé par les deux vues (IA + manuelle).
// Mêmes critères que le tableau de bord (group_id, csv_source, search,
// contact_status) — « confiés au séquenceur » inclus, pour pouvoir préparer
// les photos des salons qui vont partir en prospection.
// Toujours restreint aux salons ayant un google_id ET des photos indexées.
// L'alias de la table salons doit être `s`.
// ---------------------------------------------------------------------------
const PHOTOS_BASE_WHERE = `s.google_id IS NOT NULL AND s.google_id != ''
  AND EXISTS (SELECT 1 FROM salon_photos sp WHERE sp.google_id = s.google_id)`;

// Galerie « par défaut » = les photos Google du salon. Un salon dont la galerie
// ne vient pas du photo-picker affiche encore les images génériques du mode démo.
// (saveOverrides sérialise sans espaces → la signature JSON est stable.)
const GALLERY_MISSING_SQL = `(s.overrides_json IS NULL
  OR s.overrides_json NOT LIKE '%"imagesSource":"photo-picker"%')`;

function salonFilter(q = {}, seqSlugs = null) {
  const conds = [];
  const params = [];
  // Restriction par statut de lead séquenceur (queued, active, replied…) :
  // la liste de slugs est résolue en amont par resolveSeqSlugs() car ces
  // statuts vivent sur les nœuds, pas en base. json_each évite un IN (?,?,…)
  // de plusieurs milliers de paramètres.
  if (seqSlugs) {
    conds.push('s.slug IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(seqSlugs));
  }
  const gid = (q.group_id == null ? '' : String(q.group_id)).trim();
  if (gid === 'manuel') conds.push("s.csv_source = 'manuel'");
  else if (gid === 'none') conds.push('s.group_id IS NULL');
  else if (gid && gid !== 'all') {
    const n = parseInt(gid, 10);
    if (Number.isFinite(n)) { conds.push('s.group_id = ?'); params.push(n); }
  }
  if (q.csv_source) { conds.push('s.csv_source = ?'); params.push(String(q.csv_source)); }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`;
    conds.push('(s.nom LIKE ? OR s.nom_clean LIKE ? OR s.ville LIKE ? OR s.slug LIKE ?)');
    params.push(s, s, s, s);
  }
  // Statut cold-mail : mêmes définitions que src/routes/admin.js (coldMailConds).
  const cs = q.contact_status;
  if (cs === 'never') conds.push('s.cold_mail_campaign IS NULL');
  else if (cs === 'contacted') conds.push('s.cold_mail_campaign IS NOT NULL');
  else if (cs === 'sequenced') conds.push('EXISTS (SELECT 1 FROM sequencer_leads q WHERE q.salon_slug = s.slug)');
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params };
}

function filterFromQuery(src = {}) {
  return {
    group_id: src.group_id, csv_source: src.csv_source,
    search: src.search, contact_status: src.contact_status,
    seq_status: src.seq_status, sort: src.sort,
  };
}

// Salons du séquenceur, dans l'ordre où ils vont être démarchés, éventuellement
// restreints à un statut de lead. Renvoie null quand le séquenceur n'est pas
// concerné. `nodes_ok < nodes_total` signale une liste partielle : un nœud
// injoignable cache ses leads.
async function resolveSeqSlugs(filter, opts = {}) {
  const veutOrdre = filter.sort === 'send_order';
  if (filter.contact_status !== 'sequenced' || (!filter.seq_status && !veutOrdre)) return null;
  const { statutsLeadsParEmail } = await import('./sequencer.js');
  const { infos, nodes_ok, nodes_total, nodes } = await statutsLeadsParEmail(opts);
  const rows = db.prepare("SELECT email, salon_slug FROM sequencer_leads WHERE salon_slug IS NOT NULL AND salon_slug != ''").all();
  const items = [];
  for (const r of rows) {
    const info = infos.get(String(r.email || '').trim().toLowerCase());
    if (!info) continue; // lead absent des nœuds (nœud tombé, ou lead retiré)
    if (filter.seq_status && info.status !== filter.seq_status) continue;
    items.push({ slug: r.salon_slug, rank: info.rank, info });
  }
  items.sort((a, b) => a.rank - b.rank);
  // Un salon peut avoir PLUSIEURS emails confiés au séquenceur (la clé de
  // sequencer_leads est l'email, pas le slug). Sans ce dédoublonnage, la liste
  // de slugs contient le même slug N fois → le JOIN json_each duplique la carte
  // du salon dans les deux vues. On garde le lead le mieux placé dans la file.
  const bySlug = {};
  const slugs = [];
  for (const it of items) {
    if (bySlug[it.slug]) continue;
    bySlug[it.slug] = {
      status: it.info.status, mailbox: it.info.mailbox, step: it.info.step,
      next_send_at: it.info.next_send_at, queue_pos: slugs.length + 1,
    };
    slugs.push(it.slug);
  }
  return { slugs, bySlug, ordered: veutOrdre, nodes_ok, nodes_total, nodes };
}

// Prépare filtre + restriction séquenceur en un appel (utilisé par toutes les routes).
// `seq_retry=1` en query → relance les nœuds tombés sans attendre l'expiration du cache.
//
// Deux formes de restriction séquenceur, selon le besoin de l'appelant :
//   - `f` (IN json_each) pour les COMPTES, où l'ordre n'a aucune importance ;
//   - `join`/`order` pour les LISTES, où l'ordre d'envoi est justement le sujet
//     (un JOIN sur json_each donne l'ordre du tableau via sa clé).
async function prepareFilter(query) {
  const filter = filterFromQuery(query);
  const seq = await resolveSeqSlugs(filter, { retryFailed: query.seq_retry === '1' });
  const ordonne = !!(seq && seq.ordered);
  const f = salonFilter(filter, seq ? seq.slugs : null);
  const liste = ordonne
    ? {
        join: 'JOIN json_each(?) j ON j.value = s.slug',
        joinParams: [JSON.stringify(seq.slugs)],
        order: 'ORDER BY j.key',
        f: salonFilter(filter, null), // la jointure fait déjà la restriction
      }
    : { join: '', joinParams: [], order: 'ORDER BY s.nom COLLATE NOCASE, s.id', f };
  return { filter, seq, f, liste };
}

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

// Salons jamais scorés (sans erreur) qui matchent le filtre courant, dans
// l'ordre de la liste — donc, en mode séquenceur, les prochains démarchés
// d'abord : le scoring IA sert à préparer les envois qui arrivent.
function unscoredSalons(liste, limit) {
  return db.prepare(`
    SELECT s.slug, s.google_id, COALESCE(NULLIF(TRIM(s.nom_clean), ''), s.nom) AS nom, s.ville
    FROM salons s ${liste.join}
    WHERE ${PHOTOS_BASE_WHERE}${liste.f.sql}
      AND NOT EXISTS (SELECT 1 FROM picker_scorings sc WHERE sc.google_id = s.google_id AND sc.error IS NULL)
    ${liste.join ? liste.order : 'ORDER BY s.id'}
    LIMIT ?
  `).all(...liste.joinParams, ...liste.f.params, limit);
}

// Combien de salons le filtre courant sélectionne, et combien restent à scorer.
router.get('/api/picker/scope', async (req, res) => {
  let f, seq;
  try { ({ f, seq } = await prepareFilter(req.query)); }
  catch (e) { return res.status(502).json({ error: 'Séquenceur injoignable : ' + e.message }); }
  const salons = db.prepare(`SELECT COUNT(*) AS c FROM salons s WHERE ${PHOTOS_BASE_WHERE}${f.sql}`).get(...f.params).c;
  const unscored = db.prepare(`
    SELECT COUNT(*) AS c FROM salons s
    WHERE ${PHOTOS_BASE_WHERE}${f.sql}
      AND NOT EXISTS (SELECT 1 FROM picker_scorings sc WHERE sc.google_id = s.google_id AND sc.error IS NULL)
  `).get(...f.params).c;
  const hero = db.prepare(`
    SELECT COUNT(*) AS c FROM salons s
    WHERE ${PHOTOS_BASE_WHERE}${f.sql} AND s.overrides_json LIKE '%backgroundImage%'
  `).get(...f.params).c;
  // Salons du périmètre dont la galerie n'est PAS encore celle de leurs propres
  // photos Google (= ils affichent encore les images du mode démo).
  const galleryMissing = db.prepare(`
    SELECT COUNT(*) AS c FROM salons s
    WHERE ${PHOTOS_BASE_WHERE}${f.sql} AND ${GALLERY_MISSING_SQL}
  `).get(...f.params).c;
  res.json({
    salons, unscored, hero_applied: hero, gallery_missing: galleryMissing,
    seq_nodes: seq ? { ok: seq.nodes_ok, total: seq.nodes_total, nodes: seq.nodes } : null,
  });
});

router.post('/api/picker/batch', async (req, res) => {
  if (!isPickerAiConfigured()) {
    return res.status(503).json({ error: 'Azure OpenAI non configuré (AZURE_OPENAI_KEY manquante)' });
  }
  const size = parseInt(req.query.size || '1', 10);
  if (![1, 10, 100].includes(size)) {
    return res.status(400).json({ error: 'size doit être 1, 10 ou 100' });
  }
  // Filtre optionnel (barre de sélection des salons) : si présent, le batch ne
  // score QUE des salons de ce périmètre, dans l'ordre. Sinon, comportement
  // historique = pickNextUnscoredSalon() (tous les salons en BDD).
  let filter, liste;
  try { ({ filter, liste } = await prepareFilter(req.query)); }
  catch (e) { return res.status(502).json({ error: 'Séquenceur injoignable : ' + e.message }); }
  // `sort` n'est pas un filtre : trier seul ne restreint pas le périmètre.
  const scoped = Object.entries(filter)
    .some(([k, v]) => k !== 'sort' && v != null && v !== '' && v !== 'all');
  const queue = scoped ? unscoredSalons(liste, size) : null;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, size,
    started_at: new Date().toISOString(), finished_at: null,
    done: 0, success: 0, no_suitable: 0, no_photos: 0, errors: 0, skipped: 0,
    exhausted: false, last_result: null, cost_total_eur: 0,
  };
  batchJobs.set(jobId, job);
  // Garde les 50 derniers jobs
  if (batchJobs.size > 50) batchJobs.delete(batchJobs.keys().next().value);

  (async () => {
    for (let i = 0; i < size; i++) {
      const next = queue ? queue[i] : pickNextUnscoredSalon();
      if (!next) { job.exhausted = true; break; }
      // La file est figée au lancement du lot. Si un autre lot (ou un double clic)
      // a scoré ce salon entre-temps, on ne le repaie pas : sans ce garde-fou on
      // obtenait deux cartes identiques dans le feed, facturées deux fois.
      const dejaScore = db.prepare(
        'SELECT 1 FROM picker_scorings WHERE google_id = ? AND error IS NULL LIMIT 1'
      ).get(next.google_id);
      if (dejaScore) { job.done++; job.skipped++; continue; }
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

// Condition d'un onglet du feed, exprimée sur un alias de picker_scorings —
// paramétrée par l'alias pour pouvoir être réutilisée sur le scoring « suivant »
// (voir le NOT EXISTS de dédoublonnage ci-dessous).
function scoringWhere(filter, a = 'sc') {
  if (filter === 'pick') return `${a}.selected_photo_id IS NOT NULL AND ${a}.error IS NULL`;
  if (filter === 'no_suitable') return `${a}.selected_photo_id IS NULL AND ${a}.error IS NULL`;
  if (filter === 'errors') return `${a}.error IS NOT NULL`;
  if (filter === 'feedback_pending') return `${a}.error IS NULL AND NOT EXISTS (SELECT 1 FROM picker_feedback pf WHERE pf.scoring_id = ${a}.id)`;
  if (filter === 'applied') return `${a}.applied_hero_at IS NOT NULL`;
  return '1=1';
}

router.get('/api/picker/results', async (req, res) => {
  const filter = req.query.filter || 'all';
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);

  // Un salon peut porter PLUSIEURS scorings (rescoring depuis la modale « Avis
  // de l'IA », lots successifs) : sans ce filtre la même carte apparaît deux
  // fois. On ne garde que le scoring le plus récent PARMI CEUX qui matchent
  // l'onglet courant — un onglet par onglet, une carte par salon.
  let where = `(${scoringWhere(filter)})`
    + ` AND NOT EXISTS (SELECT 1 FROM picker_scorings sc2
          WHERE sc2.google_id = sc.google_id AND sc2.id > sc.id AND (${scoringWhere(filter, 'sc2')}))`;

  // Même périmètre de salons que la barre de sélection (région, source,
  // recherche, statut de contact) : le feed ne montre que ces salons-là.
  let f, seq, liste;
  try { ({ f, seq, liste } = await prepareFilter(req.query)); }
  catch (e) { return res.status(502).json({ error: 'Séquenceur injoignable : ' + e.message }); }

  // En tri « ordre d'envoi », le feed doit suivre la file de démarchage et non
  // la date de scoring : sinon la page Photos et l'onglet Leads du séquenceur
  // affichent deux listes sans rapport. La jointure sur json_each porte l'ordre
  // dans sa clé, et remplace la restriction par IN.
  let join = '', joinParams = [], order = 'ORDER BY sc.created_at DESC, sc.id DESC';
  const params = [];
  if (liste.join) {
    join = `JOIN salons s ON s.google_id = sc.google_id ${liste.join}`;
    joinParams = liste.joinParams;
    params.push(...joinParams);
    where += ` AND ${PHOTOS_BASE_WHERE}${liste.f.sql}`;
    params.push(...liste.f.params);
    order = 'ORDER BY j.key, sc.id DESC';
  } else if (f.sql) {
    where += ` AND EXISTS (SELECT 1 FROM salons s WHERE s.google_id = sc.google_id AND ${PHOTOS_BASE_WHERE}${f.sql})`;
    params.push(...f.params);
  }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM picker_scorings sc ${join} WHERE ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT sc.id AS scoring_id, sc.google_id, sc.slug, sc.selected_photo_id, sc.overall_score,
           sc.reasoning, sc.per_photo_scores, sc.rag_examples_used, sc.cost_eur, sc.latency_ms, sc.created_at,
           sc.error, sc.applied_hero_at,
           (SELECT rating FROM picker_feedback pf WHERE pf.scoring_id = sc.id ORDER BY pf.id DESC LIMIT 1) AS feedback_rating
    FROM picker_scorings sc ${join}
    WHERE ${where}
    ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

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
    // Position dans la file d'envoi, pour retrouver le salon dans le séquenceur
    r.seq = seq && seq.bySlug ? (seq.bySlug[r.slug] || null) : null;
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

// ---------------------------------------------------------------------------
// Galerie par défaut = TOUTES les photos du salon
//
// Règle produit : les photos d'un salon sont dans SA galerie d'office ; on ne
// fait que retirer celles qu'on ne veut pas. Le site public ne sait pas lire le
// volume /data/salon-photos (servi derrière le login admin) : chaque photo doit
// être recadrée + uploadée en object storage. Ce lot fait ce travail pour tout
// le périmètre du filtre, en arrière-plan (même mécanique que le lot de scoring).
// ---------------------------------------------------------------------------
const GALLERY_MAX = 12;          // même plafond que photo-apply.js
const GALLERY_BATCH_MAX = 200;   // garde-fou : 200 salons × 12 uploads par lancement
const galleryJobs = new Map();

router.post('/api/picker/gallery-default', async (req, res) => {
  let liste;
  try { ({ liste } = await prepareFilter(req.query)); }
  catch (e) { return res.status(502).json({ error: 'Séquenceur injoignable : ' + e.message }); }
  // only_missing=0 → réapplique aussi les salons qui ont déjà une galerie perso
  const onlyMissing = req.query.only_missing !== '0';
  const cond = onlyMissing ? ` AND ${GALLERY_MISSING_SQL}` : '';
  const found = db.prepare(`
    SELECT s.slug, s.google_id FROM salons s ${liste.join}
    WHERE ${PHOTOS_BASE_WHERE}${liste.f.sql}${cond}
    ${liste.order}
    LIMIT ?
  `).all(...liste.joinParams, ...liste.f.params, GALLERY_BATCH_MAX + 1);
  const capped = found.length > GALLERY_BATCH_MAX;
  const queue = found.slice(0, GALLERY_BATCH_MAX);

  const jobId = `gal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, size: queue.length, done: 0, applied: 0, photos: 0, errors: 0, skipped: 0,
    capped, cap: GALLERY_BATCH_MAX, started_at: new Date().toISOString(), finished_at: null, last_error: null,
  };
  galleryJobs.set(jobId, job);
  if (galleryJobs.size > 20) galleryJobs.delete(galleryJobs.keys().next().value);

  (async () => {
    for (const s of queue) {
      try {
        const raw = db.prepare('SELECT id, photo_id, dir, lowdef FROM salon_photos WHERE google_id = ? ORDER BY COALESCE(position,99), id').all(s.google_id);
        const dedup = await dedupPhotosByPhash(raw);
        const ids = dedup.kept.slice(0, GALLERY_MAX).map((p) => p.photo_id);
        if (!ids.length) { job.done++; job.skipped++; continue; }
        const r = await applyGallery({ slug: s.slug, photoIds: ids, mode: 'replace', googleId: s.google_id });
        job.done++; job.applied++; job.photos += r.count;
      } catch (e) {
        job.done++; job.errors++; job.last_error = `${s.slug}: ${e.message}`;
      }
    }
    job.finished_at = new Date().toISOString();
  })();

  res.json({ ok: true, job_id: jobId, size: job.size, capped, cap: GALLERY_BATCH_MAX });
});

router.get('/api/picker/gallery-default/:id', (req, res) => {
  const job = galleryJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job introuvable' });
  res.json(job);
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
  // Entrée synthétique : salons créés à la main (csv_source='manuel') avec photos.
  const manuel = db.prepare(`
    SELECT COUNT(*) AS c FROM salons s
    WHERE s.csv_source = 'manuel' AND s.google_id IS NOT NULL AND s.google_id != ''
      AND EXISTS (SELECT 1 FROM salon_photos sp WHERE sp.google_id = s.google_id)
  `).get().c;
  const out = manuel > 0 ? [{ group_id: 'manuel', name: '✋ Créés à la main', salons: manuel }, ...rows] : rows;
  // Sources CSV (départements) présentes parmi les salons avec photos + total
  // global : alimente la barre de sélection commune aux deux vues.
  const csvSources = db.prepare(`
    SELECT s.csv_source, COUNT(*) AS n FROM salons s
    WHERE ${PHOTOS_BASE_WHERE} AND s.csv_source IS NOT NULL AND s.csv_source != ''
    GROUP BY s.csv_source ORDER BY s.csv_source
  `).all();
  const totalSalons = db.prepare(`SELECT COUNT(*) AS c FROM salons s WHERE ${PHOTOS_BASE_WHERE}`).get().c;
  res.json({ groups: out, csv_sources: csvSources, total_salons: totalSalons });
});

router.get('/api/picker/manual-salons', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '8', 10), 24);
  const offset = parseInt(req.query.offset || '0', 10);
  let filter, seq, liste;
  try { ({ filter, seq, liste } = await prepareFilter(req.query)); }
  catch (e) { return res.status(502).json({ error: 'Séquenceur injoignable : ' + e.message }); }
  const baseWhere = `${PHOTOS_BASE_WHERE}${liste.f.sql}`;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM salons s ${liste.join} WHERE ${baseWhere}`)
    .get(...liste.joinParams, ...liste.f.params).c;
  const salons = db.prepare(`
    SELECT s.id, s.slug, s.nom, s.ville, s.google_id, s.overrides_json
    FROM salons s ${liste.join} WHERE ${baseWhere}
    ${liste.order}
    LIMIT ? OFFSET ?
  `).all(...liste.joinParams, ...liste.f.params, limit, offset);

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
      seq: seq && seq.bySlug ? (seq.bySlug[s.slug] || null) : null,
      hero_applied: heroApplied, gallery_custom: galleryCount,
      ai_pick_photo_id: lastScoring ? lastScoring.selected_photo_id : null,
      photos: dedup.kept.slice(0, 15).map((p) => ({ photo_id: p.photo_id, lowdef: !!p.lowdef, ...photoUrls(p) })),
    });
  }
  res.json({ total, limit, offset, group_id: filter.group_id || '', salons: out });
});

export default router;

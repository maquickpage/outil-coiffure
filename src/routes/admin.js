import express from 'express';
import multer from 'multer';
import bcrypt from 'bcrypt';
import { stringify } from 'csv-stringify/sync';
import { mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import db from '../db.js';
import { importCsvFile } from '../csv-importer.js';
import { captureSalon, captureBatch, recaptureAsync } from '../screenshot-worker.js';
import { startCleanNames, getCleanJob } from '../name-cleaner.js';
import { startCorrectPresentation, getPresentationJob } from '../presentation-cleaner.js';
import { startDomainSuggestions, getDomainSuggestionsJob } from '../domain-suggester.js';
import { captureBatchParallel } from '../screenshot-worker.js';
import { startProvisioning, getProvisioningStatus } from '../provisioning-worker.js';
import { slugify } from '../slug-generator.js';
import photoPickerRouter from './photo-picker.js';
import salonNewRouter from './salon-new.js';
import callingRouter from './calling.js';
import { clientIp } from './tracking.js';

const router = express.Router();
const UPLOAD_DIR = './data/csv-uploads';
const EXPORT_DIR = './data/csv-exports';
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path === '/login' || req.path === '/login.html') return next();
  // Si l'appel est XHR/fetch (Accept: application/json OU Sec-Fetch-Mode: cors), retourner 401 JSON
  const acceptsJson = (req.headers.accept || '').includes('application/json');
  const isXhr = req.xhr || req.headers['sec-fetch-mode'] === 'cors';
  if (acceptsJson || isXhr) {
    return res.status(401).json({ error: 'Non authentifie' });
  }
  if (req.accepts('html')) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'Non authentifie' });
}

router.post('/login', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Identifiants invalides' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Identifiants invalides' });

  req.session.userId = user.id;
  req.session.email = user.email;
  res.json({ ok: true, email: user.email });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ authenticated: true, email: req.session.email });
  }
  res.json({ authenticated: false });
});

router.use(requireAuth);

// Photo-picker (photos Google scrapées + scoring IA) — derrière requireAuth.
// Expose /admin/api/picker/* + /admin/photos-files/* (renditions _th/_lg).
router.use(photoPickerRouter);

// Création de salon « à l'unité » (recherche Places / saisie manuelle) — derrière requireAuth.
// Expose /admin/api/salon-new/*.
router.use(salonNewRouter);

// Prospection téléphonique (file d'appel + cockpit) — derrière requireAuth.
// Expose /admin/api/calling/*.
router.use(callingRouter);

// === Export CSV du suivi des visites maquettes (funnel) ===
// Enrichi : chaque event joint aux infos salon (nom, ville, email, statut).
// = liste d'appels directement actionnable, sans recoller Smartlead.
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
router.get('/api/preview-visits.csv', (req, res) => {
  let rows;
  try {
    rows = db.prepare(`
      SELECT e.ts, e.event, e.slug, e.src, e.meta, e.ip, e.user_agent,
             s.nom_clean, s.nom, s.ville, s.code_postal, s.email,
             s.subscription_status, s.cold_mail_sent_at
      FROM preview_events e
      LEFT JOIN salons s ON s.slug = e.slug
      ORDER BY e.ts DESC
      LIMIT 200000
    `).all();
  } catch (e) {
    return res.status(500).send('error: ' + e.message);
  }
  // NB : pas d'edit_token dans l'export — c'est le secret du lien d'édition, il
  // n'a rien à faire dans un fichier Excel qui traîne. Pour ouvrir une maquette
  // éditable, utiliser le lien « Voir » de la page (redirection authentifiée).
  const headers = ['ts', 'event', 'slug', 'salon', 'ville', 'code_postal', 'email', 'subscription_status', 'cold_mail_sent_at', 'src', 'ip', 'user_agent', 'meta'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const salon = (r.nom_clean && r.nom_clean.trim()) || r.nom || '';
    lines.push([r.ts, r.event, r.slug, salon, r.ville, r.code_postal, r.email, r.subscription_status, r.cold_mail_sent_at, r.src, r.ip, r.user_agent, r.meta].map(csvEscape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="preview-visits.csv"');
  // SÉCURITÉ : empêche tout cache (notamment Cloudflare qui cache .csv par
  // extension → exposerait les données prospects en edge sans auth).
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.send('﻿' + lines.join('\n')); // BOM UTF-8 pour Excel
});

// Derive un nom de source court a partir du nom de fichier
// "coiffeur-france-auvergne-rhone-alpes-cantal.csv" -> "cantal"
// "salons.csv" -> "salons"
function deriveSourceFromFilename(filename) {
  if (!filename) return 'import';
  const noExt = String(filename).replace(/\.(csv|tsv|txt)$/i, '');
  const parts = noExt.split(/[-_./\\\s]+/).filter(Boolean);
  return parts[parts.length - 1] || noExt || 'import';
}

router.post('/upload-csv', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

  const manualName = (req.body.source_name || '').trim();
  const sourceName = manualName || deriveSourceFromFilename(req.file.originalname);
  const groupId = req.body.group_id ? parseInt(req.body.group_id, 10) || null : null;
  try {
    const result = importCsvFile(req.file.path, sourceName, groupId);
    res.json({ ok: true, source_name: sourceName, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============= GROUPES =============
router.get('/groups', (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
           COALESCE((SELECT COUNT(*) FROM salons WHERE group_id = g.id), 0) AS salons_count,
           COALESCE((SELECT COUNT(DISTINCT csv_source) FROM salons WHERE group_id = g.id), 0) AS csv_sources_count
    FROM salon_groups g
    ORDER BY g.name COLLATE NOCASE
  `).all();
  // Salons sans groupe
  const orphanCount = db.prepare("SELECT COUNT(*) AS n FROM salons WHERE group_id IS NULL").get().n;
  res.json({ groups, orphan_count: orphanCount });
});

router.post('/groups', express.json(), (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  if (name.length > 100) return res.status(400).json({ error: 'Nom trop long' });
  try {
    const result = db.prepare('INSERT INTO salon_groups (name, description) VALUES (?, ?)').run(name, description);
    res.json({ id: result.lastInsertRowid, name, description });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Un groupe avec ce nom existe deja' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/groups/:id', express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = String(req.body?.name || '').trim();
  const description = req.body?.description != null ? String(req.body.description).trim() : null;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const result = db.prepare("UPDATE salon_groups SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(name, description, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Groupe introuvable' });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Un groupe avec ce nom existe deja' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE supprime le groupe ; les salons ne sont PAS supprimes, ils deviennent "sans groupe"
router.delete('/groups/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tx = db.transaction(() => {
    db.prepare('UPDATE salons SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM salon_groups WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// Assigner tous les salons d'un csv_source a un groupe (ou null pour retirer)
router.put('/groups/assign-csv-source', express.json(), (req, res) => {
  const { csv_source, group_id } = req.body || {};
  if (!csv_source) return res.status(400).json({ error: 'csv_source requis' });
  const targetGroupId = group_id != null ? parseInt(group_id, 10) || null : null;
  const result = db.prepare('UPDATE salons SET group_id = ? WHERE csv_source = ?').run(targetGroupId, csv_source);
  res.json({ ok: true, moved: result.changes });
});

// Construire un WHERE clause + params a partir d'un filtre frontend (group_id, csv_source, search)
function buildFilterWhere({ group_id, csv_source, search }) {
  const conds = [];
  const params = [];
  if (group_id === 'none') conds.push('group_id IS NULL');
  else if (group_id != null && group_id !== '') {
    const gid = parseInt(group_id, 10);
    if (Number.isFinite(gid)) { conds.push('group_id = ?'); params.push(gid); }
  }
  if (csv_source) { conds.push('csv_source = ?'); params.push(csv_source); }
  if (search) {
    conds.push('(nom LIKE ? OR nom_clean LIKE ? OR ville LIKE ? OR slug LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// Compter les salons matchant un filtre (utile cote UI pour preview)
router.post('/salons/bulk-count', express.json(), (req, res) => {
  const { where, params } = buildFilterWhere(req.body || {});
  const n = db.prepare(`SELECT COUNT(*) AS n FROM salons ${where}`).get(...params).n;
  res.json({ count: n });
});

// Liste TOUS les slugs matchant les filtres actifs (group_id, csv_source, search).
// Utilise par l'UI quand l'utilisateur clique sur "Selectionner tous les N salons"
// (mode toutes-les-pages) sans avoir a paginer.
router.get('/salon-slugs', (req, res) => {
  const { where, params } = buildFilterWhere({
    group_id: req.query.group_id,
    csv_source: req.query.csv_source,
    search: req.query.search
  });
  const rows = db.prepare(`SELECT slug FROM salons ${where} ORDER BY id ASC`).all(...params);
  res.json({ slugs: rows.map(r => r.slug), count: rows.length });
});

// Deplacer en masse des salons (filtre group_id/csv_source/search) vers un groupe cible
router.put('/salons/bulk-assign-group', express.json(), (req, res) => {
  const { target_group_id, group_id, csv_source, search } = req.body || {};
  if (target_group_id === undefined) {
    return res.status(400).json({ error: 'target_group_id requis (utiliser null pour retirer du groupe)' });
  }
  let target = null;
  if (target_group_id != null && target_group_id !== '') {
    target = parseInt(target_group_id, 10);
    if (!Number.isFinite(target)) return res.status(400).json({ error: 'target_group_id invalide' });
    // Verifier que le groupe existe
    const g = db.prepare('SELECT id FROM salon_groups WHERE id = ?').get(target);
    if (!g) return res.status(404).json({ error: 'Groupe cible introuvable' });
  }

  const { where, params } = buildFilterWhere({ group_id, csv_source, search });
  if (!where) return res.status(400).json({ error: 'Au moins un filtre est requis (group_id, csv_source ou search)' });

  const result = db.prepare(`UPDATE salons SET group_id = ?, updated_at = datetime('now') ${where}`)
    .run(target, ...params);
  res.json({ ok: true, moved: result.changes });
});

// Supprimer en masse des salons (par slugs explicites OU par filtre)
router.delete('/salons/bulk', express.json(), (req, res) => {
  const { confirm, group_id, csv_source, search, slugs } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'confirm: true requis pour valider la suppression' });

  if (Array.isArray(slugs) && slugs.length > 0) {
    // Mode selection : delete exactement ces slugs
    const placeholders = slugs.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM salons WHERE slug IN (${placeholders})`).run(...slugs);
    return res.json({ ok: true, deleted: result.changes, expected: slugs.length });
  }

  // Mode filtre
  const { where, params } = buildFilterWhere({ group_id, csv_source, search });
  if (!where) return res.status(400).json({ error: 'Au moins un filtre ou une selection est requis pour eviter une suppression totale accidentelle' });

  const count = db.prepare(`SELECT COUNT(*) AS n FROM salons ${where}`).get(...params).n;
  const result = db.prepare(`DELETE FROM salons ${where}`).run(...params);
  res.json({ ok: true, deleted: result.changes, expected: count });
});

router.post('/screenshot/:slug', async (req, res) => {
  const result = await captureSalon(req.params.slug);
  if (result.success) res.json(result);
  else res.status(500).json(result);
});

const activeJobs = new Map();

router.post('/screenshot-batch', express.json(), async (req, res) => {
  const { csv_source, group_id, only_missing = true, slugs: explicitSlugs } = req.body || {};
  let slugs;
  if (Array.isArray(explicitSlugs) && explicitSlugs.length > 0) {
    // Mode selection : on capture exactement ces slugs (filtre only_missing applique en plus si demande)
    if (only_missing) {
      const placeholders = explicitSlugs.map(() => '?').join(',');
      slugs = db.prepare(`SELECT slug FROM salons WHERE slug IN (${placeholders}) AND screenshot_path IS NULL`)
        .all(...explicitSlugs).map(r => r.slug);
    } else {
      slugs = explicitSlugs;
    }
  } else {
    // Mode filtre : group_id / csv_source / only_missing
    let query = 'SELECT slug FROM salons';
    const params = [];
    const conds = [];
    if (csv_source) { conds.push('csv_source = ?'); params.push(csv_source); }
    if (group_id === 'none') conds.push('group_id IS NULL');
    else if (group_id) { conds.push('group_id = ?'); params.push(parseInt(group_id, 10)); }
    if (only_missing) conds.push('screenshot_path IS NULL');
    if (conds.length) query += ' WHERE ' + conds.join(' AND ');
    query += ' ORDER BY id ASC';
    slugs = db.prepare(query).all(...params).map(r => r.slug);
  }
  const jobId = 'job_' + Date.now();
  activeJobs.set(jobId, { total: slugs.length, done: 0, errors: 0, status: 'running', last: null });

  res.json({ jobId, total: slugs.length });

  captureBatch(slugs, ({ done, total, last }) => {
    const job = activeJobs.get(jobId);
    if (!job) return;
    job.done = done;
    job.last = last;
    if (last && !last.success) job.errors++;
  }).then(() => {
    const job = activeJobs.get(jobId);
    if (job) job.status = 'finished';
  }).catch(e => {
    const job = activeJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = e.message; }
  });
});

router.get('/job/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId) || getCleanJob(req.params.jobId) || getPresentationJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job inconnu' });
  res.json(job);
});

// Correction de la presentation (texte d'intro) via GPT pour les slugs selectionnes
router.post('/correct-presentation', express.json(), async (req, res) => {
  const { slugs } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs requis (tableau non vide)' });
  }
  try {
    const result = await startCorrectPresentation({ slugs });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// ORCHESTRATEUR : lance plusieurs actions en parallele sur une selection
// Body : { slugs: [...], actions: { capture, clean_names, correct_presentation } }
// Retourne un jobId unique qui agrege la progression de toutes les sous-taches.
// =====================================================================
const runJobs = new Map();

router.get('/run-job/:jobId', (req, res) => {
  const job = runJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job inconnu' });
  res.json(job);
});

router.post('/run-actions', express.json(), async (req, res) => {
  const { slugs, actions } = req.body || {};
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return res.status(400).json({ error: 'slugs requis (tableau non vide)' });
  }
  if (!actions || typeof actions !== 'object') {
    return res.status(400).json({ error: 'actions requis (objet)' });
  }
  const enabledActions = Object.entries(actions).filter(([_, v]) => v).map(([k]) => k);
  if (enabledActions.length === 0) {
    return res.status(400).json({ error: 'Au moins une action doit etre activee' });
  }

  const jobId = 'run_' + Date.now();
  const job = {
    id: jobId,
    total: 0,
    done: 0,
    errors: 0,
    status: 'running',
    last: null,
    breakdown: {}
  };

  // Calculer le total : N (nombre de slugs) x nombre d'actions activees
  for (const a of enabledActions) {
    job.breakdown[a] = { total: slugs.length, done: 0, errors: 0, updated: 0 };
    job.total += slugs.length;
  }
  runJobs.set(jobId, job);
  res.json({ jobId, total: job.total, actions: enabledActions });

  // ====== ORCHESTRATION ======
  // Logique : les actions IA (clean_names, correct_presentation) modifient le contenu de la
  // landing. Donc si capture est aussi demandee, on doit attendre que les modifs IA aient
  // ete sauvegardees avant de lancer les captures, sinon les captures auraient l'ancien contenu.
  //
  // Phase 1 (parallele) : clean_names + correct_presentation
  // Phase 2 (apres phase 1) : capture
  // Si une seule action est cochee, c'est direct.
  // ===========================
  (async () => {
    try {
      // Phase 1 : actions IA en parallele
      const phase1 = [];

      if (actions.clean_names) {
        phase1.push((async () => {
          const sub = await startCleanNames({ slugs, force: true });
          if (!sub.jobId) return;
          while (true) {
            const subJob = getCleanJob(sub.jobId);
            if (!subJob) break;
            const b = job.breakdown.clean_names;
            const delta = subJob.done - b.done;
            b.done = subJob.done;
            b.errors = subJob.errors || 0;
            b.updated = subJob.updated || 0;
            job.done += delta;
            job.errors += (subJob.errors || 0) - (b.errorsReported || 0);
            b.errorsReported = subJob.errors || 0;
            if (subJob.last) job.last = String(subJob.last).slice(0, 80);
            if (subJob.status === 'finished' || subJob.status === 'error') break;
            await new Promise(r => setTimeout(r, 800));
          }
        })().catch(e => {
          job.breakdown.clean_names.errors = slugs.length;
          job.errors += slugs.length;
          job.last = `ERROR clean_names: ${e.message}`;
        }));
      }

      if (actions.correct_presentation) {
        phase1.push((async () => {
          const sub = await startCorrectPresentation({ slugs });
          if (!sub.jobId) return;
          while (true) {
            const subJob = getPresentationJob(sub.jobId);
            if (!subJob) break;
            const b = job.breakdown.correct_presentation;
            const delta = subJob.done - b.done;
            b.done = subJob.done;
            b.errors = subJob.errors || 0;
            b.updated = subJob.updated || 0;
            job.done += delta;
            job.errors += (subJob.errors || 0) - (b.errorsReported || 0);
            b.errorsReported = subJob.errors || 0;
            if (subJob.last) job.last = String(subJob.last).slice(0, 80);
            if (subJob.status === 'finished' || subJob.status === 'error') break;
            await new Promise(r => setTimeout(r, 800));
          }
        })().catch(e => {
          job.breakdown.correct_presentation.errors = slugs.length;
          job.errors += slugs.length;
          job.last = `ERROR correct_presentation: ${e.message}`;
        }));
      }

      if (actions.domain_suggestions) {
        phase1.push((async () => {
          // force=true : on regenere meme si deja suggere (l'utilisateur peut
          // vouloir rafraichir les propositions). Le sémaphore Azure global
          // (azure-rate-limiter) plafonne le total concurrent avec les autres workers IA.
          const sub = await startDomainSuggestions({ slugs, force: true });
          if (!sub.jobId) return;
          while (true) {
            const subJob = getDomainSuggestionsJob(sub.jobId);
            if (!subJob) break;
            const b = job.breakdown.domain_suggestions;
            const delta = subJob.done - b.done;
            b.done = subJob.done;
            b.errors = subJob.errors || 0;
            b.updated = subJob.updated || 0;
            job.done += delta;
            job.errors += (subJob.errors || 0) - (b.errorsReported || 0);
            b.errorsReported = subJob.errors || 0;
            if (subJob.last) job.last = String(subJob.last).slice(0, 80);
            if (subJob.status === 'finished' || subJob.status === 'error') break;
            await new Promise(r => setTimeout(r, 800));
          }
        })().catch(e => {
          job.breakdown.domain_suggestions.errors = slugs.length;
          job.errors += slugs.length;
          job.last = `ERROR domain_suggestions: ${e.message}`;
        }));
      }

      if (phase1.length > 0) {
        job.phase = 'ai';
        await Promise.all(phase1);
      }

      // Phase 2 : captures (avec contenu mis a jour par phase 1)
      if (actions.capture) {
        job.phase = 'capture';
        // Concurrence : laisse le default du worker (env SCREENSHOT_CONCURRENCY ou 6)
        await captureBatchParallel(slugs, undefined, ({ done, total, last }) => {
          const b = job.breakdown.capture;
          const delta = done - b.done;
          b.done = done;
          if (last && !last.success) {
            b.errors++;
            job.errors++;
          }
          job.done += delta;
          if (last) job.last = (last.slug || String(last)).slice(0, 80);
        }).catch(e => {
          job.breakdown.capture.errors = slugs.length;
          job.errors += slugs.length;
          job.last = `ERROR capture: ${e.message}`;
        });
      }

      job.status = 'finished';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
    }
  })();
});

// Etend startCleanNames pour accepter un tableau de slugs explicites

router.post('/clean-names', express.json(), async (req, res) => {
  const { csv_source = null, group_id = null, force = false, slugs = null } = req.body || {};
  try {
    const result = await startCleanNames({ csvSource: csv_source, onlyMissing: true, force, slugs });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/reset-clean-name/:slug', (req, res) => {
  // Reset = remettre nom_clean = nom (pour rester editable par humain)
  const result = db.prepare('UPDATE salons SET nom_clean = nom, nom_clean_at = NULL WHERE slug = ?').run(req.params.slug);
  res.json({ ok: true, updated: result.changes });
});

// Edition manuelle du nom final
router.put('/salon/:slug/nom-final', express.json(), (req, res) => {
  const value = String(req.body?.nom_final || '').trim();
  if (!value) return res.status(400).json({ error: 'nom_final ne peut pas etre vide' });
  if (value.length > 200) return res.status(400).json({ error: 'nom_final trop long (max 200)' });

  const result = db.prepare(`
    UPDATE salons
    SET nom_clean = ?, nom_clean_at = datetime('now'), updated_at = datetime('now'),
        screenshot_path = NULL, screenshot_generated_at = NULL
    WHERE slug = ?
  `).run(value, req.params.slug);

  if (result.changes === 0) return res.status(404).json({ error: 'Salon introuvable' });
  recaptureAsync(req.params.slug);
  res.json({ ok: true, nom_final: value });
});

// Edition manuelle de la presentation corrigee (overrides_json.intro.description)
router.put('/salon/:slug/presentation', express.json(), (req, res) => {
  const value = String(req.body?.presentation || '').trim();
  if (value.length > 1000) return res.status(400).json({ error: 'presentation trop longue (max 1000 caracteres)' });

  const row = db.prepare('SELECT id, overrides_json FROM salons WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Salon introuvable' });

  let overrides = {};
  try { overrides = row.overrides_json ? JSON.parse(row.overrides_json) : {}; } catch {}
  if (!overrides.intro) overrides.intro = {};
  if (value) {
    overrides.intro.description = value;
  } else {
    // Vider la presentation = revenir au defaut (meta_description ou fallback)
    delete overrides.intro.description;
    if (Object.keys(overrides.intro).length === 0) delete overrides.intro;
  }

  db.prepare(`
    UPDATE salons
    SET overrides_json = ?, overrides_updated_at = datetime('now'), updated_at = datetime('now'),
        screenshot_path = NULL, screenshot_generated_at = NULL
    WHERE id = ?
  `).run(Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides), row.id);

  recaptureAsync(req.params.slug);
  res.json({ ok: true, presentation: value });
});

// Tree des groupes + sources pour le composer d'export
router.get('/export-tree', (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name,
           COALESCE((SELECT COUNT(*) FROM salons WHERE group_id = g.id), 0) AS salons_count
    FROM salon_groups g
    ORDER BY g.name COLLATE NOCASE
  `).all();
  const sourcesByGroup = db.prepare(`
    SELECT group_id, csv_source, COUNT(*) AS n
    FROM salons
    WHERE csv_source IS NOT NULL AND csv_source != ''
    GROUP BY group_id, csv_source
    ORDER BY csv_source COLLATE NOCASE
  `).all();
  const orphanCount = db.prepare("SELECT COUNT(*) AS n FROM salons WHERE group_id IS NULL").get().n;

  const groupedSources = new Map();
  for (const g of groups) groupedSources.set(g.id, []);
  groupedSources.set(null, []);
  for (const r of sourcesByGroup) {
    const arr = groupedSources.get(r.group_id) || [];
    arr.push({ name: r.csv_source, count: r.n });
    groupedSources.set(r.group_id, arr);
  }

  const groupsWithSources = groups.map(g => ({
    id: g.id,
    name: g.name,
    salons_count: g.salons_count,
    sources: groupedSources.get(g.id) || []
  }));
  const orphanSources = groupedSources.get(null) || [];

  res.json({
    groups: groupsWithSources,
    orphan: { count: orphanCount, sources: orphanSources }
  });
});

router.get('/export-csv', (req, res) => {
  // csv_sources peut etre une liste (CSV separes par virgule) ou une valeur unique
  const csvSourcesRaw = req.query.csv_sources || req.query.csv_source || '';
  const csvSources = String(csvSourcesRaw).split(',').map(s => s.trim()).filter(Boolean);
  const groupId = req.query.group_id || '';
  const format = req.query.format || 'smartlead'; // 'smartlead' | 'full'
  const publicBase = process.env.PUBLIC_BASE_URL || 'https://maquickpage.fr';
  const adminBase = process.env.ADMIN_BASE_URL || 'https://outil.maquickpage.fr';

  let query = `SELECT slug, nom, nom_clean, ville, code_postal, adresse, telephone, email,
                      note_avis, nb_avis, lien_facebook, lien_instagram, lien_google_maps,
                      screenshot_path, csv_source, edit_token, group_id, data_json
               FROM salons`;
  const params = [];
  const conds = [];
  if (csvSources.length === 1) {
    conds.push('csv_source = ?'); params.push(csvSources[0]);
  } else if (csvSources.length > 1) {
    const placeholders = csvSources.map(() => '?').join(',');
    conds.push(`csv_source IN (${placeholders})`);
    params.push(...csvSources);
  }
  if (groupId === 'none') conds.push('group_id IS NULL');
  else if (groupId) { conds.push('group_id = ?'); params.push(parseInt(groupId, 10)); }
  if (conds.length) query += ' WHERE ' + conds.join(' AND ');
  query += ' ORDER BY id ASC';

  const rows = db.prepare(query).all(...params);

  let enriched;
  let stringifyOpts;

  if (format === 'smartlead') {
    // Format minimal pour Smartlead : 7 colonnes exactement, virgule, sans BOM
    // Le salon_name utilise nom_clean (Nom final) pour les noms propres
    enriched = rows.map(r => {
      let firstName = '';
      try {
        const data = JSON.parse(r.data_json || '{}');
        const original = data.original_row || {};
        firstName = String(original["Prénom de l'email individuel"] || '').trim();
      } catch {}

      const salonName = (r.nom_clean && r.nom_clean.trim()) || r.nom || '';
      return {
        email: r.email || '',
        first_name: firstName,
        salon_name: salonName,
        city: r.ville || '',
        // Slug du nom final (= nom_clean ou nom à défaut). Utile pour générer
        // des URLs personnalisées côté Smartlead (templates email avec variable).
        salon_slug: slugify(salonName),
        // URL démo personnelle du coiffeur (token embarqué) : il voit son site
        // comme un visiteur, et le token est mémorisé en sessionStorage par
        // preview-onboarding.js → "Modifier mon site" fonctionne sans 401.
        // Cette URL est destinée à l'email coiffeur — pas à partager publiquement.
        preview_url: r.edit_token ? `${publicBase}/preview/${r.slug}?token=${r.edit_token}` : `${publicBase}/preview/${r.slug}`,
        preview_image_url: r.screenshot_path ? `${publicBase}${r.screenshot_path}` : '',
        admin_url: r.edit_token ? `${publicBase}/admin/${r.slug}?token=${r.edit_token}` : ''
      };
    });
    stringifyOpts = { header: true, delimiter: ',' };
  } else {
    // Format complet pour usage interne (toutes les colonnes utiles)
    const groupNames = new Map(db.prepare('SELECT id, name FROM salon_groups').all().map(g => [g.id, g.name]));
    enriched = rows.map(r => ({
      slug: r.slug,
      nom_scrappe: r.nom,
      nom_final: (r.nom_clean && r.nom_clean.trim()) || r.nom,
      groupe: r.group_id ? (groupNames.get(r.group_id) || '') : '',
      ville: r.ville,
      code_postal: r.code_postal,
      adresse: r.adresse,
      telephone: r.telephone,
      email: r.email,
      note_avis: r.note_avis,
      nb_avis: r.nb_avis,
      lien_facebook: r.lien_facebook,
      lien_instagram: r.lien_instagram,
      lien_google_maps: r.lien_google_maps,
      csv_source: r.csv_source,
      // URL démo perso (token embarqué) — usage mailing, pas à partager publiquement
      URL_landing: r.edit_token ? `${publicBase}/preview/${r.slug}?token=${r.edit_token}` : `${publicBase}/preview/${r.slug}`,
      URL_edition: r.edit_token ? `${publicBase}/admin/${r.slug}?token=${r.edit_token}` : '',
      Capture_ecran: r.screenshot_path ? `${publicBase}${r.screenshot_path}` : ''
    }));
    stringifyOpts = { header: true, delimiter: ';' };
  }

  const csv = stringify(enriched, stringifyOpts);
  const suffix = format === 'smartlead' ? 'smartlead' : 'full';
  // Scope = source CSV (si une seule), 'multi' (plusieurs), ou groupId, ou 'all'.
  let scope;
  if (csvSources.length === 1) scope = csvSources[0].replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  else if (csvSources.length > 1) scope = `multi${csvSources.length}`;
  else if (groupId === 'none') scope = 'no-group';
  else if (groupId) scope = `group${groupId}`;
  else scope = 'all';
  const filename = `salons-${suffix}-${scope}-${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Smartlead format : pas de BOM (UTF-8 strict). Format full : BOM pour Excel.
  res.send(format === 'smartlead' ? csv : '﻿' + csv);
});

router.delete('/salon/:slug', (req, res) => {
  const result = db.prepare('DELETE FROM salons WHERE slug = ?').run(req.params.slug);
  res.json({ ok: true, deleted: result.changes });
});

router.delete('/csv-source/:name', (req, res) => {
  const result = db.prepare('DELETE FROM salons WHERE csv_source = ?').run(req.params.name);
  db.prepare('DELETE FROM csv_imports WHERE filename = ?').run(req.params.name);
  res.json({ ok: true, deleted: result.changes });
});

// =====================================================================
// Provisioning : retry manuel pour les salons en error
// POST /admin/retry-provisioning/:slug
// Relance startProvisioning sur un salon dont la subscription_status est
// 'error' ou 'past_due'. Utile quand OVH/CF a planté en cours de route.
// =====================================================================
router.post('/retry-provisioning/:slug', (req, res) => {
  const slug = req.params.slug;
  const salon = db.prepare(`
    SELECT slug, subscription_status, live_hostname, plan, owner_email,
           stripe_customer_id, stripe_subscription_id
    FROM salons WHERE slug = ?
  `).get(slug);
  if (!salon) return res.status(404).json({ error: 'Salon introuvable' });
  if (!salon.live_hostname || !salon.plan) {
    return res.status(409).json({ error: 'Salon sans live_hostname/plan : pas de checkout valide' });
  }
  if (!['error', 'past_due', 'pending', 'provisioning'].includes(salon.subscription_status || '')) {
    return res.status(409).json({
      error: `subscription_status='${salon.subscription_status}' : retry non applicable`
    });
  }

  // Reset le status à 'provisioning' avant de relancer le worker
  db.prepare(`
    UPDATE salons SET subscription_status='provisioning', updated_at=datetime('now') WHERE slug=?
  `).run(slug);

  startProvisioning({
    slug,
    hostname: salon.live_hostname,
    planKey: salon.plan,
    customerEmail: salon.owner_email,
    stripeCustomerId: salon.stripe_customer_id,
    stripeSubscriptionId: salon.stripe_subscription_id,
  }).catch(err => {
    console.error('[admin/retry-provisioning] failed:', err);
    db.prepare(`UPDATE salons SET subscription_status='error', updated_at=datetime('now') WHERE slug=?`).run(slug);
  });

  res.json({ ok: true, slug, hostname: salon.live_hostname, plan: salon.plan });
});

// GET /admin/provisioning-status/:slug — état runtime du job (en mémoire)
router.get('/provisioning-status/:slug', (req, res) => {
  const slug = req.params.slug;
  const job = getProvisioningStatus(slug);
  const dbRow = db.prepare(`
    SELECT subscription_status, live_hostname, signed_up_at, signup_session_id
    FROM salons WHERE slug = ?
  `).get(slug);
  if (!dbRow) return res.status(404).json({ error: 'Salon introuvable' });
  res.json({
    slug,
    db: dbRow,
    runtime: job ? {
      state: job.state,
      step: job.step,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
    } : null,
  });
});

// === Suivi maquettes — AGRÉGAT SERVEUR (JSON) ===
// Remplace le parse CSV côté navigateur : le serveur lit les events une fois,
// agrège par salon, et renvoie un JSON compact (N salons, pas 200k lignes).
// Ne renvoie AUCUN edit_token (le lien « Voir » passe par une redirection
// authentifiée). Sépare les visiteurs par (ip|ua) et exclut de l'entonnoir
// prospect : les bots (UA) ET les IP internes (toi/QA, table suivi_excluded_ips).
const SUIVI_BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|http-client|headless|phantom|preview|scan|proofpoint|mimecast|barracuda|safelinks|googleimageproxy|facebookexternalhit|whatsapp|bingpreview|yandex|ahrefs|semrush|monitor/i;
const SUIVI_STAGE = { preview_ouvert: 1, pricing_ouvert: 3, etape_domaine: 4, etape_email: 5, domaine_perso: 6, editeur_ouvert: 7, editeur_modifie: 8, cgv_accepte: 9, paiement_initie: 10 };
const SUIVI_SESSION_GAP_MS = 30 * 60 * 1000;
const INTERNAL_ACTIVITY_EVENTS = new Set(['demo_email_envoyee', 'demo_sms_copiee']);

function trackingPeriod(value) {
  const days = [7, 30, 90].includes(Number(value)) ? Number(value) : 30;
  return { days, eventSql: ` AND e.ts >= datetime('now', '-${days} days')` };
}

router.get('/api/suivi.json', (req, res) => {
  let rows, excludedRows, salonSlugs;
  const period = trackingPeriod(req.query.days);
  try {
    rows = db.prepare(`
      SELECT e.ts, e.event, e.slug, e.meta, e.ip, e.user_agent,
             s.nom_clean, s.nom, s.ville, s.email, s.subscription_status
      FROM preview_events e
       LEFT JOIN salons s ON s.slug = e.slug
       WHERE e.slug IS NOT NULL
       ${period.eventSql}
       ORDER BY e.ts ASC
     `).all();
    excludedRows = db.prepare('SELECT ip FROM suivi_excluded_ips').all();
    salonSlugs = db.prepare('SELECT slug FROM salons').all();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const excluded = new Set(excludedRows.map(r => r.ip));
  const realSlugs = new Set(salonSlugs.map(r => r.slug)); // « réel » = existe dans salons (même sans nom)
  const isBot = (ua) => !ua || SUIVI_BOT_RE.test(ua);
  const dkey = (ip, ua) => (ip || '?') + '|' + (ua || '').slice(0, 250);

  const bySlug = new Map();
  let botEvents = 0, internalEvents = 0, humanEvents = 0;

  for (const r of rows) {
    if (!realSlugs.has(r.slug)) continue; // écarte les slugs scanner (.env, phpinfo…)
    const bot = isBot(r.user_agent);
    const internal = !bot && (excluded.has(r.ip) || INTERNAL_ACTIVITY_EVENTS.has(r.event));
    if (bot) botEvents++; else if (internal) internalEvents++; else humanEvents++;

    let s = bySlug.get(r.slug);
    if (!s) {
      s = { slug: r.slug, salon: '', ville: '', email: '', status: '', last: '', devices: new Map() };
      bySlug.set(r.slug, s);
    }
    // Métadonnées salon (dernière valeur non vide gagne)
    const nom = (r.nom_clean && r.nom_clean.trim()) || r.nom || '';
    if (nom) s.salon = nom;
    if (r.ville) s.ville = r.ville;
    if (r.email) s.email = r.email;
    if (r.subscription_status) s.status = r.subscription_status;
    if (!bot && !internal && r.ts && r.ts > s.last) s.last = r.ts;

    const k = dkey(r.ip, r.user_agent);
    let d = s.devices.get(k);
    if (!d) { d = { ua: r.user_agent || '(inconnu)', ip: r.ip || '', bot, internal, n: 0, last: '', times: [], events: {} }; s.devices.set(k, d); }
    d.n++;
    if (r.ts) { if (r.ts > d.last) d.last = r.ts; d.times.push(r.ts); }
    const ev = d.events[r.event] || (d.events[r.event] = { n: 0, last: '' });
    ev.n++; if (r.ts && r.ts > ev.last) ev.last = r.ts;
    if (r.event === 'scroll_max' && r.meta) { try { const m = JSON.parse(r.meta); if ((m.pct || 0) > (d.scroll || 0)) d.scroll = m.pct; } catch { /* ignore */ } }
    if ((r.event === 'etape_domaine' || r.event === 'paiement_initie') && r.meta && !d.plan) { try { const m = JSON.parse(r.meta); if (m.plan) d.plan = m.plan; } catch { /* ignore */ } }
  }

  // Découpe une liste d'horodatages en visites (gap > 30 min).
  const visitsOf = (times) => {
    if (!times.length) return 0;
    const sorted = times.slice().sort();
    let visits = 1, prev = Date.parse(sorted[0].replace(' ', 'T') + 'Z');
    for (let i = 1; i < sorted.length; i++) {
      const t = Date.parse(sorted[i].replace(' ', 'T') + 'Z');
      if (!isNaN(t) && !isNaN(prev) && t - prev > SUIVI_SESSION_GAP_MS) visits++;
      if (!isNaN(t)) prev = t;
    }
    return visits;
  };

  const salons = [];
  for (const s of bySlug.values()) {
    const devices = [];
    const prospectEvents = {}; // events des seuls appareils prospect (ni bot ni interne)
    let scroll = 0, plan = '', prospectVisits = 0, prospectEventCount = 0;
    for (const d of s.devices.values()) {
      const visits = visitsOf(d.times);
      const heat = Object.keys(d.events).reduce((h, ev) => Math.max(h, SUIVI_STAGE[ev] || 0), 0);
      devices.push({
        ua: d.ua, ip: d.ip, bot: d.bot, internal: d.internal,
        n: d.n, visits, last: d.last, heat,
        scroll: d.scroll || 0,
        times: d.times.slice().sort().reverse().slice(0, 24),
      });
      if (d.bot || d.internal) continue; // exclu de l'entonnoir prospect
      prospectVisits += visits;
      prospectEventCount += d.n;
      if ((d.scroll || 0) > scroll) scroll = d.scroll;
      if (d.plan && !plan) plan = d.plan;
      for (const ev in d.events) {
        const pe = prospectEvents[ev] || (prospectEvents[ev] = { n: 0, last: '' });
        pe.n += d.events[ev].n;
        if (d.events[ev].last > pe.last) pe.last = d.events[ev].last;
      }
    }
    devices.sort((a, b) => (a.last < b.last ? 1 : (a.last > b.last ? -1 : 0)));

    // Heat prospect = plus haute étape atteinte par un appareil prospect ; scroll>0 → au moins « a scrollé » (2).
    let heat = Object.keys(prospectEvents).reduce((h, ev) => Math.max(h, SUIVI_STAGE[ev] || 0), 0);
    if (scroll > 0 && heat < 2) heat = 2;

    // Un salon visité UNIQUEMENT par toi (IP exclue) ou des bots n'a aucune
    // activité prospect → il disparaît du Suivi (sauf s'il est déjà client).
    const isClient = /^(live|active|trialing)$/.test(s.status || '');
    if (prospectEventCount === 0 && !isClient) continue;

    salons.push({
      slug: s.slug, salon: s.salon || s.slug, ville: s.ville, email: s.email,
      status: s.status, last: s.last,
      hasProspect: prospectEventCount > 0,
      heat, scroll, plan,
      visits: prospectVisits, count: prospectEventCount,
      events: prospectEvents,
      devices,
    });
  }

  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.json({
    salons,
    myIp: clientIp(req),
    excludedIps: [...excluded],
    periodDays: period.days,
    totals: { salons: salons.length, humanEvents, botEvents, internalEvents },
  });
});

// Toggle d'une IP interne (exclue de l'entonnoir prospect). body: { ip, on }
router.post('/api/suivi/exclude-ip', express.json(), (req, res) => {
  const ip = (req.body && req.body.ip ? String(req.body.ip) : '').trim();
  const on = !(req.body && req.body.on === false);
  if (!ip) return res.status(400).json({ error: 'ip requis' });
  try {
    if (on) db.prepare('INSERT OR IGNORE INTO suivi_excluded_ips (ip) VALUES (?)').run(ip);
    else db.prepare('DELETE FROM suivi_excluded_ips WHERE ip = ?').run(ip);
    const excludedIps = db.prepare('SELECT ip FROM suivi_excluded_ips').all().map(r => r.ip);
    res.json({ ok: true, excludedIps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Redirection authentifiée vers la maquette éditable — évite d'exposer les
// edit_token en masse au client (Flaw 1). Seul le token du salon cliqué transite.
router.get('/api/suivi/preview/:slug', (req, res) => {
  const row = db.prepare('SELECT slug, edit_token FROM salons WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send('salon introuvable');
  const base = 'https://maquickpage.fr/preview/';
  const url = base + encodeURIComponent(row.slug) + (row.edit_token ? '?token=' + encodeURIComponent(row.edit_token) : '');
  res.redirect(302, url);
});

// Funnel landing maquickpage.fr — agrégat + JOURNEYS TRAÇABLES (sans cookie).
// Clé visiteur = (ip | user_agent), même logique que « Appareils & connexions »
// du Suivi salon. On reconstruit le parcours de chaque visiteur, et on rattache
// l'email capturé au submit (landing_leads, rapproché par la même clé ip|ua).
// Filtre les bots par user-agent. Renvoie : entonnoir (events + visiteurs
// uniques), répartition CTA, tendance 14 j, leads (avec parcours) et engagés.
const LANDING_BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|http-client|headless|phantom|preview|scan|proofpoint|mimecast|barracuda|safelinks|googleimageproxy|facebookexternalhit|whatsapp|bingpreview|yandex|ahrefs|semrush|monitor/i;
router.get('/api/landing-stats.json', (req, res) => {
  let rows, leadRows = [];
  const period = trackingPeriod(req.query.days);
  try {
    rows = db.prepare(`
      SELECT ts, event, src, meta, ip, user_agent
       FROM preview_events
       WHERE event LIKE 'landing_%'
       AND ts >= datetime('now', '-${period.days} days')
       ORDER BY ts ASC
     `).all();
    // Rattachement email : peut échouer si la table n'existe pas encore.
    try {
      leadRows = db.prepare(`
        SELECT l.email, l.found, l.salon_slug, l.ip, l.user_agent, l.created_at AS ts,
               s.nom_clean, s.nom, s.ville, s.slug, s.screenshot_path, s.edit_token
         FROM landing_leads l
         LEFT JOIN salons s ON s.slug = l.salon_slug
         WHERE l.created_at >= datetime('now', '-${period.days} days')
         ORDER BY l.created_at ASC
       `).all();
    } catch (e) { console.error('[landing-stats] leads join failed:', e.message); leadRows = []; }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const isBot = (ua) => !ua || LANDING_BOT_RE.test(ua);
  const vkey = (ip, ua) => (ip || '?') + '|' + (ua || '').slice(0, 250);
  const STAGE = { view: 1, scroll50: 2, cta: 3, open: 4, submit: 5 };

  const funnel = { view: 0, ready: 0, scroll50: 0, cta: 0, check_open: 0, submit: 0, found: 0, notfound: 0 };
  const cta = { nav: 0, hero: 0, coverage: 0, pricing: 0 };
  const parisDay = (ts) => {
    const value = Date.parse(String(ts || '').replace(' ', 'T') + 'Z');
    if (isNaN(value)) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  };
  const dailyMap = {};
  const visitors = new Map(); // ip|ua -> parcours
  let bots = 0, total = 0;

  for (const r of rows) {
    total++;
    if (isBot(r.user_agent)) { bots++; continue; }
    const day = parisDay(r.ts);
    const d = dailyMap[day] || (dailyMap[day] = { day, views: 0, realKeys: new Set(), ctaKeys: new Set(), submitKeys: new Set() });
    let meta = {};
    if (r.meta) { try { meta = JSON.parse(r.meta) || {}; } catch { /* ignore */ } }

    const k = vkey(r.ip, r.user_agent);
    let v = visitors.get(k);
    if (!v) { v = { ip: r.ip || '', ua: r.user_agent || '', first: r.ts, last: r.ts, stage: 0, ready: false, src: null, ref: null, steps: { scroll50: false, cta: false, open: false, submit: false }, events: [], scrollMax: 0, found: null, leads: [] }; visitors.set(k, v); }
    if (r.ts && r.ts < v.first) v.first = r.ts;
    if (r.ts && r.ts > v.last) v.last = r.ts;
    // Provenance : premier ?src= vu (campagne), sinon referrer du landing_ready.
    if (r.src && !v.src) v.src = r.src;
    v.events.push({ event: r.event, ts: r.ts, meta });

    switch (r.event) {
      case 'landing_view': funnel.view++; d.views++; if (v.stage < STAGE.view) v.stage = STAGE.view; break;
      // landing_ready = beacon JS au chargement → « vrai navigateur » (les bots
      // serveur n'exécutent pas le JS). meta.ref = hostname du referrer.
      case 'landing_ready': funnel.ready++; d.realKeys.add(k); v.ready = true; if (meta.ref && !v.ref) v.ref = String(meta.ref).slice(0, 100); if (v.stage < STAGE.view) v.stage = STAGE.view; break;
      case 'landing_scroll': { const p = meta.pct || 0; if (p > v.scrollMax) v.scrollMax = p; if (p >= 50) { funnel.scroll50++; v.steps.scroll50 = true; if (v.stage < STAGE.scroll50) v.stage = STAGE.scroll50; } break; }
      case 'landing_cta': funnel.cta++; d.ctaKeys.add(k); if (cta[meta.which] != null) cta[meta.which]++; v.steps.cta = true; if (v.stage < STAGE.cta) v.stage = STAGE.cta; break;
      case 'landing_check_open': funnel.check_open++; v.steps.open = true; if (v.stage < STAGE.open) v.stage = STAGE.open; break;
      case 'landing_check_submit': funnel.submit++; d.submitKeys.add(k); v.steps.submit = true; if (v.stage < STAGE.submit) v.stage = STAGE.submit; break;
      case 'landing_check_found': funnel.found++; v.found = true; v.steps.submit = true; if (v.stage < STAGE.submit) v.stage = STAGE.submit; break;
      case 'landing_check_notfound': funnel.notfound++; if (v.found == null) v.found = false; v.steps.submit = true; if (v.stage < STAGE.submit) v.stage = STAGE.submit; break;
      default: break;
    }
  }

  // Rattache l'email (landing_leads) au visiteur par la même clé ip|ua.
  // Un lead SANS events rapprochés (antérieur au tracking, ou ancienne IP proxy
  // Cloudflare non rapprochable) reste « orphelin » : il apparaît dans la liste
  // des leads mais n'entre PAS dans l'entonnoir visiteurs — on ne compte que
  // l'observé, jamais l'inféré.
  // Activité « site démo » par salon couvert — le lead a-t-il ouvert / édité son
  // démo ? On lit les events maquette (rattachés au slug du salon) pour les slugs
  // des leads trouvés. Best-effort : un échec laisse simplement demoBySlug vide.
  const publicBase = process.env.PUBLIC_BASE_URL || 'https://maquickpage.fr';
  const demoBySlug = new Map();
  try {
    const slugs = [...new Set(leadRows.filter(l => l.slug).map(l => l.slug))];
    if (slugs.length) {
      const ph = slugs.map(() => '?').join(',');
      const drows = db.prepare(
        `SELECT slug, event, MAX(ts) AS last FROM preview_events
         WHERE slug IN (${ph}) AND event IN ('preview_ouvert','editeur_ouvert','editeur_modifie')
         GROUP BY slug, event`
      ).all(...slugs);
      for (const r of drows) {
        let d = demoBySlug.get(r.slug);
        if (!d) { d = { opened: false, editorOpened: false, edited: false, last: null }; demoBySlug.set(r.slug, d); }
        if (r.event === 'preview_ouvert') d.opened = true;
        else if (r.event === 'editeur_ouvert') d.editorOpened = true;
        else if (r.event === 'editeur_modifie') d.edited = true;
        if (r.last && (!d.last || r.last > d.last)) d.last = r.last;
      }
    }
  } catch (e) { /* best-effort : pas d'enrichissement démo si la requête échoue */ }

  // Enrichissement salon d'un lead couvert : lien démo + capture + activité démo.
  const salonMeta = (primary) => {
    if (!primary || !primary.slug) return { slug: null, demoUrl: null, screenshot: null, demo: null };
    const tok = primary.editToken ? `?token=${primary.editToken}` : '';
    return {
      slug: primary.slug,
      demoUrl: `${publicBase}/preview/${encodeURIComponent(primary.slug)}${tok}`,
      screenshot: primary.screenshot ? `${publicBase}${primary.screenshot}` : null,
      demo: demoBySlug.get(primary.slug) || null,
    };
  };

  const orphanMap = new Map();
  for (const l of leadRows) {
    if (isBot(l.user_agent)) continue;
    const k = vkey(l.ip, l.user_agent);
    const lead = { email: l.email, found: !!l.found, salon: (l.nom_clean && l.nom_clean.trim()) || l.nom || null, ville: l.ville || null, ts: l.ts, slug: l.slug || null, screenshot: l.screenshot_path || null, editToken: l.edit_token || null };
    const v = visitors.get(k);
    const leadTime = Date.parse(String(l.ts || '').replace(' ', 'T') + 'Z');
    const nearJourney = v && v.events.some(e => {
      const eventTime = Date.parse(String(e.ts || '').replace(' ', 'T') + 'Z');
      return !isNaN(leadTime) && !isNaN(eventTime) && Math.abs(leadTime - eventTime) <= 24 * 60 * 60 * 1000;
    });
    if (nearJourney) {
      if (v.found == null) v.found = !!l.found;
      if (l.ts && l.ts > v.last) v.last = l.ts;
      v.leads.push(lead);
    } else {
      let o = orphanMap.get(k);
      if (!o) { o = { ip: l.ip || '', ua: l.user_agent || '', first: l.ts, last: l.ts, found: null, leads: [] }; orphanMap.set(k, o); }
      if (l.ts && l.ts < o.first) o.first = l.ts;
      if (l.ts && l.ts > o.last) o.last = l.ts;
      if (o.found == null) o.found = !!l.found;
      o.leads.push(lead);
    }
  }

  // Entonnoir par VISITEUR UNIQUE — uniquement des étapes OBSERVÉES (events).
  // Pas de rétro-remplissage : un submit sans event scroll ne compte pas dans scroll50.
  // `real` = visiteurs confirmés navigateur (beacon JS landing_ready) — les hits
  // serveur sans JS (bots, scanners, prefetch) gonflent `visitors` mais pas `real`.
  const vf = { visitors: 0, real: 0, scroll50: 0, cta: 0, open: 0, submit: 0 };
  // Provenance des VRAIS visiteurs : ?src= (campagne) prioritaire, sinon
  // hostname du referrer, sinon accès direct.
  const sourceMap = new Map();
  for (const v of visitors.values()) {
    vf.visitors++;
    if (v.ready) {
      vf.real++;
      const s = v.src ? `src:${v.src}` : (v.ref || 'direct');
      sourceMap.set(s, (sourceMap.get(s) || 0) + 1);
      if (v.steps.scroll50) vf.scroll50++;
      if (v.steps.cta) vf.cta++;
      if (v.steps.open) vf.open++;
      if (v.steps.submit) vf.submit++;
    }
  }
  const sources = [...sourceMap.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n);

  // Parcours trié + découpage en visites : gap > 30 min = nouvelle visite.
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const journeyOf = (v) => {
    const evs = v.events.slice().sort((a, b) => (a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0)));
    let visit = 0, prev = null;
    return evs.map(e => {
      const t = Date.parse(String(e.ts || '').replace(' ', 'T') + 'Z');
      if (!isNaN(t)) { if (prev == null || t - prev > SESSION_GAP_MS) visit++; prev = t; }
      else if (visit === 0) visit = 1;
      return { event: e.event, ts: e.ts, meta: e.meta, visit };
    });
  };

  const leads = [], engaged = [];
  for (const v of visitors.values()) {
    const journey = journeyOf(v);
    const visits = journey.length ? journey[journey.length - 1].visit : 0;
    if (v.leads.length) {
      const primary = v.leads[v.leads.length - 1]; // dernier submit
      leads.push({
        email: primary.email,
        emails: [...new Set(v.leads.map(x => x.email))],
        found: v.found, salon: primary.salon, ville: primary.ville,
        ...salonMeta(primary),
        ip: v.ip, ua: v.ua, first: v.first, last: v.last,
        source: v.src ? `src:${v.src}` : (v.ref || null),
        events: v.events.length, submits: v.leads.length, scrollMax: v.scrollMax,
        visits, journey,
      });
    } else if (v.stage >= STAGE.cta) {
      engaged.push({
        ip: v.ip, ua: v.ua, first: v.first, last: v.last,
        source: v.src ? `src:${v.src}` : (v.ref || null),
        stage: v.stage, events: v.events.length, scrollMax: v.scrollMax,
        visits, journey,
      });
    }
  }
  // Leads orphelins (aucun parcours enregistré) — affichés tels quels.
  for (const o of orphanMap.values()) {
    const primary = o.leads[o.leads.length - 1];
    leads.push({
      email: primary.email,
      emails: [...new Set(o.leads.map(x => x.email))],
      found: o.found, salon: primary.salon, ville: primary.ville,
      ...salonMeta(primary),
      ip: o.ip, ua: o.ua, first: o.first, last: o.last,
      events: 0, submits: o.leads.length, scrollMax: 0,
      visits: 0, journey: [], preTracking: true,
    });
  }
  leads.sort((a, b) => (a.last < b.last ? 1 : -1));
  engaged.sort((a, b) => (b.stage - a.stage) || (a.last < b.last ? 1 : -1));

  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dayCursor = new Date(todayParts + 'T12:00:00Z');
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(dayCursor.getTime() - i * 86400000).toISOString().slice(0, 10);
    const d = dailyMap[day];
    daily.push({ day, views: d ? d.views : 0, real: d ? d.realKeys.size : 0, cta: d ? d.ctaKeys.size : 0, submit: d ? d.submitKeys.size : 0 });
  }
  const visibleLeadRows = leadRows.filter(l => !isBot(l.user_agent));
  const uniqueLeadEmails = new Set(visibleLeadRows.map(l => String(l.email || '').trim().toLowerCase()).filter(Boolean)).size;
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.json({
    funnel, visitorFunnel: vf, cta, daily, sources,
    leads, engaged: engaged.slice(0, 200), engagedTotal: engaged.length,
    periodDays: period.days,
    leadMetrics: { submissions: visibleLeadRows.length, uniqueEmails: uniqueLeadEmails, found: visibleLeadRows.filter(l => l.found).length, notfound: visibleLeadRows.filter(l => !l.found).length },
    bots, humans: total - bots, total,
  });
});

export default router;

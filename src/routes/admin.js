import express from 'express';
import multer from 'multer';
import bcrypt from 'bcrypt';
import { stringify } from 'csv-stringify/sync';
import { mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import db from '../db.js';
import { importCsvFile } from '../csv-importer.js';
import { captureSalon, captureBatch } from '../screenshot-worker.js';
import { startCleanNames, getCleanJob } from '../name-cleaner.js';
import { startCorrectPresentation, getPresentationJob } from '../presentation-cleaner.js';
import { startDomainSuggestions, getDomainSuggestionsJob } from '../domain-suggester.js';
import { captureBatchParallel } from '../screenshot-worker.js';
import { startProvisioning, getProvisioningStatus } from '../provisioning-worker.js';
import { slugify } from '../slug-generator.js';

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
      SELECT e.ts, e.event, e.slug, e.token, e.src, e.meta, e.ip, e.user_agent,
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
  const headers = ['ts', 'event', 'slug', 'salon', 'ville', 'code_postal', 'email', 'subscription_status', 'cold_mail_sent_at', 'src', 'ip', 'user_agent', 'meta'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const salon = (r.nom_clean && r.nom_clean.trim()) || r.nom || '';
    lines.push([r.ts, r.event, r.slug, salon, r.ville, r.code_postal, r.email, r.subscription_status, r.cold_mail_sent_at, r.src, r.ip, r.user_agent, r.meta].map(csvEscape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="preview-visits.csv"');
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

export default router;

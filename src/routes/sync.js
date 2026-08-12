/**
 * Sync endpoint : reçoit les données d'un salon depuis Helsinki au moment où
 * le coiffeur passe LIVE (post-paiement). Active uniquement en mode TENANT_ONLY.
 *
 * Auth : bearer token partagé (env SYNC_BEARER_TOKEN), MUST match côté Helsinki
 * provisioning-worker pour que le POST soit accepté.
 *
 * POST /api/sync/:slug
 * Body : { row: { ...colonnes salons } }
 *   → UPSERT dans salons, en PRÉSERVANT le contenu édité par le client ici.
 *
 * DELETE /api/sync/:slug
 *   → DELETE FROM salons (utile si annulation d'abonnement post-grace period)
 *
 * ── Qui fait autorité sur quoi ─────────────────────────────────────────────
 *
 * Le coiffeur édite son site sur le serveur qui le sert, c'est-à-dire ICI
 * (src/routes/edit.js est monté sur les deux serveurs). Ses modifications
 * atterrissent donc dans l'`overrides_json` de CETTE base, et rien ne les
 * remonte vers Helsinki : il n'existe aucun flux retour.
 *
 * L'ancien `INSERT OR REPLACE` écrasait toute la ligne avec la version
 * d'Helsinki — laquelle ignore tout des modifications du coiffeur. Concrètement :
 * un client qui personnalisait son site perdait tout au prochain sync, et il y
 * a un sync à chaque étape de provisioning (donc à chaque reprise du watchdog,
 * et à la bascule sur le domaine définitif).
 *
 * Règle retenue :
 *   - Helsinki fait autorité sur l'INFRASTRUCTURE (abonnement, hostname, Stripe,
 *     tokens, suspension…) : ces colonnes sont toujours écrasées.
 *   - Ce serveur fait autorité sur le CONTENU ÉDITÉ (overrides_json, template)
 *     dès lors que sa version est plus récente que celle reçue.
 *
 * Accessoirement, l'UPSERT remplace un `INSERT OR REPLACE` qui supprimait puis
 * réinsérait la ligne — ce qui changeait son id et déclenchait les ON DELETE
 * CASCADE des tables liées au slug.
 */

import express from 'express';
import db from '../db.js';

const router = express.Router();

const SYNC_TOKEN = process.env.SYNC_BEARER_TOKEN || '';

function requireSyncAuth(req, res, next) {
  if (!SYNC_TOKEN) {
    return res.status(500).json({ error: 'SYNC_BEARER_TOKEN non configuré côté Falkenstein' });
  }
  const auth = req.headers.authorization || '';
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (got !== SYNC_TOKEN) return res.status(403).json({ error: 'Token sync invalide' });
  next();
}

router.post('/sync/:slug', express.json({ limit: '2mb' }), requireSyncAuth, (req, res) => {
  const { slug } = req.params;
  const row = req.body?.row;
  if (!row || row.slug !== slug) {
    return res.status(400).json({ error: 'row.slug doit matcher :slug' });
  }

  // Liste des colonnes acceptées (= toutes celles de la table salons sauf id auto).
  // NB: data_json + nom sont NOT NULL côté DB → on met des fallbacks par défaut.
  const allowed = [
    'slug', 'nom', 'nom_clean', 'nom_clean_at',
    'ville', 'code_postal', 'adresse', 'telephone', 'email',
    'latitude', 'longitude', 'types',
    'note_avis', 'nb_avis', 'heures_ouverture',
    'meta_description', 'meta_image', 'titre_site', 'site_internet_original',
    'lien_facebook', 'lien_instagram', 'lien_tiktok', 'lien_youtube', 'lien_google_maps',
    'overrides_json', 'overrides_updated_at', 'data_json', 'template',
    'screenshot_path', 'screenshot_generated_at',
    'csv_source', 'group_id',
    'edit_token',
    'owner_email', 'plan',
    'stripe_customer_id', 'stripe_subscription_id',
    'commitment_months', 'commitment_until',
    'subscription_status', 'live_hostname', 'cloudflare_hostname_id',
    'signup_session_id', 'signed_up_at', 'cancelled_at',
    'domain_suggestions_json', 'domain_suggestions_at',
    'cgv_accepted_at', 'cgv_version', 'cgv_accepted_ip',
    'suspended_at', 'suspended_reason',
    // Magic link token doit être propagé vers Falkenstein, sinon le lien dans
    // l'email "site en ligne" (généré par Helsinki) est inconnu de Falkenstein
    // → coiffeur tombe sur le form "entrez votre email" au lieu d'accès direct.
    'recovery_token', 'recovery_token_expires_at',
    'created_at', 'updated_at',
  ];

  // Garantit les NOT NULL : si nom/data_json absents, on met une valeur safe
  if (row.nom == null) row.nom = row.slug;
  if (row.data_json == null) row.data_json = '{}';

  // Colonnes portant le travail du coiffeur : jamais écrasées par une version
  // plus ancienne. `template` suit `overrides_json` car il se modifie depuis le
  // même écran d'édition et n'a pas d'horodatage propre.
  const CONTENT_COLS = ['overrides_json', 'overrides_updated_at', 'template'];

  const existing = db.prepare('SELECT * FROM salons WHERE slug = ?').get(slug);

  // Le contenu local gagne s'il a été édité après la version qu'on reçoit.
  // Comparaison sur des dates SQLite ('YYYY-MM-DD HH:MM:SS'), donc ordonnables
  // en lexicographique. Sans date locale, il n'y a rien à préserver.
  let keepLocalContent = false;
  if (existing) {
    const localAt = existing.overrides_updated_at;
    const incomingAt = row.overrides_updated_at;
    keepLocalContent = !!localAt && (!incomingAt || localAt > incomingAt);
  }

  let cols = allowed.filter(c => row[c] !== undefined);
  if (keepLocalContent) {
    cols = cols.filter(c => !CONTENT_COLS.includes(c));
    console.log(`[sync] ${slug} : modifications locales conservées (éditées le ${existing.overrides_updated_at})`);
  }

  // Sync ne portant que du contenu, tout préservé : rien à écrire.
  if (existing && cols.filter(c => c !== 'slug').length === 0) {
    return res.json({ ok: true, slug, action: 'noop', contentPreserved: true });
  }

  const params = {};
  for (const c of cols) params[c] = row[c] === undefined ? null : row[c];

  // UPSERT ciblé plutôt qu'INSERT OR REPLACE : on met à jour les colonnes
  // reçues sans détruire la ligne (id stable, pas de CASCADE déclenché), et
  // sans toucher aux colonnes absentes de la liste.
  const colNames = cols.join(',');
  const placeholders = cols.map(c => '@' + c).join(',');
  const updates = cols.filter(c => c !== 'slug').map(c => `${c}=excluded.${c}`).join(',');
  const sql = `
    INSERT INTO salons (${colNames}) VALUES (${placeholders})
    ON CONFLICT(slug) DO UPDATE SET ${updates}
  `;

  try {
    db.prepare(sql).run(params);
    res.json({
      ok: true,
      slug,
      action: existing ? 'updated' : 'inserted',
      contentPreserved: keepLocalContent,
    });
  } catch (err) {
    console.error('[sync POST]', err);
    res.status(500).json({ error: 'DB error: ' + err.message });
  }
});

router.delete('/sync/:slug', requireSyncAuth, (req, res) => {
  const { slug } = req.params;
  try {
    const result = db.prepare('DELETE FROM salons WHERE slug = ?').run(slug);
    res.json({ ok: true, slug, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

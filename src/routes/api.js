import express from 'express';
import db from '../db.js';
import { buildSalonView } from '../defaults.js';

const router = express.Router();

// Middleware admin pour routes liste (expose edit_token, email, phone, stats internes).
// `/api/salon/:slug` (singulier) reste public car utilisé par le preview SSR — son
// payload ne contient PAS de PII (filtré par buildSalonView).
function requireAdminSession(req, res, next) {
  if (req.session?.userId) return next();
  return res.status(401).json({ error: 'Auth required' });
}

router.get('/salon/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM salons WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Salon introuvable' });
  res.json(buildSalonView(row));
});

router.get('/salons', requireAdminSession, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 5000);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search || '';
  const csvSource = req.query.csv_source || '';
  const groupId = req.query.group_id || ''; // peut etre 'none' pour les sans-groupe

  let where = '1=1';
  const params = {};
  if (search) {
    where += ' AND (nom LIKE @search OR nom_clean LIKE @search OR ville LIKE @search OR slug LIKE @search)';
    params.search = `%${search}%`;
  }
  if (csvSource) {
    where += ' AND csv_source = @csv_source';
    params.csv_source = csvSource;
  }
  if (groupId === 'none') {
    where += ' AND group_id IS NULL';
  } else if (groupId) {
    where += ' AND group_id = @group_id';
    params.group_id = parseInt(groupId, 10);
  }
  // Statut cold-mail : cold_mail_campaign fait foi (cold_mail_sent_at n'est
  // renseigné que pour les campagnes dont on a l'export Smartlead daté).
  if (req.query.contact_status === 'never') where += ' AND cold_mail_campaign IS NULL';
  else if (req.query.contact_status === 'contacted') where += ' AND cold_mail_campaign IS NOT NULL';
  if (req.query.email_domain) {
    where += ' AND email LIKE @email_domain';
    params.email_domain = `%@${String(req.query.email_domain).replace(/^@/, '').trim()}`;
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM salons WHERE ${where}`).get(params).n;
  const rows = db.prepare(`
    SELECT id, slug, nom, nom_clean, ville, code_postal, telephone, email, note_avis, nb_avis,
           meta_description, overrides_json, data_json,
           screenshot_path, screenshot_generated_at, csv_source, edit_token,
           overrides_json IS NOT NULL AS has_overrides, overrides_updated_at,
           nom_clean_at, created_at, domain_suggestions_json, domain_suggestions_at,
           cold_mail_campaign, cold_mail_sent_at
    FROM salons
    WHERE ${where}
    ORDER BY id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  // Enrichir : extraire presentation_scrappee, presentation_corrigee, domain_suggestions
  const enrichedRows = rows.map(r => {
    let presentationScrappee = r.meta_description || '';
    if (!presentationScrappee && r.data_json) {
      try {
        const data = JSON.parse(r.data_json);
        presentationScrappee = data.meta_description || '';
      } catch {}
    }
    let presentationCorrigee = '';
    if (r.overrides_json) {
      try {
        const overrides = JSON.parse(r.overrides_json);
        presentationCorrigee = overrides?.intro?.description || '';
      } catch {}
    }
    // Parse domain suggestions (JSON array [{name, rank}]) → array de noms triés par rank
    let domainSuggestions = [];
    if (r.domain_suggestions_json) {
      try {
        const arr = JSON.parse(r.domain_suggestions_json);
        if (Array.isArray(arr)) {
          domainSuggestions = arr
            .slice()
            .sort((a, b) => (a.rank || 999) - (b.rank || 999))
            .map(x => x.name)
            .filter(Boolean);
        }
      } catch {}
    }
    // On retire les colonnes brutes pour reduire la taille de la reponse
    const { meta_description, overrides_json, data_json, domain_suggestions_json, ...rest } = r;
    return {
      ...rest,
      presentation_scrappee: presentationScrappee,
      presentation_corrigee: presentationCorrigee,
      domain_suggestions: domainSuggestions,
    };
  });

  res.json({ total, limit, offset, rows: enrichedRows });
});

router.get('/csv-imports', requireAdminSession, (req, res) => {
  const rows = db.prepare(`
    SELECT id, filename, total_rows, imported_rows, skipped_rows, imported_at
    FROM csv_imports
    ORDER BY id DESC
    LIMIT 50
  `).all();
  res.json(rows);
});

router.get('/stats', requireAdminSession, (req, res) => {
  const groupId = req.query.group_id || '';
  let groupClause = '';
  const groupParams = {};
  if (groupId === 'none') {
    groupClause = ' WHERE group_id IS NULL';
  } else if (groupId) {
    groupClause = ' WHERE group_id = @group_id';
    groupParams.group_id = parseInt(groupId, 10);
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM salons' + groupClause).get(groupParams).n;
  const withScreenshot = db.prepare('SELECT COUNT(*) as n FROM salons' + (groupClause ? groupClause + ' AND' : ' WHERE') + ' screenshot_path IS NOT NULL').get(groupParams).n;
  const withoutScreenshot = total - withScreenshot;
  const withCleanName = db.prepare("SELECT COUNT(*) as n FROM salons" + (groupClause ? groupClause + ' AND' : ' WHERE') + " nom_clean_at IS NOT NULL").get(groupParams).n;
  const csvSources = db.prepare('SELECT csv_source, COUNT(*) as n FROM salons' + groupClause + ' GROUP BY csv_source ORDER BY n DESC').all(groupParams);
  // Cold-mail : combien de salons ont déjà reçu une campagne Smartlead.
  const contacted = db.prepare('SELECT COUNT(*) as n FROM salons' + (groupClause ? groupClause + ' AND' : ' WHERE') + ' cold_mail_campaign IS NOT NULL').get(groupParams).n;
  const neverContacted = total - contacted;
  // Joignables : adresse retenue par l'audit email (email_audit IS NULL) ET jamais
  // contactée. « Jamais contactés » compte des fiches, celui-ci compte des boîtes
  // réellement atteignables : sans doublon, sans adresse de plateforme ni de
  // domaine mort. Tant qu'aucun audit n'a tourné, les deux chiffres coïncident.
  const reachable = db.prepare('SELECT COUNT(*) as n FROM salons' + (groupClause ? groupClause + ' AND' : ' WHERE') +
    " cold_mail_campaign IS NULL AND email_audit IS NULL AND email IS NOT NULL AND trim(email) != ''").get(groupParams).n;
  const audited = db.prepare('SELECT COUNT(*) as n FROM salons' + (groupClause ? groupClause + ' AND' : ' WHERE') + ' email_audit IS NOT NULL').get(groupParams).n;
  res.json({ total, withScreenshot, withoutScreenshot, withCleanName, csvSources, contacted, neverContacted, reachable, audited });
});

export default router;

// Rapatriement de l'historique cold-mail Smartlead dans la table salons.
//
// Logique partagée entre le script CLI (scripts/import-contacted.js) et le
// bouton du dashboard (/admin/import-contacted). En prod on n'a pas d'accès
// SSH au conteneur, donc le bouton est le seul chemin praticable — le CLI
// reste utile en local et pour rejouer un import après coup.
//
// Source : data/contacted-seed.csv (email, slug, campaign, sent_at). Seul
// l'export Smartlead W7 fournit une date d'envoi ; W3/W6/W6-2 n'ont que le nom
// de campagne, donc sent_at y est vide et cold_mail_sent_at reste NULL. C'est
// cold_mail_campaign qui fait foi pour « déjà contacté ».
//
// Matching sur le slug (clé primaire côté salons, présent dans les preview_url
// des CSV d'origine) avec repli sur l'email. Idempotent.
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { db } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SEED = join(ROOT, 'data', 'contacted-seed.csv');

export function runContactedImport({ dryRun = true, seedPath = DEFAULT_SEED } = {}) {
  if (!existsSync(seedPath)) {
    const err = new Error(`Fichier seed introuvable : ${seedPath}`);
    err.code = 'SEED_MISSING';
    throw err;
  }

  const rows = parse(readFileSync(seedPath), { columns: true, skip_empty_lines: true, relax_quotes: true });

  const bySlug = db.prepare('SELECT slug FROM salons WHERE slug = ?');
  const byEmail = db.prepare('SELECT slug FROM salons WHERE lower(email) = ? LIMIT 1');
  const update = db.prepare(
    "UPDATE salons SET cold_mail_campaign = ?, cold_mail_sent_at = ?, updated_at = datetime('now') WHERE slug = ?"
  );

  const stats = { seed: rows.length, matchedBySlug: 0, matchedByEmail: 0, missed: 0, withDate: 0 };
  const missedSamples = [];
  const plan = [];

  for (const r of rows) {
    const email = (r.email || '').toLowerCase().trim();
    const campaign = (r.campaign || '').trim();
    const sentAt = (r.sent_at || '').trim() || null;
    if (!campaign) continue;

    let hit = r.slug ? bySlug.get(r.slug) : null;
    if (hit) stats.matchedBySlug++;
    else {
      hit = email ? byEmail.get(email) : null;
      if (hit) stats.matchedByEmail++;
    }
    if (!hit) {
      stats.missed++;
      if (missedSamples.length < 10) missedSamples.push(email || r.slug);
      continue;
    }
    if (sentAt) stats.withDate++;
    plan.push([campaign, sentAt, hit.slug]);
  }

  stats.matched = plan.length;
  stats.matchRate = rows.length ? Math.round((plan.length / rows.length) * 1000) / 10 : 0;
  stats.dryRun = dryRun;
  stats.applied = 0;

  if (!dryRun) {
    const run = db.transaction(items => { for (const p of items) update.run(...p); });
    run(plan);
    stats.applied = plan.length;
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM salons').get().n;
  const contacted = db.prepare('SELECT COUNT(*) AS n FROM salons WHERE cold_mail_campaign IS NOT NULL').get().n;
  stats.totalSalons = total;
  stats.contacted = contacted;
  stats.neverContacted = total - contacted;
  stats.missedSamples = missedSamples;

  return stats;
}

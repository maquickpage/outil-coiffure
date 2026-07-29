// Rapatrie l'historique cold-mail Smartlead dans la DB.
//
// Source : data/contacted-seed.csv (email, slug, campaign, sent_at) — construit
// depuis bibiproject/04-leads (contacted-master.csv) + les exports Smartlead par
// campagne. Seul l'export W7 fournit une date d'envoi exacte ; pour W3/W6/W6-2 on
// ne connaît que la campagne, donc sent_at reste vide et cold_mail_sent_at NULL.
// C'est cold_mail_campaign qui fait foi pour « déjà contacté ».
//
//   node scripts/import-contacted.js --dry-run   # rapport, n'écrit rien
//   node scripts/import-contacted.js             # applique
//
// Le matching se fait sur le slug (clé primaire côté salons, présent dans les
// preview_url des CSV) avec repli sur l'email. Idempotent : relancer ne fait que
// réécrire les mêmes valeurs.
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { db } from '../src/db.js';

const dryRun = process.argv.includes('--dry-run');
const seedPath = process.argv.find(a => a.endsWith('.csv')) || 'data/contacted-seed.csv';

const rows = parse(readFileSync(seedPath), { columns: true, skip_empty_lines: true, relax_quotes: true });
console.log(`Seed : ${rows.length} lignes (${seedPath})`);

const bySlug = db.prepare('SELECT slug FROM salons WHERE slug = ?');
const byEmail = db.prepare('SELECT slug FROM salons WHERE lower(email) = ? LIMIT 1');
const update = db.prepare(
  'UPDATE salons SET cold_mail_campaign = ?, cold_mail_sent_at = ?, updated_at = datetime(\'now\') WHERE slug = ?'
);

const stats = { slug: 0, email: 0, miss: 0, withDate: 0 };
const missed = [];
const plan = [];

for (const r of rows) {
  const email = (r.email || '').toLowerCase().trim();
  const campaign = (r.campaign || '').trim();
  const sentAt = (r.sent_at || '').trim() || null;
  if (!campaign) continue;

  let hit = r.slug ? bySlug.get(r.slug) : null;
  if (hit) stats.slug++;
  else {
    hit = email ? byEmail.get(email) : null;
    if (hit) stats.email++;
  }
  if (!hit) {
    stats.miss++;
    if (missed.length < 10) missed.push(email || r.slug);
    continue;
  }
  if (sentAt) stats.withDate++;
  plan.push([campaign, sentAt, hit.slug]);
}

console.log(`  matché par slug  : ${stats.slug}`);
console.log(`  matché par email : ${stats.email}`);
console.log(`  introuvable      : ${stats.miss}`);
console.log(`  dont date exacte : ${stats.withDate}`);
if (missed.length) console.log(`  exemples introuvables : ${missed.join(', ')}`);

const rate = rows.length ? ((plan.length / rows.length) * 100).toFixed(1) : '0';
console.log(`Taux de matching : ${rate}%`);

if (dryRun) {
  console.log('\n--dry-run : rien écrit.');
  process.exit(0);
}

const run = db.transaction(items => { for (const p of items) update.run(...p); });
run(plan);
console.log(`\n${plan.length} salons marqués comme contactés.`);

const total = db.prepare('SELECT COUNT(*) AS n FROM salons').get().n;
const done = db.prepare('SELECT COUNT(*) AS n FROM salons WHERE cold_mail_campaign IS NOT NULL').get().n;
console.log(`Base : ${done} contactés / ${total} salons → ${total - done} jamais contactés.`);

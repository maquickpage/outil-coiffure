/**
 * Adresse provisoire d'un site client — le sous-domaine sur lequel il vit entre le
 * paiement et la livraison du nom de domaine par le registrar.
 *
 * Le coiffeur paie, son site est en ligne dans la seconde sur
 * `{nom}.maquickpage.fr`, et bascule sur son vrai domaine quand OVH le livre
 * (de quelques minutes à 24 h). L'adresse provisoire est construite à partir du
 * domaine qu'il vient d'acheter — `quickpagefrance.fr` donne
 * `quickpagefrance.maquickpage.fr` — pour qu'il retrouve « son » nom tout de
 * suite et ose la partager.
 *
 * Servi par Falkenstein via le wildcard DNS `*.maquickpage.fr` et le TLS
 * on-demand de Caddy, exactement comme les domaines clients définitifs.
 */

import db from './db.js';

const ZONE = process.env.TEMP_HOSTNAME_ZONE || 'maquickpage.fr';

// Sous-domaines qui appartiennent à l'infra : un salon ne doit jamais pouvoir
// se les approprier, sinon il détourne la landing, l'admin agence ou le
// fallback des sites clients.
const RESERVED = new Set([
  'www', 'outil', 'demo', 'customers', 'ftp', 'mail', 'smtp', 'imap', 'pop',
  'api', 'admin', 'app', 'cdn', 'static', 'assets', 'blog', 'shop', 'test',
  'staging', 'dev', 'preview', 'mx', 'ns', 'ns1', 'ns2', 'autodiscover',
]);

/**
 * Racine utilisable d'un nom de domaine : `Salon-Jean.fr` → `salon-jean`.
 * Renvoie null si rien d'exploitable n'en sort.
 */
export function baseLabelFromHostname(hostname) {
  if (!hostname) return null;
  const label = String(hostname).toLowerCase().trim().split('.')[0];
  const clean = label
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // accents
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Un label DNS fait 63 caractères au plus.
  const trimmed = clean.slice(0, 50).replace(/-$/, '');
  return trimmed || null;
}

/**
 * Calcule l'adresse provisoire d'un salon, en évitant les collisions avec
 * l'infra et avec les autres salons (deux coiffeurs peuvent acheter
 * `salon-jean.fr` et `salon-jean.com`).
 *
 * @param {string} hostname - le domaine acheté (ex: 'quickpagefrance.fr')
 * @param {string} slug     - le salon concerné, pour ne pas se voir refuser sa propre adresse
 */
export function buildTempHostname(hostname, slug) {
  let base = baseLabelFromHostname(hostname);
  if (!base) base = baseLabelFromHostname(slug);
  if (!base) return null;
  if (RESERVED.has(base)) base = `${base}-salon`;

  const taken = db.prepare(
    'SELECT slug FROM salons WHERE temp_hostname = ? AND slug != ?'
  );

  let candidate = `${base}.${ZONE}`;
  if (!taken.get(candidate, slug)) return candidate;

  // Collision : on suffixe. Le suffixe reste court et lisible — c'est une
  // adresse que le coiffeur va lire et parfois dicter.
  for (let i = 2; i <= 99; i++) {
    candidate = `${base}-${i}.${ZONE}`;
    if (!taken.get(candidate, slug)) return candidate;
  }
  return null;
}

/**
 * Renvoie l'adresse provisoire du salon, en la calculant et en la persistant au
 * premier appel. Idempotent : rappelé lors d'une reprise du watchdog, il rend
 * la même adresse et ne touche pas à la base.
 */
export function ensureTempHostname(slug, hostname) {
  const row = db.prepare('SELECT temp_hostname FROM salons WHERE slug = ?').get(slug);
  if (!row) return null;
  if (row.temp_hostname) return row.temp_hostname;

  const temp = buildTempHostname(hostname, slug);
  if (!temp) return null;
  db.prepare(
    "UPDATE salons SET temp_hostname = ?, updated_at = datetime('now') WHERE slug = ?"
  ).run(temp, slug);
  console.log(`[temp-hostname] ${slug} → ${temp}`);
  return temp;
}

export default { buildTempHostname, ensureTempHostname, baseLabelFromHostname };

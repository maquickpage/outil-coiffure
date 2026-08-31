/**
 * Attribution minimale de paiement (WP1) — module ISOLÉ, écriture best-effort.
 *
 * Principe : on veut savoir de quelle source vient un paiement, SANS cookie de
 * parcours et SANS ajouter de donnée personnelle.
 *
 *   1. L'enregistrement est créé côté serveur AU MOMENT de la soumission du
 *      lookup (POST /api/landing/check). Jamais avant, jamais par le client.
 *   2. L'`id` est opaque : 16 octets aléatoires. Il ne contient ni email, ni IP,
 *      ni User-Agent, ni slug.
 *   3. La continuité vers le preview puis vers Stripe passe par un token SIGNÉ
 *      côté serveur (HMAC-SHA256), sur le modèle déjà éprouvé en production
 *      dans src/routes/unsubscribe.js (`/u/:token`).
 *   4. Le token ne peut que RÉFÉRENCER un enregistrement existant : la
 *      vérification lit la base et renvoie null si la ligne n'existe pas. Un
 *      client ne peut donc ni créer ni écraser un enregistrement.
 *   5. Le token d'attribution ne donne AUCUN droit : il ne remplace ni
 *      l'edit_token, ni le magic link, ni aucune vérification de propriété.
 *
 * Toutes les fonctions publiques sont best-effort : elles n'émettent JAMAIS
 * d'exception, sur le modèle de logEvent() dans src/routes/tracking.js. Une
 * attribution absente ou en échec ne doit jamais bloquer Checkout, paiement ou
 * provisioning.
 */

import crypto from 'node:crypto';
import db from './db.js';

// Séparation de domaine : le secret peut être partagé avec d'autres usages,
// le préfixe empêche qu'une signature valide ailleurs le soit ici.
const HMAC_PREFIX = 'mqa1:';

function secret() {
  return process.env.ATTRIBUTION_SECRET || process.env.SESSION_SECRET || '';
}

// =============================================================================
// Normalisation / validation des entrées (aucune valeur brute n'est stockée)
// =============================================================================

const SRC_MAX = 40;
const UTM_MAX = 80;
const PATH_MAX = 120;
const HOST_MAX = 100;

/** src / utm_* : minuscules, [a-z0-9._-] + tirets, longueur bornée. */
export function normalizeTag(value, max = UTM_MAX) {
  if (value == null) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[\s+]+/g, '-');          // espaces/plus → tiret
  s = s.replace(/[^a-z0-9._-]/g, '');     // validation de caractères
  s = s.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  s = s.slice(0, max);
  return s || null;
}

/** Hostname de referrer : jamais l'URL complète, jamais de query string. */
export function normalizeHost(value) {
  if (value == null) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  // Tolère une URL complète : on n'en garde que l'hôte.
  if (s.includes('/')) {
    try { s = new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return null; }
  }
  s = s.replace(/^www\./, '');
  if (!/^[a-z0-9.-]{1,100}$/.test(s)) return null;
  return s.slice(0, HOST_MAX) || null;
}

/** Chemin de la page d'entrée (sans query string : pas de PII dans les params). */
export function normalizePath(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.split('?')[0].split('#')[0].toLowerCase();
  s = s.replace(/[^a-z0-9/_.-]/g, '');
  s = s.slice(0, PATH_MAX);
  return s || null;
}

/**
 * Extrait source + UTM d'une URL de page (celle d'où le lookup a été soumis).
 * Retourne toujours un objet, même sur URL invalide.
 */
export function parsePageUrl(pageUrl) {
  const out = {
    landing_path: null, first_source: null,
    utm_source: null, utm_medium: null, utm_campaign: null,
    utm_term: null, utm_content: null,
  };
  if (!pageUrl) return out;
  let u;
  try { u = new URL(String(pageUrl)); } catch { return out; }
  out.landing_path = normalizePath(u.pathname);
  const q = u.searchParams;
  out.first_source = normalizeTag(q.get('src'), SRC_MAX);
  out.utm_source = normalizeTag(q.get('utm_source'));
  out.utm_medium = normalizeTag(q.get('utm_medium'));
  out.utm_campaign = normalizeTag(q.get('utm_campaign'));
  out.utm_term = normalizeTag(q.get('utm_term'));
  out.utm_content = normalizeTag(q.get('utm_content'));
  // Pas de ?src= explicite → l'utm_source fait office de source première.
  if (!out.first_source && out.utm_source) out.first_source = out.utm_source.slice(0, SRC_MAX);
  return out;
}

// =============================================================================
// Création (uniquement à la soumission du lookup)
// =============================================================================

/**
 * @param {Object} input
 * @param {string} [input.pageUrl]      URL de la page d'où le lookup est soumis
 *                                      (header Referer de la requête, même origine)
 * @param {string} [input.referrerHost] hostname du referrer externe (fourni par
 *                                      la page, normalisé et validé ici)
 * @param {string} [input.salonSlug]    slug du salon trouvé (null si non couvert)
 * @param {boolean} [input.found]
 * @returns {string|null} id d'attribution, ou null si l'écriture a échoué
 */
export function createAttribution({ pageUrl = null, referrerHost = null, salonSlug = null, found = false } = {}) {
  try {
    const parsed = parsePageUrl(pageUrl);
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO payment_attributions
        (id, first_source, landing_path, referrer_host,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         salon_slug, lead_found)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      parsed.first_source,
      parsed.landing_path,
      normalizeHost(referrerHost),
      parsed.utm_source, parsed.utm_medium, parsed.utm_campaign,
      parsed.utm_term, parsed.utm_content,
      salonSlug ? String(salonSlug).slice(0, 200) : null,
      found ? 1 : 0
    );
    return id;
  } catch (err) {
    console.error('[attribution] création impossible (non bloquant):', err.message);
    return null;
  }
}

// =============================================================================
// Token signé (continuité lookup → preview → Checkout)
// =============================================================================

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(id) {
  return b64url(crypto.createHmac('sha256', secret()).update(HMAC_PREFIX + id).digest());
}

/** @returns {string|null} token porteur, ou null si pas de secret / pas d'id. */
export function signToken(id) {
  try {
    if (!secret() || !/^[0-9a-f]{32}$/.test(String(id || ''))) return null;
    return `${id}.${sign(id)}`;
  } catch { return null; }
}

/**
 * Vérifie la signature SANS toucher la base. Comparaison à temps constant.
 * @returns {string|null} l'id si la signature est authentique, sinon null.
 */
export function verifyToken(token) {
  try {
    if (!secret() || typeof token !== 'string') return null;
    const m = token.match(/^([0-9a-f]{32})\.([A-Za-z0-9_-]{1,64})$/);
    if (!m) return null;
    const expected = sign(m[1]);
    const a = Buffer.from(m[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return m[1];
  } catch { return null; }
}

/**
 * Token → enregistrement EXISTANT. Ne crée jamais rien, n'écrase jamais rien.
 * @returns {Object|null} la ligne payment_attributions, ou null.
 */
export function resolveAttribution(token) {
  try {
    const id = verifyToken(token);
    if (!id) return null;
    return db.prepare('SELECT * FROM payment_attributions WHERE id = ?').get(id) || null;
  } catch { return null; }
}

/** Le prospect est revenu sur son preview avec un token valide. Best-effort. */
export function touchPreviewSeen(token) {
  try {
    const id = verifyToken(token);
    if (!id) return false;
    const r = db.prepare(`
      UPDATE payment_attributions
      SET preview_seen_at = COALESCE(preview_seen_at, datetime('now'))
      WHERE id = ?
    `).run(id);
    return r.changes === 1;
  } catch { return false; }
}

// =============================================================================
// Checkout / paiement
// =============================================================================

/** Enregistre la Session Stripe créée. Idempotent, jamais bloquant. */
export function recordCheckout({ sessionId, attributionId = null, salonSlug = null, plan = null, hostname = null, template = null } = {}) {
  try {
    if (!sessionId) return false;
    db.prepare(`
      INSERT INTO attribution_checkouts
        (stripe_session_id, attribution_id, salon_slug, plan, hostname, template)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(stripe_session_id) DO NOTHING
    `).run(
      String(sessionId).slice(0, 200),
      attributionId ? String(attributionId).slice(0, 64) : null,
      salonSlug ? String(salonSlug).slice(0, 200) : null,
      plan ? String(plan).slice(0, 40) : null,
      hostname ? String(hostname).slice(0, 253) : null,
      template ? String(template).slice(0, 40) : null
    );
    return true;
  } catch (err) {
    console.error('[attribution] recordCheckout échoué (non bloquant):', err.message);
    return false;
  }
}

/**
 * Marque une Session comme payée, par ID de Session Stripe.
 * - Rejeu de webhook : `paid_at` conserve la PREMIÈRE valeur (idempotent).
 * - Session antérieure à l'attribution : la ligne est créée avec
 *   attribution_id NULL, le traitement continue normalement.
 * Ne lève jamais : un échec ici ne doit pas faire échouer le webhook, sinon
 * Stripe rejouerait l'event et relancerait un provisioning (achat de domaine).
 */
export function markCheckoutPaid({ sessionId, attributionId = null, salonSlug = null, plan = null, hostname = null, template = null } = {}) {
  try {
    if (!sessionId) return false;
    db.prepare(`
      INSERT INTO attribution_checkouts
        (stripe_session_id, attribution_id, salon_slug, plan, hostname, template, paid_at)
      VALUES (?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(stripe_session_id) DO UPDATE SET
        paid_at = COALESCE(attribution_checkouts.paid_at, datetime('now')),
        attribution_id = COALESCE(attribution_checkouts.attribution_id, excluded.attribution_id),
        salon_slug = COALESCE(attribution_checkouts.salon_slug, excluded.salon_slug),
        plan = COALESCE(attribution_checkouts.plan, excluded.plan),
        hostname = COALESCE(attribution_checkouts.hostname, excluded.hostname),
        template = COALESCE(attribution_checkouts.template, excluded.template)
    `).run(
      String(sessionId).slice(0, 200),
      attributionId ? String(attributionId).slice(0, 64) : null,
      salonSlug ? String(salonSlug).slice(0, 200) : null,
      plan ? String(plan).slice(0, 40) : null,
      hostname ? String(hostname).slice(0, 253) : null,
      template ? String(template).slice(0, 40) : null
    );
    return true;
  } catch (err) {
    console.error('[attribution] markCheckoutPaid échoué (non bloquant):', err.message);
    return false;
  }
}

export default {
  createAttribution,
  signToken,
  verifyToken,
  resolveAttribution,
  touchPreviewSeen,
  recordCheckout,
  markCheckoutPaid,
  normalizeTag,
  normalizeHost,
  normalizePath,
  parsePageUrl,
};

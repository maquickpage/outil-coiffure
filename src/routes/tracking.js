/**
 * Suivi funnel maquettes — module ISOLÉ, écriture best-effort (jamais bloquante).
 *
 * - logEvent() : insert défensif dans preview_events (ne throw JAMAIS).
 * - trackingMiddleware : log côté serveur preview_ouvert / editeur_ouvert /
 *   editeur_modifie d'après method+path (slug = segment d'URL, pas de body parse).
 *   Gated routingMode='public' → ne logge que le funnel prospect (pas l'admin agence).
 * - router : POST /api/track (beacons navigateur, events whitelistés).
 *
 * N'altère AUCUNE logique existante : observe seulement.
 */

import express from 'express';
import db from '../db.js';

const router = express.Router();

// Slugs réservés sous /admin (= pas des salons) — ne pas logger comme éditeur.
const RESERVED = new Set(['login', 'logout', 'me', 'index.html', 'login.html', 'admin.css', 'admin.js', 'i18n.js', 'api', 'groups', 'salon', 'job', 'screenshot', 'upload-csv', 'export-csv', 'clean-names', 'csv-source', 'reset-clean-name']);

// Events navigateur autorisés (anti-spam de la table si l'endpoint est sondé).
const ALLOWED_CLIENT_EVENTS = new Set(['pricing_ouvert', 'etape_prix', 'etape_domaine', 'domaine_perso', 'etape_email', 'cgv_accepte', 'paiement_initie', 'scroll_max']);

// Funnel de la landing maquickpage.fr (page marketing) — events ANONYMES, sans
// salon rattaché (slug=null). N'exigent donc PAS salonExists() (contrairement
// aux events maquette ci-dessus qui sont rattachés à un salon réel).
const ALLOWED_LANDING_EVENTS = new Set(['landing_scroll', 'landing_cta', 'landing_check_open', 'landing_check_submit']);

let insertStmt = null;
export function logEvent({ event, slug = null, token = null, src = null, meta = null, ip = null, ua = null }) {
  try {
    if (!event) return;
    if (!insertStmt) {
      insertStmt = db.prepare(
        'INSERT INTO preview_events (event, slug, token, src, meta, ip, user_agent) VALUES (?,?,?,?,?,?,?)'
      );
    }
    const metaStr = meta == null ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta));
    insertStmt.run(
      String(event).slice(0, 40),
      slug ? String(slug).slice(0, 200) : null,
      token ? String(token).slice(0, 200) : null,
      src ? String(src).slice(0, 40) : null,
      metaStr ? metaStr.slice(0, 500) : null,
      ip ? String(ip).slice(0, 64) : null,
      ua ? String(ua).slice(0, 400) : null
    );
  } catch { /* best-effort : ne JAMAIS casser la requête appelante */ }
}

// Vrai uniquement si le slug correspond à un salon réel. Bloque le bruit des
// scanners qui sondent /admin/<x> (phpinfo.php, .env, controller…) : sans salon
// correspondant, on ne logge pas l'event (sinon il pollue le suivi des maquettes).
let existsStmt = null;
function salonExists(slug) {
  try {
    if (!slug) return false;
    if (!existsStmt) existsStmt = db.prepare('SELECT 1 FROM salons WHERE slug = ? LIMIT 1');
    return !!existsStmt.get(String(slug));
  } catch { return false; }
}

// IP client — MÊME dérivation partout (funnel + landing_leads) pour que le
// rapprochement journey↔lead par (ip|ua) matche exactement, y compris hors CF.
export function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim();
}

// Middleware serveur — log non-bloquant, uniquement sur le host public (prospects).
export function trackingMiddleware(req, res, next) {
  try {
    // maquickpage.fr = routingMode 'landing' (LANDING_BASE_URL défaute sur
    // PUBLIC_BASE_URL et 'landing' est testé avant 'public'). On accepte les
    // deux = tout le funnel prospect, en excluant 'admin' (agence) et 'mixed'.
    if (req.routingMode === 'public' || req.routingMode === 'landing') {
      const m = req.method, p = req.path;
      if (m === 'GET') {
        // Landing maquickpage.fr : la home est servie sur l'apex (routingMode
        // 'landing'). GET / = une visite du funnel marketing (anonyme).
        if (req.routingMode === 'landing' && (p === '/' || p === '/index.html')) {
          logEvent({ event: 'landing_view', src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'] });
        }
        let mm = p.match(/^\/preview\/([^/?#]+)/);
        if (mm) {
          const slug = decodeURIComponent(mm[1]);
          if (salonExists(slug)) {
            logEvent({ event: 'preview_ouvert', slug, token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'] });
          }
        } else {
          mm = p.match(/^\/admin\/([^/?#]+)/);
          if (mm && !RESERVED.has(mm[1])) {
            const slug = decodeURIComponent(mm[1]);
            if (salonExists(slug)) {
              logEvent({ event: 'editeur_ouvert', slug, token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'] });
            }
          }
        }
      } else if (m === 'POST') {
        const mm = p.match(/^\/api\/edit\/([^/?#]+)/);
        if (mm) {
          const slug = decodeURIComponent(mm[1]);
          if (salonExists(slug)) {
            logEvent({ event: 'editeur_modifie', slug, ip: clientIp(req), ua: req.headers['user-agent'] });
          }
        }
      }
    }
  } catch { /* never block */ }
  next();
}

// Beacon navigateur
router.post('/track', express.json({ limit: '4kb' }), (req, res) => {
  try {
    const b = req.body || {};
    if (b.event && ALLOWED_LANDING_EVENTS.has(b.event)) {
      // Funnel landing : anonyme, jamais rattaché à un salon (slug ignoré).
      logEvent({ event: b.event, src: b.src, meta: b.meta, ip: clientIp(req), ua: req.headers['user-agent'] });
    } else if (b.event && ALLOWED_CLIENT_EVENTS.has(b.event) && salonExists(b.slug)) {
      logEvent({ event: b.event, slug: b.slug, token: b.token, src: b.src, meta: b.meta, ip: clientIp(req), ua: req.headers['user-agent'] });
    }
  } catch {}
  res.status(204).end();
});

export default router;

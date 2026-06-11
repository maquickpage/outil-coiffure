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
const ALLOWED_CLIENT_EVENTS = new Set(['pricing_ouvert', 'etape_prix', 'etape_domaine', 'etape_email', 'paiement_initie', 'scroll_max']);

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

function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim();
}

// Middleware serveur — log non-bloquant, uniquement sur le host public (prospects).
export function trackingMiddleware(req, res, next) {
  try {
    if (req.routingMode === 'public') {
      const m = req.method, p = req.path;
      if (m === 'GET') {
        let mm = p.match(/^\/preview\/([^/?#]+)/);
        if (mm) {
          logEvent({ event: 'preview_ouvert', slug: decodeURIComponent(mm[1]), token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'] });
        } else {
          mm = p.match(/^\/admin\/([^/?#]+)/);
          if (mm && !RESERVED.has(mm[1])) {
            logEvent({ event: 'editeur_ouvert', slug: decodeURIComponent(mm[1]), token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'] });
          }
        }
      } else if (m === 'POST') {
        const mm = p.match(/^\/api\/edit\/([^/?#]+)/);
        if (mm) {
          logEvent({ event: 'editeur_modifie', slug: decodeURIComponent(mm[1]), ip: clientIp(req), ua: req.headers['user-agent'] });
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
    if (b.event && ALLOWED_CLIENT_EVENTS.has(b.event)) {
      logEvent({ event: b.event, slug: b.slug, token: b.token, src: b.src, meta: b.meta, ip: clientIp(req), ua: req.headers['user-agent'] });
    }
  } catch {}
  res.status(204).end();
});

export default router;

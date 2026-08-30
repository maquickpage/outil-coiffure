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
import crypto from 'node:crypto';
import db from '../db.js';

const router = express.Router();

// Slugs réservés sous /admin (= pas des salons) — ne pas logger comme éditeur.
const RESERVED = new Set(['login', 'logout', 'me', 'index.html', 'login.html', 'admin.css', 'admin.js', 'i18n.js', 'api', 'groups', 'salon', 'job', 'screenshot', 'upload-csv', 'export-csv', 'clean-names', 'csv-source', 'reset-clean-name']);

// Events navigateur autorisés (anti-spam de la table si l'endpoint est sondé).
const ALLOWED_CLIENT_EVENTS = new Set(['pricing_ouvert', 'etape_prix', 'etape_domaine', 'domaine_perso', 'etape_email', 'cgv_accepte', 'paiement_initie', 'scroll_max', 'paywall_peek_viewed', 'paywall_peek_opened', 'paywall_dismissed', 'template_essaye']);

// Funnel de la landing maquickpage.fr (page marketing) — events ANONYMES, sans
// salon rattaché (slug=null). N'exigent donc PAS salonExists() (contrairement
// aux events maquette ci-dessus qui sont rattachés à un salon réel).
const ALLOWED_LANDING_EVENTS = new Set(['landing_ready', 'landing_scroll', 'landing_cta', 'landing_check_open', 'landing_check_submit']);

let insertStmt = null;
export function logEvent({ event, slug = null, token = null, src = null, meta = null, ip = null, ua = null, device = null }) {
  try {
    if (!event) return;
    if (!insertStmt) {
      insertStmt = db.prepare(
        'INSERT INTO preview_events (event, slug, token, src, meta, ip, user_agent, device) VALUES (?,?,?,?,?,?,?,?)'
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
      ua ? String(ua).slice(0, 400) : null,
      device ? String(device).slice(0, 40) : null
    );
  } catch { /* best-effort : ne JAMAIS casser la requête appelante */ }
}

// === Appareils internes (cookie longue durée) ===================
// Un de nos appareils passe une fois par /api/no-track?k=… : on lui pose un
// cookie 10 ans et on l'inscrit dans suivi_excluded_devices. Ensuite chaque
// visite (a) marque l'event de son device_id, (b) mémorise sa signature
// (ip|ua) — c'est cette signature qui permet d'écarter RÉTROACTIVEMENT ses
// visites passées, qui elles n'ont pas de device_id.
const NOTRACK_COOKIE = 'mqs_nt';
const NOTRACK_MAX_AGE = 10 * 365 * 24 * 3600; // 10 ans

export function deviceIdOf(req) {
  try {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() !== NOTRACK_COOKIE) continue;
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : null;
    }
  } catch { /* ignore */ }
  return null;
}

let isExcludedStmt = null, touchSigStmt = null, touchDevStmt = null;
// Mémorise (device, ip, ua) si l'appareil est marqué. Best-effort, jamais bloquant.
function rememberDevice(req, device, ip, ua) {
  try {
    if (!device) return;
    if (!isExcludedStmt) isExcludedStmt = db.prepare('SELECT 1 FROM suivi_excluded_devices WHERE device_id = ? LIMIT 1');
    if (!isExcludedStmt.get(device)) return; // cookie présent mais appareil réactivé → on ne mémorise plus
    if (!touchSigStmt) {
      touchSigStmt = db.prepare(`
        INSERT INTO suivi_device_sigs (device_id, ip, ua) VALUES (?,?,?)
        ON CONFLICT(device_id, ip, ua) DO UPDATE SET last_seen = datetime('now')
      `);
      touchDevStmt = db.prepare("UPDATE suivi_excluded_devices SET last_seen = datetime('now') WHERE device_id = ?");
    }
    touchSigStmt.run(device, String(ip || '').slice(0, 64), String(ua || '').slice(0, 400));
    touchDevStmt.run(device);
  } catch { /* ignore */ }
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
      const device = deviceIdOf(req);
      if (device) rememberDevice(req, device, clientIp(req), req.headers['user-agent']);
      if (m === 'GET') {
        // Landing maquickpage.fr : la home est servie sur l'apex (routingMode
        // 'landing'). GET / = une visite du funnel marketing (anonyme).
        if (req.routingMode === 'landing' && (p === '/' || p === '/index.html' || p === '/en')) {
          const meta = p === '/en' ? { lang: 'en' } : null;
          logEvent({ event: 'landing_view', src: req.query.src || null, meta, ip: clientIp(req), ua: req.headers['user-agent'], device });
        }
        let mm = p.match(/^\/preview\/([^/?#]+)/);
        if (mm) {
          const slug = decodeURIComponent(mm[1]);
          if (salonExists(slug)) {
            logEvent({ event: 'preview_ouvert', slug, token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'], device });
          }
        } else {
          mm = p.match(/^\/admin\/([^/?#]+)/);
          if (mm && !RESERVED.has(mm[1])) {
            const slug = decodeURIComponent(mm[1]);
            if (salonExists(slug)) {
              logEvent({ event: 'editeur_ouvert', slug, token: req.query.token || null, src: req.query.src || null, ip: clientIp(req), ua: req.headers['user-agent'], device });
            }
          }
        }
      } else if (m === 'POST') {
        const mm = p.match(/^\/api\/edit\/([^/?#]+)/);
        if (mm) {
          const slug = decodeURIComponent(mm[1]);
          if (salonExists(slug)) {
            logEvent({ event: 'editeur_modifie', slug, ip: clientIp(req), ua: req.headers['user-agent'], device });
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
    const device = deviceIdOf(req);
    if (device) rememberDevice(req, device, clientIp(req), req.headers['user-agent']);
    if (b.event && ALLOWED_LANDING_EVENTS.has(b.event)) {
      // Funnel landing : anonyme, jamais rattaché à un salon (slug ignoré).
      logEvent({ event: b.event, src: b.src, meta: b.meta, ip: clientIp(req), ua: req.headers['user-agent'], device });
    } else if (b.event && ALLOWED_CLIENT_EVENTS.has(b.event) && salonExists(b.slug)) {
      logEvent({ event: b.event, slug: b.slug, token: b.token, src: b.src, meta: b.meta, ip: clientIp(req), ua: req.headers['user-agent'], device });
    }
  } catch {}
  res.status(204).end();
});

// === GET /api/no-track — marque CET appareil comme interne ==================
//   ?k=<TRACKING_OPTOUT_KEY>          obligatoire (sinon 404, endpoint invisible)
//   &label=iphone-johann              libellé lisible dans stats.html
//   &off=1                            réactive l'appareil (retire l'exclusion)
// Pose un cookie 10 ans et enregistre tout de suite la signature (ip|ua) : les
// visites PASSÉES de cet appareil sortent donc du Suivi immédiatement, sans
// qu'aucun event ne soit supprimé.
const optoutKey = () => process.env.TRACKING_OPTOUT_KEY || '';

function cookieDomain(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  const m = h.match(/([^.]+\.[^.]+)$/); // domaine enregistrable (maquickpage.fr)
  return m && h !== 'localhost' ? `; Domain=.${m[1]}` : '';
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!doctype html><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${title}</title>`
  + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#222}`
  + `h1{font-size:1.3rem}code{background:#f4f4f4;padding:.15em .4em;border-radius:.25em}`
  + `input[type=text]{width:100%;font:inherit;padding:.7em .8em;border:1.5px solid #ccc;border-radius:.5em;margin:.4em 0 1em}`
  + `input:focus{outline:none;border-color:#C8A24B}`
  + `button{font:inherit;font-weight:600;background:#C8A24B;color:#fff;border:0;padding:.7em 1.4em;border-radius:.5em;cursor:pointer}`
  + `.hint{color:#777;font-size:.9em}</style>`
  + body;

// Proposition de nom d'après le User-Agent — l'utilisateur reste libre de la
// remplacer, c'est juste pour éviter d'avoir à tout taper sur un mobile.
function guessLabel(ua) {
  const s = String(ua || '');
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? 'Téléphone Android' : 'Tablette Android';
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac';
  if (/Windows/i.test(s)) return 'PC Windows';
  if (/Linux/i.test(s)) return 'PC Linux';
  return '';
}

router.get('/no-track', (req, res) => {
  const key = optoutKey();
  // Pas de clé configurée ou clé fausse → 404 : l'endpoint n'existe pas pour un tiers.
  if (!key || String(req.query.k || '') !== key) return res.status(404).end();

  try {
    const host = req.headers.host;
    const attrs = `; Path=/; Max-Age=${NOTRACK_MAX_AGE}; SameSite=Lax; Secure${cookieDomain(host)}`;

    if (req.query.off) {
      const device = deviceIdOf(req);
      if (device) db.prepare('DELETE FROM suivi_excluded_devices WHERE device_id = ?').run(device);
      res.setHeader('Set-Cookie', `${NOTRACK_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure${cookieDomain(host)}`);
      return res.send(page('Tracking réactivé', '<h1>Tracking réactivé</h1><p>Cet appareil est de nouveau compté dans le Suivi maquettes. Ses visites passées y réapparaissent.</p>'));
    }

    // Pas encore de nom → on demande, et on ne marque RIEN tant qu'il n'est pas
    // donné (sinon un simple aperçu de lien crée une entrée fantôme).
    const label = String(req.query.label || '').trim().slice(0, 60);
    if (!label) {
      const suggestion = guessLabel(req.headers['user-agent']);
      return res.send(page('Nommer cet appareil',
        `<h1>Quel est cet appareil&nbsp;?</h1>`
        + `<p>Donne-lui un nom reconnaissable — c'est celui que tu verras dans le Suivi pour le réactiver un jour.</p>`
        + `<form method="GET" action="/api/no-track">`
        + `<input type="hidden" name="k" value="${esc(key)}">`
        + `<input type="text" name="label" autofocus autocomplete="off" maxlength="60" required`
        + ` value="${esc(suggestion)}" placeholder="ex. téléphone Johann">`
        + `<button type="submit">Exclure cet appareil du suivi</button>`
        + `</form>`
        + `<p class="hint">Astuce : précise à qui il est (« téléphone Johann », « Mac Michele ») — il y aura vite plusieurs iPhone dans la liste.</p>`));
    }

    // Un même appareil passe souvent par plusieurs navigateurs (Chrome, Safari,
    // navigateur in-app d'une messagerie) : chacun a son propre cookie, donc son
    // propre identifiant, et la liste se remplissait de doublons du même nom.
    // Le NOM fait donc foi : si ce libellé existe déjà, on reprend son
    // identifiant et le nouveau navigateur rejoint l'appareil existant.
    const twin = db.prepare(`
      SELECT device_id FROM suivi_excluded_devices
      WHERE lower(trim(label)) = lower(trim(?)) ORDER BY added_at LIMIT 1
    `).get(label);
    const fromCookie = deviceIdOf(req);
    const device = (twin && twin.device_id) || fromCookie || crypto.randomUUID().replace(/-/g, '').slice(0, 24);

    // Le navigateur portait déjà un autre identifiant (ex. il avait été nommé
    // autrement) → on rapatrie ses signatures et ses events sur l'appareil retenu
    // pour ne perdre aucune exclusion rétroactive, puis on supprime le doublon.
    if (fromCookie && fromCookie !== device) {
      db.prepare('UPDATE OR IGNORE suivi_device_sigs SET device_id = ? WHERE device_id = ?').run(device, fromCookie);
      db.prepare('DELETE FROM suivi_device_sigs WHERE device_id = ?').run(fromCookie);
      db.prepare('UPDATE preview_events SET device = ? WHERE device = ?').run(device, fromCookie);
      db.prepare('DELETE FROM suivi_excluded_devices WHERE device_id = ?').run(fromCookie);
    }
    db.prepare(`
      INSERT INTO suivi_excluded_devices (device_id, label, last_seen) VALUES (?,?,datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET label = excluded.label, last_seen = datetime('now')
    `).run(device, label);
    // Signature immédiate = c'est ce qui rend l'exclusion rétroactive.
    db.prepare(`
      INSERT INTO suivi_device_sigs (device_id, ip, ua) VALUES (?,?,?)
      ON CONFLICT(device_id, ip, ua) DO UPDATE SET last_seen = datetime('now')
    `).run(device, String(clientIp(req)).slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 400));

    res.setHeader('Set-Cookie', `${NOTRACK_COOKIE}=${device}${attrs}`);
    res.send(page('Appareil exclu du suivi', `<h1>C'est bon, cet appareil est exclu du Suivi</h1>`
      + `<p>Libellé : <code>${esc(label)}</code></p>`
      + `<p>Tes visites sur les maquettes ne seront plus comptées comme celles d'un prospect — ni les prochaines, ni celles déjà enregistrées depuis cette connexion.</p>`
      + `<p>Valable 10 ans sur ce navigateur. À refaire si tu effaces les cookies, ou depuis un autre navigateur du même appareil.</p>`));
  } catch (e) {
    res.status(500).send(page('Erreur', `<h1>Erreur</h1><p>${esc(e.message)}</p>`));
  }
});

export default router;

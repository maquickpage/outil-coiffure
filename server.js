import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import db from './src/db.js';
import apiRouter from './src/routes/api.js';
import editRouter from './src/routes/edit.js';
import { buildSalonView } from './src/defaults.js';
import { renderSalonHtml, renderRobotsTxt, renderSitemap, isMainDomainHost } from './src/ssr.js';

// === TENANT_ONLY mode ===
// Sur Falkenstein (= sites coiffeurs payants) on désactive :
//   - admin agence (/admin), Stripe webhook, signup flow (/api/checkout, /api/domain),
//     captures Puppeteer, IA workers, CSV import.
// On garde uniquement : preview, admin coiffeur tokenisé, /api/edit, /api/salon,
// et un endpoint /api/sync pour recevoir les data depuis Helsinki au moment du paiement.
const TENANT_ONLY = process.env.TENANT_ONLY === '1' || process.env.TENANT_ONLY === 'true';

// Routes désactivées en mode TENANT_ONLY (chargées dynamiquement plus bas)
let adminRouter = null;
let checkoutRouter = null;
let stripeWebhookRouter = null;
let recoverRouter = null;
let landingRouter = null;
let syncRouter = null;
if (!TENANT_ONLY) {
  ({ default: adminRouter } = await import('./src/routes/admin.js'));
  ({ default: checkoutRouter } = await import('./src/routes/checkout.js'));
  ({ default: stripeWebhookRouter } = await import('./src/routes/stripe-webhook.js'));
  ({ default: recoverRouter } = await import('./src/routes/recover.js'));
  ({ default: landingRouter } = await import('./src/routes/landing.js'));
} else {
  ({ default: syncRouter } = await import('./src/routes/sync.js'));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || join(__dirname, 'public/screenshots');
// IMPORTANT : UPLOADS_DIR doit utiliser la même logique que src/routes/edit.js
// (sinon Express sert depuis un dossier alors que les uploads sont écrits ailleurs).
// Fallback : à côté de SCREENSHOTS_DIR (= sur le volume persistant en prod).
const UPLOADS_DIR = process.env.UPLOADS_DIR
  || join(process.env.SCREENSHOTS_DIR ? dirname(process.env.SCREENSHOTS_DIR) : join(__dirname, 'data'), 'uploads');
const SITE_DIR = join(__dirname, 'public/site');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
// LANDING_BASE_URL : domaine commercial (page d'accueil + signup).
// Découplé de PUBLIC_BASE_URL pour permettre une bascule indépendante.
// Sur maquickpage.fr on garde les /preview/*, /admin/*, etc., mais la landing
// "Voir si mon salon est couvert" vit maintenant sur https://maquickpage.fr/.
const LANDING_BASE_URL = process.env.LANDING_BASE_URL || 'https://maquickpage.fr';
const adminHost = ADMIN_BASE_URL ? new URL(ADMIN_BASE_URL).hostname : null;
const publicHost = PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).hostname : null;
const landingHost = LANDING_BASE_URL ? new URL(LANDING_BASE_URL).hostname : null;

async function ensureAdminUser() {
  const email = process.env.ADMIN_EMAIL || 'admin@lamidetlm.com';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return;

  let hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    const tempPassword = process.env.ADMIN_PASSWORD || 'change-me-' + Math.random().toString(36).slice(2, 10);
    hash = await bcrypt.hash(tempPassword, 10);
    console.log('============================================');
    console.log('ADMIN USER CREATED');
    console.log('Email:    ', email);
    console.log('Password: ', tempPassword);
    console.log('Sauvegarde ce mot de passe — il ne sera plus affiche.');
    console.log('============================================');
  }
  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
}

if (!TENANT_ONLY) {
  await ensureAdminUser();
}

// Fail-fast si SESSION_SECRET non défini ou trop court — empêche tout démarrage
// avec un secret prédictible (qui rendrait toutes les sessions forgeables).
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('FATAL: SESSION_SECRET manquant ou trop court (min 16 chars). Set la variable d\'env avant de redémarrer.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// Headers de sécurité défensifs (clickjacking, MIME sniffing, leak referer).
// Pas de CSP ici — nécessite un audit dédié pour ne pas casser Stripe.js, fonts
// Google, Cloudflare Insights, etc.
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
    sameSite: 'lax'
  }
}));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), mode: TENANT_ONLY ? 'tenant' : 'tools' }));

// =============================================================================
// SUSPENSION GATE (Falkenstein only)
// =============================================================================
// Si un salon a un subscription_status qui n'est pas dans { live, active }
// (= défaut de paiement, annulation, suspension manuelle), on intercepte les
// routes publiques (preview + admin coiffeur) et on renvoie suspended.html.
// Les données restent en base — réactivation transparente quand le webhook
// customer.subscription.updated repasse en active (cf. stripe-webhook.js).
//
// Statuts considérés "actifs" :
//   - 'live'                       → site provisionné et facturé
//   - 'active'                     → abonnement Stripe actif
//   - 'trialing'                   → période d'essai (devrait pas arriver mais safe)
// Tous les autres (past_due, unpaid, canceled, incomplete, suspended, ...) → page 'site suspendu'.
// =============================================================================
const ACTIVE_STATUSES = new Set(['live', 'active', 'trialing']);

function lookupSalonByHost(req) {
  // Ordre de résolution :
  //   1. live_hostname EXACT match (ex: salon-jean.fr)
  //   2. fallback : si pas trouvé, on retourne null → 404 ailleurs
  try {
    const host = (req.hostname || '').toLowerCase();
    if (!host) return null;
    return db.prepare(
      'SELECT slug, subscription_status, suspended_at, suspended_reason, live_hostname FROM salons WHERE live_hostname = ?'
    ).get(host);
  } catch {
    return null;
  }
}

function lookupSalonBySlug(slug) {
  try {
    return db.prepare(
      'SELECT slug, subscription_status, suspended_at, suspended_reason, live_hostname FROM salons WHERE slug = ?'
    ).get(slug);
  } catch {
    return null;
  }
}

function isSuspended(salon) {
  if (!salon) return false;
  return !ACTIVE_STATUSES.has(salon.subscription_status || '');
}

function serveSuspendedPage(res) {
  // 402 Payment Required (sémantiquement adapté au défaut de paiement)
  return res.status(402).sendFile(join(SITE_DIR, 'legal', 'suspended.html'));
}

// Middleware qui intercepte tout sur Falkenstein si le salon hôte est suspendu.
// On laisse passer :
//   - /legal/*    → page suspended.html + CGV servies en lecture publique
//   - /_assets/*  → CSS/JS pour rendre la page suspendue
//   - /health     → monitoring
if (TENANT_ONLY) {
  app.use((req, res, next) => {
    // Whitelist : on ne bloque jamais ces routes
    if (req.path.startsWith('/legal/')) return next();
    if (req.path.startsWith('/_assets/')) return next();
    if (req.path === '/health') return next();
    if (req.path.startsWith('/screenshots/')) return next();
    if (req.path.startsWith('/uploads/')) return next();
    // /api/sync : auth bearer-protected, garde toujours actif (sinon Helsinki ne peut plus pousser de réactivation)
    if (req.path.startsWith('/api/sync')) return next();

    // Lookup par hostname custom
    const salon = lookupSalonByHost(req);
    if (salon && isSuspended(salon)) return serveSuspendedPage(res);

    // Lookup par slug pour les routes /preview/:slug et /admin/:slug
    const m = req.path.match(/^\/(preview|admin)\/([^/]+)/);
    if (m) {
      const slug = m[2];
      const sBySlug = lookupSalonBySlug(slug);
      if (sBySlug && isSuspended(sBySlug)) return serveSuspendedPage(res);
    }

    next();
  });
}

// Stripe webhook : uniquement sur Helsinki (la signup vit là)
if (!TENANT_ONLY) {
  app.use('/webhook', stripeWebhookRouter);
}

// Sync endpoint : uniquement sur Falkenstein (= reçoit les data depuis Helsinki
// au moment où un coiffeur passe LIVE). Auth par bearer token partagé.
if (TENANT_ONLY) {
  app.use('/api', syncRouter); // expose POST /api/sync/:slug
  // Caddy on-demand TLS "ask" endpoint — répond 200 si hostname autorisé,
  // 4xx sinon. Interrogé par Caddy avant chaque demande de cert LE.
  const { default: caddyRouter } = await import('./src/routes/caddy.js');
  app.use('/api/caddy', caddyRouter); // expose GET /api/caddy/check-hostname?domain=xxx
}

// ====================================================================
// HOSTNAME-AWARE ROUTING (maquickpage.fr architecture)
// ====================================================================
// Agency admin tool       : outil.maquickpage.fr (ADMIN_BASE_URL)
//   /                     -> redirect to /admin
//   /admin                -> agency dashboard
//   /admin/login          -> login page
//   /admin/<api-route>    -> agency admin API (POST/PUT/DELETE/GET)
//   /api/*                -> public API
//
// Public landing + salon admin : maquickpage.fr (PUBLIC_BASE_URL)
//   /                     -> homepage
//   /preview/:slug        -> public landing of a salon
//   /admin/:slug          -> salon's edit page (auth via ?token=xxx)
//   /api/*                -> public API + edit API
//   /screenshots/*        -> static screenshots
//   /uploads/*            -> uploaded photos (hero, gallery)
// ====================================================================

// ====================================================================
// LEGACY HOSTS — 301 redirect everything to the new MaQuickPage domain
// ====================================================================
// On préserve le SEO juice + les anciens liens (cold emails, bookmarks
// admin agence, URLs CGV partagées dans Stripe) en redirigeant chaque
// host monsitehq.com vers son équivalent maquickpage.fr.
//
// Exclu : customers.monsitehq.com (= wildcard Falkenstein, sera migré
// séparément quand on basculera la prod Cloudflare for SaaS).
// ====================================================================
const LEGACY_HOST_REDIRECTS = {
  'monsitehq.com': 'https://maquickpage.fr',
  'www.monsitehq.com': 'https://maquickpage.fr',
  'outil.monsitehq.com': 'https://outil.maquickpage.fr',
};
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  const dest = LEGACY_HOST_REDIRECTS[host];
  if (dest) {
    return res.redirect(301, `${dest}${req.originalUrl}`);
  }
  next();
});

// === Outil démo individuel (demo.maquickpage.fr) — module ISOLÉ, additif ===
// Intercepte ENTIÈREMENT le hostname démo avant toute autre logique de routing.
// Uniquement sur Helsinki (TOOLS). Le router gère ses propres paths (gated par
// URL secrète) + un catch-all 404 → aucune fuite vers les autres routes.
// Ne modifie RIEN au reste : si le host n'est pas le host démo, on next() direct.
if (!TENANT_ONLY) {
  const { default: demoToolRouter } = await import('./src/routes/demo-tool.js');
  const DEMO_HOST = (process.env.DEMO_TOOL_HOST || 'demo.maquickpage.fr').toLowerCase();
  app.use((req, res, next) => {
    if ((req.hostname || '').toLowerCase() !== DEMO_HOST) return next();
    return demoToolRouter(req, res, next);
  });
}

app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  const isAdminHost = adminHost && host === adminHost;
  const isPublicHost = publicHost && host === publicHost;
  // Landing host = apex (maquickpage.fr) OU www.maquickpage.fr
  const isLandingHost = landingHost && (host === landingHost || host === `www.${landingHost}`);

  if (isAdminHost) {
    req.routingMode = 'admin';
  } else if (isLandingHost) {
    req.routingMode = 'landing';
    // Canonical : www.maquickpage.fr → maquickpage.fr (301)
    if (host === `www.${landingHost}`) {
      return res.redirect(301, `https://${landingHost}${req.originalUrl}`);
    }
  } else if (isPublicHost) {
    req.routingMode = 'public';
  } else {
    req.routingMode = 'mixed'; // local dev or unknown host
  }
  next();
});

// === Tracking funnel maquettes (observe-only, JAMAIS bloquant) ===
// Middleware : log preview_ouvert / editeur_ouvert / editeur_modifie (gated
// routingMode==='public' → uniquement le funnel prospect). Router : POST
// /api/track (beacons navigateur). Module isolé, n'altère aucune route.
const { trackingMiddleware, default: trackingRouter } = await import('./src/routes/tracking.js');
app.use(trackingMiddleware);
app.use('/api', trackingRouter);

// Routes always available regardless of host
app.use('/screenshots', express.static(SCREENSHOTS_DIR, { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
// Normalisation : /legal/privacy.html/  →  redirige 301 vers /legal/privacy.html
// (sécurise les liens partagés ou collés avec un slash final, par ex. dans Stripe).
app.use('/legal', (req, res, next) => {
  if (/\.html\/$/.test(req.path)) {
    return res.redirect(301, req.path.slice(0, -1) + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
  }
  next();
});
// Pages légales (CGV par plan + page de site suspendu) — accessibles publiquement
// sur les deux hôtes (Helsinki + Falkenstein) pour qu'on puisse linker /legal/cgv-2y.html
// depuis la modale pricing ET les afficher sur les sites coiffeurs suspendus.
app.use('/legal', express.static(join(SITE_DIR, 'legal'), { maxAge: '1h' }));
app.use('/api', apiRouter);
app.use('/api', editRouter); // expose /api/edit/:slug

// Routes signup/checkout : uniquement sur Helsinki
if (!TENANT_ONLY) {
  app.use('/api', checkoutRouter); // expose /api/domain/* + /api/checkout/*
  app.use('/', recoverRouter);     // expose POST /api/recover + GET /recover/confirm
  app.use('/api', landingRouter);  // expose POST /api/landing/check
  // Page HTML statique du formulaire de récupération (Helsinki uniquement)
  app.get('/recover', (req, res) => res.sendFile(join(SITE_DIR, 'recover.html')));
}

const RESERVED_ADMIN_PATHS = new Set([
  'login', 'logout', 'me', 'index.html', 'login.html',
  'admin.css', 'admin.js', 'i18n.js',
  'upload-csv', 'export-csv', 'screenshot-batch', 'clean-names',
  'salon', 'csv-source', 'screenshot', 'job',
  'groups', 'reset-clean-name'
]);

const RESERVED_PATHS = new Set(['favicon.ico', 'robots.txt', 'sitemap.xml']);
// SITE_DIR is hoisted near the top of this file so the suspension gate (TENANT_ONLY) can use it before route declarations.

// Edit page assets (cropper.js etc.)
app.use('/edit-app', express.static(join(__dirname, 'public/edit')));

// ====================================================================
// PUBLIC HOST GATE on /admin/*
// Sur maquickpage.fr (host public), on bloque TOUT sous /admin/* sauf le
// pattern /admin/{slug} (page d'edition coiffeur). Sinon le static middleware
// servirait public/admin/index.html sur maquickpage.fr/admin/ — bug de leak.
// ====================================================================
app.use('/admin', (req, res, next) => {
  if (req.routingMode !== 'public') return next();

  // Sur public host, seul /admin/{slug-non-reserve} est servi.
  const rel = req.path; // path relative to /admin (e.g. '/', '/login', '/some-slug')
  if (rel === '/' || rel === '') {
    return res.status(404).sendFile(join(SITE_DIR, '404.html'));
  }
  const firstSeg = rel.split('/').filter(Boolean)[0] || '';
  if (RESERVED_ADMIN_PATHS.has(firstSeg)) {
    return res.status(404).sendFile(join(SITE_DIR, '404.html'));
  }
  // Toute autre URL (suppose etre /admin/{slug}) : laisse passer pour /admin/:slug handler
  next();
});

// Salon edit page : /admin/:slug
//
// Auth :
//   - SITES DÉMO (Helsinki / maquickpage.fr) : token URL uniquement (?token={edit_token})
//   - SITES LIVE (Falkenstein) : cookie session signé (`mqs_session`), valable 30j.
//     Si pas de cookie : check ?token= (edit_token OU session_token magic link)
//       → si valide : pose cookie + redirect /admin/{slug} (URL nettoyée)
//     Si rien : 401, l'UI affiche un form magic link.
//
// Sur Helsinki, si le salon est LIVE → redirect vers le custom hostname pour
// que l'auth Falkenstein prenne le relais.
const { readSessionCookie, setSessionCookie } = await import('./src/admin-auth.js');
const { consumeSessionToken } = TENANT_ONLY ? await import('./src/routes/admin-recover.js') : { consumeSessionToken: () => null };

app.get('/admin/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (RESERVED_ADMIN_PATHS.has(slug)) return next();
  if (req.routingMode === 'admin') return next();

  // Helsinki : si LIVE → redirect vers Falkenstein
  if (!TENANT_ONLY) {
    try {
      const r = db.prepare('SELECT live_hostname, subscription_status FROM salons WHERE slug = ?').get(slug);
      if (r && r.live_hostname && r.subscription_status === 'live') {
        const tk = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
        return res.redirect(302, `https://${r.live_hostname}/admin/${encodeURIComponent(slug)}${tk}`);
      }
    } catch {}
  }

  // === Sites LIVE (Falkenstein) : Magic Link Only ===========================
  // Auth = cookie session 30 j, posé par un magic link single-use.
  //   - setup_token (24 h)  : 1er lien dans l'email post-paiement
  //   - recovery_token (10 min) : magic link demandé via le form 401
  // Aucune valeur permanente : pas de fallback sur edit_token. Le token URL
  // est forcément consommé et lié à une expiry stricte.
  if (TENANT_ONLY) {
    // 1. Cookie valide ?
    const cookieSlug = readSessionCookie(req);
    if (cookieSlug === slug) {
      return res.status(200).sendFile(join(__dirname, 'public/edit/index.html'));
    }

    // 2. Magic link (token query param ou session_token legacy) → single-use
    const magicToken = req.query.token || req.query.session_token;
    if (magicToken) {
      const tokenSlug = consumeSessionToken(magicToken);
      if (tokenSlug === slug) {
        setSessionCookie(res, slug);
        return res.redirect(302, `/admin/${encodeURIComponent(slug)}`);
      }
    }

    // 3. Aucune auth (cookie expiré, lien périmé/consommé) → 401, l'UI
    //    affiche le form "Saisissez votre email" pour recevoir un nouveau lien.
    return res.status(401).sendFile(join(__dirname, 'public/edit/index.html'));
  }

  // === Sites DÉMO (Helsinki) : token URL uniquement (= comportement actuel) =
  const token = req.query.token;
  let statusCode = 200;
  if (!token) {
    statusCode = 401;
  } else {
    try {
      const r = db.prepare('SELECT 1 FROM salons WHERE slug = ? AND edit_token = ?').get(slug, token);
      if (!r) statusCode = 401;
    } catch {
      statusCode = 401;
    }
  }
  res.status(statusCode).sendFile(join(__dirname, 'public/edit/index.html'));
});

// === Magic link recovery sur Falkenstein ================================
if (TENANT_ONLY) {
  const { default: adminRecoverRouter } = await import('./src/routes/admin-recover.js');
  app.use('/api', adminRecoverRouter); // POST /api/auth/request-magic-link
}

// === Routes admin agence : uniquement sur Helsinki ===
if (!TENANT_ONLY) {
  // Agency admin assets (CSS, JS, login.html, etc.) — uniquement utilises sur outil.maquickpage.fr
  app.use('/admin', express.static(join(__dirname, 'public/admin')));

  // Agency admin login page
  app.get('/admin/login', (req, res) => {
    res.sendFile(join(__dirname, 'public/admin/login.html'));
  });

  // Agency admin dashboard root /admin
  app.get('/admin', (req, res) => {
    if (req.session && req.session.userId) {
      res.sendFile(join(__dirname, 'public/admin/index.html'));
    } else {
      res.redirect('/admin/login');
    }
  });

  // Agency admin auth-protected API routes (login, upload-csv, screenshot, groups, etc.)
  app.use('/admin', adminRouter);
}

// Site assets (CSS, JS for the public landing)
app.use('/_assets', express.static(SITE_DIR, { maxAge: '1d' }));

// Public preview : /preview/:slug — SSR pour SEO
// Sur Helsinki : si salon LIVE → redirect 302 vers le custom hostname (Falkenstein le sert).
//                Sinon → SSR avec noindex (= démo non payée, on protège maquickpage.fr).
// Sur Falkenstein : SSR avec index+follow (= site coiffeur payé, on veut qu'il ranke).
app.get('/preview/:slug', (req, res) => {
  const slug = req.params.slug;
  if (RESERVED_PATHS.has(slug)) return res.status(404).sendFile(join(SITE_DIR, '404.html'));

  let salon;
  try {
    salon = db.prepare('SELECT * FROM salons WHERE slug = ?').get(slug);
  } catch {
    return res.status(500).sendFile(join(SITE_DIR, '404.html'));
  }
  if (!salon) return res.status(404).sendFile(join(SITE_DIR, '404.html'));

  // Helsinki uniquement : si salon LIVE → 302 vers son custom hostname.
  // IMPORTANT : on redirige UNIQUEMENT sur status='live' (= provisioning terminé,
  // domaine résolvable, cert HTTPS prêt). 'active' = Stripe a facturé mais le
  // provisioning peut ne pas être fini → si on redirige sur 'active', le client
  // tombe sur DNS_PROBE_FINISHED_NXDOMAIN tant que la propagation .fr est en cours.
  // Tant que status != 'live', on sert la SSR /preview qui charge waiting-screen.js
  // pour poller /api/signup/status jusqu'à 'live' puis rediriger côté client.
  if (!TENANT_ONLY && salon.live_hostname && salon.subscription_status === 'live') {
    return res.redirect(302, `https://${salon.live_hostname}/`);
  }

  // SSR
  const host = (req.hostname || '').toLowerCase();
  const onMainDomain = isMainDomainHost(host);
  const view = buildSalonView(salon);

  // Canonical + noindex selon contexte :
  //   - maquickpage.fr/preview/* → noindex (= URL démo, jamais à indexer)
  //                              canonical pointe vers le custom hostname si payé,
  //                              sinon self-canonical
  //   - {custom}/preview/* (Falkenstein) → indexable, canonical = https://{host}/
  let canonicalUrl, noindex;
  if (onMainDomain) {
    noindex = true;
    canonicalUrl = (salon.live_hostname && (salon.subscription_status === 'live' || salon.subscription_status === 'active'))
      ? `https://${salon.live_hostname}/`
      : `https://${host}/preview/${encodeURIComponent(slug)}`;
  } else {
    noindex = false;
    canonicalUrl = `https://${host}/`;
  }

  const siteUrl = onMainDomain ? `https://${host}/preview/${encodeURIComponent(slug)}` : `https://${host}`;

  try {
    const html = renderSalonHtml(view, { canonicalUrl, siteUrl, noindex });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[preview SSR] error:', err);
    res.sendFile(join(SITE_DIR, 'index.html')); // fallback : template brut, main.js fera le reste
  }
});

// /robots.txt host-aware (Helsinki + Falkenstein)
//   - maquickpage.fr : Disallow /preview/, /admin/, etc.
//   - custom hostname : Allow tout + sitemap référencé
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderRobotsTxt(req.hostname));
});

// /sitemap.xml dynamique
app.get('/sitemap.xml', (req, res) => {
  const host = (req.hostname || '').toLowerCase();
  let salonUpdatedAt = null;

  if (!isMainDomainHost(host)) {
    // Custom hostname : on récupère la date de dernière maj du salon pour <lastmod>
    try {
      const r = db.prepare('SELECT updated_at, overrides_updated_at FROM salons WHERE live_hostname = ?').get(host);
      if (r) salonUpdatedAt = r.overrides_updated_at || r.updated_at;
    } catch {}
  }

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderSitemap(host, { salonUpdatedAt }));
});

// Sur Falkenstein (TENANT_ONLY), la racine d'un custom hostname (salon-jean.fr/)
// sert directement le site du salon en SSR. Plus de redirect /preview/{slug}
// (= une seule URL canonique = https://salon-jean.fr/, meilleur SEO).
if (TENANT_ONLY) {
  app.get('/', (req, res) => {
    const host = (req.hostname || '').toLowerCase();
    let salon;
    try {
      salon = db.prepare('SELECT * FROM salons WHERE live_hostname = ?').get(host);
    } catch (err) {
      console.error('[Falkenstein /] DB error:', err);
      return res.status(500).send('Erreur serveur');
    }
    if (!salon) return res.status(404).send('Aucun salon associé à ' + host);

    const view = buildSalonView(salon);
    try {
      const html = renderSalonHtml(view, {
        canonicalUrl: `https://${host}/`,
        siteUrl: `https://${host}`,
        noindex: false,
      });
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      console.error('[Falkenstein / SSR] error:', err);
      // Fallback : redirect vers /preview/{slug} (ancien comportement)
      res.redirect(302, `/preview/${encodeURIComponent(salon.slug)}`);
    }
  });
}

// Root
//   - host=outil.maquickpage.fr  → /admin
//   - host=maquickpage.fr        → landing (home.html)
//   - host=monsitehq.com (legacy)→ 301 via LEGACY_HOST_REDIRECTS middleware en amont
//   - local dev / autre host     → landing par défaut
app.get('/', (req, res) => {
  if (req.routingMode === 'admin') return res.redirect('/admin');
  res.sendFile(join(SITE_DIR, 'home.html'));
});

// 404 fallback
app.use((req, res) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(join(SITE_DIR, '404.html'));
});

app.listen(PORT, () => {
  console.log(`outil-coiffure listening on http://localhost:${PORT}`);
  console.log(`  Mode           : ${TENANT_ONLY ? 'TENANT (Falkenstein)' : 'TOOLS (Helsinki)'}`);
  console.log(`  Public preview : http://localhost:${PORT}/preview/{slug}`);
  console.log(`  Salon admin    : http://localhost:${PORT}/admin/{slug}?token=...`);
  if (!TENANT_ONLY) {
    console.log(`  Agency admin   : http://localhost:${PORT}/admin (login)`);
  }
});

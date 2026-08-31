// WP2 — page pilier /site-internet-coiffeur.
//
// Mêmes règles que WP1 : un vrai serveur Express est démarré en sous-processus
// sur une base SQLite temporaire, et interrogé en HTTP réel (node:http, pour
// pouvoir forcer l'en-tête Host et tester le gate de domaine de marque).
// Aucun appel réseau sortant.
//
// Run : node --test tests/inbound-wp2.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BRAND_HOST = 'maquickpage.test';
const ADMIN_HOST = 'outil.maquickpage.test';
const CUSTOMER_HOST = 'salon-jean.test';
// Hôte reconnu comme « domaine principal » par src/ssr.js (MAIN_DOMAIN_HOSTS).
const MAIN_HOST = 'localhost';

const PAGE_PATH = '/site-internet-coiffeur';
const CANONICAL = 'https://maquickpage.fr/site-internet-coiffeur';

const ATTRIBUTION_SECRET = 'wp2-test-attribution-secret'; // secret-scan: allow-test-fixture
const ADMIN_EMAIL = 'wp2@test.local';
const ADMIN_PASSWORD = 'wp2-test-password'; // secret-scan: allow-test-fixture

let tmpDir, dbPath, port, child, db;
let pageHtml, pageText, homeHtml;

// =============================================================================
// Helpers
// =============================================================================

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request({ method = 'GET', path = '/', host = BRAND_HOST, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postJson(path, payload, opts = {}) {
  const body = JSON.stringify(payload);
  return request({
    method: 'POST',
    path,
    body,
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(opts.headers || {}),
    },
  });
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request({ path: '/health' });
      if (r.status === 200) return;
    } catch { /* pas encore à l'écoute */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('serveur de test non démarré dans le délai imparti');
}

/** Lookup : chaque appel avec une IP distincte (rate-limit 5/h par IP). */
let ipCounter = 0;
function nextIp() { return `198.51.100.${++ipCounter}`; }

/** Texte VISIBLE de la page : scripts/styles retirés, balises retirées,
 *  entités décodées, espaces normalisés. C'est ce que lit un humain. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s) {
  return String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]);
}

function metaContent(html, attr, value) {
  const re = new RegExp(`<meta[^>]+${attr}="${value}"[^>]+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

// =============================================================================
// Démarrage / arrêt du serveur de test
// =============================================================================

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mqs-wp2-'));
  dbPath = join(tmpDir, 'wp2.db');
  port = await freePort();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: dbPath,
    SESSION_SECRET: 'wp2-test-session-secret-0123456789', // secret-scan: allow-test-fixture
    ATTRIBUTION_SECRET,
    STRIPE_SECRET_KEY: 'sk_test_wp2', // secret-scan: allow-test-fixture
    PROVISIONING_DRY_RUN: '1',
    STRIPE_PRICE_2Y: '', STRIPE_PRICE_1Y: '', STRIPE_PRICE_FLEX: '',
    OVH_APP_KEY: '', OVH_APP_SECRET: '', OVH_CONSUMER_KEY: '',
    RESEND_API_KEY: '',
    SYNC_BEARER_TOKEN: '',
    ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: await bcrypt.hash(ADMIN_PASSWORD, 10),
    PUBLIC_BASE_URL: `http://${BRAND_HOST}`,
    LANDING_BASE_URL: `http://${BRAND_HOST}`,
    ADMIN_BASE_URL: `http://${ADMIN_HOST}`,
    SCREENSHOTS_DIR: join(tmpDir, 'screenshots'),
    UPLOADS_DIR: join(tmpDir, 'uploads'),
    TENANT_ONLY: '',
  };

  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitForServer();

  db = new Database(dbPath);
  db.prepare(`
    INSERT INTO salons (slug, nom, nom_clean, ville, lien_google_maps, data_json, subscription_status)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    'salon-test-wp2', 'Salon Test WP2', 'Salon Test WP2', 'Nantes',
    'https://www.google.com/maps/place/Salon+Test+WP2/@47.2,-1.5,17z',
    JSON.stringify({ nom: 'Salon Test WP2' }), 'demo'
  );

  const page = await request({ path: PAGE_PATH, host: BRAND_HOST });
  pageHtml = page.body;
  pageText = visibleText(pageHtml);
  homeHtml = (await request({ path: '/', host: BRAND_HOST })).body;
});

after(() => {
  try { db && db.close(); } catch { /* ignore */ }
  try { child && child.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// =============================================================================
// A. Host gate — la page pilier est une page de MARQUE
// =============================================================================

describe('WP2 — host gate', () => {
  test('200 sur le domaine de marque', async () => {
    const r = await request({ path: PAGE_PATH, host: BRAND_HOST });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/html/);
  });

  test('404 sur un hostname client', async () => {
    const r = await request({ path: PAGE_PATH, host: CUSTOMER_HOST });
    assert.equal(r.status, 404, 'la page pilier ne doit pas fuiter sur un domaine client');
    assert.ok(!r.body.includes('Site internet pour salon de coiffure'),
      'aucun contenu de la page pilier ne doit être servi sur un domaine client');
  });

  test('sur l\'hôte admin : jamais servie comme page de marque', async () => {
    const r = await request({ path: PAGE_PATH, host: ADMIN_HOST });
    assert.notEqual(r.status, 200, 'l\'admin agence ne sert aucune page de marque');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/admin');
  });

  test('servie en dev sur localhost', async () => {
    const r = await request({ path: PAGE_PATH, host: '127.0.0.1' });
    assert.equal(r.status, 200);
  });
});

// =============================================================================
// B. SEO — head unique, un seul H1, canonical auto-référent
// =============================================================================

describe('WP2 — SEO', () => {
  test('exactement un <h1>', () => {
    const h1s = pageHtml.match(/<h1\b/gi) || [];
    assert.equal(h1s.length, 1, `attendu 1 <h1>, trouvé ${h1s.length}`);
  });

  test('canonical unique, absolu et auto-référent', () => {
    const links = [...pageHtml.matchAll(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/gi)].map((m) => m[1]);
    assert.equal(links.length, 1, 'un seul <link rel="canonical">');
    assert.equal(links[0], CANONICAL);
    assert.ok(links[0].startsWith('https://'), 'canonical absolu');
    assert.ok(links[0].endsWith(PAGE_PATH), 'canonical auto-référent');
    assert.equal(metaContent(pageHtml, 'property', 'og:url'), CANONICAL, 'og:url = canonical');
  });

  test('robots : index, follow', () => {
    const robots = metaContent(pageHtml, 'name', 'robots');
    assert.ok(robots, 'balise robots présente');
    assert.match(robots, /^index,\s*follow$/);
  });

  test('title et meta description uniques (différents de la home)', () => {
    const titleOf = (h) => (h.match(/<title>([^<]*)<\/title>/i) || [])[1];
    const pageTitle = titleOf(pageHtml);
    const homeTitle = titleOf(homeHtml);
    assert.ok(pageTitle && pageTitle.length > 10);
    assert.notEqual(pageTitle, homeTitle, 'le <title> doit différer de celui de la home');

    const pageDesc = metaContent(pageHtml, 'name', 'description');
    const homeDesc = metaContent(homeHtml, 'name', 'description');
    assert.ok(pageDesc && pageDesc.length > 50);
    assert.notEqual(pageDesc, homeDesc, 'la meta description doit différer de celle de la home');
  });

  test('Open Graph + Twitter Card présents', () => {
    assert.ok(metaContent(pageHtml, 'property', 'og:title'));
    assert.ok(metaContent(pageHtml, 'property', 'og:description'));
    assert.ok(metaContent(pageHtml, 'property', 'og:image'));
    assert.equal(metaContent(pageHtml, 'name', 'twitter:card'), 'summary_large_image');
    assert.ok(metaContent(pageHtml, 'name', 'twitter:title'));
  });
});

// =============================================================================
// C. JSON-LD — parsable, Service + BreadcrumbList, FAQPage fidèle au visible
// =============================================================================

describe('WP2 — données structurées', () => {
  test('chaque bloc application/ld+json est parsable', () => {
    const blocks = jsonLdBlocks(pageHtml);
    assert.ok(blocks.length >= 2, 'au moins Service + BreadcrumbList');
    for (const raw of blocks) {
      assert.doesNotThrow(() => JSON.parse(raw), `JSON-LD invalide : ${raw.slice(0, 120)}`);
    }
  });

  test('Service et BreadcrumbList sont présents et pointent sur cette page', () => {
    const types = jsonLdBlocks(pageHtml).map((b) => JSON.parse(b)['@type']);
    assert.ok(types.includes('Service'));
    assert.ok(types.includes('BreadcrumbList'));

    const breadcrumb = jsonLdBlocks(pageHtml).map((b) => JSON.parse(b))
      .find((o) => o['@type'] === 'BreadcrumbList');
    const last = breadcrumb.itemListElement[breadcrumb.itemListElement.length - 1];
    assert.equal(last.item, CANONICAL);
  });

  test('aucun schema review / rating', () => {
    for (const raw of jsonLdBlocks(pageHtml)) {
      assert.ok(!/aggregateRating|ratingValue|reviewCount|"Review"/i.test(raw),
        'pas de review/rating schema sur cette page');
    }
  });

  test('FAQPage : chaque réponse figure MOT POUR MOT dans le texte visible', () => {
    const faq = jsonLdBlocks(pageHtml).map((b) => JSON.parse(b))
      .find((o) => o['@type'] === 'FAQPage');
    if (!faq) return; // FAQPage optionnel ; s'il existe, il doit être exact.
    assert.ok(Array.isArray(faq.mainEntity) && faq.mainEntity.length > 0);
    const text = norm(pageText);
    for (const q of faq.mainEntity) {
      const answer = norm(q.acceptedAnswer.text);
      assert.ok(
        text.includes(answer),
        `réponse FAQPage absente du texte visible : « ${answer.slice(0, 90)}… »`
      );
      assert.ok(
        text.includes(norm(q.name)),
        `question FAQPage absente du texte visible : « ${q.name} »`
      );
    }
  });
});

// =============================================================================
// D. Sitemap / robots / preview
// =============================================================================

describe('WP2 — sitemap', () => {
  test('le sitemap de marque contient la page pilier', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, new RegExp(`<loc>https://maquickpage\\.fr${PAGE_PATH}</loc>`));
  });

  test('le sitemap ne contient jamais de preview', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    assert.ok(!r.body.includes('/preview/'));
  });

  test('lastmod : pas la date du jour pour toutes les URLs', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    const lastmods = [...r.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    assert.ok(lastmods.length > 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(lastmods.some((d) => d !== today),
      `tous les lastmod valent ${today} : le sitemap se redate tout seul`);
  });

  test('les maquettes restent en noindex', async () => {
    const r = await request({ path: '/preview/salon-test-wp2', host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, /<meta name="robots" content="noindex, nofollow">/);
  });

  test('robots.txt continue de bloquer /preview/', async () => {
    const r = await request({ path: '/robots.txt', host: MAIN_HOST });
    assert.match(r.body, /Disallow: \/preview\//);
  });
});

// =============================================================================
// E. Maillage interne
// =============================================================================

describe('WP2 — maillage interne', () => {
  test('la home porte un lien crawlable vers la page pilier', () => {
    assert.match(homeHtml, new RegExp(`<a href="${PAGE_PATH}"[^>]*>[^<]+</a>`),
      'lien <a href> réel (pas de JS) depuis la home');
  });

  test('la page pilier renvoie vers /faq, les CGV et le pricing de la home', () => {
    assert.match(pageHtml, /href="\/faq"/);
    assert.match(pageHtml, /href="\/legal\/cgv\.html"/);
    assert.match(pageHtml, /href="\/#tarifs"/);
  });
});

// =============================================================================
// F. CTA — lookup existant + attribution WP1, aucun second formulaire
// =============================================================================

describe('WP2 — CTA et attribution', () => {
  test('la page réutilise le script de lookup de la home, sans JS dédié', () => {
    assert.match(pageHtml, /\/_assets\/home\.js/);
    const forms = pageHtml.match(/<form\b/gi) || [];
    assert.equal(forms.length, 1, 'un seul formulaire : celui du lookup existant');
    assert.match(pageHtml, /id="hp-form"/);
    // Aucun script propre à la page : uniquement les assets partagés.
    const scripts = [...pageHtml.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
    for (const src of scripts) {
      assert.match(src, /^\/_assets\/(track|home)\.js/, `script inattendu : ${src}`);
    }
  });

  test('la page ne pose aucun cookie', async () => {
    const r = await request({ path: PAGE_PATH, host: BRAND_HOST });
    assert.equal(r.headers['set-cookie'], undefined, 'aucun cookie posé par la page pilier');
  });

  test('un lookup soumis depuis la page enregistre landing_path = /site-internet-coiffeur', async () => {
    const r = await postJson('/api/landing/check', {
      google_maps_url: 'https://www.google.com/maps/place/Salon+Test+WP2/@47.2,-1.5,17z',
      email: 'coiffeur-wp2@test.local',
      ref: 'https://www.google.com/search?q=site+internet+coiffeur',
    }, {
      headers: {
        'X-Forwarded-For': nextIp(),
        Referer: `http://${BRAND_HOST}${PAGE_PATH}?src=seo`,
        'User-Agent': 'Mozilla/5.0 (test wp2)',
      },
    });
    assert.equal(r.status, 200);

    const row = db.prepare(`
      SELECT * FROM payment_attributions
      WHERE landing_path = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(PAGE_PATH);
    assert.ok(row, 'une attribution doit être créée avec landing_path = ' + PAGE_PATH);
    assert.equal(row.first_source, 'seo');
    assert.equal(row.referrer_host, 'google.com');

    // Le lead est bien rattaché à cette attribution (chaîne WP1 intacte).
    const lead = db.prepare(
      'SELECT attribution_id FROM landing_leads WHERE email = ? ORDER BY rowid DESC LIMIT 1'
    ).get('coiffeur-wp2@test.local');
    assert.ok(lead, 'lead enregistré');
    assert.equal(lead.attribution_id, row.id);
  });
});

// =============================================================================
// G. Régression inverse — les affirmations de la home restent, et ne sont
//    PAS recopiées sur la page pilier.
// =============================================================================

describe('WP2 — régression de contenu', () => {
  // Décision Michele du 2026-08-31 : ces formulations restent en ligne sur la
  // home. Aucun agent ne doit les réécrire ou les supprimer.
  const PROTECTED_ON_HOME = [
    'salons couverts',
    'Le plus choisi',
    'monitoring 24/7',
    'sauvegardes quotidiennes chiffrées',
    'best practices Google 2026',
    'en ligne en 5 minutes',
    'moins de 100\u00a0ms partout en France',
    'Squarespace',
    'sous 48h',
  ];

  // « Ne pas supprimer » protège les pages existantes ; ça n'autorise pas à
  // recopier ces affirmations sur une page neuve.
  const FORBIDDEN_ON_PILLAR = [
    '11 000', '11 000', 'salons couverts',
    'Le plus choisi', 'Most popular', 'POPULAIRE',
    'monitoring 24/7', '24/7',
    '100 ms', '100 ms',
    'sauvegardes quotidiennes',
    'best practices Google 2026',
    'Wix', 'Squarespace', 'agences classiques',
    'en ligne en 5 minutes', 'sous 48h', '48h',
    'aggregateRating', 'ratingValue', 'reviewCount',
    'rich result', 'rich snippet',
    'étoiles',
  ];

  test('les formulations protégées sont toujours présentes sur la home', () => {
    for (const s of PROTECTED_ON_HOME) {
      assert.ok(
        norm(visibleText(homeHtml)).includes(norm(s)) || homeHtml.includes(s) || norm(homeHtml).includes(norm(s)),
        `formulation protégée disparue de la home : « ${s} »`
      );
    }
  });

  test('aucune de ces formulations n\'est recopiée sur la page pilier', () => {
    const haystack = norm(pageHtml).toLowerCase();
    for (const s of FORBIDDEN_ON_PILLAR) {
      assert.ok(
        !haystack.includes(norm(s).toLowerCase()),
        `formulation interdite recopiée sur la page pilier : « ${s} »`
      );
    }
  });

  test('la page pilier ne compare aucun prix barré ni tarif concurrent', () => {
    assert.ok(!/<s>|<del>|text-decoration:\s*line-through/i.test(pageHtml),
      'aucun prix barré sur la page pilier');
  });

  test('les tarifs affichés sont ceux de PLANS, en TTC', () => {
    for (const amount of ['9,90 €', '17,90 €', '29 €']) {
      assert.ok(norm(pageText).includes(amount), `tarif manquant : ${amount}`);
    }
    assert.ok(!/\bHT\b/.test(pageText), 'aucun tarif ne doit être présenté hors taxes');
  });
});

// =============================================================================
// Exposition HTML par les routes d'assets
// =============================================================================
// SITE_DIR contient à la fois les assets publics et les pages de marque. Le
// montage /_assets les servait donc sur n'importe quel hôte, y compris un
// domaine client — le gate brandPageOnly ne couvrant que les chemins propres.
describe('/_assets ne sert jamais de HTML', () => {
  const HTML_UNDER_ASSETS = [
    '/_assets/site-internet-coiffeur.html',
    '/_assets/home.html',
    '/_assets/home-en.html',
    '/_assets/faq.html',
    '/_assets/index.html',
    '/_assets/legal/privacy.html',
  ];

  for (const path of HTML_UNDER_ASSETS) {
    test(`404 sur le domaine de marque : ${path}`, async () => {
      const r = await request({ path, host: BRAND_HOST });
      assert.equal(r.status, 404, `${path} ne doit pas être servi`);
    });

    test(`404 sur un hostname client : ${path}`, async () => {
      const r = await request({ path, host: CUSTOMER_HOST });
      assert.equal(r.status, 404, `${path} ne doit pas fuiter sur un domaine client`);
    });
  }

  test('/_assets/ ne renvoie pas d\'index HTML', async () => {
    for (const host of [BRAND_HOST, CUSTOMER_HOST]) {
      const r = await request({ path: '/_assets/', host });
      assert.equal(r.status, 404, `/_assets/ doit être refusé (host ${host})`);
      assert.ok(!/<html/i.test(r.body), 'aucun index HTML ne doit être servi');
    }
  });

  test('les assets légitimes restent servis', async () => {
    const assets = [
      '/_assets/home.css',
      '/_assets/home.js',
      '/_assets/template-config.js',
      '/_assets/gallery-defaults/coiffeur-homme.jpg',
      '/_assets/landing/france-coverage.webp',
    ];
    for (const path of assets) {
      for (const host of [BRAND_HOST, CUSTOMER_HOST]) {
        const r = await request({ path, host });
        assert.equal(r.status, 200, `${path} doit rester servi (host ${host})`);
      }
    }
  });

  test('les chemins propres ne sont pas affectés', async () => {
    const brand = await request({ path: PAGE_PATH, host: BRAND_HOST });
    assert.equal(brand.status, 200, 'la page pilier reste servie sur le domaine de marque');

    const customer = await request({ path: PAGE_PATH, host: CUSTOMER_HOST });
    assert.equal(customer.status, 404, 'la page pilier reste inaccessible sur un domaine client');

    const faq = await request({ path: '/faq', host: BRAND_HOST });
    assert.equal(faq.status, 200, '/faq reste servi sur le domaine de marque');

    const legal = await request({ path: '/legal/privacy.html', host: BRAND_HOST });
    assert.equal(legal.status, 200, '/legal/* garde son propre montage');
  });
});

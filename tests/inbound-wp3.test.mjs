// WP3 — guide BOFU /guides/prix-site-internet-coiffeur.
//
// Même protocole que WP2 : un vrai serveur Express est démarré en sous-processus
// sur une base SQLite temporaire et interrogé en HTTP réel (node:http, pour
// pouvoir forcer l'en-tête Host et tester le gate de domaine de marque).
// Aucun appel réseau sortant.
//
// Run : node --test tests/inbound-wp3.test.mjs

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

const GUIDE_PATH = '/guides/prix-site-internet-coiffeur';
const PILLAR_PATH = '/site-internet-coiffeur';
const CANONICAL = 'https://maquickpage.fr/guides/prix-site-internet-coiffeur';

const ATTRIBUTION_SECRET = 'wp3-test-attribution-secret'; // secret-scan: allow-test-fixture
const ADMIN_EMAIL = 'wp3@test.local';
const ADMIN_PASSWORD = 'wp3-test-password'; // secret-scan: allow-test-fixture

let tmpDir, dbPath, port, child, db;
let guideHtml, guideText, homeHtml, pillarHtml;

// =============================================================================
// Helpers (identiques à tests/inbound-wp2.test.mjs)
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
function nextIp() { return `198.51.101.${++ipCounter}`; }

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

function titleOf(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? norm(m[1]) : null;
}

// =============================================================================
// Démarrage / arrêt du serveur de test
// =============================================================================

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mqs-wp3-'));
  dbPath = join(tmpDir, 'wp3.db');
  port = await freePort();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: dbPath,
    SESSION_SECRET: 'wp3-test-session-secret-0123456789', // secret-scan: allow-test-fixture
    ATTRIBUTION_SECRET,
    STRIPE_SECRET_KEY: 'sk_test_wp3', // secret-scan: allow-test-fixture
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
    'salon-test-wp3', 'Salon Test WP3', 'Salon Test WP3', 'Rennes',
    'https://www.google.com/maps/place/Salon+Test+WP3/@48.1,-1.6,17z',
    JSON.stringify({ nom: 'Salon Test WP3' }), 'demo'
  );

  const page = await request({ path: GUIDE_PATH, host: BRAND_HOST });
  guideHtml = page.body;
  guideText = visibleText(guideHtml);
  homeHtml = (await request({ path: '/', host: BRAND_HOST })).body;
  pillarHtml = (await request({ path: PILLAR_PATH, host: BRAND_HOST })).body;
});

after(() => {
  try { db && db.close(); } catch { /* ignore */ }
  try { child && child.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// =============================================================================
// A. Host gate — le guide est une page de MARQUE
// =============================================================================

describe('WP3 — host gate', () => {
  test('200 sur le domaine de marque', async () => {
    const r = await request({ path: GUIDE_PATH, host: BRAND_HOST });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/html/);
  });

  test('404 sur un hostname client', async () => {
    const r = await request({ path: GUIDE_PATH, host: CUSTOMER_HOST });
    assert.equal(r.status, 404, 'le guide ne doit pas fuiter sur un domaine client');
    assert.ok(!r.body.includes('Les huit postes qui composent le prix'),
      'aucun contenu du guide ne doit être servi sur un domaine client');
  });

  test('sur l\'hôte admin : jamais servi comme page de marque', async () => {
    const r = await request({ path: GUIDE_PATH, host: ADMIN_HOST });
    assert.ok(r.status !== 200 || !r.body.includes('Les huit postes qui composent le prix'),
      'le guide ne doit pas être servi sur l\'hôte admin');
  });
});

// =============================================================================
// B. Exposition par les routes d'assets et par le chemin .html
// =============================================================================

describe('WP3 — pas d\'exposition parallèle du HTML', () => {
  for (const host of [BRAND_HOST, CUSTOMER_HOST]) {
    test(`/_assets/guides/prix-site-internet-coiffeur.html → 404 (host ${host})`, async () => {
      const r = await request({ path: '/_assets/guides/prix-site-internet-coiffeur.html', host });
      assert.equal(r.status, 404);
      assert.ok(!r.body.includes('Les huit postes qui composent le prix'));
    });

    test(`/_assets/guides/ → 404 (host ${host})`, async () => {
      const r = await request({ path: '/_assets/guides/', host });
      assert.equal(r.status, 404);
    });

    test(`${GUIDE_PATH}.html → 404 (host ${host})`, async () => {
      const r = await request({ path: `${GUIDE_PATH}.html`, host });
      assert.equal(r.status, 404);
      assert.ok(!r.body.includes('Les huit postes qui composent le prix'));
    });

    test(`/guides/ → 404, aucun index de répertoire (host ${host})`, async () => {
      const r = await request({ path: '/guides/', host });
      assert.equal(r.status, 404);
      assert.ok(!r.body.includes('prix-site-internet-coiffeur'),
        'aucun listing du répertoire /guides');
    });
  }

  test('les assets légitimes restent servis', async () => {
    const r = await request({ path: '/_assets/home.css', host: BRAND_HOST });
    assert.equal(r.status, 200);
  });
});

// =============================================================================
// C. SEO — title, description, canonical, H1, robots, OG/Twitter
// =============================================================================

describe('WP3 — SEO de base', () => {
  test('canonical absolu et auto-référent', () => {
    const m = guideHtml.match(/<link rel="canonical" href="([^"]+)"/i);
    assert.ok(m, 'balise canonical présente');
    assert.equal(m[1], CANONICAL);
    assert.ok(m[1].startsWith('https://'), 'canonical absolu');
  });

  test('robots index, follow', () => {
    assert.equal(metaContent(guideHtml, 'name', 'robots'), 'index, follow');
  });

  test('exactement un <h1>', () => {
    const h1s = guideHtml.match(/<h1\b/gi) || [];
    assert.equal(h1s.length, 1, 'un seul h1 sur la page');
  });

  test('title unique — différent de la home ET de la page pilier', () => {
    const t = titleOf(guideHtml);
    assert.ok(t && t.length > 10, 'title non vide');
    assert.notEqual(t, titleOf(homeHtml), 'title identique à la home');
    assert.notEqual(t, titleOf(pillarHtml), 'title identique à la page pilier');
  });

  test('meta description unique — différente de la home ET de la page pilier', () => {
    const d = norm(metaContent(guideHtml, 'name', 'description') || '');
    assert.ok(d.length > 40, 'meta description non vide');
    assert.notEqual(d, norm(metaContent(homeHtml, 'name', 'description') || ''));
    assert.notEqual(d, norm(metaContent(pillarHtml, 'name', 'description') || ''));
  });

  test('H1 unique — différent de celui de la home et de la page pilier', () => {
    const h1 = (html) => {
      const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      return m ? norm(visibleText(m[1])) : null;
    };
    const mine = h1(guideHtml);
    assert.ok(mine && mine.length > 10);
    assert.notEqual(mine, h1(homeHtml));
    assert.notEqual(mine, h1(pillarHtml));
  });

  test('Open Graph et Twitter Card présents et cohérents', () => {
    assert.equal(metaContent(guideHtml, 'property', 'og:url'), CANONICAL);
    assert.equal(metaContent(guideHtml, 'property', 'og:type'), 'article');
    assert.ok(metaContent(guideHtml, 'property', 'og:title'));
    assert.ok(metaContent(guideHtml, 'property', 'og:description'));
    assert.ok(metaContent(guideHtml, 'property', 'og:image'));
    assert.equal(metaContent(guideHtml, 'name', 'twitter:card'), 'summary_large_image');
    assert.ok(metaContent(guideHtml, 'name', 'twitter:title'));
    assert.ok(metaContent(guideHtml, 'name', 'twitter:description'));
  });

  test('le corps principal est visible côté serveur (pas de rendu JS)', () => {
    for (const s of [
      'Les huit postes qui composent le prix',
      'Les quatre façons de s\'y prendre',
      'La checklist à poser avant de signer',
      'Sources et méthode',
    ]) {
      assert.ok(norm(guideText).includes(norm(s)), `section absente du HTML servi : « ${s} »`);
    }
    assert.ok(guideText.length > 6000, 'le corps de l\'article doit être servi en entier');
  });
});

// =============================================================================
// D. JSON-LD
// =============================================================================

describe('WP3 — données structurées', () => {
  test('tous les blocs JSON-LD sont parsables', () => {
    const blocks = jsonLdBlocks(guideHtml);
    assert.ok(blocks.length >= 2, 'au moins Article + BreadcrumbList');
    for (const b of blocks) {
      assert.doesNotThrow(() => JSON.parse(b), 'bloc JSON-LD invalide');
    }
  });

  test('Article : datePublished et dateModified cohérents avec la date visible', () => {
    const article = jsonLdBlocks(guideHtml).map((b) => JSON.parse(b))
      .find((o) => o['@type'] === 'Article' || o['@type'] === 'BlogPosting');
    assert.ok(article, 'un bloc Article ou BlogPosting est requis');
    assert.match(article.datePublished, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(article.dateModified, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(article.publisher && article.publisher.name, 'publisher requis');
    assert.equal(article.mainEntityOfPage['@id'], CANONICAL);

    // La date visible sur la page doit correspondre, au jour près, aux dates du
    // JSON-LD. Un balisage qui annonce une fraîcheur que le texte ne montre pas
    // est un mensonge lisible par une machine seulement.
    const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
      'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const frDate = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return `${d} ${MOIS[m - 1]} ${y}`;
    };
    const text = norm(guideText);
    assert.ok(text.includes(`Publié le ${frDate(article.datePublished)}`),
      `date de publication visible absente : ${frDate(article.datePublished)}`);
    assert.ok(text.includes(`Mis à jour le ${frDate(article.dateModified)}`),
      `date de mise à jour visible absente : ${frDate(article.dateModified)}`);
  });

  test('BreadcrumbList présent et terminant sur la page courante', () => {
    const bc = jsonLdBlocks(guideHtml).map((b) => JSON.parse(b))
      .find((o) => o['@type'] === 'BreadcrumbList');
    assert.ok(bc, 'BreadcrumbList requis');
    const last = bc.itemListElement[bc.itemListElement.length - 1];
    assert.equal(last.item, CANONICAL);
  });

  test('aucun schema d\'avis ou de note', () => {
    for (const raw of jsonLdBlocks(guideHtml)) {
      assert.ok(!/aggregateRating|ratingValue|reviewCount|"Review"/i.test(raw),
        'pas de review/rating schema sur cet article');
    }
  });

  test('FAQPage : absent, ou strictement adossé au texte visible', () => {
    const faq = jsonLdBlocks(guideHtml).map((b) => JSON.parse(b))
      .find((o) => o['@type'] === 'FAQPage');
    if (!faq) return; // choix retenu : pas de FAQPage sur cet article.
    const text = norm(guideText);
    for (const q of faq.mainEntity) {
      assert.ok(text.includes(norm(q.acceptedAnswer.text)));
      assert.ok(text.includes(norm(q.name)));
    }
  });
});

// =============================================================================
// E. Sitemap / robots / preview
// =============================================================================

describe('WP3 — sitemap', () => {
  test('le sitemap de marque contient le guide', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, new RegExp(`<loc>https://maquickpage\\.fr${GUIDE_PATH}</loc>`));
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

  test('robots.txt continue de bloquer /preview/', async () => {
    const r = await request({ path: '/robots.txt', host: MAIN_HOST });
    assert.match(r.body, /Disallow: \/preview\//);
  });

  test('le sitemap client ne contient pas le guide', async () => {
    const r = await request({ path: '/sitemap.xml', host: CUSTOMER_HOST });
    assert.ok(!r.body.includes(GUIDE_PATH));
  });
});

// =============================================================================
// F. Maillage interne
// =============================================================================

describe('WP3 — maillage interne', () => {
  test('la page pilier porte un lien crawlable vers le guide', () => {
    assert.match(pillarHtml, new RegExp(`<a href="${GUIDE_PATH}"[^>]*>[^<]+</a>`),
      'lien <a href> réel (pas de JS) depuis la page pilier');
  });

  test('la home reste inchangée : aucun lien vers le guide n\'y a été ajouté', () => {
    assert.ok(!homeHtml.includes(GUIDE_PATH),
      'home.html ne doit pas avoir été modifiée par WP3');
  });

  test('le guide renvoie vers la page pilier, la FAQ et les CGV', () => {
    assert.match(guideHtml, new RegExp(`href="${PILLAR_PATH}"`));
    assert.match(guideHtml, /href="\/faq"/);
    assert.match(guideHtml, /href="\/legal\/cgv\.html"/);
    assert.match(guideHtml, /href="\/legal\/cgv-2y\.html"/);
    assert.match(guideHtml, /href="\/legal\/cgv-1y\.html"/);
    assert.match(guideHtml, /href="\/legal\/cgv-flex\.html"/);
  });

  test('tous les liens internes du guide répondent (200 ou 3xx)', async () => {
    const hrefs = [...guideHtml.matchAll(/href="(\/[^"#?]*)(?:[#?][^"]*)?"/g)]
      .map((m) => m[1])
      .filter((h) => h && !h.startsWith('/_assets/'));
    const unique = [...new Set(hrefs)];
    assert.ok(unique.length >= 6, 'le guide doit porter plusieurs liens internes');
    for (const href of unique) {
      const r = await request({ path: href, host: BRAND_HOST });
      assert.ok(r.status < 400, `lien interne cassé : ${href} → ${r.status}`);
    }
  });
});

// =============================================================================
// G. CTA — lookup existant + attribution WP1
// =============================================================================

describe('WP3 — CTA et attribution', () => {
  test('le guide réutilise le script de lookup, sans JS dédié', () => {
    assert.match(guideHtml, /\/_assets\/home\.js/);
    const forms = guideHtml.match(/<form\b/gi) || [];
    assert.equal(forms.length, 1, 'un seul formulaire : celui du lookup existant');
    assert.match(guideHtml, /id="hp-form"/);
    const scripts = [...guideHtml.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
    for (const src of scripts) {
      assert.match(src, /^\/_assets\/(track|home)\.js/, `script inattendu : ${src}`);
    }
    // Aucun script inline hors JSON-LD.
    const inline = [...guideHtml.matchAll(/<script(?![^>]+src=)([^>]*)>/gi)].map((m) => m[1]);
    for (const attrs of inline) {
      assert.match(attrs, /application\/ld\+json/, `script inline inattendu : <script${attrs}>`);
    }
  });

  test('le guide ne pose aucun cookie', async () => {
    const r = await request({ path: GUIDE_PATH, host: BRAND_HOST });
    assert.equal(r.headers['set-cookie'], undefined, 'aucun cookie posé par le guide');
  });

  test(`un lookup soumis depuis le guide enregistre landing_path = ${GUIDE_PATH}`, async () => {
    const r = await postJson('/api/landing/check', {
      google_maps_url: 'https://www.google.com/maps/place/Salon+Test+WP3/@48.1,-1.6,17z',
      email: 'coiffeur-wp3@test.local',
      ref: 'https://www.google.com/search?q=prix+site+internet+coiffeur',
    }, {
      headers: {
        'X-Forwarded-For': nextIp(),
        Referer: `http://${BRAND_HOST}${GUIDE_PATH}?src=seo`,
        'User-Agent': 'Mozilla/5.0 (test wp3)',
      },
    });
    assert.equal(r.status, 200);

    const row = db.prepare(`
      SELECT * FROM payment_attributions
      WHERE landing_path = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(GUIDE_PATH);
    assert.ok(row, 'une attribution doit être créée avec landing_path = ' + GUIDE_PATH);
    assert.equal(row.first_source, 'seo');
    assert.equal(row.referrer_host, 'google.com');

    const lead = db.prepare(
      'SELECT attribution_id FROM landing_leads WHERE email = ? ORDER BY rowid DESC LIMIT 1'
    ).get('coiffeur-wp3@test.local');
    assert.ok(lead, 'lead enregistré');
    assert.equal(lead.attribution_id, row.id);
  });
});

// =============================================================================
// H. Régression de contenu — protections home, interdits sur le guide
// =============================================================================

describe('WP3 — régression de contenu', () => {
  // Décision Michele du 2026-08-31 : ces formulations restent en ligne sur la
  // home. WP3 n'a pas le droit de les supprimer.
  const PROTECTED_ON_HOME = [
    'salons couverts',
    'Le plus choisi',
    'monitoring 24/7',
    'sauvegardes quotidiennes chiffrées',
    'best practices Google 2026',
    'en ligne en 5 minutes',
    'moins de 100 ms partout en France',
    'sous 48h',
  ];

  // « Ne pas supprimer sur la home » n'autorise pas à recopier sur une page neuve.
  const FORBIDDEN_ON_GUIDE = [
    '11 000', 'salons couverts',
    'Le plus choisi', 'Most popular', 'POPULAIRE',
    'monitoring 24/7', '24/7',
    '100 ms',
    'sauvegardes quotidiennes',
    'best practices Google 2026',
    'en ligne en 5 minutes', 'sous 48h', '48h',
    'aggregateRating', 'ratingValue', 'reviewCount',
    'rich result', 'rich snippet',
    'étoiles',
    'meilleur', 'numéro 1', 'numéro un', 'top 10',
  ];

  test('les formulations protégées sont toujours présentes sur la home', () => {
    for (const s of PROTECTED_ON_HOME) {
      assert.ok(
        norm(visibleText(homeHtml)).includes(norm(s)) || homeHtml.includes(s) || norm(homeHtml).includes(norm(s)),
        `formulation protégée disparue de la home : « ${s} »`
      );
    }
  });

  test('aucune formulation interdite sur le guide', () => {
    const haystack = norm(guideHtml).toLowerCase();
    for (const s of FORBIDDEN_ON_GUIDE) {
      assert.ok(
        !haystack.includes(norm(s).toLowerCase()),
        `formulation interdite recopiée sur le guide : « ${s} »`
      );
    }
  });

  test('aucun prix barré sur le guide', () => {
    assert.ok(!/<s>|<del>|text-decoration:\s*line-through/i.test(guideHtml));
  });

  test('les tarifs affichés sont ceux de PLANS, en TTC', () => {
    for (const amount of ['9,90 €', '17,90 €', '29 €']) {
      assert.ok(norm(guideText).includes(amount), `tarif manquant : ${amount}`);
    }
    // « HT ou TTC ? » est une question légitime de la checklist, et les tarifs de
    // noms de domaine relevés chez un registraire sont cités dans l'unité de leur
    // source (HT chez OVHcloud). Ce qui est interdit, c'est d'afficher NOTRE prix
    // hors taxes : la section produit ne doit contenir aucun « HT ».
    for (const bad of ['9,90 € HT', '17,90 € HT', '29 € HT', '29,00 € HT']) {
      assert.ok(!norm(guideText).includes(bad), `tarif MaQuickPage en HT : ${bad}`);
    }
    const start = guideHtml.indexOf('id="maquickpage"');
    assert.ok(start > 0, 'section produit introuvable');
    const end = guideHtml.indexOf('<section', start);
    const productText = visibleText(guideHtml.slice(start, end > 0 ? end : undefined));
    assert.ok(!/\bHT\b/.test(productText),
      'la section tarifaire MaQuickPage ne doit contenir aucun montant hors taxes');
    assert.ok(/9,90 €[^.]*TTC/.test(norm(productText)), 'nos tarifs doivent être affichés TTC');
  });

  test('la page pilier reste intacte sur ses propres interdits', () => {
    const haystack = norm(pillarHtml).toLowerCase();
    for (const s of ['11 000', 'salons couverts', 'le plus choisi', 'monitoring 24/7', 'wix', 'squarespace']) {
      assert.ok(!haystack.includes(s), `formulation interdite apparue sur la page pilier : « ${s} »`);
    }
  });

  test('la section « Sources et méthode » est visible et datée', () => {
    const text = norm(guideText);
    assert.ok(text.includes('Sources et méthode'));
    assert.ok(/Mis à jour le \d{1,2} [a-zéûô]+ \d{4}/.test(text), 'date de mise à jour visible');
  });
});

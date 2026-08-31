// WP1 — cohérence publique + attribution minimale de paiement.
//
// Tests de COMPORTEMENT : un vrai serveur Express est démarré en sous-processus
// sur une base SQLite temporaire, et interrogé en HTTP réel (node:http, pour
// pouvoir forcer l'en-tête Host et tester le gate de domaine de marque).
// Aucun appel réseau sortant : Stripe, OVH, Resend et Falkenstein sont
// volontairement laissés non configurés.
//
// Run : node --test tests/inbound-wp1.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BRAND_HOST = 'maquickpage.test';
const ADMIN_HOST = 'outil.maquickpage.test';
const CUSTOMER_HOST = 'salon-jean.test';
// Hôte reconnu comme « domaine principal » par src/ssr.js (MAIN_DOMAIN_HOSTS) :
// c'est lui qui décide du sitemap de marque, du robots.txt et du noindex des
// maquettes. En production c'est maquickpage.fr ; en test, localhost.
const MAIN_HOST = 'localhost';

const ATTRIBUTION_SECRET = 'wp1-test-attribution-secret'; // secret-scan: allow-test-fixture
const WEBHOOK_SECRET = 'whsec_wp1_test'; // secret-scan: allow-test-fixture
const ADMIN_EMAIL = 'wp1@test.local';
const ADMIN_PASSWORD = 'wp1-test-password'; // secret-scan: allow-test-fixture

let tmpDir, dbPath, port, child, db;

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

/** Signature Stripe v1 (même calcul que stripe.webhooks.constructEvent). */
function stripeSignature(payload, secret, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function sendWebhook(event) {
  const payload = JSON.stringify(event);
  return request({
    method: 'POST',
    path: '/webhook/stripe',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'stripe-signature': stripeSignature(payload, WEBHOOK_SECRET),
    },
  });
}

function checkoutCompleted({ eventId, sessionId, slug, attributionId, plan = 'TWO_YEAR', hostname = 'salon-jean.fr' }) {
  const metadata = { slug, hostname, plan, template: 'classic' };
  if (attributionId) metadata.attribution_id = attributionId;
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        customer: 'cus_test',
        subscription: 'sub_test',
        invoice: null,
        customer_email: 'client@test.local',
        metadata,
      },
    },
  };
}

/** Lookup : chaque appel avec une IP distincte (rate-limit 5/h par IP). */
let ipCounter = 0;
function nextIp() { return `203.0.113.${++ipCounter}`; }

// =============================================================================
// Démarrage / arrêt du serveur de test
// =============================================================================

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mqs-wp1-'));
  dbPath = join(tmpDir, 'wp1.db');
  port = await freePort();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: dbPath,
    SESSION_SECRET: 'wp1-test-session-secret-0123456789', // secret-scan: allow-test-fixture
    ATTRIBUTION_SECRET,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // sk_test_ ⇒ PROVISIONING_DRY_RUN implicite. Aucun prix configuré ⇒
    // /api/checkout/create-session s'arrête AVANT tout appel réseau.
    STRIPE_SECRET_KEY: 'sk_test_wp1', // secret-scan: allow-test-fixture
    PROVISIONING_DRY_RUN: '1',
    STRIPE_PRICE_2Y: '',
    STRIPE_PRICE_1Y: '',
    STRIPE_PRICE_FLEX: '',
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
    'salon-test-wp1', 'Salon Test WP1', 'Salon Test WP1', 'Lyon',
    'https://www.google.com/maps/place/Salon+Test+WP1/@45.7,4.8,17z',
    JSON.stringify({ nom: 'Salon Test WP1' }), 'demo'
  );
});

after(() => {
  try { db && db.close(); } catch { /* ignore */ }
  try { child && child.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// =============================================================================
// Migration
// =============================================================================

describe('WP1 — migration', () => {
  test('initSchema est rejouable et ne perd aucune donnée', async () => {
    const migDb = join(tmpDir, 'migration.db');
    const script = `
      process.env.DB_PATH = ${JSON.stringify(migDb)};
      const m = await import(${JSON.stringify(join(ROOT, 'src/db.js'))});
      const db = m.default;
      m.initSchema();
      const seedId = 'a'.repeat(32);
      db.prepare('INSERT INTO payment_attributions (id, first_source) VALUES (?, ?)').run(seedId, 'seed');
      db.prepare('INSERT INTO attribution_checkouts (stripe_session_id, attribution_id) VALUES (?, ?)').run('cs_seed', seedId);
      m.initSchema();
      m.initSchema();
      const attrs = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;
      const cks = db.prepare('SELECT COUNT(*) AS n FROM attribution_checkouts').get().n;
      const leadCols = db.prepare("PRAGMA table_info(landing_leads)").all().map(c => c.name);
      console.log(JSON.stringify({ attrs, cks, hasLink: leadCols.includes('attribution_id') }));
    `;
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env, DB_PATH: migDb } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (c) => { stdout += c; });
      p.stderr.on('data', (c) => { stderr += c; });
      p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))));
    });
    const res = JSON.parse(out.trim().split('\n').pop());
    assert.equal(res.attrs, 1, 'les lignes d\'attribution survivent au rejeu de la migration');
    assert.equal(res.cks, 1);
    assert.ok(res.hasLink, 'landing_leads.attribution_id créé par la migration');
  });

  test('payment_attributions ne contient aucune colonne de donnée personnelle', () => {
    const cols = db.prepare('PRAGMA table_info(payment_attributions)').all().map((c) => c.name);
    for (const forbidden of ['email', 'ip', 'user_agent', 'ua', 'referrer']) {
      assert.ok(!cols.includes(forbidden), `colonne interdite : ${forbidden}`);
    }
    assert.ok(cols.includes('referrer_host'));
    assert.ok(cols.includes('first_source'));
  });
});

// =============================================================================
// B. Host gate marque
// =============================================================================

describe('WP1 — host gate des pages de marque', () => {
  test('/faq et /en : 200 sur le domaine de marque', async () => {
    const faq = await request({ path: '/faq', host: BRAND_HOST });
    assert.equal(faq.status, 200);
    const en = await request({ path: '/en', host: BRAND_HOST });
    assert.equal(en.status, 200);
  });

  test('/faq et /en : 404 sur un hostname client', async () => {
    const faq = await request({ path: '/faq', host: CUSTOMER_HOST });
    assert.equal(faq.status, 404, '/faq ne doit pas fuiter sur un domaine client');
    const en = await request({ path: '/en', host: CUSTOMER_HOST });
    assert.equal(en.status, 404, '/en ne doit pas fuiter sur un domaine client');
  });

  test('/faq et /en : servis en dev sur localhost', async () => {
    const faq = await request({ path: '/faq', host: '127.0.0.1' });
    assert.equal(faq.status, 200);
    const en = await request({ path: '/en', host: 'localhost' });
    assert.equal(en.status, 200);
  });

  test('la racine reste servie sur un hostname client (comportement inchangé)', async () => {
    const root = await request({ path: '/', host: CUSTOMER_HOST });
    assert.equal(root.status, 200);
  });
});

// =============================================================================
// C. Sitemap
// =============================================================================

describe('WP1 — sitemap', () => {
  test('contient /faq et /en, jamais /preview/', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, /<loc>https:\/\/maquickpage\.fr\/faq<\/loc>/);
    assert.match(r.body, /<loc>https:\/\/maquickpage\.fr\/en<\/loc>/);
    assert.ok(!r.body.includes('/preview/'), 'les maquettes ne doivent jamais entrer au sitemap');
  });

  test('lastmod n\'est pas la date du jour pour toutes les URLs', async () => {
    const r = await request({ path: '/sitemap.xml', host: MAIN_HOST });
    const lastmods = [...r.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    assert.ok(lastmods.length > 0, 'au moins un lastmod attendu');
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(
      lastmods.some((d) => d !== today),
      `tous les lastmod valent ${today} : le sitemap se redate tout seul`
    );
  });

  test('robots.txt continue de bloquer /preview/', async () => {
    const r = await request({ path: '/robots.txt', host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, /Disallow: \/preview\//);
  });
});

// =============================================================================
// D. Attribution
// =============================================================================

describe('WP1 — attribution : lookup → preview → Checkout → paiement', () => {
  let token, attributionId;

  test('le lookup crée l\'attribution côté serveur et signe le lien preview', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;
    const r = await postJson('/api/landing/check', {
      google_maps_url: 'https://www.google.com/maps/place/Salon+Test+WP1/@45.7,4.8,17z',
      email: 'coiffeur@test.local',
      ref: 'https://www.google.com/search?q=site+coiffeur',
    }, {
      headers: {
        'X-Forwarded-For': nextIp(),
        Referer: `http://${BRAND_HOST}/?src=Newsletter%20Ao%C3%BBt&utm_source=mailjet&utm_campaign=RENTREE%202026&utm_medium=email`,
        'User-Agent': 'Mozilla/5.0 (test)',
      },
    });
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.equal(data.found, true);
    assert.match(data.demo_url, /\?mqa=[0-9a-f]{32}\./, 'le lien démo porte le token signé');

    token = decodeURIComponent(data.demo_url.split('mqa=')[1]);
    attributionId = token.split('.')[0];

    const after = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;
    assert.equal(after, before + 1);

    const row = db.prepare('SELECT * FROM payment_attributions WHERE id = ?').get(attributionId);
    assert.ok(row);
    // Normalisation + validation de caractères + bornes de longueur.
    assert.equal(row.first_source, 'newsletter-aot');
    assert.equal(row.utm_source, 'mailjet');
    assert.equal(row.utm_campaign, 'rentree-2026');
    assert.equal(row.utm_medium, 'email');
    assert.equal(row.landing_path, '/');
    assert.equal(row.referrer_host, 'google.com', 'seul le host du referrer est conservé');
    assert.equal(row.salon_slug, 'salon-test-wp1');
    assert.equal(row.lead_found, 1);
    // L'identifiant est opaque : il ne dérive d'aucune donnée du lead.
    assert.match(row.id, /^[0-9a-f]{32}$/);
    for (const pii of ['coiffeur@test.local', '203.0.113', 'Mozilla', 'salon-test-wp1']) {
      assert.ok(!row.id.includes(pii));
    }

    const lead = db.prepare('SELECT attribution_id FROM landing_leads ORDER BY id DESC LIMIT 1').get();
    assert.equal(lead.attribution_id, attributionId, 'le lead est rattaché à son attribution');
  });

  test('le retour sur le preview avec le token horodate la visite', async () => {
    const before = db.prepare('SELECT preview_seen_at FROM payment_attributions WHERE id = ?').get(attributionId);
    assert.equal(before.preview_seen_at, null);

    const r = await request({ path: `/preview/salon-test-wp1?mqa=${encodeURIComponent(token)}`, host: MAIN_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, /<meta name="robots" content="noindex/, 'la maquette reste noindex');

    const after = db.prepare('SELECT preview_seen_at FROM payment_attributions WHERE id = ?').get(attributionId);
    assert.ok(after.preview_seen_at, 'preview_seen_at horodaté');
  });

  test('un token forgé est rejeté et ne crée AUCUN enregistrement', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;

    // 1. Signature invalide sur un id existant
    const tampered = `${attributionId}.${'A'.repeat(43)}`;
    // 2. Id inventé + signature inventée
    const invented = `${'f'.repeat(32)}.${'B'.repeat(43)}`;
    // 3. Id inconnu MAIS signé avec le vrai secret (le token ne peut que
    //    référencer un enregistrement existant, jamais en créer un)
    const unknownId = crypto.randomBytes(16).toString('hex');
    const sig = crypto.createHmac('sha256', ATTRIBUTION_SECRET).update(`mqa1:${unknownId}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signedUnknown = `${unknownId}.${sig}`;

    for (const bad of [tampered, invented, signedUnknown, 'not-a-token', '']) {
      const r = await request({ path: `/preview/salon-test-wp1?mqa=${encodeURIComponent(bad)}`, host: MAIN_HOST });
      assert.equal(r.status, 200, 'un token invalide n\'altère pas la page');
    }

    const after = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;
    assert.equal(after, before, 'aucun enregistrement créé par un token forgé');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM payment_attributions WHERE id = ?').get(unknownId).n,
      0,
      'un id signé mais inconnu ne crée pas de ligne'
    );
  });

  test('un token forgé au Checkout ne crée ni n\'écrase aucune attribution', async () => {
    const beforeAttr = db.prepare('SELECT * FROM payment_attributions WHERE id = ?').get(attributionId);
    const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n;

    const r = await postJson('/api/checkout/create-session', {
      slug: 'salon-test-wp1',
      plan: 'TWO_YEAR',
      hostname: 'salon-test-wp1.fr',
      email: 'coiffeur@test.local',
      cgv_accepted: true,
      cgv_version: '1.1',
      attribution_token: `${attributionId}.${'Z'.repeat(43)}`,
    }, { host: BRAND_HOST });

    // Stripe n'est pas configuré dans l'environnement de test : la route
    // s'arrête sur cette erreur, sans appel réseau. Ce qui compte ici est
    // qu'aucune écriture d'attribution n'ait eu lieu.
    assert.ok(r.status >= 400, `réponse attendue en erreur (Stripe non configuré), reçu ${r.status}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_attributions').get().n, beforeCount);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM attribution_checkouts').get().n, 0,
      'aucune Session enregistrée tant que Stripe n\'a rien créé'
    );
    const afterAttr = db.prepare('SELECT * FROM payment_attributions WHERE id = ?').get(attributionId);
    assert.deepEqual(afterAttr, beforeAttr, 'l\'enregistrement existant n\'est jamais écrasé par le client');
  });

  test('le webhook marque le paiement par ID de Session Stripe', async () => {
    const r = await sendWebhook(checkoutCompleted({
      eventId: 'evt_wp1_1',
      sessionId: 'cs_wp1_1',
      slug: 'salon-test-wp1',
      attributionId,
    }));
    assert.equal(r.status, 200);

    const row = db.prepare('SELECT * FROM attribution_checkouts WHERE stripe_session_id = ?').get('cs_wp1_1');
    assert.ok(row, 'ligne créée par le webhook');
    assert.equal(row.attribution_id, attributionId);
    assert.equal(row.salon_slug, 'salon-test-wp1');
    assert.equal(row.plan, 'TWO_YEAR');
    assert.ok(row.paid_at, 'paid_at horodaté');

    const salon = db.prepare('SELECT subscription_status FROM salons WHERE slug = ?').get('salon-test-wp1');
    assert.equal(salon.subscription_status, 'provisioning');
  });

  test('le rejeu du webhook reste idempotent', async () => {
    const first = db.prepare('SELECT paid_at FROM attribution_checkouts WHERE stripe_session_id = ?').get('cs_wp1_1').paid_at;

    // Même event.id → court-circuit d'idempotence
    const replay = await sendWebhook(checkoutCompleted({
      eventId: 'evt_wp1_1', sessionId: 'cs_wp1_1', slug: 'salon-test-wp1', attributionId,
    }));
    assert.equal(replay.status, 200);
    assert.match(replay.body, /"duplicate":true/);

    // Nouvel event.id, MÊME Session → une seule ligne, paid_at inchangé
    await new Promise((r) => setTimeout(r, 1100));
    const again = await sendWebhook(checkoutCompleted({
      eventId: 'evt_wp1_1bis', sessionId: 'cs_wp1_1', slug: 'salon-test-wp1', attributionId,
    }));
    assert.equal(again.status, 200);

    const rows = db.prepare('SELECT * FROM attribution_checkouts WHERE stripe_session_id = ?').all('cs_wp1_1');
    assert.equal(rows.length, 1, 'une seule ligne par Session');
    assert.equal(rows[0].paid_at, first, 'paid_at conserve sa première valeur');
  });

  test('une Session sans champ d\'attribution est traitée normalement (NULL)', async () => {
    const r = await sendWebhook(checkoutCompleted({
      eventId: 'evt_wp1_legacy', sessionId: 'cs_wp1_legacy', slug: 'salon-test-wp1',
      attributionId: null,
    }));
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT * FROM attribution_checkouts WHERE stripe_session_id = ?').get('cs_wp1_legacy');
    assert.ok(row);
    assert.equal(row.attribution_id, null);
    assert.ok(row.paid_at);
  });

  test('deux Checkouts conservent chacun leur attribution', async () => {
    // Deuxième parcours complet, avec une source différente.
    const r = await postJson('/api/landing/check', {
      google_maps_url: 'https://www.google.com/maps/place/Salon+Test+WP1/@45.7,4.8,17z',
      email: 'coiffeur2@test.local',
      ref: 'facebook.com',
    }, {
      headers: {
        'X-Forwarded-For': nextIp(),
        Referer: `http://${BRAND_HOST}/?src=facebook`,
        'User-Agent': 'Mozilla/5.0 (test)',
      },
    });
    const second = decodeURIComponent(JSON.parse(r.body).demo_url.split('mqa=')[1]).split('.')[0];
    assert.notEqual(second, attributionId);

    await sendWebhook(checkoutCompleted({
      eventId: 'evt_wp1_2', sessionId: 'cs_wp1_2', slug: 'salon-test-wp1',
      attributionId: second, plan: 'ONE_YEAR',
    }));

    const rows = db.prepare(
      'SELECT stripe_session_id, attribution_id FROM attribution_checkouts WHERE stripe_session_id IN (?,?) ORDER BY stripe_session_id'
    ).all('cs_wp1_1', 'cs_wp1_2');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].attribution_id, attributionId);
    assert.equal(rows[1].attribution_id, second);
    assert.notEqual(rows[0].attribution_id, rows[1].attribution_id);
  });

  test('un échec d\'écriture d\'attribution ne bloque ni le paiement ni le provisioning', async () => {
    // On casse volontairement la table d'attribution SOUS le serveur en cours
    // d'exécution : c'est le seul moyen honnête de provoquer l'échec d'écriture.
    db.exec('ALTER TABLE attribution_checkouts RENAME TO attribution_checkouts_backup');
    db.prepare("UPDATE salons SET subscription_status = 'demo' WHERE slug = ?").run('salon-test-wp1');
    try {
      const r = await sendWebhook(checkoutCompleted({
        eventId: 'evt_wp1_broken', sessionId: 'cs_wp1_broken', slug: 'salon-test-wp1', attributionId,
      }));
      assert.equal(r.status, 200, 'le webhook acquitte malgré l\'échec d\'attribution');

      const salon = db.prepare('SELECT subscription_status FROM salons WHERE slug = ?').get('salon-test-wp1');
      assert.equal(salon.subscription_status, 'provisioning', 'le provisioning est bien déclenché');

      // Le chemin `DELETE FROM stripe_events` NE DOIT PAS avoir été emprunté :
      // sinon Stripe rejouerait l'event et rachèterait un domaine.
      const evt = db.prepare('SELECT id FROM stripe_events WHERE id = ?').get('evt_wp1_broken');
      assert.ok(evt, 'l\'event reste acquitté : aucun rejeu Stripe provoqué');
    } finally {
      db.exec('ALTER TABLE attribution_checkouts_backup RENAME TO attribution_checkouts');
    }
  });
});

// =============================================================================
// Metadata Stripe : contrat côté émission
// =============================================================================

describe('WP1 — metadata Stripe', () => {
  const source = readFileSync(join(ROOT, 'src/routes/checkout.js'), 'utf8');

  test('la Session porte attribution_id + source, en plus de slug/plan/hostname/template', () => {
    assert.match(source, /attribution_id: attribution\.id/);
    assert.match(source, /attribution_source: attribution\.first_source \|\| 'direct'/);
    assert.match(source, /metadata: \{\s*\n\s*slug,\s*\n\s*hostname,\s*\n\s*plan: planKey,\s*\n\s*template,/);
  });

  test('aucune PII dans la metadata de Session', () => {
    // Extraction exacte des deux littéraux `metadata: { ... }` (celui de la
    // Session et celui de subscription_data) par comptage d'accolades.
    const blocks = [];
    let from = 0;
    for (;;) {
      const i = source.indexOf('metadata: {', from);
      if (i < 0) break;
      let depth = 0, j = i + 'metadata: '.length;
      for (; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      blocks.push(source.slice(i, j));
      from = j;
    }
    assert.equal(blocks.length, 2, 'deux blocs metadata attendus');
    for (const raw of blocks) {
      // Les commentaires citent volontairement les champs interdits.
      const body = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      for (const forbidden of ['email', 'ip:', 'user_agent', 'userAgent', 'referrer', 'clientIp']) {
        assert.ok(!body.includes(forbidden), `metadata Stripe ne doit jamais porter « ${forbidden} » :\n${body}`);
      }
    }
    assert.ok(blocks.some((b) => b.includes('attribution_id')), 'attribution_id présent');
  });

  test('le webhook lit l\'attribution par ID de Session, pas par salon', () => {
    const hook = readFileSync(join(ROOT, 'src/routes/stripe-webhook.js'), 'utf8');
    assert.match(hook, /markCheckoutPaid\(\{\s*\n\s*sessionId: session\.id/);
  });
});

// =============================================================================
// A. Cohérence publique
// =============================================================================

describe('WP1 — cohérence publique', () => {
  test('l\'email de lookup annonce 9,90 € TTC (HTML et texte)', () => {
    const src = readFileSync(join(ROOT, 'src/routes/landing.js'), 'utf8');
    assert.ok(!/9,90\s*€\s*HT\b/.test(src), 'plus aucun « 9,90 € HT »');
    assert.equal((src.match(/9,90 € TTC/g) || []).length, 2, 'corps HTML ET corps texte');
  });

  test('le checkout ne promet plus « sans frais »', () => {
    const modal = readFileSync(join(ROOT, 'public/site/pricing-modal.js'), 'utf8');
    assert.ok(!modal.includes('sans frais'), '« sans frais » supprimé des 2 chaînes');
    assert.match(modal, /la première mensualité reste due/);
    assert.match(modal, /aucun prélèvement ensuite/);
    assert.match(modal, /engagement 12 ou 24 mois est entièrement levé/);
  });

  test('le parcours d\'achat divulgue indemnité, reconduction tacite et préavis', () => {
    const modal = readFileSync(join(ROOT, 'public/site/pricing-modal.js'), 'utf8');
    assert.match(modal, /reconduit tacitement par périodes de 12 mois/);
    assert.match(modal, /préavis d’1 mois \(formule 12 mois\) ou de 2 mois \(formule 24 mois\)/);
    assert.match(modal, /indemnité de 50 % des mensualités restant dues/);
    // Variante par formule au récapitulatif (étape 3).
    assert.match(modal, /préavis de 2 mois/);
    assert.match(modal, /préavis d’1 mois/);
  });

  test('la FAQ divulgue indemnité, reconduction tacite et préavis', async () => {
    const r = await request({ path: '/faq', host: BRAND_HOST });
    assert.equal(r.status, 200);
    assert.match(r.body, /tacite reconduction pour des périodes successives de douze \(12\) mois/);
    assert.match(r.body, /préavis d’un \(1\) mois pour la formule 12 mois, et de deux \(2\) mois pour la formule 24 mois/);
    assert.match(r.body, /cinquante pour cent \(50 %\) du montant total des mensualités restant dues/);
    assert.match(r.body, /plafonnés à 50 € TTC/);
  });
});

// =============================================================================
// Non-régression inverse : les affirmations que Michele a décidé de garder
// =============================================================================

describe('WP1 — non-régression : rien de commercial n\'a été supprimé', () => {
  const files = {
    home: readFileSync(join(ROOT, 'public/site/home.html'), 'utf8'),
    homeEn: readFileSync(join(ROOT, 'public/site/home-en.html'), 'utf8'),
    modal: readFileSync(join(ROOT, 'public/site/pricing-modal.js'), 'utf8'),
    landing: readFileSync(join(ROOT, 'src/routes/landing.js'), 'utf8'),
  };

  const expectations = [
    ['home', /11(&nbsp;|\s|\u00a0|\u202f)000 salons couverts/],
    ['home', /en ligne en 5 minutes/],
    ['home', /moins de 100(&nbsp;|\s|\u00a0|\u202f)ms partout en/],
    ['home', /monitoring 24\/7/i],
    ['home', /sauvegardes quotidiennes chiffrées/],
    ['home', /best practices Google 2026/],
    ['home', /48h/],
    ['homeEn', /11,000 salons covered/],
    ['modal', /615 €/],
    ['modal', /15 €/],
    ['modal', /Le plus choisi/],
    ['landing', /en ligne en 5 minutes/],
  ];

  for (const [file, re] of expectations) {
    test(`${file} contient toujours ${re}`, () => {
      assert.match(files[file], re);
    });
  }

  test('« POPULAIRE » / « Most popular » toujours présents', () => {
    const all = files.home + files.homeEn + files.modal;
    assert.ok(/POPULAIRE/i.test(all) || /Most popular/i.test(all) || /Le plus choisi/.test(all));
  });
});

// =============================================================================
// Admin : visibilité minimale (item 28)
// =============================================================================

describe('WP1 — visibilité admin', () => {
  test('landing-stats.json expose source → lead → maquette → Checkout → paiement', async () => {
    const login = await postJson('/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { host: ADMIN_HOST });
    assert.equal(login.status, 200, `login admin attendu 200, reçu ${login.status} : ${login.body}`);
    const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'cookie de session admin');

    const r = await request({
      path: '/admin/api/landing-stats.json?days=30',
      host: ADMIN_HOST,
      headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.ok(Array.isArray(data.attributions), 'champ attributions présent');

    const paid = data.attributions.find((a) => a.stripe_session_id === 'cs_wp1_1');
    assert.ok(paid, 'le Checkout payé est visible');
    assert.equal(paid.lead_email, 'coiffeur@test.local');
    assert.equal(paid.salon_slug, 'salon-test-wp1');
    assert.equal(paid.first_source, 'newsletter-aot');
    assert.ok(paid.paid_at);
  });
});

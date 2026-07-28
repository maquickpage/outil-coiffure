import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('checkout keeps prices TTC across landing and paywall', async () => {
  const landing = await readFile(new URL('public/site/home.html', root), 'utf8');
  assert.doesNotMatch(landing, /(?:9,90|17,90|29(?:,00)?)\s*€\s*HT/i);
  assert.doesNotMatch(landing, /Tarifs HT/i);
  assert.match(landing, /9,90 € TTC\/mois/);
});

test('checkout demo cannot reach payment backend', async () => {
  const frontend = await readFile(new URL('public/site/pricing-modal.js', root), 'utf8');
  const backend = await readFile(new URL('src/routes/checkout.js', root), 'utf8');
  assert.match(frontend, /checkout_demo: isCheckoutDemoMode\(\)/);
  assert.match(backend, /req\.body\?\.checkout_demo === true/);
  assert.match(backend, /CHECKOUT_DEMO_ONLY/);
});

test('Stripe webhook failures remain retryable', async () => {
  const source = await readFile(new URL('src/routes/stripe-webhook.js', root), 'utf8');
  assert.match(source, /DELETE FROM stripe_events WHERE id = \?/);
  assert.match(source, /status\(500\)\.json\(\{ received: false, retry: true \}\)/);
  assert.doesNotMatch(source, /retourne 200 quand même/);
  assert.match(source, /updateResult\.changes !== 1/);
});

test('tenant sync includes selected template and is required in production', async () => {
  const sync = await readFile(new URL('src/routes/sync.js', root), 'utf8');
  const worker = await readFile(new URL('src/provisioning-worker.js', root), 'utf8');
  assert.match(sync, /'data_json', 'template'/);
  assert.match(worker, /SYNC_BEARER_TOKEN absent : sync Falkenstein impossible/);
  assert.match(worker, /throw new Error\(`sync Falkenstein failed/);
});

test('server owns the active CGV version', async () => {
  const source = await readFile(new URL('src/routes/checkout.js', root), 'utf8');
  assert.match(source, /CURRENT_CGV_VERSION = '1\.1'/);
  assert.match(source, /cgv_version !== CURRENT_CGV_VERSION/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('tracking aggregates use bounded periods without oldest-row caps', async () => {
  const source = await readFile(new URL('src/routes/admin.js', root), 'utf8');
  assert.match(source, /\[7, 30, 90\]/);
  assert.doesNotMatch(source, /ORDER BY e\.ts ASC\s+LIMIT 500000/);
  assert.doesNotMatch(source, /ORDER BY ts ASC\s+LIMIT 500000/);
  assert.match(source, /periodDays: period\.days/);
});

test('landing funnel stages share the JS-confirmed visitor population', async () => {
  const source = await readFile(new URL('src/routes/admin.js', root), 'utf8');
  const confirmedBlock = source.match(/if \(v\.ready\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(confirmedBlock, /vf\.real\+\+/);
  assert.match(confirmedBlock, /vf\.scroll50\+\+/);
  assert.match(confirmedBlock, /vf\.cta\+\+/);
  assert.match(confirmedBlock, /vf\.open\+\+/);
  assert.match(confirmedBlock, /vf\.submit\+\+/);
});

test('internal outreach actions cannot create prospect activity', async () => {
  // Comportemental, pas textuel : l'ancienne version comparait le SOURCE d'admin.js et
  // s'est cassée dès que l'exclusion par appareil a été ajoutée entre les deux clauses.
  const { creerClassifieur, INTERNAL_ACTIVITY_EVENTS } = await import('../src/suivi-classifier.js');
  assert.deepEqual([...INTERNAL_ACTIVITY_EVENTS].sort(), ['demo_email_envoyee', 'demo_sms_copiee']);
  const c = creerClassifieur({ excludedIps: ['1.2.3.4'], excludedDevices: ['dev-1'], excludedSigs: [] });
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15';
  assert.equal(c.classify({ event: 'demo_email_envoyee', ip: '9.9.9.9', user_agent: ua }), 'internal');
  assert.equal(c.classify({ event: 'demo_sms_copiee',   ip: '9.9.9.9', user_agent: ua }), 'internal');
  assert.equal(c.classify({ event: 'preview_ouvert',    ip: '9.9.9.9', user_agent: ua }), 'human');
});

test('landing scroll tracking can report a higher depth after returning', async () => {
  const source = await readFile(new URL('public/site/home.js', root), 'utf8');
  assert.match(source, /let maxPct = 0, sentPct = 0/);
  assert.match(source, /if \(maxPct <= sentPct\) return/);
  assert.doesNotMatch(source, /let maxPct = 0, sent = false/);
});

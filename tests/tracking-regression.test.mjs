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
  const source = await readFile(new URL('src/routes/admin.js', root), 'utf8');
  assert.match(source, /INTERNAL_ACTIVITY_EVENTS = new Set\(\['demo_email_envoyee', 'demo_sms_copiee'\]\)/);
  assert.match(source, /excluded\.has\(r\.ip\) \|\| INTERNAL_ACTIVITY_EVENTS\.has\(r\.event\)/);
});

test('landing scroll tracking can report a higher depth after returning', async () => {
  const source = await readFile(new URL('public/site/home.js', root), 'utf8');
  assert.match(source, /let maxPct = 0, sentPct = 0/);
  assert.match(source, /if \(maxPct <= sentPct\) return/);
  assert.doesNotMatch(source, /let maxPct = 0, sent = false/);
});

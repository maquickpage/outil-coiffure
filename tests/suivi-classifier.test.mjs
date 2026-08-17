import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creerClassifieur, isBot, ip64, skey, BOT_RE } from '../src/suivi-classifier.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

test('bots: UA déclaré, UA vide, et scanners de messagerie reconnus à l\'IP', () => {
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)', '203.0.113.7'), true);
  assert.equal(isBot('', '203.0.113.7'), true, 'UA vide = bot');
  assert.equal(isBot(CHROME, '66.249.66.1'), true, 'Google scanner IP with a browser UA is still a bot');
  assert.equal(isBot(CHROME, '40.94.12.9'), true, 'Microsoft SafeLinks range');
  assert.equal(isBot(IPHONE, '2001:863:2d3:e0::1'), false, 'French residential IPv6 on iPhone is human');
  assert.equal(isBot(CHROME, '193.248.55.109'), false, 'Orange residential IPv4 is human');
});

test('interne: IP exclue (v4 exact et v6 par /64), appareil exclu, signature ip|ua', () => {
  const c = creerClassifieur({
    excludedIps: ['193.248.55.109', ip64('2a01:cb00:1234:5678:aaaa:bbbb:cccc:dddd')],
    excludedDevices: ['dev-michele'],
    excludedSigs: [skey('86.0.0.1', CHROME)]
  });
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '193.248.55.109', user_agent: CHROME }), 'internal');
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '2a01:cb00:1234:5678:1:2:3:4', user_agent: IPHONE }), 'internal', 'same /64, different host bits');
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '5.5.5.5', user_agent: IPHONE, device: 'dev-michele' }), 'internal');
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '86.0.0.1', user_agent: CHROME }), 'internal', 'retroactive signature match');
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '86.0.0.2', user_agent: CHROME }), 'human', 'different ip, same ua: not excluded');
});

test('un bot reste un bot même depuis une IP exclue (bot prime sur interne)', () => {
  const c = creerClassifieur({ excludedIps: ['1.1.1.1'] });
  assert.equal(c.classify({ event: 'preview_ouvert', ip: '1.1.1.1', user_agent: 'curl/8.4' }), 'bot');
});

test('la regex bot n\'attrape pas un vrai navigateur', () => {
  assert.equal(BOT_RE.test(IPHONE), false);
  assert.equal(BOT_RE.test(CHROME), false);
});

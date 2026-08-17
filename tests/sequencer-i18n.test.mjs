// G6 — la porte i18n. Le 2026-08-17, « prix vu · scroll · édité » (français) est parti en
// production dans les locales EN et ZH parce que rien ne l'interdisait. Ce test lit le
// tableau T de sequencer.html et impose : mêmes clés dans fr/en/zh, aucune valeur vide,
// et aucun mot français caractéristique dans EN/ZH (hors liste blanche : noms propres et
// termes que l'équipe garde tels quels dans les trois langues).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

async function chargerT() {
  const html = await readFile(new URL('public/admin/sequencer.html', root), 'utf8');
  const start = html.indexOf('var T = {');
  assert.ok(start > 0, 'var T introuvable dans sequencer.html');
  // fin du littéral : première ligne "};" après le début
  const end = html.indexOf('\n};', start);
  assert.ok(end > start, 'fin de T introuvable');
  const src = html.slice(start, end + 3);
  const ctx = {};
  vm.runInNewContext(src + '; this.T = T;', ctx);
  return ctx.T;
}

// Mots légitimes en anglais qui ressemblent à du français : retirés avant la recherche.
const ALLOW = /\b(?:maquette|stripe|coolify|apps script|planity|booksy|treatwell|maquickpage|séquenceur|sequenceur|csv|json|url|ok|paris|utc|id|api|node|nœud|noeud|silence|scroll(?:ed|ing)?|slug|bot|stop|toast|table|import|export|total|active|mobile|desktop|template|status|action|question|section|option|position|portal|prospect|salon|version|session|note|date|minute|second|route|module|service)\b/gi;
// Mots/graphies qui trahissent du français resté dans une autre langue.
const FRENCH = /\b(le|la|les|des|du|une|un|et|ou|pour|avec|sans|dans|sur|par|vers|chez|est|sont|pas|aucun|aucune|tous|toutes|prix|vu|vue|envoi|envoyé|envoyée|ouvert|ouverte|ouverture|édité|éditée|désinscrit|désinscrite|désinscription|répondu|silence|à|où|déjà|encore|hier|aujourd)\b/i;

test('T : mêmes clés dans fr, en, zh — aucune manquante, aucune en trop', async () => {
  const T = await chargerT();
  const fr = Object.keys(T.fr).sort(), en = Object.keys(T.en).sort(), zh = Object.keys(T.zh).sort();
  assert.deepEqual(en, fr, 'en ≠ fr');
  assert.deepEqual(zh, fr, 'zh ≠ fr');
});

test('T : aucune valeur vide', async () => {
  const T = await chargerT();
  for (const lang of ['fr', 'en', 'zh']) for (const [k, v] of Object.entries(T[lang])) {
    assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.${k} vide`);
  }
});

test('T : pas de français dans EN et ZH (hors liste blanche)', async () => {
  const T = await chargerT();
  const fautes = [];
  for (const lang of ['en', 'zh']) for (const [k, v] of Object.entries(T[lang])) {
    // on retire les tokens {x} et les mots en liste blanche avant de chercher
    const clean = String(v).replace(/\{[^}]+\}/g, ' ').replace(ALLOW, ' ');
    if (lang === 'zh' && !/[A-Za-zÀ-ÿ]{3,}/.test(clean)) continue; // du chinois pur : rien à vérifier
    const m = FRENCH.exec(clean);
    if (m) fautes.push(`${lang}.${k}: « ${m[0]} » dans "${v}"`);
  }
  assert.deepEqual(fautes, [], 'français détecté :\n' + fautes.join('\n'));
});

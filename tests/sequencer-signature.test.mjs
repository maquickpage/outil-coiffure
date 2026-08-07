import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prenomNoeud, resoudreSignature, neutraliserSignature } from '../src/sequencer-signature.js';

const modele = [{
  step_no: 1,
  subject: 'Objet sans prénom',
  body: 'Bonjour,\n\nvoici le site.\n\n{{sender_name}}\nMaQuickPage\n07 49 42 06 08'
}];

describe('prenomNoeud', () => {
  test('prend le premier mot du libellé', () => {
    assert.equal(prenomNoeud({ label: 'Sophie Moreau', mailbox: 'sophie@x.fr' }), 'Sophie');
  });

  test('retombe sur la partie locale de l\'adresse quand le libellé est vide', () => {
    assert.equal(prenomNoeud({ label: '', mailbox: 'camille@monsitehq.com' }), 'Camille');
  });

  test('nœud sans rien exploitable → chaîne vide, pas de plantage', () => {
    assert.equal(prenomNoeud({}), '');
    assert.equal(prenomNoeud(null), '');
  });
});

describe('resoudreSignature', () => {
  test('chaque boîte signe de son prénom', () => {
    const noeuds = [
      { label: 'Sophie Moreau', mailbox: 'sophie@getquickpage.fr' },
      { label: 'Solène Perrin', mailbox: 'solene@getquickpage.fr' },
      { label: 'Cédric Lambert', mailbox: 'cedric@getquickpage.fr' },
    ];
    const signatures = noeuds.map(n => resoudreSignature(modele, n)[0].body.split('\n')[4]);
    assert.deepEqual(signatures, ['Sophie', 'Solène', 'Cédric']);
  });

  test('le modèle d\'origine n\'est pas muté', () => {
    const avant = JSON.stringify(modele);
    resoudreSignature(modele, { label: 'Sophie Moreau' });
    assert.equal(JSON.stringify(modele), avant);
  });
});

describe('neutraliserSignature', () => {
  test('aller-retour : ce que l\'admin relit est exactement le modèle écrit', () => {
    for (const n of [
      { label: 'Sophie Moreau', mailbox: 'sophie@getquickpage.fr' },
      { label: 'Solène Perrin', mailbox: 'solene@getquickpage.fr' },   // accent : \b ne suffirait pas
      { label: '', mailbox: 'camille@monsitehq.com' },
    ]) {
      const retour = neutraliserSignature(resoudreSignature(modele, n), n);
      assert.deepEqual(retour, modele, 'aller-retour cassé pour ' + prenomNoeud(n));
    }
  });

  test('un prénom cité dans le corps du texte n\'est PAS transformé en signature', () => {
    const n = { label: 'Sophie Moreau', mailbox: 'sophie@getquickpage.fr' };
    const m = [{ subject: '', body: 'Notre cliente Sophie a adoré.\n\n{{sender_name}}' }];
    const retour = neutraliserSignature(resoudreSignature(m, n), n);
    assert.equal(retour[0].body, 'Notre cliente Sophie a adoré.\n\n{{sender_name}}');
  });

  test('un mot qui contient le prénom reste intact', () => {
    const n = { label: 'Sophie Moreau', mailbox: 'sophie@getquickpage.fr' };
    const m = [{ subject: '', body: 'Sophiane est cliente.\n{{sender_name}}' }];
    assert.equal(neutraliserSignature(resoudreSignature(m, n), n)[0].body,
                 'Sophiane est cliente.\n{{sender_name}}');
  });

  test('steps absents ou non tableau : renvoyés tels quels', () => {
    const n = { label: 'Sophie Moreau' };
    assert.equal(neutraliserSignature(undefined, n), undefined);
    assert.equal(resoudreSignature(null, n), null);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filtrerLot, repartir, estUnRejeuIdentique, COLONNES_IMPORT } from '../src/sequencer-filters.js';

const ligne = (email, slug = 'salon-x') => ({ email, salon_slug: slug, salon_name: 'X', city: 'Paris' });

describe('filtrage avant import', () => {
  test('refuse tout le fichier si une ligne est mal formée', () => {
    const r = filtrerLot([ligne('a@b.fr'), { email: '', salon_slug: 's' }, ligne('c@d.fr')]);
    assert.equal(r.erreurs.length, 1);
    assert.match(r.erreurs[0], /ligne 3/);
  });

  test('signale un slug manquant', () => {
    const r = filtrerLot([{ email: 'a@b.fr', salon_slug: '  ' }]);
    assert.match(r.erreurs[0], /salon_slug/);
  });

  test('détecte un doublon interne au fichier', () => {
    const r = filtrerLot([ligne('a@b.fr'), ligne('A@B.FR')]);
    assert.equal(r.erreurs.length, 1);
    assert.match(r.erreurs[0], /double/);
  });

  test('écarte une adresse désinscrite sans bloquer le reste', () => {
    const r = filtrerLot([ligne('stop@b.fr'), ligne('ok@b.fr')], new Set(['stop@b.fr']));
    assert.equal(r.erreurs.length, 0);
    assert.deepEqual(r.ecartes.desinscrits, ['stop@b.fr']);
    assert.equal(r.retenus.length, 1);
    assert.equal(r.retenus[0].email, 'ok@b.fr');
  });

  test('écarte une adresse déjà confiée à un autre nœud', () => {
    const r = filtrerLot([ligne('deja@b.fr'), ligne('neuf@b.fr')], new Set(), new Set(['deja@b.fr']));
    assert.deepEqual(r.ecartes.deja_confies, ['deja@b.fr']);
    assert.equal(r.retenus.length, 1);
  });

  test('la désinscription prime sur le dédoublonnage', () => {
    const r = filtrerLot([ligne('x@b.fr')], new Set(['x@b.fr']), new Set(['x@b.fr']));
    assert.equal(r.ecartes.desinscrits.length, 1);
    assert.equal(r.ecartes.deja_confies.length, 0);
  });

  test('normalise casse et espaces', () => {
    const r = filtrerLot([{ email: '  MiXeD@Case.FR ', salon_slug: 's' }]);
    assert.equal(r.retenus[0].email, 'mixed@case.fr');
  });
});

describe('répartition sur les nœuds', () => {
  const nodes = [{ mailbox: 'a@x.fr' }, { mailbox: 'b@x.fr' }];

  test('distribue une ligne sur deux et force la boîte d envoi', () => {
    const paniers = repartir([ligne('1@b.fr'), ligne('2@b.fr'), ligne('3@b.fr')], nodes);
    assert.equal(paniers[0].length, 2);
    assert.equal(paniers[1].length, 1);
    const iMailbox = COLONNES_IMPORT.indexOf('mailbox');
    assert.equal(paniers[0][0][iMailbox], 'a@x.fr');
    assert.equal(paniers[1][0][iMailbox], 'b@x.fr');
  });

  test('respecte l ordre des colonnes attendu par le nœud', () => {
    const paniers = repartir([ligne('1@b.fr')], [{ mailbox: 'a@x.fr' }]);
    assert.equal(paniers[0][0][COLONNES_IMPORT.indexOf('email')], '1@b.fr');
    assert.equal(paniers[0][0][COLONNES_IMPORT.indexOf('salon_slug')], 'salon-x');
  });
});

describe('rejeu après réponse perdue', () => {
  test('un lot entièrement « already imported » est un rejeu, pas un échec', () => {
    const rep = { ok: false, error: '2 error(s):\n- row 2: email already imported (a@b.fr)\n- row 3: email already imported (c@d.fr)' };
    assert.equal(estUnRejeuIdentique(rep, 2), true);
  });

  test('un refus partiel reste un échec', () => {
    const rep = { ok: false, error: '- row 2: email already imported (a@b.fr)\n- row 3: quota dépassé' };
    assert.equal(estUnRejeuIdentique(rep, 2), false);
  });

  test('une réponse réussie n est jamais un rejeu', () => {
    assert.equal(estUnRejeuIdentique({ ok: true, imported: 5 }, 5), false);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validerTemplate, variablesDuTexte, resteDesVariables, verifierEligibilite, verifierQuota,
         MANUEL_MAX_PAR_JOUR, TOTAL_MAX_PAR_JOUR } from '../src/sequencer-manual-followup.js';
import { construireTimeline } from '../src/sequencer-engagement.js';

// ---------- modèle ----------
describe('validerTemplate', () => {
  test('modèle vide (ou blanc) refusé — le bouton ne doit jamais envoyer un email vide', () => {
    assert.deepEqual(validerTemplate(''), { ok: false, raison: 'modele_vide' });
    assert.deepEqual(validerTemplate('   \n  '), { ok: false, raison: 'modele_vide' });
    assert.deepEqual(validerTemplate(null), { ok: false, raison: 'modele_vide' });
  });

  test('variable inconnue refusée dès l\'enregistrement (faute de frappe visible tout de suite)', () => {
    const r = validerTemplate('Bonjour {{salon_nam}}, voici {{preview_url}}');
    assert.equal(r.ok, false);
    assert.equal(r.raison, 'variable_inconnue');
    assert.deepEqual(r.inconnues, ['salon_nam']);
  });

  test('toutes les variables autorisées passent, y compris {{sender_name}}', () => {
    const r = validerTemplate('{{first_name}} {{salon_name}} {{city}} {{salon_slug}} {{preview_url}} {{preview_image_url}} {{admin_url}}\n{{sender_name}}');
    assert.equal(r.ok, true);
  });

  test('variablesDuTexte extrait sans doublon ; resteDesVariables détecte toute trace de {{ ou }}', () => {
    assert.deepEqual(variablesDuTexte('{{a}} {{b}} {{a}}'), ['a', 'b']);
    assert.equal(resteDesVariables('Bonjour {{salon_name}}'), true);
    assert.equal(resteDesVariables('Bonjour {{ salon_name }}'), true);
    assert.equal(resteDesVariables('accolades }} orphelines'), true);
    assert.equal(resteDesVariables('Bonjour Chez Lucie'), false);
  });

  test('variable MAL ÉCRITE refusée — le nœud ne la rendrait pas et elle partirait en clair', () => {
    // {{ first_name }} (espaces) et {{salon-name}} (tiret) ne matchent pas render_ ({{\w+}} exact)
    assert.equal(validerTemplate('Bonjour {{ first_name }}').raison, 'variable_inconnue');
    assert.equal(validerTemplate('Voici {{salon-name}}').raison, 'variable_inconnue');
    assert.deepEqual(validerTemplate('x {{ first_name }} y').inconnues, [' first_name ']);
  });

  test('accolades orphelines refusées', () => {
    assert.equal(validerTemplate('Bonjour {{first_name}} et }} reste').raison, 'accolades_orphelines');
    assert.equal(validerTemplate('Bonjour {{').raison, 'accolades_orphelines');
  });
});

// ---------- éligibilité ----------
const leadOk = { status: 'completed', current_step: 1, sends: 1, manual_followup_at: '' };
const engOk = { etat: 'activite_humaine', slug_partage: false };
const base = { lead: leadOk, engagement: engOk, desinscrit: false, salon: null, enregistre: true };
const elig = (patch) => verifierEligibilite({ ...base, ...patch });

describe('verifierEligibilite', () => {
  test('active (en attente du step vide) ET completed sont éligibles — pas de refus au seul motif du statut', () => {
    assert.equal(elig({}).ok, true);
    assert.equal(elig({ lead: { ...leadOk, status: 'active' } }).ok, true);
  });

  test('replied refusé', () => {
    assert.equal(elig({ lead: { ...leadOk, status: 'replied' } }).raison, 'repondu');
  });

  test('désinscrit refusé — statut nœud OU liste centrale', () => {
    assert.equal(elig({ lead: { ...leadOk, status: 'unsubscribed' } }).raison, 'desinscrit');
    assert.equal(elig({ desinscrit: true }).raison, 'desinscrit');
  });

  test('bounce/échec (failed) et stoppé (stop manuel / suppression / opposition) refusés', () => {
    assert.equal(elig({ lead: { ...leadOk, status: 'failed' } }).raison, 'echec_envoi');
    assert.equal(elig({ lead: { ...leadOk, status: 'stopped' } }).raison, 'stoppe');
  });

  test('step 1 non parti refusé (queued, step 0 ou aucun envoi réel)', () => {
    assert.equal(elig({ lead: { status: 'queued', current_step: 0, sends: 0 } }).raison, 'step1_non_envoye');
    assert.equal(elig({ lead: { status: 'active', current_step: 1, sends: 0 } }).raison, 'step1_non_envoye');
  });

  test('déjà relancé → deja:true (le bouton devient « Relance envoyée », pas une erreur)', () => {
    const r1 = elig({ lead: { ...leadOk, status: 'manual_followup' } });
    assert.equal(r1.raison, 'deja_relance'); assert.equal(r1.deja, true);
    const r2 = elig({ lead: { ...leadOk, manual_followup_at: '2026-08-28 10:00' } });
    assert.equal(r2.deja, true);
  });

  test('attribution impossible refusée : slug partagé, slug incohérent, hors portail', () => {
    assert.equal(elig({ engagement: { ...engOk, slug_partage: true } }).raison, 'slug_partage');
    assert.equal(elig({ engagement: { etat: 'slug_incoherent', slug_partage: false } }).raison, 'slug_incoherent');
    assert.equal(elig({ enregistre: false }).raison, 'hors_portail');
  });

  test('signal insuffisant refusé : ouverture isolée non confirmée, sans trace, sans engagement', () => {
    assert.equal(elig({ engagement: { etat: 'ouverture_non_confirmee', slug_partage: false } }).raison, 'activite_insuffisante');
    assert.equal(elig({ engagement: { etat: 'pas_de_trace', slug_partage: false } }).raison, 'activite_insuffisante');
    assert.equal(elig({ engagement: null }).raison, 'sans_engagement');
  });

  test('paiement/inscription existants refusés ; salon inconnu ou plan free acceptés', () => {
    assert.equal(elig({ salon: { stripe_subscription_id: 'sub_1' } }).raison, 'deja_client');
    assert.equal(elig({ salon: { signed_up_at: '2026-08-01' } }).raison, 'deja_client');
    assert.equal(elig({ salon: { plan: 'FLEX' } }).raison, 'deja_client');
    assert.equal(elig({ salon: { plan: 'free' } }).ok, true);
    assert.equal(elig({ salon: null }).ok, true);
  });

  test('lead introuvable sur le nœud refusé', () => {
    assert.equal(elig({ lead: null }).raison, 'lead_introuvable');
  });
});

// ---------- quota ----------
describe('verifierQuota (jour de Paris, par boîte)', () => {
  test('constantes du mode interim : 2 manuelles/jour, 10 au total', () => {
    assert.equal(MANUEL_MAX_PAR_JOUR, 2);
    assert.equal(TOTAL_MAX_PAR_JOUR, 10);
  });

  test('3e relance manuelle du jour refusée', () => {
    assert.equal(verifierQuota({ manuelAujourdhui: 1, autoAujourdhui: 0 }).ok, true);
    assert.equal(verifierQuota({ manuelAujourdhui: 2, autoAujourdhui: 0 }).raison, 'quota_manuel_atteint');
  });

  test('auto + manuel plafonné à 10 : 9+1 refusé, 8+1 accepté', () => {
    assert.equal(verifierQuota({ manuelAujourdhui: 1, autoAujourdhui: 9 }).raison, 'quota_total_atteint');
    assert.equal(verifierQuota({ manuelAujourdhui: 1, autoAujourdhui: 8 }).ok, true);
  });
});

// ---------- timeline ----------
describe('timeline : la relance manuelle est un événement DISTINCT, jamais un step', () => {
  test('manual_followup_at → item type relance, horodaté Paris, après l\'envoi', () => {
    const lead = { email: 'x@y.fr', salon_slug: 's', status: 'manual_followup', current_step: 1,
      first_sent_at: '2026-08-27 10:00', last_sent_at: '2026-08-27 10:00', sends: 1,
      manual_followup_at: '2026-08-28 09:30', mailbox: 'cedric@getquickpage.fr' };
    const tl = construireTimeline({ lead, events: [] });
    const types = tl.items.map(i => i.type);
    assert.deepEqual(types, ['envoi', 'relance']);
    const rel = tl.items[1];
    assert.equal(rel.t_paris, '2026-08-28 09:30');
    assert.equal(rel.mailbox, 'cedric@getquickpage.fr');
    assert.equal(rel.offset_min, (23 * 60) + 30);
    assert.equal(types.filter(t2 => t2 === 'envoi').length, 1, 'la relance ne devient pas un 2e envoi de step');
  });

  test('sans manual_followup_at, aucune relance n\'apparaît (pas d\'inférence)', () => {
    const lead = { email: 'x@y.fr', salon_slug: 's', status: 'active', current_step: 1,
      first_sent_at: '2026-08-27 10:00', last_sent_at: '2026-08-27 10:00', sends: 1 };
    const tl = construireTimeline({ lead, events: [] });
    assert.equal(tl.items.some(i => i.type === 'relance'), false);
  });

  test('relance puis réponse détectée : les deux figurent, la réponse reste l\'issue', () => {
    const lead = { email: 'x@y.fr', salon_slug: 's', status: 'replied', current_step: 1,
      first_sent_at: '2026-08-27 10:00', last_sent_at: '2026-08-27 10:00', sends: 1,
      manual_followup_at: '2026-08-28 09:30', last_activity_at: '2026-08-28 11:00' };
    const tl = construireTimeline({ lead, events: [] });
    assert.deepEqual(tl.items.map(i => i.type), ['envoi', 'relance', 'reponse']);
    assert.equal(tl.statut, 'replied');
  });
});

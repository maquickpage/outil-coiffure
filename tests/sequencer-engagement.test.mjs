import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parisToEpoch, utcToEpoch, epochToParis, etatDepuisEvents, calculerEngagement } from '../src/sequencer-engagement.js';

// ---------- G5 / G9 : fuseaux ----------
test('parisToEpoch et utcToEpoch se rejoignent — été (UTC+2) ET hiver (UTC+1)', () => {
  // été : 14 août 2026 16:55 Paris = 14:55 UTC
  assert.equal(parisToEpoch('2026-08-14 16:55'), utcToEpoch('2026-08-14 14:55:00'));
  // hiver : 10 déc 2026 09:04 Paris = 08:04 UTC  (un offset fixe +7200 s se tromperait ici)
  assert.equal(parisToEpoch('2026-12-10 09:04'), utcToEpoch('2026-12-10 08:04:00'));
  // aller-retour d'affichage
  assert.equal(epochToParis(utcToEpoch('2026-08-14 16:54:46')), '2026-08-14 18:54');
  assert.equal(epochToParis(utcToEpoch('2026-12-10 08:04:00')), '2026-12-10 09:04');
});

test('changement d heure 2026-10-25 : de part et d autre de la bascule', () => {
  // 25 oct 2026 : à 03:00 Paris on revient à 02:00 (UTC+2 → UTC+1)
  assert.equal(parisToEpoch('2026-10-25 01:30'), utcToEpoch('2026-10-24 23:30:00')); // encore UTC+2
  assert.equal(parisToEpoch('2026-10-25 04:00'), utcToEpoch('2026-10-25 03:00:00')); // déjà UTC+1
  // le lendemain, tout est en UTC+1
  assert.equal(parisToEpoch('2026-10-26 09:00'), utcToEpoch('2026-10-26 08:00:00'));
});

test('entrées invalides → null, jamais une date fantaisiste', () => {
  assert.equal(parisToEpoch(''), null);
  assert.equal(parisToEpoch(undefined), null);
  assert.equal(utcToEpoch('n/a'), null);
  assert.equal(epochToParis(null), '');
});

// ---------- vocabulaire ----------
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)';
test('un preview_ouvert isolé = ouverture_non_confirmee ; prix vu ou 2 passages = activite_humaine', () => {
  assert.equal(etatDepuisEvents([]), 'pas_de_trace');
  assert.equal(etatDepuisEvents([{ event: 'preview_ouvert' }]), 'ouverture_non_confirmee');
  assert.equal(etatDepuisEvents([{ event: 'preview_ouvert' }, { event: 'preview_ouvert' }]), 'activite_humaine');
  assert.equal(etatDepuisEvents([{ event: 'preview_ouvert' }, { event: 'paywall_peek_viewed' }]), 'activite_humaine');
  assert.equal(etatDepuisEvents([{ event: 'scroll_max' }]), 'activite_humaine');
});

// ---------- G1 / G3 / G4 sur un cas réel (a-martins, 14 août) ----------
const REG = [{ email: 'contact@adelinemartins.fr', salon_slug: 'clermont-ferrand-a-martins-coiffure-energetique' },
             { email: 'contact@chezmc.fr', salon_slug: 'vichy-chez-mc' },
             { email: 'dup1@x.fr', salon_slug: 'shared-salon' }, { email: 'dup2@x.fr', salon_slug: 'shared-salon' }];
const LEADS = [
  { email: 'contact@adelinemartins.fr', salon_slug: 'clermont-ferrand-a-martins-coiffure-energetique', status: 'stopped', current_step: 1, first_sent_at: '2026-08-14 16:55', last_sent_at: '2026-08-14 16:55' },
  { email: 'contact@chezmc.fr', salon_slug: 'vichy-chez-mc', status: 'active', current_step: 1, first_sent_at: '2026-08-15 09:05', last_sent_at: '2026-08-15 09:05' },
  { email: 'dup1@x.fr', salon_slug: 'shared-salon', status: 'active', current_step: 1, first_sent_at: '2026-08-15 09:10' },
  { email: 'dup2@x.fr', salon_slug: 'shared-salon', status: 'active', current_step: 1, first_sent_at: '2026-08-15 09:12' },
  { email: 'ghost@x.fr', salon_slug: 'ghost', status: 'active', current_step: 1, first_sent_at: '' },   // G4 : envoyé mais sans horodatage
  { email: 'queued@x.fr', salon_slug: 'q', status: 'queued', current_step: 0, first_sent_at: '' },
  { email: 'outsider@x.fr', salon_slug: 'out', status: 'active', current_step: 1, first_sent_at: '2026-08-15 09:20' }, // pas dans le registre
];
const EVENTS = [
  // AVANT l'envoi (prépa photos) → doit être ignoré (G1)
  { slug: 'clermont-ferrand-a-martins-coiffure-energetique', event: 'preview_ouvert', ts: '2026-08-13 10:00:00', user_agent: 'Mozilla Chrome' },
  // après : ouverture 17:32 Paris = 15:32 UTC, paywall, scroll
  { slug: 'clermont-ferrand-a-martins-coiffure-energetique', event: 'preview_ouvert',      ts: '2026-08-14 15:32:57', user_agent: UA_IPHONE },
  { slug: 'clermont-ferrand-a-martins-coiffure-energetique', event: 'paywall_peek_viewed', ts: '2026-08-14 15:33:09', user_agent: UA_IPHONE },
  { slug: 'clermont-ferrand-a-martins-coiffure-energetique', event: 'scroll_max',          ts: '2026-08-14 15:33:37', user_agent: UA_IPHONE },
  // chez-mc : une seule ouverture nue après l'envoi
  { slug: 'vichy-chez-mc', event: 'preview_ouvert', ts: '2026-08-15 08:00:00', user_agent: 'Mozilla Chrome' },
  // shared-salon : une visite → ne doit compter qu'UN slug dans l'entonnoir
  { slug: 'shared-salon', event: 'preview_ouvert', ts: '2026-08-15 08:30:00', user_agent: UA_IPHONE },
  { slug: 'shared-salon', event: 'scroll_max',     ts: '2026-08-15 08:31:00', user_agent: UA_IPHONE },
];

test('a-martins : events pré-envoi ignorés, activité réelle 37 min après l envoi, sur mobile', () => {
  const r = calculerEngagement({ leads: LEADS, events: EVENTS, registre: REG, nowMs: utcToEpoch('2026-08-17 12:00:00') });
  const a = r.par_email['contact@adelinemartins.fr'];
  assert.equal(a.etat, 'activite_humaine');
  assert.equal(a.activite.ouvertures, 1, 'l ouverture du 13/08 (avant envoi) ne compte pas');
  assert.equal(a.activite.prix_vu, 1);
  assert.equal(a.activite.delai_premier_min, 37);
  assert.equal(a.activite.appareil, 'mobile');
  assert.equal(a.first_sent_at, '2026-08-14 16:55');
});

test('chez-mc : une seule ouverture nue → ouverture_non_confirmee', () => {
  const r = calculerEngagement({ leads: LEADS, events: EVENTS, registre: REG });
  assert.equal(r.par_email['contact@chezmc.fr'].etat, 'ouverture_non_confirmee');
});

test('G3 : slug partagé compte pour UN dans l entonnoir et est signalé sur chaque ligne', () => {
  const r = calculerEngagement({ leads: LEADS, events: EVENTS, registre: REG });
  assert.equal(r.par_email['dup1@x.fr'].slug_partage, true);
  assert.equal(r.par_email['dup2@x.fr'].slug_partage, true);
  // contactés = a-martins, chez-mc, shared-salon (1), outsider = 4 slugs ; ouverts = a-martins, chez-mc, shared = 3 ; prix vu = a-martins = 1
  assert.equal(r.funnel.contactes, 4);
  assert.equal(r.funnel.ouvert, 3);
  assert.equal(r.funnel.prix_vu, 1);
});

test('G4 : envoyé sans horodatage = inconnu (pas dans contactés, pas « jamais envoyé ») ; en file = rien', () => {
  const r = calculerEngagement({ leads: LEADS, events: EVENTS, registre: REG });
  assert.equal(r.funnel.inconnu, 1);
  assert.equal(r.par_email['ghost@x.fr'].etat, 'pas_de_trace');
  assert.equal(r.par_email['queued@x.fr'], undefined);
});

test('hors_portail et slug_incoherent sont comptés', () => {
  const reg = REG.concat([{ email: 'contact@chezmc.fr', salon_slug: 'WRONG' }]); // dernier gagne dans la Map → incohérent
  const r = calculerEngagement({ leads: LEADS, events: EVENTS, registre: reg });
  assert.equal(r.hors_portail, 3, 'ghost + queued + outsider'); // en file ou non : un lead absent du registre est un import hors portail
  assert.equal(r.slug_incoherent, 1);
  assert.equal(r.par_email['contact@chezmc.fr'].etat, 'slug_incoherent');
});

test('silence = completed + 3 jours sans activité ; avant, en_cours', () => {
  const leads = [
    { email: 'a@x.fr', salon_slug: 'a', status: 'completed', current_step: 5, first_sent_at: '2026-08-01 09:00', last_sent_at: '2026-08-10 09:00' },
    { email: 'b@x.fr', salon_slug: 'b', status: 'completed', current_step: 5, first_sent_at: '2026-08-01 09:00', last_sent_at: '2026-08-16 09:00' },
  ];
  const reg = [{ email: 'a@x.fr', salon_slug: 'a' }, { email: 'b@x.fr', salon_slug: 'b' }];
  const r = calculerEngagement({ leads, events: [], registre: reg, nowMs: parisToEpoch('2026-08-17 12:00') });
  assert.equal(r.outcomes.silence, 1);
  assert.equal(r.outcomes.en_cours, 1);
});

test('désinscrit vient de la liste centrale : un opt-out historique resté `stopped` sur le nœud est compté désinscrit, pas « arrêté par nous »', () => {
  const leads = [
    { email: 'old@x.fr', salon_slug: 'old', status: 'stopped', current_step: 1, first_sent_at: '2026-08-14 16:55' },
    { email: 'seed@x.fr', salon_slug: 'seed', status: 'stopped', current_step: 1, first_sent_at: '2026-08-03 16:47' },
  ];
  const reg = [{ email: 'old@x.fr', salon_slug: 'old' }, { email: 'seed@x.fr', salon_slug: 'seed' }];
  const r = calculerEngagement({ leads, events: [], registre: reg, desinscrits: ['OLD@x.fr'] });
  assert.equal(r.par_email['old@x.fr'].issue, 'desinscrit');
  assert.equal(r.par_email['seed@x.fr'].issue, 'stoppe');
  assert.equal(r.outcomes.desinscrit, 1);
});

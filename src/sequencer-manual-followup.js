// Relance manuelle (V1) — règles PURES (aucun accès DB, aucun fetch), pour que chaque
// refus soit testable unitairement, comme sequencer-engagement.js.
//
// Le principe : le bouton « Envoyer la relance » du portail ne fait confiance à RIEN
// de ce que le navigateur envoie (ni boîte, ni destinataire, ni thread). Le portail
// recharge l'état réel du lead et applique ces règles ; le nœud Apps Script refait
// ses propres contrôles (thread, réponse fraîche, quota) au moment de l'envoi.
// Sémantique : ce n'est PAS le Step 2 automatique — un seul modèle central, un seul
// envoi par lead, statut dédié `manual_followup` côté nœud.

// Variables que le nœud sait résoudre depuis sa feuille leads, plus {{sender_name}}
// résolu côté portail (même mécanisme que la séquence : sequencer-signature.js).
export const VARIABLES_AUTORISEES = new Set(['first_name', 'salon_name', 'city',
  'salon_slug', 'preview_url', 'preview_image_url', 'admin_url', 'sender_name']);

export const MANUEL_MAX_PAR_JOUR = 2;    // relances manuelles par boîte et par jour
export const TOTAL_MAX_PAR_JOUR = 10;    // automatique + manuel, par boîte et par jour

/**
 * Tout ce qui ressemble à un placeholder {{...}}, y compris les formes mal écrites
 * ({{ first_name }}, {{salon-name}}) que le nœud ne rendrait PAS (render_ ne remplace
 * que {{\w+}} exact) et qui partiraient donc en clair chez le prospect. Le contenu est
 * renvoyé BRUT, sans trim : `{{ first_name }}` doit être signalé, pas normalisé.
 */
export function variablesDuTexte(texte) {
  const vues = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let m;
  while ((m = re.exec(String(texte || ''))) !== null) if (!vues.includes(m[1])) vues.push(m[1]);
  return vues;
}

/**
 * Modèle utilisable ? Refusé si : vide ; variable inconnue OU mal formée (espaces,
 * tiret…) ; accolades {{ / }} orphelines. Tout refus ici évite un `{{...}}` littéral
 * dans l'email du prospect.
 * @returns {{ok: boolean, raison?: string, inconnues?: string[]}}
 */
export function validerTemplate(texte) {
  const s = String(texte || '');
  if (!s.trim()) return { ok: false, raison: 'modele_vide' };
  // Seul {{mot}} exact est rendu par le nœud : toute autre forme est « inconnue ».
  const inconnues = variablesDuTexte(s).filter(v => !(/^\w+$/.test(v) && VARIABLES_AUTORISEES.has(v)));
  if (inconnues.length) return { ok: false, raison: 'variable_inconnue', inconnues };
  // Accolades doubles restantes une fois les tokens bien formés retirés ({{x, x}}…).
  if (/\{\{|\}\}/.test(s.replace(/\{\{[^{}]*\}\}/g, ''))) return { ok: false, raison: 'accolades_orphelines' };
  return { ok: true };
}

/**
 * Éligibilité d'UN lead, à partir de l'état réel rechargé par le portail.
 * Retourne le PREMIER motif de refus (l'opérateur n'a besoin que d'une raison claire).
 *
 * @param {object} p
 * @param {object|null} p.lead        lead du nœud (status, current_step, sends, manual_followup_at)
 * @param {object|null} p.engagement  entrée par_email de calculerEngagement (etat, slug_partage, hors_portail)
 * @param {boolean} p.desinscrit      présent dans la liste centrale sequencer_unsubscribes
 * @param {object|null} p.salon       ligne salons du slug (stripe_subscription_id, signed_up_at, plan)
 * @param {boolean} p.enregistre      présent dans sequencer_leads (attribution portail)
 * @returns {{ok: boolean, raison?: string, deja?: boolean}}
 */
export function verifierEligibilite({ lead, engagement, desinscrit, salon, enregistre }) {
  if (!lead) return { ok: false, raison: 'lead_introuvable' };
  const st = String(lead.status || '');
  // Déjà relancé : pas une erreur, un état — le bouton devient « Relance envoyée ».
  if (st === 'manual_followup' || lead.manual_followup_at) return { ok: false, raison: 'deja_relance', deja: true };
  if (desinscrit || st === 'unsubscribed') return { ok: false, raison: 'desinscrit' };
  if (st === 'replied') return { ok: false, raison: 'repondu' };
  if (st === 'failed') return { ok: false, raison: 'echec_envoi' };          // bounce / erreur d'envoi
  if (st === 'stopped') return { ok: false, raison: 'stoppe' };              // stop manuel, opposition ou suppression
  // Step 1 doit être PARTI (active en attente de step vide, ou completed, sont éligibles).
  if (!(Number(lead.current_step) >= 1) || !(Number(lead.sends) >= 1)) return { ok: false, raison: 'step1_non_envoye' };
  if (st !== 'active' && st !== 'completed') return { ok: false, raison: 'statut_' + (st || 'inconnu') };
  // Attribution : sans registre portail ou avec un slug partagé, l'activité observée
  // ne peut pas être attribuée à CE destinataire — pas de relance « vous avez visité ».
  if (!enregistre) return { ok: false, raison: 'hors_portail' };
  if (!engagement) return { ok: false, raison: 'sans_engagement' };
  if (engagement.slug_partage) return { ok: false, raison: 'slug_partage' };
  if (engagement.etat === 'slug_incoherent') return { ok: false, raison: 'slug_incoherent' };
  // Signal requis : prix vu ou activité humaine confirmée. Une ouverture isolée non
  // confirmée (scanners de messagerie) ne suffit pas.
  if (engagement.etat !== 'activite_humaine') return { ok: false, raison: 'activite_insuffisante' };
  // Déjà client / paiement engagé : plus une cible de relance commerciale.
  if (salon && (salon.stripe_subscription_id || salon.signed_up_at
      || (salon.plan && salon.plan !== 'free'))) return { ok: false, raison: 'deja_client' };
  return { ok: true };
}

/**
 * Quota par boîte (jour de Paris, même calendrier que les compteurs du nœud).
 * NB : ne couvre que ce que le système compte — les envois Gmail faits à la main et
 * sendTest n'entrent pas dans ces compteurs (limite connue, affichée dans l'UI).
 * @returns {{ok: boolean, raison?: string}}
 */
export function verifierQuota({ manuelAujourdhui, autoAujourdhui }) {
  if (Number(manuelAujourdhui) >= MANUEL_MAX_PAR_JOUR) return { ok: false, raison: 'quota_manuel_atteint' };
  if (Number(autoAujourdhui) + Number(manuelAujourdhui) >= TOTAL_MAX_PAR_JOUR) return { ok: false, raison: 'quota_total_atteint' };
  return { ok: true };
}

/** Après résolution des variables, AUCUNE trace de {{ ou }} ne doit rester. */
export function resteDesVariables(texte) {
  return /\{\{|\}\}/.test(String(texte || ''));
}

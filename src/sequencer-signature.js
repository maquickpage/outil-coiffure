/**
 * Signature dynamique de la séquence cold-email.
 *
 * Chaque boîte d'envoi écrit sous son propre prénom (Sophie, Camille, Cédric, Solène),
 * mais l'opérateur doit continuer à rédiger UN seul modèle. Le placeholder
 * {{sender_name}} n'est pas connu du nœud Apps Script — qui ne résout que les variables
 * du lead — il est donc traité ici :
 *   - à l'aller  : résolu avec le prénom du nœud destinataire (chaque nœud reçoit son texte) ;
 *   - au retour  : re-neutralisé, pour que l'admin relise le modèle commun et non quatre
 *                  variantes qui déclencheraient à tort l'alerte « les nœuds divergent ».
 */

export const SENDER_TAG = '{{sender_name}}';

/** Prénom de la boîte : premier mot du libellé du nœud, à défaut la partie locale de l'adresse. */
export function prenomNoeud(node) {
  const brut = (node && node.label || '').trim().split(/\s+/)[0]
            || (node && node.mailbox || '').split('@')[0];
  return brut ? brut.charAt(0).toUpperCase() + brut.slice(1) : '';
}

function echapper(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** {{sender_name}} → prénom du nœud. */
export function resoudreSignature(steps, node) {
  const prenom = prenomNoeud(node);
  if (!prenom || !Array.isArray(steps)) return steps;
  const remplace = s => String(s == null ? '' : s).split(SENDER_TAG).join(prenom);
  return steps.map(st => ({ ...st, subject: remplace(st.subject), body: remplace(st.body) }));
}

/**
 * Prénom du nœud → {{sender_name}}, mais UNIQUEMENT quand il est seul sur sa ligne,
 * c'est-à-dire en position de signature. Sans cette restriction, un prénom cité dans le
 * corps du texte (« notre cliente Sophie ») deviendrait un placeholder, et se
 * transformerait en « Camille » ou « Cédric » à la sauvegarde suivante.
 */
export function neutraliserSignature(steps, node) {
  const prenom = prenomNoeud(node);
  if (!prenom || !Array.isArray(steps)) return steps;
  const re = new RegExp('^[ \\t]*' + echapper(prenom) + '[ \\t]*$', 'gmu');
  const neutre = s => String(s == null ? '' : s).replace(re, SENDER_TAG);
  return steps.map(st => ({ ...st, subject: neutre(st.subject), body: neutre(st.body) }));
}

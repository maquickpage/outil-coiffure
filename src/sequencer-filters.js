// Filtres appliqués AVANT d'envoyer un lot de leads aux nœuds du séquenceur.
//
// Pourquoi ici et pas dans le nœud : un nœud Apps Script ne voit que sa propre
// boîte. Il sait refuser un doublon chez lui, il ne peut pas savoir qu'une adresse
// est déjà séquencée par une autre boîte, ni qu'elle s'est désinscrite via un lien
// reçu d'un autre expéditeur. Ces deux contrôles n'ont de sens qu'au niveau portail.
//
// Fonctions pures, sans accès base ni réseau, pour être testables directement.

export const COLONNES_IMPORT = ['email', 'first_name', 'salon_name', 'city', 'salon_slug',
  'preview_url', 'preview_image_url', 'admin_url', 'mailbox'];

export function normaliserEmail(valeur) {
  return String(valeur == null ? '' : valeur).trim().toLowerCase();
}

/**
 * Valide un lot et écarte ce qui ne doit jamais partir.
 *
 * @param {object[]} lignes        lignes du CSV, clés en minuscules
 * @param {Set<string>} desinscrits emails désinscrits (déjà normalisés)
 * @param {Set<string>} dejaConfies emails déjà dispatchés vers un nœud
 * @returns {{retenus: object[], erreurs: string[], ecartes: {desinscrits: string[], deja_confies: string[]}}}
 *
 * Distinction volontaire entre « erreurs » et « écartés » :
 *   - une erreur = fichier mal formé, l'opérateur doit le corriger, donc on refuse tout ;
 *   - un écarté  = ligne valide mais qu'on ne DOIT pas envoyer, c'est un résultat
 *     normal qu'on rapporte sans bloquer l'import du reste.
 */
export function filtrerLot(lignes, desinscrits = new Set(), dejaConfies = new Set()) {
  const erreurs = [];
  const retenus = [];
  const ecartes = { desinscrits: [], deja_confies: [] };
  const vusDansLeFichier = new Set();

  lignes.forEach((ligne, index) => {
    const numero = index + 2; // +1 en-tête, +1 pour compter à partir de 1
    const email = normaliserEmail(ligne.email);
    const slug = String(ligne.salon_slug || '').trim();

    if (!email || !email.includes('@')) { erreurs.push(`ligne ${numero}: email vide/invalide`); return; }
    if (vusDansLeFichier.has(email)) { erreurs.push(`ligne ${numero}: email en double dans le fichier (${email})`); return; }
    if (!slug) { erreurs.push(`ligne ${numero}: salon_slug vide`); return; }
    vusDansLeFichier.add(email);

    // L'ordre compte : la désinscription prime sur tout le reste.
    if (desinscrits.has(email)) { ecartes.desinscrits.push(email); return; }
    if (dejaConfies.has(email)) { ecartes.deja_confies.push(email); return; }

    retenus.push({ ...ligne, email });
  });

  return { retenus, erreurs, ecartes };
}

/** Répartit les lignes retenues sur les nœuds, une par une, et force la boîte d'envoi. */
export function repartir(lignes, nodes) {
  const paniers = nodes.map(() => []);
  lignes.forEach((ligne, index) => {
    const cible = index % nodes.length;
    paniers[cible].push(COLONNES_IMPORT.map(colonne =>
      colonne === 'mailbox' ? nodes[cible].mailbox : String(ligne[colonne] || '')));
  });
  return paniers;
}

/**
 * Un renvoi après une réponse perdue fait répondre au nœud « already imported »
 * sur TOUTES les lignes. Ce n'est pas un échec : le premier envoi avait abouti.
 * Sans ce test, l'opérateur croit l'import raté et le relance en boucle.
 */
export function estUnRejeuIdentique(reponse, lignesEnvoyees) {
  if (!reponse || reponse.ok !== false || typeof reponse.error !== 'string') return false;
  const dejaImporte = (reponse.error.match(/already imported/gi) || []).length;
  return dejaImporte > 0 && dejaImporte >= lignesEnvoyees;
}

/** Erreurs de transport : ça vaut le coup de réessayer. Une réponse métier, non. */
export function meriteUneRelance(resultat) {
  if (!resultat) return true;
  if (resultat.__transport) return true;   // exception fetch, timeout, réponse non-JSON
  return false;
}

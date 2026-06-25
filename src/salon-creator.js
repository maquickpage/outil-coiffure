// Création d'un salon « à l'unité » (hors import CSV).
// Réutilise EXACTEMENT le même schéma d'insertion que csv-importer.js, plus la
// colonne google_id (dédiée). Déclenche la capture d'écran comme les autres flux.
import db from './db.js';
import { generateSlug } from './slug-generator.js';
import { generateEditToken } from './token-generator.js';
import { captureSalon } from './screenshot-worker.js';

const insertSalon = db.prepare(`
  INSERT INTO salons (
    slug, nom, nom_clean, ville, code_postal, adresse, telephone, email,
    latitude, longitude, types, note_avis, nb_avis, heures_ouverture,
    lien_facebook, lien_instagram, lien_tiktok, lien_youtube, lien_google_maps,
    meta_image, titre_site, meta_description, site_internet_original,
    google_id, data_json, csv_source, edit_token, group_id
  ) VALUES (
    @slug, @nom, @nom, @ville, @code_postal, @adresse, @telephone, @email,
    @latitude, @longitude, @types, @note_avis, @nb_avis, @heures_ouverture,
    @lien_facebook, @lien_instagram, @lien_tiktok, @lien_youtube, @lien_google_maps,
    @meta_image, @titre_site, @meta_description, @site_internet_original,
    @google_id, @data_json, @csv_source, @edit_token, @group_id
  )
`);

/**
 * Crée un salon en base et lance sa capture d'écran (fire-and-forget).
 * @param {Object} data  champs salon (seul `nom` est obligatoire)
 * @param {Object} opts  { csvSource='manuel', groupId=null }
 * @returns {{ id:number, slug:string, edit_token:string }}
 */
export function createSalon(data, { csvSource = 'manuel', groupId = null } = {}) {
  if (!data || !data.nom) throw new Error('Le nom du salon est requis');
  const slug = generateSlug(data.nom, data.ville || '');
  const edit_token = generateEditToken();
  const row = {
    slug,
    nom: data.nom,
    ville: data.ville || null,
    code_postal: data.code_postal || null,
    adresse: data.adresse || null,
    telephone: data.telephone || null,
    email: data.email || null,
    latitude: data.latitude != null ? data.latitude : null,
    longitude: data.longitude != null ? data.longitude : null,
    types: data.types || null,
    note_avis: data.note_avis != null ? data.note_avis : null,
    nb_avis: data.nb_avis != null ? String(data.nb_avis) : null,
    heures_ouverture: data.heures_ouverture ? JSON.stringify(data.heures_ouverture) : null,
    lien_facebook: data.lien_facebook || null,
    lien_instagram: data.lien_instagram || null,
    lien_tiktok: data.lien_tiktok || null,
    lien_youtube: data.lien_youtube || null,
    lien_google_maps: data.lien_google_maps || null,
    meta_image: data.meta_image || null,
    titre_site: data.titre_site || null,
    meta_description: data.meta_description || null,
    site_internet_original: data.site_internet_original || null,
    google_id: data.google_id || null,
    data_json: JSON.stringify({ ...data, source: csvSource, created_manually: true, created_at: new Date().toISOString() }),
    csv_source: csvSource,
    edit_token,
    group_id: groupId,
  };
  const info = insertSalon.run(row);
  captureSalon(slug).catch((e) => console.warn(`[salon-creator] screenshot ${slug} fail: ${e.message}`));
  return { id: Number(info.lastInsertRowid), slug, edit_token };
}

/**
 * Mappe un résultat Google Places (Place Details New) vers le format `data` de createSalon.
 */
export function mapPlaceToSalonData(place) {
  const comps = place.addressComponents || [];
  const comp = (type) => {
    const c = comps.find((x) => (x.types || []).includes(type));
    return c ? (c.longText || c.shortText) : null;
  };
  const streetNo = comp('street_number');
  const route = comp('route');
  const adresse = (streetNo && route)
    ? `${streetNo} ${route}`
    : (route || place.shortFormattedAddress || place.formattedAddress || null);
  return {
    nom: (place.displayName && place.displayName.text) || null,
    ville: comp('locality') || comp('postal_town') || comp('administrative_area_level_2') || null,
    code_postal: comp('postal_code') || null,
    adresse,
    telephone: place.internationalPhoneNumber || place.nationalPhoneNumber || null,
    latitude: place.location ? place.location.latitude : null,
    longitude: place.location ? place.location.longitude : null,
    note_avis: place.rating != null ? place.rating : null,
    nb_avis: place.userRatingCount != null ? place.userRatingCount : null,
    types: (place.primaryTypeDisplayName && place.primaryTypeDisplayName.text) || (place.types || [])[0] || 'Salon de coiffure',
    lien_google_maps: place.googleMapsUri || null,
    site_internet_original: place.websiteUri || null,
    meta_description: (place.editorialSummary && place.editorialSummary.text) || null,
    google_id: place.id || null,
  };
}

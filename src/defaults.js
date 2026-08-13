// Valeurs par defaut + services standards de coiffure
// Tout est ecrasable par les overrides du coiffeur

import { DEFAULT_TEMPLATE_ID } from './templates.js';

// Galerie par défaut : 9 images triées pour rester homogène en mode "grid"
// (vignettes carrées, défaut). L'alternance portrait/paysage et les 3 portraits
// "humains" (barbier, mariage, couleur argent) en positions accrocheuses
// (1, 3, 5) créent une connexion émotionnelle plus forte que les images de
// produits/textures, et ce choix marche aussi bien en mode "masonry" (Pinterest)
// si le coiffeur l'active dans l'admin.
//   1. coiffeur-homme    (portrait, barbier homme)
//   2. unsplash landscape
//   3. cheveux-argentes  (portrait, couleur argent/violet)
//   4. unsplash landscape
//   5. mariage-chignon   (portrait, mariage)
//   6. unsplash landscape
//   7. unsplash portrait
//   8. unsplash landscape
//   9. unsplash portrait
export const DEFAULT_GALLERY_IMAGES = [
  '/_assets/gallery-defaults/coiffeur-homme.jpg',
  'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=800&q=80',
  '/_assets/gallery-defaults/cheveux-argentes.jpg',
  'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=800&q=80',
  '/_assets/gallery-defaults/mariage-chignon.jpg',
  'https://images.unsplash.com/photo-1634449571010-02389ed0f9b0?w=800&q=80',
  'https://images.unsplash.com/photo-1605497788044-5a32c7078486?w=800&q=80',
  'https://images.unsplash.com/photo-1562322140-8baeececf3df?w=800&q=80',
  'https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?w=800&q=80'
];

export const DEFAULT_HERO_IMAGE = 'https://images.unsplash.com/photo-1633381521050-26bb467d9d5a?w=1920&q=80';

// Catégories de services : 'femme' | 'homme' | 'autres'.
// Affichées sur mobile en carrousel (1 slide par catégorie, liste dedans) ;
// éditables service par service dans l'admin coiffeur.
export const SERVICE_CATEGORIES = ['femme', 'homme', 'autres'];

export const DEFAULT_SERVICES = [
  { id: 's1', name: 'Coupe Femme', description: 'Coupe personnalisee femme : shampoing, coupe, finition.', price: '35€', category: 'femme' },
  { id: 's2', name: 'Coupe Homme', description: 'Coupe homme classique ou tendance, finition incluse.', price: '22€', category: 'homme' },
  { id: 's3', name: 'Coupe Enfant', description: 'Coupe enfant (jusqu\'a 12 ans).', price: '18€', category: 'autres' },
  { id: 's4', name: 'Shampoing & Brushing', description: 'Lavage, soin et mise en forme.', price: '25€', category: 'femme' },
  { id: 's5', name: 'Brushing seul', description: 'Mise en forme cheveux propres.', price: '20€', category: 'femme' },
  { id: 's6', name: 'Coloration', description: 'Coloration couvrante, ton sur ton ou couleur d\'envie.', price: '55€', category: 'femme' },
  { id: 's7', name: 'Meches / Balayage', description: 'Eclaircissement sur mesure pour donner du relief.', price: '75€', category: 'femme' },
  { id: 's8', name: 'Soin profond', description: 'Soin reparateur et hydratant en profondeur.', price: '30€', category: 'autres' },
  { id: 's9', name: 'Coiffure Mariage', description: 'Coiffure d\'exception pour le jour J (essai inclus).', price: '90€', category: 'autres' },
  { id: 's10', name: 'Lissage', description: 'Lissage professionnel pour cheveux soyeux et disciplines.', price: '80€', category: 'femme' }
];

export const DEFAULT_TESTIMONIALS = [
  { id: 't1', text: 'Une experience top du debut a la fin. L\'equipe est aux petits soins, l\'ecoute est reelle et le resultat sublime ! Je recommande sans hesiter.', author: 'Marie L.', date: 'Il y a quelques semaines' },
  { id: 't2', text: 'Je n\'avais jamais ete aussi satisfaite d\'un salon. Coupe parfaite, ambiance chaleureuse et conseils personnalises. C\'est devenu mon adresse !', author: 'Sophie D.', date: 'Il y a 1 mois' },
  { id: 't3', text: 'Accueil au top, professionnalisme exemplaire et tarifs honnetes. Mes cheveux n\'ont jamais ete aussi beaux. Merci a toute l\'equipe pour ce moment !', author: 'Julie M.', date: 'Il y a quelques jours' }
];

export const DEFAULT_INTRO_FALLBACK = 'Une equipe passionnee a votre ecoute pour des prestations de qualite, dans une ambiance conviviale.';

// Horaires standards d'un salon de coiffure (utilises quand le scrap n'a pas
// d'info, ou quand le scrap dit "closed" pour un jour). Le coiffeur peut
// toujours forcer "closed" via l'admin (override) - on respecte ses overrides.
// Décision business : pas de "Fermé" affiche par défaut, on suppose que tous
// les jours sont ouverts pour rendre la fiche attractive.
export const DEFAULT_HOURS = {
  monday:    '9h - 19h',
  tuesday:   '9h - 19h',
  wednesday: '9h - 19h',
  thursday:  '9h - 19h',
  friday:    '9h - 19h',
  saturday:  '9h - 18h',
  sunday:    '10h - 16h'
};

// Merge horaires : override coiffeur > scrap (sauf 'closed' qui est remplace) > defaults.
// `scraped` = objet { monday: "9-am-7-pm" | "closed" | null, ... }
// Retourne un objet du même format avec, pour chaque jour, soit l'horaire scrappé
// (s'il est valide et != "closed"), soit la valeur DEFAULT_HOURS.
export function mergeHoursWithDefaults(scraped) {
  const out = { ...DEFAULT_HOURS };
  if (!scraped || typeof scraped !== 'object') return out;
  for (const day of Object.keys(DEFAULT_HOURS)) {
    const v = scraped[day];
    if (v && v !== 'closed' && v !== null) {
      out[day] = v;
    }
    // Sinon on garde le default (déjà mis dans `out` via spread)
  }
  return out;
}

// Detecte automatiquement une URL de reservation en ligne specifique au salon
// dans les colonnes du CSV (Planity, Booksy, Reservio, Cituro, Settime, Treatwell)
export function detectBookingUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname || '/';

  // Sous-domaine sur une plateforme (toujours specifique au salon)
  const subdomainPlatforms = ['booksy.com', 'site-solocal.com'];
  for (const p of subdomainPlatforms) {
    if (host.endsWith('.' + p) && host !== p) return rawUrl;
  }

  // Plateforme racine + path significatif (= page specifique du salon)
  const rootPlatforms = [
    'planity.com', 'reservio.com', 'cituro.com',
    'settime.io', 'book.settime.io', 'app.cituro.com',
    'treatwell.fr', 'treatwell.com', 'treatwell.de',
    'rdv360.com', 'merci-yanis.com'
  ];
  for (const p of rootPlatforms) {
    if (host === p && path.length > 1 && !['/login', '/'].includes(path)) {
      return rawUrl;
    }
  }
  return null;
}

const ACCENT_MAP = {
  'à':'a','á':'a','â':'a','ä':'a','é':'e','è':'e','ê':'e','ë':'e','î':'i','ï':'i','ô':'o','ö':'o','ù':'u','û':'u','ü':'u','ÿ':'y','ç':'c','ñ':'n'
};
function deburr(s) {
  return String(s || '').toLowerCase().replace(/[àáâäéèêëîïôöùûüÿçñ]/g, ch => ACCENT_MAP[ch] || ch);
}

// Genere des defauts contextualises a partir des donnees CSV brutes
export function buildDefaults(csvData) {
  const nom = csvData.nom || 'Salon de coiffure';
  const ville = csvData.ville || '';
  const note = parseFloat(csvData.note_avis);
  const showRating = Number.isFinite(note) && note >= 4;

  return {
    hero: {
      title: nom,
      tagline: 'Bienvenue chez',
      subtitle: ville ? `Salon de coiffure a ${ville}` : 'Votre coiffeur de proximite',
      backgroundImage: DEFAULT_HERO_IMAGE,
      showRating
    },
    intro: {
      title: ville ? `Bienvenue à ${ville}` : 'Bienvenue',
      description: csvData.meta_description || `Notre equipe vous accueille ${ville ? `a ${ville} ` : ''}pour vous offrir des prestations de coiffure soignees dans une ambiance chaleureuse. Nous mettons notre savoir-faire au service de votre style.`,
      // Photo d'illustration de la section intro (template Contrast).
      // Vide → le template choisit automatiquement une photo de la galerie
      // différente du hero.
      image: '',
      showRating,
      ratingFallback: 'Une qualite de service reconnue par nos clients fideles, jour apres jour.',
      showSatisfaction: true,
      satisfactionValue: '100%',
      satisfactionLabel: 'Satisfaction'
    },
    services: {
      title: 'Nos Services',
      items: DEFAULT_SERVICES.slice()
    },
    gallery: {
      title: 'Galerie',
      layout: 'grid', // 'grid' (vignettes carrées, défaut) | 'masonry' (style Pinterest)
      images: DEFAULT_GALLERY_IMAGES.slice(),
      visibleCount: 6
    },
    testimonials: {
      title: 'Avis Clients',
      items: DEFAULT_TESTIMONIALS.slice()
    },
    contact: {
      title: 'Venez nous rendre visite',
      description: `Notre equipe vous accueille pour tous vos besoins en coiffure${ville ? ` a ${ville}` : ''}.`,
      address: csvData.adresse || '',
      addressLine2: csvData.code_postal && csvData.ville ? `${csvData.code_postal} ${csvData.ville}` : (csvData.code_postal || csvData.ville || ''),
      phone: csvData.telephone || '',
      email: csvData.email || '',
      hours: mergeHoursWithDefaults(csvData.heures_ouverture),
      latitude: csvData.latitude,
      longitude: csvData.longitude,
      bookingUrl: detectBookingUrl(csvData.site_internet_original) || ''
    },
    design: {
      // Contrast/Drama passent les photos en noir & blanc (filtre « cinéma »).
      // false → photos affichées en couleur d'origine. Sans effet sur Classic.
      monochromePhotos: true
    },
    socials: {
      facebook: { url: csvData.lien_facebook || '', enabled: !!csvData.lien_facebook },
      instagram: { url: csvData.lien_instagram || '', enabled: !!csvData.lien_instagram },
      tiktok: { url: csvData.lien_tiktok || '', enabled: !!csvData.lien_tiktok },
      youtube: { url: csvData.lien_youtube || '', enabled: !!csvData.lien_youtube }
    }
  };
}

// Merge profond : overrides ecrase defaults, mais garde les cles non touchees
export function mergeOverrides(defaults, overrides) {
  if (!overrides || typeof overrides !== 'object') return defaults;
  const out = JSON.parse(JSON.stringify(defaults));

  for (const section of Object.keys(overrides)) {
    if (overrides[section] === null || overrides[section] === undefined) continue;
    if (section === 'services' || section === 'gallery' || section === 'testimonials' || section === 'socials') {
      // Pour ces sections, on remplace completement la section si overridee
      out[section] = { ...out[section], ...overrides[section] };
    } else if (typeof overrides[section] === 'object') {
      out[section] = { ...out[section], ...overrides[section] };
    } else {
      out[section] = overrides[section];
    }
  }

  return out;
}

// Construit la version finale (defaults + overrides) a partir des donnees DB
export function buildSalonView(salonRow) {
  let csvData = {};
  try { csvData = JSON.parse(salonRow.data_json || '{}'); } catch {}
  let hours = null;
  try { hours = salonRow.heures_ouverture ? JSON.parse(salonRow.heures_ouverture) : null; } catch {}

  // Nom affiche : nom_clean s'il existe, sinon nom brut du CSV
  const displayName = (salonRow.nom_clean && salonRow.nom_clean.trim()) || salonRow.nom;

  // Enrichissement avec les colonnes typees
  const flat = {
    ...csvData,
    nom: displayName,
    ville: salonRow.ville,
    code_postal: salonRow.code_postal,
    adresse: salonRow.adresse,
    telephone: salonRow.telephone,
    email: salonRow.email,
    latitude: salonRow.latitude,
    longitude: salonRow.longitude,
    note_avis: salonRow.note_avis,
    nb_avis: salonRow.nb_avis,
    heures_ouverture: hours,
    lien_facebook: salonRow.lien_facebook,
    lien_instagram: salonRow.lien_instagram,
    lien_tiktok: salonRow.lien_tiktok,
    lien_youtube: salonRow.lien_youtube,
    lien_google_maps: salonRow.lien_google_maps,
    meta_image: salonRow.meta_image,
    meta_description: salonRow.meta_description
  };

  const defaults = buildDefaults(flat);

  let overrides = null;
  try { overrides = salonRow.overrides_json ? JSON.parse(salonRow.overrides_json) : null; } catch {}

  return {
    slug: salonRow.slug,
    nom: displayName,
    nom_original: salonRow.nom,
    template: salonRow.template || DEFAULT_TEMPLATE_ID,
    ville: salonRow.ville,
    note_avis: salonRow.note_avis,
    nb_avis: salonRow.nb_avis,
    lien_google_maps: salonRow.lien_google_maps,
    meta_description: salonRow.meta_description,
    content: mergeOverrides(defaults, overrides),
    has_overrides: !!overrides
  };
}

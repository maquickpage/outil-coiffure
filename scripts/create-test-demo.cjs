/* Crée la région "test-demo" + 2 salons de test identiques (emails distincts).
   Idempotent : INSERT OR REPLACE sur les 2 slugs fixes. */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const db = new Database('/data/salons.db');

// 1. Groupe test-demo
db.prepare('INSERT OR IGNORE INTO salon_groups (name) VALUES (?)').run('test-demo');
const groupId = db.prepare('SELECT id FROM salon_groups WHERE name=?').get('test-demo').id;

// 2. Contenu commun aux 2 salons (identiques, hors slug + email)
const hours = { monday:'9h - 19h', tuesday:'9h - 19h', wednesday:'9h - 19h', thursday:'9h - 19h', friday:'9h - 19h', saturday:'9h - 18h', sunday:'closed' };
const NOM = 'Salon Démo Test';
const VILLE = 'Démoville';
const CP = '75000';
const ADRESSE = '1 rue de la Démonstration';
const TEL = '01 23 45 67 89';

function makeData(email) {
  return {
    nom: NOM, ville: VILLE, code_postal: CP, adresse: ADRESSE,
    telephone: TEL, email,
    types: 'Coiffeur',
    latitude: 48.8566, longitude: 2.3522,
    heures_ouverture: hours,
    meta_description: 'Salon de démonstration MaQuickPage — coupe, couleur, soins dans une ambiance chaleureuse. Données fictives pour tests.',
    site_internet_original: null,
    note_avis: '4.9', nb_avis: '37',
    lien_facebook: null, lien_instagram: null, lien_tiktok: null, lien_youtube: null,
  };
}

const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

const stmt = db.prepare(`
  INSERT OR REPLACE INTO salons
    (slug, nom, nom_clean, nom_clean_at, ville, code_postal, adresse, telephone, email,
     latitude, longitude, types, note_avis, nb_avis, heures_ouverture,
     data_json, edit_token, group_id, csv_source, created_at, updated_at)
  VALUES
    (@slug, @nom, @nom_clean, @now, @ville, @code_postal, @adresse, @telephone, @email,
     @latitude, @longitude, @types, @note_avis, @nb_avis, @heures_ouverture,
     @data_json, @edit_token, @group_id, @csv_source, @now, @now)
`);

function makeSalon(slug, email) {
  const data = makeData(email);
  stmt.run({
    slug, nom: NOM, nom_clean: NOM, now,
    ville: VILLE, code_postal: CP, adresse: ADRESSE, telephone: TEL, email,
    latitude: 48.8566, longitude: 2.3522, types: 'Coiffeur',
    note_avis: '4.9', nb_avis: '37',
    heures_ouverture: JSON.stringify(hours),
    data_json: JSON.stringify(data),
    edit_token: crypto.randomBytes(12).toString('base64url'),
    group_id: groupId, csv_source: 'test-demo',
  });
  const r = db.prepare('SELECT slug, email, edit_token FROM salons WHERE slug=?').get(slug);
  console.log(`OK ${r.slug} | email=${r.email} | token=${r.edit_token}`);
}

makeSalon('test-demo-salon-1', 'johann@metagora.tech');
makeSalon('test-demo-salon-2', 'baydeu@gmail.com');

console.log('Groupe test-demo id=' + groupId + ' — 2 salons créés.');
process.exit(0);

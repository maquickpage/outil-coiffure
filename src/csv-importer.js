import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import db from './db.js';
import { generateSlug } from './slug-generator.js';
import { generateEditToken } from './token-generator.js';
import { DEFAULT_TEMPLATE_ID } from './templates.js';

function detectDelimiter(firstLine) {
  const tabs = (firstLine.match(/\t/g) || []).length;
  const semi = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  if (tabs > semi && tabs > commas) return '\t';
  if (semi > commas) return ';';
  return ',';
}

function parseHoursJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFloatOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isValidExternalSite(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  if (u.includes('facebook.com')) return false;
  if (u.includes('site-solocal.com')) return false;
  if (u.includes('horaires.lefigaro.fr')) return false;
  if (u.includes('booksy.com')) return false;
  if (u.includes('planity.com')) return false;
  if (u.includes('settime.io')) return false;
  if (u.includes('topcoiffeur.fr')) return false;
  return true;
}

const COLUMN_MAP = {
  nom: ['Nom', '﻿Nom'],
  types: ['Tous les types', 'Type principal'],
  google_id: ['Google ID'],
  lien_google_maps: ['Lien'],
  telephone: ['Téléphone international', 'Téléphone'],
  email: ['Email de contact', 'Email', 'Email individuel', 'Email 1', 'labels.frontend.export.export_fields.website_email_1'],
  site_internet_original: ['Site internet'],
  adresse: ['Adresse 1', 'Adresse complète'],
  ville: ['Ville'],
  code_postal: ['Code postal'],
  latitude: ['Latitude'],
  longitude: ['Longitude'],
  note_avis: ['Note des avis'],
  nb_avis: ['Nombre d\'avis'],
  est_ferme: ['Est fermé définitivement'],
  heures_ouverture: ['Heures d\'ouverture'],
  lien_facebook: ['Lien Facebook'],
  lien_instagram: ['Lien Instagram'],
  lien_tiktok: ['Lien Tiktok'],
  lien_youtube: ['Lien Youtube'],
  titre_site: ['Titre du site'],
  meta_description: ['Meta description du site'],
  meta_image: ['Meta image du site']
};

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k];
  }
  return null;
}

function rowToSalonData(row) {
  return {
    nom: pick(row, COLUMN_MAP.nom),
    types: pick(row, COLUMN_MAP.types),
    google_id: pick(row, COLUMN_MAP.google_id),
    lien_google_maps: pick(row, COLUMN_MAP.lien_google_maps),
    telephone: pick(row, COLUMN_MAP.telephone),
    email: pick(row, COLUMN_MAP.email),
    site_internet_original: pick(row, COLUMN_MAP.site_internet_original),
    adresse: pick(row, COLUMN_MAP.adresse),
    ville: pick(row, COLUMN_MAP.ville),
    code_postal: pick(row, COLUMN_MAP.code_postal),
    latitude: parseFloatOrNull(pick(row, COLUMN_MAP.latitude)),
    longitude: parseFloatOrNull(pick(row, COLUMN_MAP.longitude)),
    note_avis: parseFloatOrNull(pick(row, COLUMN_MAP.note_avis)),
    nb_avis: pick(row, COLUMN_MAP.nb_avis),
    est_ferme: pick(row, COLUMN_MAP.est_ferme),
    heures_ouverture: parseHoursJson(pick(row, COLUMN_MAP.heures_ouverture)),
    lien_facebook: pick(row, COLUMN_MAP.lien_facebook),
    lien_instagram: pick(row, COLUMN_MAP.lien_instagram),
    lien_tiktok: pick(row, COLUMN_MAP.lien_tiktok),
    lien_youtube: pick(row, COLUMN_MAP.lien_youtube),
    titre_site: pick(row, COLUMN_MAP.titre_site),
    meta_description: pick(row, COLUMN_MAP.meta_description),
    meta_image: pick(row, COLUMN_MAP.meta_image),
    has_real_website: isValidExternalSite(pick(row, COLUMN_MAP.site_internet_original))
  };
}

export function importCsvFile(filePath, csvSourceName, groupId = null) {
  const raw = readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
  const firstLine = raw.split(/\r?\n/, 1)[0];
  const delimiter = detectDelimiter(firstLine);

  const rows = parse(raw, {
    delimiter,
    columns: header => header.map(h => h.replace(/^﻿/, '').trim()),
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false
  });

  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  const insertSalon = db.prepare(`
    INSERT INTO salons (
      slug, nom, nom_clean, ville, code_postal, adresse, telephone, email,
      latitude, longitude, types, note_avis, nb_avis, heures_ouverture,
      lien_facebook, lien_instagram, lien_tiktok, lien_youtube, lien_google_maps,
      meta_image, titre_site, meta_description, site_internet_original,
      data_json, csv_source, edit_token, group_id, template
    ) VALUES (
      @slug, @nom, @nom, @ville, @code_postal, @adresse, @telephone, @email,
      @latitude, @longitude, @types, @note_avis, @nb_avis, @heures_ouverture,
      @lien_facebook, @lien_instagram, @lien_tiktok, @lien_youtube, @lien_google_maps,
      @meta_image, @titre_site, @meta_description, @site_internet_original,
      @data_json, @csv_source, @edit_token, @group_id, @template
    )
  `);

  const insertImport = db.prepare(`
    INSERT INTO csv_imports (filename, total_rows, imported_rows, skipped_rows, original_headers)
    VALUES (?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let skipped = 0;
  const skippedReasons = [];
  const importedSlugs = [];

  const tx = db.transaction(() => {
    for (const row of rows) {
      const data = rowToSalonData(row);

      if (!data.nom) {
        skipped++;
        skippedReasons.push('Pas de nom');
        continue;
      }
      if (data.est_ferme && data.est_ferme.toLowerCase() === 'oui') {
        skipped++;
        skippedReasons.push(`Ferme: ${data.nom}`);
        continue;
      }

      const slug = generateSlug(data.nom, data.ville);

      try {
        insertSalon.run({
          slug,
          nom: data.nom,
          ville: data.ville,
          code_postal: data.code_postal,
          adresse: data.adresse,
          telephone: data.telephone,
          email: data.email,
          latitude: data.latitude,
          longitude: data.longitude,
          types: data.types,
          note_avis: data.note_avis,
          nb_avis: data.nb_avis,
          heures_ouverture: data.heures_ouverture ? JSON.stringify(data.heures_ouverture) : null,
          lien_facebook: data.lien_facebook,
          lien_instagram: data.lien_instagram,
          lien_tiktok: data.lien_tiktok,
          lien_youtube: data.lien_youtube,
          lien_google_maps: data.lien_google_maps,
          meta_image: data.meta_image,
          titre_site: data.titre_site,
          meta_description: data.meta_description,
          site_internet_original: data.site_internet_original,
          data_json: JSON.stringify({ ...data, original_row: row }),
          csv_source: csvSourceName,
          edit_token: generateEditToken(),
          group_id: groupId,
          template: DEFAULT_TEMPLATE_ID
        });
        imported++;
        importedSlugs.push(slug);
      } catch (e) {
        skipped++;
        skippedReasons.push(`Insert error ${data.nom}: ${e.message}`);
      }
    }

    insertImport.run(csvSourceName, rows.length, imported, skipped, JSON.stringify(headers));
  });

  tx();

  return {
    total: rows.length,
    imported,
    skipped,
    skippedReasons: skippedReasons.slice(0, 20),
    headers,
    delimiter,
    importedSlugs
  };
}

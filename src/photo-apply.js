// Application d'une photo scrapée comme héro ou en galerie d'un salon.
// Réplique EXACTEMENT le pipeline de l'éditeur coiffeur (src/routes/edit.js
// upload-image) : mêmes dimensions, même qualité, même stockage (S3 ou disque),
// même format d'overrides — pour que le rendu soit indistinguable d'un upload manuel.
// Source : rendition _lg (≤1920px q90) du volume /data/salon-photos.

import sharp from 'sharp';
import { existsSync } from 'node:fs';
import db from './db.js';
import { uploadObject } from './object-storage.js';
import { photoLgPath } from './picker-core.js';
import { captureSalon } from './screenshot-worker.js';
import { DEFAULT_GALLERY_IMAGES } from './defaults.js';

const GALLERY_MAX = 12;

const HERO_POSITIONS = { haut: 'top', centre: 'centre', bas: 'bottom' };

function getSalonOrThrow(slug) {
  const salon = db.prepare('SELECT id, slug, google_id, overrides_json FROM salons WHERE slug = ?').get(slug);
  if (!salon) throw new Error(`Salon introuvable: ${slug}`);
  return salon;
}

function getPhotoOrThrow(googleId, photoId) {
  const photo = db.prepare('SELECT id, dir, photo_id, lowdef FROM salon_photos WHERE google_id = ? AND photo_id = ?').get(googleId, photoId);
  if (!photo) throw new Error(`Photo introuvable: ${photoId} (google_id=${googleId})`);
  const path = photoLgPath(photo.dir, photo.photo_id);
  if (!existsSync(path)) throw new Error(`Fichier manquant sur le volume: ${path}`);
  return { ...photo, path };
}

function saveOverrides(salonId, overrides) {
  db.prepare(`
    UPDATE salons
    SET overrides_json = ?, overrides_updated_at = datetime('now'), updated_at = datetime('now'),
        screenshot_path = NULL, screenshot_generated_at = NULL
    WHERE id = ?
  `).run(JSON.stringify(overrides), salonId);
}

function recaptureAsync(slug) {
  // Fire-and-forget : la recapture Puppeteer prend ~5-15s, on ne bloque pas la réponse HTTP.
  captureSalon(slug).catch((e) => console.warn(`[photo-apply] recapture ${slug} fail: ${e.message}`));
}

/**
 * Applique une photo comme fond héro d'un salon.
 * @param {Object} p { slug, photoId, position: 'haut'|'centre'|'bas', googleId? }
 * @returns {Promise<{url, slug}>}
 */
export async function applyHero({ slug, photoId, position = 'centre', googleId = null }) {
  const salon = getSalonOrThrow(slug);
  const gid = googleId || salon.google_id;
  if (!gid) throw new Error(`Le salon ${slug} n'a pas de google_id — impossible de retrouver ses photos`);
  const photo = getPhotoOrThrow(gid, photoId);

  // Même spec que l'éditeur coiffeur : 1920x1080 cover q80 progressive
  const buffer = await sharp(photo.path)
    .rotate()
    .resize(1920, 1080, { fit: 'cover', position: HERO_POSITIONS[position] || 'centre' })
    .jpeg({ quality: 80, progressive: true, mozjpeg: true })
    .toBuffer();

  const url = await uploadObject(`${slug}/hero-${Date.now()}.jpg`, buffer, 'image/jpeg');

  let overrides = {};
  try { overrides = JSON.parse(salon.overrides_json || '{}') || {}; } catch {}
  overrides.hero = {
    ...(overrides.hero || {}),
    backgroundImage: url,
    backgroundImageSource: 'photo-picker',
    backgroundImageUpdatedAt: new Date().toISOString(),
  };
  saveOverrides(salon.id, overrides);
  recaptureAsync(slug);
  return { url, slug, sizeKb: Math.round(buffer.length / 1024) };
}

/**
 * Met à jour la galerie d'un salon avec une sélection de photos scrapées.
 *   - mode 'replace' (défaut) : la galerie ne contient QUE les photos choisies
 *     (retire les photos du mode démo).
 *   - mode 'append' : ajoute les photos choisies EN TÊTE de la galerie actuelle
 *     (démo + éventuels overrides précédents), pour qu'elles soient visibles en
 *     haut. Total plafonné à 12 (les nouvelles sont prioritaires).
 * @param {Object} p { slug, photoIds: string[], mode?: 'replace'|'append', googleId? }
 */
export async function applyGallery({ slug, photoIds, mode = 'replace', googleId = null }) {
  if (!Array.isArray(photoIds) || photoIds.length === 0) throw new Error('photoIds vide');
  if (photoIds.length > GALLERY_MAX) throw new Error(`Maximum ${GALLERY_MAX} images dans la galerie`);
  const salon = getSalonOrThrow(slug);
  const gid = googleId || salon.google_id;
  if (!gid) throw new Error(`Le salon ${slug} n'a pas de google_id`);

  const urls = [];
  for (const photoId of photoIds) {
    const photo = getPhotoOrThrow(gid, photoId);
    // Même spec que l'éditeur coiffeur : 1024px max côté long, q80
    const buffer = await sharp(photo.path)
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true, mozjpeg: true })
      .toBuffer();
    const url = await uploadObject(
      `${slug}/gallery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`,
      buffer, 'image/jpeg'
    );
    urls.push(url);
  }

  let overrides = {};
  try { overrides = JSON.parse(salon.overrides_json || '{}') || {}; } catch {}

  // État actuel de la galerie = override existant s'il y en a un, sinon les
  // images du mode démo (DEFAULT_GALLERY_IMAGES) — exactement ce que voit le visiteur.
  const currentImages = (overrides.gallery && Array.isArray(overrides.gallery.images))
    ? overrides.gallery.images
    : DEFAULT_GALLERY_IMAGES.slice();

  let finalImages;
  if (mode === 'append') {
    // Nouvelles EN TÊTE, puis l'existant, plafonné à 12 (les nouvelles gagnent).
    finalImages = [...urls, ...currentImages].slice(0, GALLERY_MAX);
  } else {
    finalImages = urls.slice(0, GALLERY_MAX);
  }

  const gallery = {
    ...(overrides.gallery || {}),
    images: finalImages,
    imagesSource: 'photo-picker',
    imagesUpdatedAt: new Date().toISOString(),
  };
  // En mode append, on s'assure que les photos ajoutées tombent dans la zone
  // visible (sinon elles seraient masquées derrière "voir plus").
  if (mode === 'append') {
    const baseVisible = (overrides.gallery && overrides.gallery.visibleCount) || 6;
    gallery.visibleCount = Math.min(finalImages.length, Math.max(baseVisible, urls.length));
  }
  overrides.gallery = gallery;

  saveOverrides(salon.id, overrides);
  recaptureAsync(slug);
  return { slug, count: finalImages.length, added: urls.length, mode, urls };
}

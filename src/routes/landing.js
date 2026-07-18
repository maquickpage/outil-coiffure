/**
 * Landing page lookup API : POST /api/landing/check
 *
 * Le coiffeur arrive sur la home, clique "Voir si mon salon est déjà couvert",
 * colle son URL Google Maps + son email. On cherche son salon dans la DB :
 *
 *   - Si trouvé : on lui renvoie le lien démo + on lui RE-envoie l'email avec
 *     son lien (utile s'il l'avait perdu) + on stocke son email comme lead.
 *
 *   - Si pas trouvé : on stocke sa demande dans `pending_demos` avec son URL
 *     Google Maps. Plus tard (process séparé manuel ou auto), on scrape les
 *     données et on crée le salon. Réponse : "vous recevrez votre site sous 48h".
 *
 * Sécurité :
 *   - Validation email + URL
 *   - Rate-limit en mémoire : 5 tentatives par IP par heure
 *   - Réponse uniforme côté front (pas de fingerprinting du résultat)
 */

import express from 'express';
import db from '../db.js';
import { sendSignupSuccessEmail } from '../email-sender.js';
import { logEvent, clientIp } from './tracking.js';

const router = express.Router();

// =============================================================================
// Rate limit en mémoire (anti-spam)
// =============================================================================
const RATE_MAX = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1h
const rateAttempts = new Map();

function canAttempt(key) {
  if (!key) return false;
  const now = Date.now();
  const past = (rateAttempts.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (past.length >= RATE_MAX) {
    rateAttempts.set(key, past);
    return false;
  }
  past.push(now);
  rateAttempts.set(key, past);
  return true;
}

// =============================================================================
// Helpers : parsing Google Maps URL + matching DB
// =============================================================================

function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Suit les redirects (cas Maps app shortlink maps.app.goo.gl/XYZ).
 * On limite à 5 hops + 5s timeout pour éviter les abus.
 */
async function resolveShortUrl(url) {
  try {
    const u = new URL(url);
    const isShort = u.hostname === 'maps.app.goo.gl' || u.hostname === 'goo.gl' || u.hostname === 'g.co';
    if (!isShort) return url;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    return res.url || url;
  } catch {
    return url; // best-effort, on continue avec l'URL originale
  }
}

/**
 * Extrait le nom du lieu depuis une URL Google Maps "longue".
 * Exemple : https://www.google.com/maps/place/Salon+Sophie/@45.5,5.9,17z/data=...
 *           → "Salon Sophie"
 */
function extractPlaceNameFromUrl(url) {
  try {
    const m = url.match(/\/maps\/place\/([^/@]+)/i);
    if (!m) return null;
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch { return null; }
}

/**
 * Extrait place_id (CHIJ...) depuis le segment data=... d'une URL Google Maps.
 * Format observé : data=!4m...!3m...!1s0x47bc...:0xabc...
 * Le place_id v1 commence par "0x" et contient un ":".
 */
function extractPlaceIdFromUrl(url) {
  try {
    // Tente d'extraire la signature complète "0x...:0x..." (format Google interne)
    const m = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (m) return m[1];
    // Fallback : place_id v1 (commence par ChIJ)
    const m2 = url.match(/(?:place_id=|!1s)(ChIJ[A-Za-z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
  } catch { return null; }
}

/**
 * Cherche un salon en DB selon plusieurs stratégies (par ordre de précision).
 * Retourne le row complet ou null.
 */
function findSalon({ rawUrl, placeName, placeId }) {
  // 1. Match exact sur lien_google_maps (= URL identique stockée)
  if (rawUrl) {
    const exact = db.prepare(
      'SELECT * FROM salons WHERE lien_google_maps = ? LIMIT 1'
    ).get(rawUrl);
    if (exact) return exact;
  }

  // 2. Match partiel sur lien_google_maps (= URL contient le nom ou place_id)
  if (placeId) {
    const byPlaceId = db.prepare(
      'SELECT * FROM salons WHERE lien_google_maps LIKE ? LIMIT 1'
    ).get(`%${placeId}%`);
    if (byPlaceId) return byPlaceId;
  }

  // 3. Match sur le nom de salon (LIKE insensible à la casse)
  if (placeName && placeName.length >= 3) {
    const byName = db.prepare(`
      SELECT * FROM salons
      WHERE LOWER(nom) = LOWER(?) OR LOWER(nom_clean) = LOWER(?)
      LIMIT 1
    `).get(placeName, placeName);
    if (byName) return byName;

    // 4. Fuzzy : nom du salon contient le terme de recherche
    const fuzzy = db.prepare(`
      SELECT * FROM salons
      WHERE LOWER(nom) LIKE LOWER(?) OR LOWER(nom_clean) LIKE LOWER(?)
      LIMIT 1
    `).get(`%${placeName}%`, `%${placeName}%`);
    if (fuzzy) return fuzzy;
  }

  return null;
}

// =============================================================================
// POST /api/landing/check
// Body: { google_maps_url, email }
// =============================================================================
router.post('/landing/check', express.json({ limit: '10kb' }), async (req, res) => {
  // MÊME dérivation IP que le funnel (clientIp) → le rapprochement lead↔journey
  // par (ip|ua) matche exactement. UA tronqué à 250 (idem preview_events côté join).
  const ip = clientIp(req);
  const userAgent = (req.headers['user-agent'] || '').slice(0, 250);

  // Rate limit par IP
  if (!canAttempt(ip || 'no-ip')) {
    return res.status(429).json({ ok: false, error: 'Trop de tentatives. Réessayez dans une heure.' });
  }

  const rawUrl = (req.body?.google_maps_url || '').toString().trim();
  const email = (req.body?.email || '').toString().trim().toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Adresse e-mail invalide.' });
  }
  if (!rawUrl || rawUrl.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Lien Google Maps manquant ou trop long.' });
  }
  // Validation grossière du domaine
  if (!/google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs/i.test(rawUrl)) {
    return res.status(400).json({
      ok: false,
      error: 'Le lien doit provenir de Google Maps. Suivez le mini-tuto ci-dessous.'
    });
  }

  // Résout les short links → URL longue
  const resolvedUrl = await resolveShortUrl(rawUrl);
  const placeName = extractPlaceNameFromUrl(resolvedUrl);
  const placeId = extractPlaceIdFromUrl(resolvedUrl);

  // Cherche le salon
  const salon = findSalon({ rawUrl: resolvedUrl, placeName, placeId });

  // Stocke le lead dans tous les cas
  try {
    db.prepare(`
      INSERT INTO landing_leads (email, google_maps_url, salon_slug, found, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(email, resolvedUrl, salon?.slug || null, salon ? 1 : 0, ip || null, userAgent);
  } catch (err) {
    console.error('[landing/check] DB insert lead error:', err.message);
  }

  // Funnel landing : issue de la recherche de couverture (bas de l'entonnoir).
  logEvent({ event: salon ? 'landing_check_found' : 'landing_check_notfound', ip: ip || null, ua: userAgent });

  if (salon) {
    // === SALON TROUVÉ ===
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://maquickpage.fr';
    const demoUrl = `${baseUrl}/preview/${encodeURIComponent(salon.slug)}`;
    const salonName = salon.nom_clean || salon.nom;

    // On RE-envoie l'email avec le lien démo (utile si le coiffeur l'avait perdu).
    // Réutilise le template sendSignupSuccessEmail mais sans le edit_token (pas
    // pertinent pour un démo non payé). On adapte le template pour ce cas.
    sendDemoLinkEmail({
      to: email,
      salonName,
      demoUrl,
      ville: salon.ville || '',
    }).then(result => {
      if (result.ok) {
        try {
          db.prepare('UPDATE landing_leads SET email_sent = 1 WHERE id = (SELECT MAX(id) FROM landing_leads WHERE email = ?)').run(email);
        } catch {}
      }
    }).catch(err => console.error('[landing/check] email send error:', err.message));

    return res.json({
      ok: true,
      found: true,
      salon_name: salonName,
      ville: salon.ville || null,
      demo_url: demoUrl,
      message: `Bonne nouvelle ! Votre site démo de ${salonName} est prêt.`,
    });
  }

  // === SALON NON TROUVÉ → ajout à la waitlist ===
  try {
    // Évite les doublons (même email + même URL)
    const existing = db.prepare(
      'SELECT id FROM pending_demos WHERE email = ? AND google_maps_url = ? LIMIT 1'
    ).get(email, resolvedUrl);
    if (!existing) {
      db.prepare(`
        INSERT INTO pending_demos (email, google_maps_url, ip, user_agent)
        VALUES (?, ?, ?, ?)
      `).run(email, resolvedUrl, ip || null, userAgent);
    }
  } catch (err) {
    console.error('[landing/check] DB insert pending error:', err.message);
  }

  return res.json({
    ok: true,
    found: false,
    message: 'Nous créons votre site démo et vous l\'envoyons par email sous 48h.',
  });
});

// =============================================================================
// Email helper : sendDemoLinkEmail
// =============================================================================
async function sendDemoLinkEmail({ to, salonName, demoUrl, ville }) {
  const { isEnabled } = await import('../email-sender.js');
  if (!isEnabled || !isEnabled()) {
    console.log(`[landing] RESEND_API_KEY missing — skip demo email to ${to}`);
    return { ok: false, reason: 'no_api_key' };
  }
  const subject = `Votre site démo ${salonName} est prêt`;
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 30px; color: #1a1a1a; background: #ffffff;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">Bonjour,</h1>
  <p style="font-size: 15px; line-height: 1.5; color: #4b5563;">
    Voici le site web qu'on a créé spécialement pour <strong>${escapeHtml(salonName)}</strong>${ville ? ` à ${escapeHtml(ville)}` : ''} :
  </p>
  <div style="background: #fff7e6; border-left: 4px solid #c9a96e; border-radius: 0 8px 8px 0; padding: 18px 20px; margin: 24px 0;">
    <p style="margin: 0 0 12px; font-size: 14px; color: #4b5563;">
      C'est gratuit pour le découvrir. Personnalisez-le, choisissez votre formule, votre site est en ligne en 5 minutes.
    </p>
    <a href="${escapeHtml(demoUrl)}" style="display: inline-block; background: #0a0a0a; color: white; padding: 12px 28px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Voir mon site démo →</a>
  </div>
  <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
    À partir de 9,90 € HT/mois. Domaine .fr ou .com offert.
    Aucun frais d'installation.
  </p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">
  <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0;">
    MaQuickPage · KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610<br>
    <a href="https://maquickpage.fr/legal/cgv.html" style="color: #9ca3af;">CGV</a> ·
    <a href="https://maquickpage.fr/legal/mentions-legales.html" style="color: #9ca3af;">Mentions légales</a> ·
    <a href="https://maquickpage.fr/legal/privacy.html" style="color: #9ca3af;">Confidentialité</a>
  </p>
</body></html>`;
  const text = `Bonjour,

Voici le site web qu'on a créé pour ${salonName}${ville ? ` à ${ville}` : ''} :
${demoUrl}

C'est gratuit pour le découvrir. À partir de 9,90 € HT/mois, domaine offert, aucun frais d'installation.

MaQuickPage — contact@maquickpage.fr`;

  // Réutilise sendRaw via un import dynamique (évite cycle)
  const { default: emailSender } = await import('../email-sender.js');
  // Pas de sendRaw exporté → on appelle via fetch direct ici (RESEND API)
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'noreply@maquickpage.fr';
  const replyTo = process.env.RESEND_REPLY_TO || null;
  const body = { from, to: [to], subject, html, text };
  if (replyTo) body.reply_to = replyTo;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[landing] Resend error:', data);
      return { ok: false, reason: 'api_error' };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[landing] network error:', err.message);
    return { ok: false, reason: 'network_error' };
  }
}

function escapeHtml(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default router;

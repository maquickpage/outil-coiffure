/**
 * Server-Side Rendering pour les pages salon (SEO).
 *
 * Architecture :
 *   - Lit `public/site/index.html` une fois au boot (cache mémoire)
 *   - Pour chaque requête /preview/{slug} ou / (sur Falkenstein) :
 *       - Récupère la row salon de la DB
 *       - Construit la view via buildSalonView() (déjà existant)
 *       - Injecte dans le template :
 *           * <head> SEO : title, meta description, canonical, OG, Twitter, JSON-LD HairSalon, robots
 *           * <body> : H1, hero tagline/subtitle, intro title/description, contact NAP, logo
 *       - Renvoie le HTML rendu
 *   - main.js continue de fonctionner normalement : il fait fetch /api/salon/{slug}
 *     et override le DOM (avec les MÊMES données que le SSR), donc :
 *       - Google voit le SSR'd content (1ère réponse HTTP) → rich results, indexation rapide
 *       - L'utilisateur voit le contenu instantanément (pas de flicker car même contenu)
 *
 * Routes additionnelles :
 *   - renderRobotsTxt(host) : robots.txt host-aware
 *   - renderSitemap(host, salon?) : sitemap.xml dynamique
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateTitle,
  generateMetaDescription,
  generateJsonLd,
  generateOgTags,
  escapeHtml,
} from './seo-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'public', 'site', 'index.html');

// Cache du template lu une fois au boot. Si le fichier change, il faut redémarrer
// le serveur (ou supprimer cette optimisation pour le dev).
let templateCache = null;
function loadTemplate() {
  if (templateCache == null) {
    templateCache = readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return templateCache;
}

// Hosts considérés comme "domaine principal" SaaS (marketing + agency) — utilisé
// pour décider du noindex et du canonical. Tout host pas dans cette liste est
// un custom hostname coiffeur (= site qui doit être indexable).
// Note: monsitehq.com reste dans la liste pour préserver le comportement noindex
// sur les URLs legacy (avant qu'elles ne 301-redirect côté Express).
const MAIN_DOMAIN_HOSTS = new Set([
  'maquickpage.fr',
  'www.maquickpage.fr',
  'monsitehq.com',
  'www.monsitehq.com',
  'localhost',
  '127.0.0.1',
]);
export function isMainDomainHost(host) {
  return MAIN_DOMAIN_HOSTS.has((host || '').toLowerCase());
}

// =============================================================================
// Helpers de remplacement DOM (regex-based, simple et rapide)
// =============================================================================

/**
 * Remplace le contenu d'un élément avec un id donné, en préservant ses attributs.
 * Tolérant à différents noms de tag.
 *
 * Ex : replaceElementById(html, 'hero-title', 'Salon Sophie')
 *   → <h1 ... id="hero-title">Salon</h1>  devient  <h1 ... id="hero-title">Salon Sophie</h1>
 */
function replaceElementById(html, id, newContent) {
  if (newContent == null || newContent === '') return html;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match <tag ... id="ID" ... >...</tag> with non-greedy content
  const regex = new RegExp(
    `(<([a-z0-9]+)\\b[^>]*\\bid="${escaped}"[^>]*>)([^<]*)(</\\2>)`,
    'i'
  );
  return html.replace(regex, (_, openTag, _tag, _oldContent, closeTag) => {
    return `${openTag}${newContent}${closeTag}`;
  });
}

/**
 * Remplace le contenu d'un élément id=X, en autorisant que le contenu actuel
 * contienne lui-même des sous-tags (ex: <p id="contact-address">12 rue<br>75012</p>).
 * Plus permissif mais plus risqué — utiliser quand replaceElementById ne suffit pas.
 */
function replaceElementByIdHtml(html, id, newInnerHtml) {
  if (newInnerHtml == null) return html;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(<([a-z0-9]+)\\b[^>]*\\bid="${escaped}"[^>]*>)([\\s\\S]*?)(</\\2>)`,
    'i'
  );
  return html.replace(regex, (_, openTag, _tag, _oldContent, closeTag) => {
    return `${openTag}${newInnerHtml}${closeTag}`;
  });
}

// =============================================================================
// Render principal de la page salon
// =============================================================================

/**
 * @param {Object} view - résultat de buildSalonView(salonRow) (cf. defaults.js)
 * @param {Object} options
 * @param {string} options.canonicalUrl - URL canonique (https://salon-jean.fr/ ou https://maquickpage.fr/preview/jean)
 * @param {string} options.siteUrl - URL utilisée pour OG/JSON-LD (= origin du site)
 * @param {boolean} options.noindex - injecte <meta robots noindex,nofollow>
 * @returns {string} HTML rendu
 */
export function renderSalonHtml(view, options = {}) {
  const { canonicalUrl, siteUrl, noindex = false } = options;
  let html = loadTemplate();

  // ============================================================================
  // 1. <HEAD> — SEO complet
  // ============================================================================
  const title = generateTitle(view);
  const description = generateMetaDescription(view);
  const ogTags = generateOgTags(view, { siteUrl, title, description });
  const jsonLd = generateJsonLd(view, { siteUrl });

  const robotsTag = noindex
    ? `<meta name="robots" content="noindex, nofollow">`
    : `<meta name="robots" content="index, follow, max-image-preview:large">`;

  // Performance : preload du hero background pour optimiser le LCP (Largest
  // Contentful Paint), c'est l'image qui domine le above-the-fold.
  const heroImageUrl = (view.content && view.content.hero && view.content.hero.backgroundImage) || null;
  const preloadHero = heroImageUrl
    ? `<link rel="preload" as="image" href="${escapeHtml(heroImageUrl)}" fetchpriority="high">`
    : '';

  const ssrHeadBlock = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">` : '',
    robotsTag,
    `<meta name="format-detection" content="telephone=yes">`,
    `<meta name="author" content="${escapeHtml(view.nom || 'MaQuickPage')}">`,
    preloadHero,
    ogTags,
    `<script type="application/ld+json">${jsonLd}</script>`,
  ].filter(Boolean).join('\n    ');

  // Remplace le bloc <title>...<meta name="description"...> existant.
  // Le template part avec un title et une meta description hardcodés ; on les
  // remplace tous les deux d'un coup en SSR.
  html = html.replace(
    /<title>[^<]*<\/title>\s*<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    ssrHeadBlock
  );

  // ============================================================================
  // 2. <BODY> — éléments SEO-critiques uniquement
  //    (le reste sera filled par main.js, pas critique pour SEO)
  // ============================================================================
  const c = view.content || {};
  const hero = c.hero || {};
  const intro = c.intro || {};
  const contact = c.contact || {};

  // Logo (top + footer)
  const logoText = view.nom || 'Salon';
  html = replaceElementById(html, 'logo-text', escapeHtml(logoText));
  html = replaceElementById(html, 'logo-sub', escapeHtml(view.ville || 'Coiffure'));
  html = replaceElementById(html, 'footer-logo-text', escapeHtml(logoText));
  html = replaceElementById(html, 'footer-logo-sub', escapeHtml(view.ville || 'Coiffure'));
  html = replaceElementById(html, 'footer-name', escapeHtml(logoText));

  // Hero (= H1 + tagline + subtitle)
  if (hero.tagline) {
    html = replaceElementById(html, 'hero-tagline', escapeHtml(hero.tagline));
  }
  if (hero.title) {
    html = replaceElementById(html, 'hero-title', escapeHtml(hero.title));
  }
  if (hero.subtitle) {
    html = replaceElementById(html, 'hero-subtitle', escapeHtml(hero.subtitle));
  }

  // Intro
  if (intro.title) {
    html = replaceElementById(html, 'intro-title', escapeHtml(intro.title));
  }
  if (intro.description) {
    html = replaceElementByIdHtml(html, 'intro-description', escapeHtml(intro.description));
  }

  // Contact NAP (Name-Address-Phone) = signaux #1 du Local SEO
  if (contact.address || contact.addressLine2) {
    const addrHtml = [
      contact.address ? escapeHtml(contact.address) : '',
      contact.addressLine2 ? escapeHtml(contact.addressLine2) : '',
    ].filter(Boolean).join('<br>');
    html = replaceElementByIdHtml(html, 'contact-address', addrHtml);
  }
  if (contact.phone) {
    // Conserver href="tel:..." ajouté par main.js — on remplace seulement le texte
    html = replaceElementById(html, 'contact-phone', escapeHtml(contact.phone));
  }
  if (contact.email) {
    html = replaceElementById(html, 'contact-email', escapeHtml(contact.email));
  }

  // Footer tagline
  const footerTagline = `Votre salon de coiffure${view.ville ? ` à ${view.ville}` : ''}`;
  html = replaceElementByIdHtml(html, 'footer-tagline', escapeHtml(footerTagline));

  // Inject la view complète en JS global pour que main.js puisse render les
  // sections répétitives (services, gallery, testimonials, hours…) sans avoir
  // à refaire un fetch /api/salon. Indispensable sur custom hostnames
  // (Falkenstein) où l'URL est `/` et où main.js ne peut pas inférer un slug.
  //
  // IMPORTANT : on injecte dans <head> (pas avant </body>) parce que main.js
  // est chargé en mode bloquant dans le body et son IIFE s'exécute AVANT
  // les scripts en bas de page. En mettant ce script dans <head>, on garantit
  // qu'il s'exécute en premier et que window.__SALON_VIEW__ est défini quand
  // main.js démarre.
  const safeView = JSON.stringify(view).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const viewScript = `<script>window.__SALON_VIEW__=${safeView};</script>`;
  html = html.replace(/<\/head>/i, `${viewScript}</head>`);

  return html;
}

// =============================================================================
// /robots.txt host-aware
// =============================================================================

/**
 * Génère le contenu robots.txt selon l'hôte.
 * - maquickpage.fr (et localhost en dev) : Disallow /preview/, /admin/, /api/, etc.
 *     → protège contre l'indexation des 11k pages démo + l'admin
 * - Custom hostname (= salon coiffeur live) : Allow tout + sitemap référencé
 */
export function renderRobotsTxt(host) {
  const isMain = isMainDomainHost(host);
  const safeHost = (host || 'maquickpage.fr').toLowerCase();

  if (isMain) {
    return [
      `User-agent: *`,
      `Disallow: /preview/`,
      `Disallow: /admin/`,
      `Disallow: /api/`,
      `Disallow: /webhook/`,
      `Disallow: /edit-app/`,
      `Disallow: /screenshots/`,
      `Disallow: /uploads/`,
      `Allow: /`,
      ``,
      `Sitemap: https://maquickpage.fr/sitemap.xml`,
      ``,
    ].join('\n');
  }

  // Custom hostname (salon coiffeur live)
  return [
    `User-agent: *`,
    `Disallow: /admin/`,
    `Disallow: /api/`,
    `Allow: /`,
    ``,
    `Sitemap: https://${safeHost}/sitemap.xml`,
    ``,
  ].join('\n');
}

// =============================================================================
// /sitemap.xml dynamique
// =============================================================================

/**
 * Génère le sitemap.xml selon le contexte.
 *
 * - maquickpage.fr : home + pages légales (PAS les /preview/, qui sont noindex)
 * - Custom hostname : home (one-pager). Plus tard si on passe en multi-page,
 *     on ajoutera les sous-pages.
 *
 * @param {string} host - hostname courant (req.hostname)
 * @param {Object} options
 * @param {string} [options.salonUpdatedAt] - ISO datetime de la dernière maj
 *   (= overrides_updated_at) pour le <lastmod>
 */
export function renderSitemap(host, options = {}) {
  const isMain = isMainDomainHost(host);
  const safeHost = (host || 'maquickpage.fr').toLowerCase();
  const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const urls = [];

  if (isMain) {
    urls.push({ loc: `https://maquickpage.fr/`, changefreq: 'weekly', priority: '1.0', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/cgv.html`, changefreq: 'monthly', priority: '0.5', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/cgv-2y.html`, changefreq: 'monthly', priority: '0.4', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/cgv-1y.html`, changefreq: 'monthly', priority: '0.4', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/cgv-flex.html`, changefreq: 'monthly', priority: '0.4', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/privacy.html`, changefreq: 'monthly', priority: '0.5', lastmod: todayIso });
    urls.push({ loc: `https://maquickpage.fr/legal/mentions-legales.html`, changefreq: 'monthly', priority: '0.4', lastmod: todayIso });
  } else {
    // Custom hostname : home seule (one-pager).
    const lastmod = (options.salonUpdatedAt && options.salonUpdatedAt.slice(0, 10)) || todayIso;
    urls.push({ loc: `https://${safeHost}/`, changefreq: 'weekly', priority: '1.0', lastmod });
  }

  const xmlUrls = urls.map(u => {
    const parts = [`<loc>${escapeHtml(u.loc)}</loc>`];
    if (u.lastmod) parts.push(`<lastmod>${u.lastmod}</lastmod>`);
    if (u.changefreq) parts.push(`<changefreq>${u.changefreq}</changefreq>`);
    if (u.priority) parts.push(`<priority>${u.priority}</priority>`);
    return `  <url>${parts.join('')}</url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlUrls}\n</urlset>\n`;
}

export default {
  renderSalonHtml,
  renderRobotsTxt,
  renderSitemap,
  isMainDomainHost,
};

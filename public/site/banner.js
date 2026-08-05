/* =============================================================================
   Chrome de conversion MaQuickPage — ribbon + prix passif + CTA inline + sheet.

   Comportement :
     - Sur /preview/{slug} :
         INVISIBLE tant que le user n'a pas scrollé jusqu'à .intro
         Trigger : mouseenter desktop OU IntersectionObserver ≥ 30% mobile
         Attend la fermeture de l'onboarding si actif
          Affiche : ribbon + prix passif + CTA inline
          Le bottom sheet apparaît seulement près du footer, une fois par session
     - Sur /admin/{slug} :
         VISIBLE immédiatement
         Affiche : bar (bottom) UNIQUEMENT — pas de ribbon dans l'éditeur
     - N'apparaît PAS si :
         - URL ?nocapture=1 (Puppeteer screenshots)
         - URL ?banner=off (dev)
         - Host = custom (= site coiffeur payé, Falkenstein)
     - CTA → ouvre la modal pricing via window.MqsPricingModal.open()

   Décalage des FAB : quand la sheet est visible, on pose `body.mqs-bar-active` +
   on set la CSS variable `--mqs-bar-h` (hauteur réelle de la bar). Les FAB
   utilisent ces signaux pour se décaler au-dessus de la bar uniquement
   pendant que celle-ci est visible.
   ============================================================================= */

(function () {
  'use strict';

  // === Détection contexte ===
  const params = new URLSearchParams(window.location.search);
  if (params.has('nocapture') || params.get('banner') === 'off') return;

  const path = window.location.pathname;
  const isPreview = path.indexOf('/preview/') === 0;
  const isAdmin = path.indexOf('/admin/') === 0;
  if (!isPreview && !isAdmin) return;

  const host = window.location.hostname;
  const isDemoHost = host === 'maquickpage.fr' || host === 'localhost' || host === '127.0.0.1';
  if (!isDemoHost) return;
  const isCheckoutDemo = (host === 'localhost' || host === '127.0.0.1') && params.get('checkoutDemo') === '1';

  let mounted = false;
  let sheetShown = false;
  let sheetDismissed = false;
  let pageReadyAt = Date.now();
  let sheetObserver = null;
  let availableDomains = [];
  let domainLookupFinished = false;
  const SHEET_DISMISSED_KEY = `mqs-sheet-dismissed:${path}`;

  // Helpers
  function openPricingModal(source) {
    if (typeof window.MqsPricingModal === 'object' && window.MqsPricingModal.open) {
      window.MqsPricingModal.open(source || 'unknown', source === 'bottom_sheet' ? {
        verifiedSuggestions: availableDomains,
      } : null);
    } else {
      console.warn('[mqs-banner] MqsPricingModal not loaded');
    }
  }

  // Mesure la hauteur réelle de la bar (incluant son margin-bottom virtuel de
  // 24px / 16px = position bottom) et expose --mqs-bar-h sur <html>. Les FAB
  // s'en servent pour se positionner au-dessus pile au bon endroit.
  function syncBarHeightVar() {
    const bar = document.querySelector('#mqs-bar-wrap .mqs-bar');
    if (!bar) {
      document.documentElement.style.removeProperty('--mqs-bar-h');
      return;
    }
    const h = Math.round(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--mqs-bar-h', `${h}px`);
  }

  function setBarActive(active) {
    document.body.classList.toggle('mqs-bar-active', !!active);
    if (active) {
      syncBarHeightVar();
    } else {
      document.documentElement.style.removeProperty('--mqs-bar-h');
    }
  }

  function buildRibbon() {
    const r = document.createElement('div');
    r.id = 'mqs-ribbon';
    r.setAttribute('role', 'complementary');
    r.innerHTML = `
      <div class="mqs-ribbon-inner">
        <div class="mqs-ribbon-track">
          <div class="mqs-ribbon-left">
            <span class="mqs-ribbon-chip">
              <span class="mqs-ribbon-dot"></span>
              DÉMO
            </span>
            <span class="mqs-ribbon-message">
              Votre site est prêt — <b>il ne reste qu'une étape</b> pour le mettre en ligne
            </span>
          </div>
          <div class="mqs-ribbon-options" aria-label="Formules disponibles">
            <button type="button"><small>24 mois</small><strong>9,90 €</strong><small>/mois</small></button>
            <button type="button" class="is-popular"><span>POPULAIRE</span><small>12 mois</small><strong>17,90 €</strong><small>/mois</small></button>
            <button type="button"><small>Sans engag.</small><strong>29 €</strong><small>/mois</small></button>
          </div>
          <button class="mqs-ribbon-cta" type="button" aria-label="Voir les détails">
            Détails
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 6h7M6 2.5L9.5 6 6 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    // Délégation : le marquee mobile duplique la piste (cf. setupRibbonMarquee),
    // donc on ne peut pas attacher les handlers aux boutons un par un.
    r.addEventListener('click', (event) => {
      if (event.target.closest('.mqs-ribbon-cta, .mqs-ribbon-options button')) {
        openPricingModal('top_ribbon');
      }
    });
    return r;
  }

  // ── Défilement automatique du ribbon sur mobile ────────────────────────────
  // Le contenu ne tient pas dans 375px : plutôt que de le tronquer ou d'exiger
  // un geste, on le fait défiler en boucle. Technique marquee classique : on
  // clone la piste, les deux glissent de -100% de leur largeur, et comme le
  // clone démarre là où l'original finit la boucle est invisible.
  // Le clone est aria-hidden + non focusable (contenu dupliqué pour l'a11y).
  const MOBILE_RIBBON_QUERY = '(max-width: 760px)';
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  let ribbonPauseTimer = null;

  function setupRibbonMarquee(ribbon) {
    const inner = ribbon.querySelector('.mqs-ribbon-inner');
    const track = ribbon.querySelector('.mqs-ribbon-track');
    if (!inner || !track) return;

    const sync = () => {
      const isMobile = window.matchMedia(MOBILE_RIBBON_QUERY).matches;
      const reduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
      const clone = inner.querySelector('.mqs-ribbon-track-clone');
      // Marquee inutile si le contenu tient déjà, si on est sur desktop, ou si
      // l'utilisateur a demandé moins d'animations (on retombe alors sur un
      // défilement manuel, cf. .mqs-ribbon-inner en CSS).
      if (!isMobile || reduced || track.scrollWidth <= inner.clientWidth + 1) {
        if (clone) clone.remove();
        ribbon.classList.remove('is-marquee');
        return;
      }
      if (!clone) {
        const copy = track.cloneNode(true);
        copy.classList.add('mqs-ribbon-track-clone');
        copy.setAttribute('aria-hidden', 'true');
        copy.querySelectorAll('button').forEach(b => b.setAttribute('tabindex', '-1'));
        inner.appendChild(copy);
      }
      // La durée suit la largeur pour garder une vitesse de lecture constante
      // (~55 px/s) quelle que soit la taille de l'écran ou la longueur du texte.
      ribbon.style.setProperty('--mqs-marquee-duration', `${Math.round(track.scrollWidth / 55)}s`);
      ribbon.classList.add('is-marquee');
    };

    // Un tap met le défilement en pause quelques secondes : sans ça les puces
    // de prix sont des cibles mouvantes, donc quasi incliquables au doigt.
    ribbon.addEventListener('pointerdown', () => {
      ribbon.classList.add('is-paused');
      clearTimeout(ribbonPauseTimer);
      ribbonPauseTimer = setTimeout(() => ribbon.classList.remove('is-paused'), 5000);
    });

    sync();
    window.addEventListener('resize', sync);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(() => {});
  }

  function buildPassiveBanner() {
    const section = document.createElement('aside');
    section.id = 'mqs-passive-price';
    section.setAttribute('aria-label', 'Tarifs MaQuickPage');
    section.innerHTML = `
      <div class="mqs-passive-price-inner">
        <span class="mqs-passive-price-kicker">Votre site, prêt à être mis en ligne</span>
        <strong>Plans dès 9,90 € TTC/mois</strong>
        <span>Domaine, hébergement et mises à jour inclus</span>
        <button type="button">Voir les formules →</button>
      </div>
    `;
    section.querySelector('button').addEventListener('click', () => openPricingModal('mid_banner'));
    return section;
  }

  function buildBar() {
    const count = availableDomains.length;
    const firstHostname = count ? escapeHtml(availableDomains[0].hostname) : '';
    const secondHostname = count > 1 ? escapeHtml(availableDomains[1].hostname) : '';
    const desktopRemaining = Math.max(0, count - 2);
    const mobileRemaining = Math.max(0, count - 1);
    const desktopTitle = count
      ? 'Ces adresses web sont disponibles pour vous — <span>En voir plus</span>'
      : 'Trouvez l’adresse idéale pour votre salon';
    const desktopDetail = count
      ? `<span class="mqs-domain-preview-list"><strong><span aria-hidden="true">✓</span> ${firstHostname}</strong>${secondHostname ? `<strong><span aria-hidden="true">✓</span> ${secondHostname}</strong>` : ''}${desktopRemaining ? `<span>+${desktopRemaining} autres</span>` : ''}</span>`
      : '<span>Consultez nos suggestions ou recherchez directement le nom de votre choix.</span>';
    // Mobile : pas de phrase d'accroche (la bar doit rester compacte au-dessus
    // des deux pilules), juste le kicker + l'adresse + le reste du décompte.
    const mobileDetail = count
      ? `<span class="mqs-bar-kicker">Adresses disponibles</span><span class="mqs-domain-preview-list"><strong><span aria-hidden="true">✓</span> ${firstHostname}</strong>${mobileRemaining ? `<span>+${mobileRemaining} autres</span>` : ''}</span>`
      : '<span class="mqs-bar-kicker">Adresses disponibles</span><span>Consultez nos suggestions ou recherchez le nom de votre choix.</span>';
    const cta = count ? 'Voir les adresses' : 'Explorer les domaines';
    const b = document.createElement('div');
    b.id = 'mqs-bar-wrap';
    b.innerHTML = `
      <div class="mqs-bar" id="mqs-bar" role="complementary" aria-label="Découvrir les adresses disponibles">
        <div class="mqs-sheet-handle" aria-hidden="true"></div>
        <button class="mqs-sheet-close" type="button" aria-label="Fermer">×</button>
        <div class="mqs-bar-inner">
          <div class="mqs-bar-copy">
            <div class="mqs-bar-desktop">
              <div class="mqs-bar-copy-1"><b>${desktopTitle}</b></div>
              <div class="mqs-bar-copy-2">${desktopDetail}</div>
            </div>
            <div class="mqs-bar-mobile">
              <div class="mqs-bar-copy-2">${mobileDetail}</div>
            </div>
          </div>
          <div class="mqs-bar-action"><button class="mqs-bar-cta" type="button">${cta}</button></div>
        </div>
      </div>
    `;
    b.querySelector('.mqs-bar-cta').addEventListener('click', () => {
      try { window.mqsTrack && window.mqsTrack('paywall_peek_opened', getSheetMeta()); } catch (e) {}
      openPricingModal('bottom_sheet');
    });
    b.querySelector('.mqs-sheet-close').addEventListener('click', dismissSheet);
    return b;
  }

  // Sur /preview, on attend la réponse de la recherche de domaines avant de
  // monter la bar : sinon elle s'affiche d'abord dans son état de repli
  // (« Trouvez l'adresse idéale… »), puis refreshBar() la remplace une seconde
  // plus tard par la vraie liste — ce qui se voyait comme un clignotement.
  // Garde-fou : si l'API traîne, on monte quand même le repli au bout de 2,5 s.
  const DOMAIN_WAIT_MS = 2500;
  let mountPending = false;
  let mountWaitTimer = null;

  function mountBar() {
    if (sheetShown || sheetDismissed) return;
    if (isPreview && !domainLookupFinished) {
      if (!mountPending) {
        mountPending = true;
        mountWaitTimer = setTimeout(() => { mountPending = false; mountBarNow(); }, DOMAIN_WAIT_MS);
      }
      return;
    }
    mountBarNow();
  }

  function mountBarNow() {
    if (sheetShown || sheetDismissed) return;
    const existing = document.getElementById('mqs-bar-wrap');
    if (existing) existing.remove();
    const bar = buildBar();
    document.body.appendChild(bar);
    sheetShown = true;
    setBarActive(true);
    // Signal utilisé par les deux pilules (« Style du site » / « Modifier mon
    // site ») pour apparaître en même temps que la bar, pas au chargement.
    window.dispatchEvent(new CustomEvent('mqs-bar-shown'));
    try { window.mqsTrack && window.mqsTrack('paywall_peek_viewed', getSheetMeta()); } catch (e) {}
    // Re-mesure après que le DOM ait peint, et au resize (la hauteur peut changer
    // si la 2e ligne wrap sur petite largeur).
    requestAnimationFrame(syncBarHeightVar);
  }

  function refreshBar() {
    if (!sheetShown || sheetDismissed) return;
    const current = document.getElementById('mqs-bar-wrap');
    if (!current) return;
    current.replaceWith(buildBar());
    requestAnimationFrame(syncBarHeightVar);
  }

  function getSheetMeta() {
    const doc = document.documentElement;
    const max = Math.max(1, doc.scrollHeight - window.innerHeight);
    return {
      source: 'bottom_sheet',
      scrollDepth: Math.min(100, Math.round((window.scrollY / max) * 100)),
      timeOnPage: Math.round((Date.now() - pageReadyAt) / 1000),
      availableDomainCount: availableDomains.length,
      previewedHostname: availableDomains[0]?.hostname || null,
    };
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  async function loadAvailableDomains() {
    if (!isPreview || domainLookupFinished) return;
    const slug = path.split('/')[2];
    if (!slug) return;
    try {
      const response = await fetch(`/api/domain/suggestions/${encodeURIComponent(slug)}?plan=ONE_YEAR`);
      if (response.ok) {
        const data = await response.json();
        const suggestions = isCheckoutDemo
          ? (data.suggestions || []).map(item => ({ ...item, available: true, isIncluded: true }))
          : (data.suggestions || []);
        availableDomains = suggestions.filter(item => item.available === true);
      }
    } catch (e) {
      availableDomains = [];
    } finally {
      domainLookupFinished = true;
      if (mountPending) {
        mountPending = false;
        clearTimeout(mountWaitTimer);
        mountBarNow();
      } else {
        refreshBar();
      }
    }
  }

  function dismissSheet() {
    const wrap = document.getElementById('mqs-bar-wrap');
    if (wrap) wrap.remove();
    sheetShown = false;
    sheetDismissed = true;
    setBarActive(false);
    try { sessionStorage.setItem(SHEET_DISMISSED_KEY, '1'); } catch (e) {}
    try { window.mqsTrack && window.mqsTrack('paywall_dismissed', getSheetMeta()); } catch (e) {}
  }

  function mountPageConversion() {
    if (!isPreview) return;
    const services = document.querySelector('#services, .services');
    const gallery = document.querySelector('#galerie, .gallery');
    if (services && gallery && !document.getElementById('mqs-passive-price')) {
      services.insertAdjacentElement('afterend', buildPassiveBanner());
    }

    const footer = document.querySelector('footer');
    if (!footer) return;
    // Le sentinel reste enfant direct de <body> pour ne jamais hériter de la
    // grille d'un template hydraté.
    const bodyAnchor = Array.from(document.body.children).find(el => el.tagName === 'SCRIPT') || null;
    if (!document.getElementById('mqs-sheet-sentinel')) {
      const sentinel = document.createElement('div');
      sentinel.id = 'mqs-sheet-sentinel';
      sentinel.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(sentinel, bodyAnchor);
    }
  }

  function armSheetTrigger() {
    if (!isPreview || sheetDismissed || sheetObserver) return;
    const showOnFirstScroll = () => {
      if (window.scrollY <= 0) return;
      window.removeEventListener('scroll', showOnFirstScroll);
      mountBar();
    };
    sheetObserver = { disconnect: () => window.removeEventListener('scroll', showOnFirstScroll) };
    window.addEventListener('scroll', showOnFirstScroll, { passive: true });
    showOnFirstScroll();
  }

  function showAll() {
    if (mounted) return;
    mounted = true;

    // Ribbon (top noir "APERÇU + Voir les tarifs") : visible uniquement en /preview/{slug}.
    // Pas dans l'éditeur /admin/{slug} où l'utilisateur est déjà en train de
    // personnaliser son site — le ribbon serait redondant et visuellement parasite.
    if (isPreview && !document.getElementById('mqs-ribbon')) {
      const ribbon = buildRibbon();
      document.body.appendChild(ribbon);
      setupRibbonMarquee(ribbon);
      // Le ribbon pousse la navbar (cf. banner.css → body:has(#mqs-ribbon)).
      // On laisse main.js re-mesurer dynamiquement la nouvelle hauteur "header"
      // (= navbar + ribbon) via syncHeroBounds(). .hero-content suit avec
      // l'animation `transition: top` de 350ms.
      window.dispatchEvent(new CustomEvent('mqs-header-changed'));
    }
    mountPageConversion();
    if (isAdmin) mountBar();
    else armSheetTrigger();
  }

  // Cache visuellement le ribbon + bar quand la modal pricing est ouverte
  // (les éléments restent en DOM, juste display:none → l'état est préservé).
  // On retire aussi `body.mqs-bar-active` pour que les FAB reprennent leur
  // position normale tant que la modal masque la bar.
  function setHidden(hidden) {
    const ids = ['mqs-ribbon', 'mqs-bar-wrap'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = hidden ? 'none' : '';
    }
    setBarActive(!hidden && !!document.getElementById('mqs-bar-wrap'));
  }
  window.addEventListener('mqs-pricing-modal-open',  () => setHidden(true));
  window.addEventListener('mqs-pricing-modal-close', () => setHidden(false));

  // Re-mesure au resize (la bar peut changer de hauteur quand bar-copy-2 wrap).
  window.addEventListener('resize', () => {
    if (document.body.classList.contains('mqs-bar-active')) {
      syncBarHeightVar();
    }
  });

  // === Triggers ===
  function isOnboardingActive() {
    return !!document.querySelector('.mqs-pre-overlay, .mqs-onb-overlay');
  }

  function tryShow() {
    if (mounted) return;
    if (isOnboardingActive()) return;
    showAll();
  }

  function scheduleAppear() {
    if (mounted) return;

    if (isAdmin) {
      setTimeout(tryShow, 300);
      return;
    }

    try { sheetDismissed = sessionStorage.getItem(SHEET_DISMISSED_KEY) === '1'; } catch (e) {}

    // Lancé au plus tôt (et non à l'apparition de la bar) : la réponse a ainsi
    // le temps d'arriver avant le premier scroll, et la bar se monte
    // directement dans son état final.
    loadAvailableDomains();

    // Le premier geste de scroll révèle immédiatement la chrome et la bubble.
    // Si OVH n'a pas encore répondu, la bubble affiche son fallback honnête puis
    // se met à jour sans attendre que l'utilisateur atteigne le footer.
    const showFromInitialScroll = () => {
      if (window.scrollY <= 0 || isOnboardingActive()) return;
      window.removeEventListener('scroll', showFromInitialScroll);
      tryShow();
      if (mounted && !sheetDismissed) mountBar();
    };
    window.addEventListener('scroll', showFromInitialScroll, { passive: true });

    let attempts = 0;
    const tryAttach = () => {
      const intro = document.querySelector('.intro');
      if (!intro) {
        if (attempts++ < 50) return setTimeout(tryAttach, 100);
        return;
      }
      intro.addEventListener('mouseenter', tryShow, { once: true });
      if (typeof IntersectionObserver === 'function') {
        const obs = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
              obs.disconnect();
              tryShow();
              break;
            }
          }
        }, { threshold: [0, 0.3, 0.5, 1] });
        obs.observe(intro);
      }
    };
    tryAttach();

    window.addEventListener('mqs-onboarding-closed', () => {
      const intro = document.querySelector('.intro');
      if (!intro) return;
      const rect = intro.getBoundingClientRect();
      const visibleRatio = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)) / Math.max(1, rect.height);
      if (visibleRatio >= 0.3) tryShow();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleAppear, { once: true });
  } else {
    scheduleAppear();
  }
})();

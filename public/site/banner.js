/* =============================================================================
   Banner MaQuickPage — TOP RIBBON + BOTTOM BAR
   Design adapté de "Sitely CTA combo" → vanilla JS.

   Comportement :
     - Sur /preview/{slug} :
         INVISIBLE tant que le user n'a pas scrollé jusqu'à .intro
         Trigger : mouseenter desktop OU IntersectionObserver ≥ 30% mobile
         Attend la fermeture de l'onboarding si actif
         Affiche : ribbon (top) + bar (bottom)
     - Sur /admin/{slug} :
         VISIBLE immédiatement
         Affiche : bar (bottom) UNIQUEMENT — pas de ribbon dans l'éditeur
     - Pas de bouton "réduire" : la bar reste toujours visible (pas de pill).
     - N'apparaît PAS si :
         - URL ?nocapture=1 (Puppeteer screenshots)
         - URL ?banner=off (dev)
         - Host = custom (= site coiffeur payé, Falkenstein)
     - CTA → ouvre la modal pricing via window.MqsPricingModal.open()

   Décalage des FAB (bouton "Modifier mon site" sur preview, bouton "?" tuto
   dans l'éditeur) : quand la bar est mounted, on pose `body.mqs-bar-active` +
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

  let mounted = false;

  // Helpers
  function openPricingModal() {
    if (typeof window.MqsPricingModal === 'object' && window.MqsPricingModal.open) {
      window.MqsPricingModal.open();
    } else {
      console.warn('[mqs-banner] MqsPricingModal not loaded');
    }
  }

  // Récupère le nom du salon depuis le DOM (id="hero-title") pour personnaliser
  // le texte secondaire du ribbon.
  function getSalonName() {
    const el = document.getElementById('hero-title');
    return (el && el.textContent && el.textContent.trim()) || 'votre site';
  }

  // Compteur "X sites publiés ce mois" — déterministe et partagé entre toutes
  // les démos. Baseline 802 au 18 mai 2026 00:00 UTC, +1 toutes les 2 heures
  // (= 12 par jour). Tous les visiteurs voient la même valeur au même moment.
  function getSitesPublishedCount() {
    const REF_MS = Date.UTC(2026, 4, 18, 0, 0, 0); // mai = month 4 (0-indexed)
    const REF_VALUE = 802;
    const TWO_HOURS_MS = 2 * 3600 * 1000;
    const diff = Date.now() - REF_MS;
    if (diff < 0) return REF_VALUE;
    return REF_VALUE + Math.floor(diff / TWO_HOURS_MS);
  }
  function formatCount(n) {
    // "1234" → "1 234" (espace insécable comme séparateur de milliers, format FR)
    return n.toLocaleString('fr-FR').replace(/\s/g, ' ');
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
        <div class="mqs-ribbon-left">
          <span class="mqs-ribbon-chip">
            <span class="mqs-ribbon-dot"></span>
            DÉMO
          </span>
          <span class="mqs-ribbon-text">
            Ce site a été créé avec <b>MaQuickPage</b>. Pas encore en ligne.
          </span>
          <span class="mqs-ribbon-text mqs-ribbon-text--sm">
            Site de démonstration · ${getSalonName().replace(/[<>]/g, '')}
          </span>
        </div>
        <button class="mqs-ribbon-cta" type="button" aria-label="Voir les tarifs">
          Voir les tarifs
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 6h7M6 2.5L9.5 6 6 9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    `;
    r.querySelector('.mqs-ribbon-cta').addEventListener('click', openPricingModal);
    return r;
  }

  function buildBar() {
    const b = document.createElement('div');
    b.id = 'mqs-bar-wrap';
    b.innerHTML = `
      <div class="mqs-bar" id="mqs-bar">
        <div class="mqs-bar-inner">
          <div class="mqs-bar-avatars" aria-hidden="true">
            <div class="mqs-ava mqs-ava--1"></div>
            <div class="mqs-ava mqs-ava--2"></div>
            <div class="mqs-ava mqs-ava--3"></div>
            <div class="mqs-ava mqs-ava--n">+2K</div>
          </div>
          <div class="mqs-bar-copy">
            <div class="mqs-bar-copy-1"><b>${formatCount(getSitesPublishedCount())} sites</b> publiés ce mois sur MaQuickPage</div>
            <div class="mqs-bar-copy-2">
              <span class="mqs-bar-from">dès</span>
              <span class="mqs-price-chip">9,90 €/mois</span>
              <span class="mqs-bar-extra">— installation et domaine offerts</span>
            </div>
          </div>
          <button class="mqs-bar-cta" type="button">Publier mon site →</button>
        </div>
      </div>
    `;
    b.querySelector('.mqs-bar-cta').addEventListener('click', openPricingModal);
    return b;
  }

  function mountBar() {
    const existing = document.getElementById('mqs-bar-wrap');
    if (existing) existing.remove();
    const bar = buildBar();
    document.body.appendChild(bar);
    setBarActive(true);
    // Re-mesure après que le DOM ait peint, et au resize (la hauteur peut changer
    // si la 2e ligne wrap sur petite largeur).
    requestAnimationFrame(syncBarHeightVar);
  }

  function showAll() {
    if (mounted) return;
    mounted = true;

    // Ribbon (top noir "DÉMO + Voir les tarifs") : visible uniquement en /preview/{slug}.
    // Pas dans l'éditeur /admin/{slug} où l'utilisateur est déjà en train de
    // personnaliser son site — le ribbon serait redondant et visuellement parasite.
    if (isPreview && !document.getElementById('mqs-ribbon')) {
      document.body.appendChild(buildRibbon());
      // Le ribbon pousse la navbar (cf. banner.css → body:has(#mqs-ribbon)).
      // On laisse main.js re-mesurer dynamiquement la nouvelle hauteur "header"
      // (= navbar + ribbon) via syncHeroBounds(). .hero-content suit avec
      // l'animation `transition: top` de 350ms.
      window.dispatchEvent(new CustomEvent('mqs-header-changed'));
    }
    mountBar();
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

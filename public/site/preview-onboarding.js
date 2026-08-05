/* =============================================================================
   Onboarding visite guidée — site preview public

   3 bulles concises, ordre = on présente, on dévoile la modif, puis on lâche
   le coiffeur pour qu'il explore librement :
   1. Bienvenue (centre)
   2. "Tout est modifiable" → highlight le bouton flottant "Modifier mon site"
   3. "Faites le tour" → invite à scroll, lâche-prise

   Visite rejouée à chaque chargement de la page, SAUF si on arrive depuis
   l'écran de modification (referrer contient /admin/{slug}).
   ============================================================================= */
(function () {
  'use strict';

  const STEPS = [
    {
      id: 'welcome',
      target: null,
      title: 'Bienvenue 👋',
      text: "Voici votre site tel qu'on l'a pensé pour vous.",
      next: 'Suivant →',
    },
    {
      id: 'customize',
      target: '.mqs-pre-edit-btn',
      title: 'Tout est modifiable',
      text: "Dès maintenant ou après votre achat, vous pouvez tout personnaliser depuis votre espace gérant : les images de fond, vos photos, les textes, les prestations etc.",
      next: 'Suivant →',
      placement: 'top',
    },
    {
      id: 'explore',
      target: null,
      title: 'Faites le tour',
      text: 'Descendez la page pour découvrir comment vos clients verront votre salon : services, photos, avis, contact… Bonne découverte !',
      next: 'C\'est parti ✓',
    },
  ];

  let state = {
    overlay: null,
    spotlight: null,
    popup: null,
    editBtn: null,
    currentStep: 0,
    onResize: null,
    onScroll: null,
  };

  function getSlugFromUrl() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    if (parts[0] === 'preview' && parts[1]) return parts[1];
    return null;
  }

  // Récupère le edit_token : priorité URL > sessionStorage.
  // Si l'URL contient ?token=xxx, on le mémorise (sessionStorage) pour la durée
  // de la session, et le bouton "Modifier mon site" l'utilise pour rediriger
  // vers /admin/{slug}?token=xxx.
  function getEditToken(slug) {
    if (!slug) return null;
    const skey = 'mqs_edit_token_' + slug;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      try { sessionStorage.setItem(skey, fromUrl); } catch {}
      return fromUrl;
    }
    try { return sessionStorage.getItem(skey); } catch { return null; }
  }

  // Détecte si on arrive depuis l'écran de modification du salon
  // (referrer contient /admin/{slug} pour ce salon).
  function arrivingFromAdmin() {
    if (!document.referrer) return false;
    try {
      const ref = new URL(document.referrer);
      const slug = getSlugFromUrl();
      if (!slug) return false;
      // /admin/{slug}?token=... OU /admin/{slug}/...
      return new RegExp(`^/admin/${slug}(\\b|/|\\?|$)`).test(ref.pathname + ref.search);
    } catch {
      return false;
    }
  }

  // Bouton flottant "Modifier mon site" en bas-droite (remplace l'ancien picto ⓘ).
  // Click → redirection même onglet vers /admin/{slug} (le coiffeur arrive sur
  // sa console, où le système de token gère l'auth s'il en a un).
  function injectEditButton() {
    if (document.querySelector('.mqs-pre-edit-btn')) return;
    const slug = getSlugFromUrl();
    const btn = document.createElement('button');
    btn.className = 'mqs-pre-edit-btn';
    btn.type = 'button';
    btn.title = 'Modifier mon site';
    btn.setAttribute('aria-label', 'Modifier mon site');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/>
      </svg>
      <span class="mqs-pre-edit-btn-text">
        <span class="mqs-pre-edit-btn-kicker">Personnaliser</span>
        <span class="mqs-pre-edit-btn-label">Modifier mon site</span>
      </span>
    `;
    btn.addEventListener('click', () => {
      if (!slug) return;
      const token = getEditToken(slug);
      const url = token
        ? `/admin/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`
        : `/admin/${encodeURIComponent(slug)}`;
      window.location.href = url;
    });
    document.body.appendChild(btn);
    state.editBtn = btn;
    armEditButtonReveal();
  }

  // Le bouton n'apparaît qu'avec la grande CTA « adresses disponibles », pas au
  // chargement de la démo. Signal principal : l'event `mqs-bar-shown` émis par
  // banner.js. Repli : si la bar a été fermée plus tôt dans la session, l'event
  // ne viendra jamais → on révèle 3 s après le premier scroll.
  function armEditButtonReveal() {
    let timer = null;
    const onScroll = () => {
      if (window.scrollY <= 0 || timer) return;
      timer = setTimeout(revealEditButton, 3000);
    };
    state.onEditReveal = () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
    window.addEventListener('mqs-bar-shown', revealEditButton, { once: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // Révélation immédiate, sans attendre le scroll. Utilisé par la visite
  // guidée : son étape 2 pointe le bouton, il doit donc être visible.
  function revealEditButton() {
    if (state.onEditReveal) state.onEditReveal();
    const btn = state.editBtn || document.querySelector('.mqs-pre-edit-btn');
    if (btn) btn.classList.add('is-revealed');
  }

  function start() {
    if (state.overlay) return;

    // L'étape 2 met le bouton en surbrillance : il doit être visible dès le
    // début de la visite, sans attendre le scroll.
    revealEditButton();

    state.overlay = document.createElement('div');
    state.overlay.className = 'mqs-pre-overlay';
    state.overlay.setAttribute('role', 'dialog');
    state.overlay.setAttribute('aria-modal', 'true');

    state.spotlight = document.createElement('div');
    state.spotlight.className = 'mqs-pre-spotlight';
    state.overlay.appendChild(state.spotlight);

    state.popup = document.createElement('div');
    state.popup.className = 'mqs-pre-popup';
    state.overlay.appendChild(state.popup);

    document.body.appendChild(state.overlay);
    document.body.style.overflow = 'hidden';

    state.currentStep = 0;
    renderStep();

    state.onResize = () => positionStep();
    state.onScroll = () => positionStep();
    window.addEventListener('resize', state.onResize);
    window.addEventListener('scroll', state.onScroll, true);
  }

  function close() {
    if (state.overlay) state.overlay.remove();
    state.overlay = null;
    state.spotlight = null;
    state.popup = null;
    document.body.style.overflow = '';
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    if (state.onScroll) window.removeEventListener('scroll', state.onScroll, true);
    // Notifie les autres scripts (ex: banner.js) que l'onboarding est terminé
    // → permet au banner de re-check ses conditions d'affichage immédiatement
    try { window.dispatchEvent(new CustomEvent('mqs-onboarding-closed')); } catch {}
  }

  function finish() { close(); }

  function renderStep() {
    const s = STEPS[state.currentStep];
    if (!s) return finish();

    const total = STEPS.length;
    const stepNum = state.currentStep + 1;

    state.popup.innerHTML = `
      <p class="mqs-pre-popup-step">Étape ${stepNum} / ${total}</p>
      <h3 class="mqs-pre-popup-title">${escapeHtml(s.title)}</h3>
      <p class="mqs-pre-popup-text">${escapeHtml(s.text)}</p>
      <div class="mqs-pre-popup-actions">
        <button type="button" class="mqs-pre-skip">Passer</button>
        <button type="button" class="mqs-pre-next">${escapeHtml(s.next)}</button>
      </div>
    `;
    state.popup.querySelector('.mqs-pre-skip').addEventListener('click', finish);
    state.popup.querySelector('.mqs-pre-next').addEventListener('click', () => {
      state.currentStep++;
      if (state.currentStep >= STEPS.length) finish();
      else renderStep();
    });

    positionStep();
  }

  function positionStep() {
    const s = STEPS[state.currentStep];
    if (!s || !state.spotlight || !state.popup) return;

    if (!s.target) {
      state.spotlight.classList.add('mqs-pre-center');
      state.spotlight.style.left = '50%';
      state.spotlight.style.top = '50%';
      state.spotlight.style.width = '0px';
      state.spotlight.style.height = '0px';
      const pw = state.popup.offsetWidth;
      const ph = state.popup.offsetHeight;
      state.popup.style.left = `${(window.innerWidth - pw) / 2}px`;
      state.popup.style.top = `${(window.innerHeight - ph) / 2}px`;
      return;
    }

    state.spotlight.classList.remove('mqs-pre-center');
    const el = document.querySelector(s.target);
    if (!el) {
      state.spotlight.classList.add('mqs-pre-center');
      const pw = state.popup.offsetWidth;
      const ph = state.popup.offsetHeight;
      state.popup.style.left = `${(window.innerWidth - pw) / 2}px`;
      state.popup.style.top = `${(window.innerHeight - ph) / 2}px`;
      return;
    }

    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const rect = el.getBoundingClientRect();
    const padding = 8;

    state.spotlight.style.left = `${rect.left - padding}px`;
    state.spotlight.style.top = `${rect.top - padding}px`;
    state.spotlight.style.width = `${rect.width + padding * 2}px`;
    state.spotlight.style.height = `${rect.height + padding * 2}px`;

    const pw = state.popup.offsetWidth || 340;
    const ph = state.popup.offsetHeight || 180;
    const margin = 20;
    const placement = s.placement || 'bottom';
    let popupLeft, popupTop;

    switch (placement) {
      case 'right':
        popupLeft = rect.right + margin;
        popupTop = rect.top + rect.height / 2 - ph / 2;
        if (popupLeft + pw > window.innerWidth - 16) popupLeft = rect.left - pw - margin;
        break;
      case 'top':
        popupLeft = rect.left + rect.width / 2 - pw / 2;
        popupTop = rect.top - ph - margin;
        if (popupTop < 16) popupTop = rect.bottom + margin;
        break;
      case 'bottom':
      default:
        popupLeft = rect.left + rect.width / 2 - pw / 2;
        popupTop = rect.bottom + margin;
        if (popupTop + ph > window.innerHeight - 16) popupTop = rect.top - ph - margin;
        break;
    }

    popupLeft = Math.max(16, Math.min(popupLeft, window.innerWidth - pw - 16));
    popupTop = Math.max(16, Math.min(popupTop, window.innerHeight - ph - 16));

    state.popup.style.left = `${popupLeft}px`;
    state.popup.style.top = `${popupTop}px`;
  }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function init() {
    if (!/^\/preview\//.test(window.location.pathname)) return;

    // === Mode capture (Puppeteer screenshots) : skip toute l'UI d'onboarding ===
    // Le screenshot-worker passe ?nocapture=1 à la page : pas de modale tour,
    // pas de bouton flottant "Modifier mon site", pas de bannière. Comme ça
    // le rendu capturé reflète le vrai site comme un visiteur lambda.
    const params = new URLSearchParams(window.location.search);
    if (params.has('nocapture')) {
      return;
    }
    const onboardingDisabled = params.get('onboarding') === 'off';

    // Capture early : si ?token=xxx dans l'URL, on le stocke en sessionStorage
    const slug = getSlugFromUrl();
    if (slug) getEditToken(slug);

    // Sur les sites coiffeurs LIVE (custom hostname / Falkenstein), on
    // n'affiche le bouton flottant "Modifier mon site" QUE si le coiffeur a
    // un token valide (sessionStorage rempli car il vient de son admin ou
    // d'un email de récupération). Les visiteurs publics du salon ne doivent
    // pas voir ce bouton (UX confuse + risque de redirection vers /admin).
    const host = window.location.hostname;
    const isDemoHost = host === 'maquickpage.fr' || host === 'localhost' || host === '127.0.0.1';

    if (isDemoHost) {
      // Site demo Helsinki → comportement actuel : bouton + onboarding tour
      injectEditButton();
      if (!onboardingDisabled && !arrivingFromAdmin()) {
        setTimeout(start, 800);
      }
    } else {
      // Site live custom hostname → bouton uniquement si coiffeur authentifié
      const hasToken = !!(slug && getEditToken(slug));
      if (hasToken) {
        injectEditButton();
        // Pas d'onboarding tour sur live (le coiffeur a déjà fait le tour
        // sur son site demo avant de payer).
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.mqsPreviewOnboarding = { start, finish };
})();

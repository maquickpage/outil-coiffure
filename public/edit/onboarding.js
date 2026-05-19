/* =============================================================================
   Onboarding visite guidée — admin coiffeur (4 étapes)

   Workflow validé Johann :
   1. Bienvenue (centre)
   2. Highlight sidebar (les 6 catégories)
   3. Highlight bouton Enregistrer (de la section active)
   4. Highlight bouton "Voir mon site" (top-right)

   Fin : flag mqs_onb_done=1 dans localStorage. Bouton "?" pour rejouer.
   ============================================================================= */
(function () {
  'use strict';

  // Key localStorage scopée par slug : chaque coiffeur voit le tuto à sa
  // première ouverture, indépendamment des autres salons visités sur le même
  // browser (= utile en démo agence pour re-tester sur différents slugs).
  const LS_KEY_PREFIX = 'mqs_onboarding_v2_done_';
  function getCurrentSlug() {
    const m = (window.location.pathname || '').match(/^\/admin\/([^/?#]+)/);
    return m ? m[1] : 'unknown';
  }
  function lsKey() {
    return LS_KEY_PREFIX + getCurrentSlug();
  }

  const STEPS = [
    {
      id: 'welcome',
      target: null, // centré
      title: 'Bienvenue dans votre Espace de modification',
      text: "D'ici, vous avez le contrôle total sur le contenu de votre site. Si vous publiez votre site, vous recevrez un accès privé à cette page.",
      next: 'C\'est parti →',
    },
    {
      id: 'sidebar',
      target: '#edit-sidebar',
      title: 'Les 6 sections de votre site',
      text: "Ces 6 boutons correspondent aux 6 parties que vous retrouvez sur votre site, de haut en bas.",
      next: 'Suivant →',
      placement: 'right',          // desktop : à droite de la sidebar
      placementMobile: 'bottom',   // mobile/tablette : en-dessous (sinon recouvre la sidebar)
    },
    {
      id: 'save',
      // resolveVisible() retourne le 1er .btn-save dans la section active
      // (les sections inactives ont display:none → offsetParent null)
      target: '.btn-save',
      title: 'Pensez à enregistrer',
      text: "Quand vous faites une modification, n'oubliez pas de cliquer sur Enregistrer en bas de chaque section.",
      next: 'Suivant →',
      placement: 'top',
    },
    {
      id: 'preview',
      target: '#preview-link',
      title: 'Voir votre site mis à jour',
      text: 'Cliquez ici à tout moment pour retrouver votre site modifié 😉',
      next: 'Suivant →',
      placement: 'bottom',
    },
    {
      id: 'help',
      target: '.mqs-onb-help-btn',
      title: 'Besoin de revoir cette visite ?',
      text: 'Ce bouton reste toujours là, en bas à droite. Cliquez dessus quand vous voulez relancer la visite guidée.',
      next: 'Terminer ✓',
      placement: 'top',           // popup au-dessus du bouton ? (qui est en bas-droite)
    },
  ];

  let state = {
    overlay: null,
    spotlight: null,
    popup: null,
    helpBtn: null,
    currentStep: 0,
    onResize: null,
    onScroll: null,
  };

  function isDone() {
    return localStorage.getItem(lsKey()) === '1';
  }
  function markDone() {
    localStorage.setItem(lsKey(), '1');
  }
  function clearDone() {
    localStorage.removeItem(lsKey());
  }

  function injectHelpButton() {
    if (document.querySelector('.mqs-onb-help-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'mqs-onb-help-btn';
    btn.type = 'button';
    btn.innerHTML = '?';
    btn.title = 'Rejouer la visite guidée';
    btn.setAttribute('aria-label', 'Rejouer la visite guidée');
    btn.addEventListener('click', () => {
      clearDone();
      start();
    });
    document.body.appendChild(btn);
    state.helpBtn = btn;
  }

  function start() {
    if (state.overlay) return; // déjà en cours

    state.overlay = document.createElement('div');
    state.overlay.className = 'mqs-onb-overlay';
    state.overlay.setAttribute('role', 'dialog');
    state.overlay.setAttribute('aria-modal', 'true');

    state.spotlight = document.createElement('div');
    state.spotlight.className = 'mqs-onb-spotlight';
    state.overlay.appendChild(state.spotlight);

    state.popup = document.createElement('div');
    state.popup.className = 'mqs-onb-popup';
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
    state.onResize = null;
    state.onScroll = null;
  }

  function finish() {
    markDone();
    close();
  }

  function renderStep() {
    const s = STEPS[state.currentStep];
    if (!s) return finish();

    const total = STEPS.length;
    const stepNum = state.currentStep + 1;

    state.popup.innerHTML = `
      <p class="mqs-onb-popup-step">Étape ${stepNum} / ${total}</p>
      <h3 class="mqs-onb-popup-title">${escapeHtml(s.title)}</h3>
      <p class="mqs-onb-popup-text">${escapeHtml(s.text)}</p>
      <div class="mqs-onb-popup-actions">
        <button type="button" class="mqs-onb-skip">Passer la visite</button>
        <button type="button" class="mqs-onb-next">${escapeHtml(s.next)}</button>
      </div>
    `;
    state.popup.querySelector('.mqs-onb-skip').addEventListener('click', finish);
    state.popup.querySelector('.mqs-onb-next').addEventListener('click', () => {
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
      // Étape centrée (Bienvenue)
      state.spotlight.classList.add('mqs-onb-center');
      state.spotlight.style.left = '50%';
      state.spotlight.style.top = '50%';
      state.spotlight.style.width = '0px';
      state.spotlight.style.height = '0px';
      // Popup centré
      const pw = state.popup.offsetWidth;
      const ph = state.popup.offsetHeight;
      state.popup.style.left = `${(window.innerWidth - pw) / 2}px`;
      state.popup.style.top = `${(window.innerHeight - ph) / 2}px`;
      return;
    }

    state.spotlight.classList.remove('mqs-onb-center');
    // target peut être une string (sélecteur) ou une fonction (résolution dynamique).
    // Utile quand l'élément cible dépend de l'état UI (ex: bouton Enregistrer de l'onglet actif).
    const el = typeof s.target === 'function' ? s.target() : resolveVisible(s.target);
    if (!el) {
      // Cible introuvable → on saute en mode centré
      state.spotlight.classList.add('mqs-onb-center');
      const pw = state.popup.offsetWidth;
      const ph = state.popup.offsetHeight;
      state.popup.style.left = `${(window.innerWidth - pw) / 2}px`;
      state.popup.style.top = `${(window.innerHeight - ph) / 2}px`;
      return;
    }

    // Scroll l'élément dans la vue si besoin
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    const rect = el.getBoundingClientRect();
    const padding = 8;

    // Spotlight : englobe l'élément avec un padding
    state.spotlight.style.left = `${rect.left - padding}px`;
    state.spotlight.style.top = `${rect.top - padding}px`;
    state.spotlight.style.width = `${rect.width + padding * 2}px`;
    state.spotlight.style.height = `${rect.height + padding * 2}px`;

    // Popup : positionnée selon placement (placementMobile prend le relais sous 1024px = tablette + mobile)
    const pw = state.popup.offsetWidth || 340;
    const ph = state.popup.offsetHeight || 180;
    const margin = 20;
    let popupLeft, popupTop;
    const isNarrow = window.innerWidth < 1024;
    const placement = (isNarrow && s.placementMobile) ? s.placementMobile : (s.placement || 'bottom');

    switch (placement) {
      case 'right':
        popupLeft = rect.right + margin;
        popupTop = rect.top + rect.height / 2 - ph / 2;
        if (popupLeft + pw > window.innerWidth - 16) {
          popupLeft = rect.left - pw - margin;
        }
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

    // Clamp dans la viewport
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

  // Retourne le 1er élément matchant ET réellement visible à l'écran.
  // Note : on ne peut pas utiliser offsetParent (null pour les éléments
  // position: fixed). On vérifie juste la taille via getBoundingClientRect.
  function resolveVisible(selector) {
    const all = document.querySelectorAll(selector);
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }
    return null;
  }

  // === Bootstrap ===
  function init() {
    injectHelpButton();
    if (!isDone()) {
      // Léger délai pour laisser l'app se monter
      setTimeout(start, 600);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // API publique pour debug : window.mqsOnboarding.start()
  window.mqsOnboarding = { start, finish, clearDone };
})();

/* Sélecteur de style des démos MaQuickPage. Le choix reste temporaire jusqu'au checkout. */
(function () {
  'use strict';

  const STYLES = window.__MQS_TEMPLATES__ || [];
  if (!STYLES.length) return;
  const styleIds = new Set(STYLES.map(style => style.id));
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  const host = window.location.hostname;
  const isDemoHost = host === 'maquickpage.fr' || host === 'localhost' || host === '127.0.0.1';

  if (!isDemoHost || path.indexOf('/preview/') !== 0 || params.has('nocapture')) return;

  const requestedStyle = params.get('template');
  const viewStyle = window.__SALON_VIEW__ && window.__SALON_VIEW__.template;
  const currentStyle = styleIds.has(requestedStyle)
    ? requestedStyle
    : (styleIds.has(viewStyle) ? viewStyle : 'classic');

  let pricingOpen = false;
  const root = document.createElement('div');
  root.id = 'mqs-style-switcher';
  root.className = 'mqs-style-switcher';
  root.innerHTML = `
    <button class="mqs-style-scrim" type="button" aria-label="Fermer le choix du style" hidden></button>
    <button class="mqs-style-trigger" type="button" aria-expanded="false" aria-controls="mqs-style-panel">
      <span><small>Style du site</small><strong>${escapeHtml(styleById(currentStyle).name)}</strong></span>
      <span class="mqs-style-trigger-action">Voir les trois styles pensés pour vous</span>
    </button>
    <div class="mqs-style-panel" id="mqs-style-panel" role="dialog" aria-label="Choisir le style du site" hidden>
      <div class="mqs-style-panel-head">
        <div>
          <strong>Choisissez votre ambiance</strong>
          <p>Les trois styles qui nous ont semblé matcher avec votre salon.</p>
        </div>
        <button class="mqs-style-close" type="button" aria-label="Fermer">×</button>
      </div>
      <div class="mqs-style-options">
        ${STYLES.map(style => renderStyle(style, style.id === currentStyle)).join('')}
      </div>
      <p class="mqs-style-reassurance">Vous pourrez encore modifier ce choix après la mise en ligne.</p>
    </div>
  `;
  document.body.appendChild(root);

  const trigger = root.querySelector('.mqs-style-trigger');
  const panel = root.querySelector('.mqs-style-panel');
  const close = root.querySelector('.mqs-style-close');
  const scrim = root.querySelector('.mqs-style-scrim');

  trigger.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  scrim.addEventListener('click', () => setOpen(false));
  root.querySelectorAll('[data-template]').forEach(button => {
    button.addEventListener('click', () => selectStyle(button.dataset.template));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });
  window.addEventListener('mqs-pricing-modal-open', () => {
    pricingOpen = true;
    setOpen(false);
    syncVisibility();
  });
  window.addEventListener('mqs-pricing-modal-close', () => {
    pricingOpen = false;
    syncVisibility();
  });
  window.addEventListener('mqs-onboarding-closed', syncVisibility);

  const observer = new MutationObserver(syncVisibility);
  observer.observe(document.body, { childList: true, subtree: true });
  syncVisibility();

  function styleById(id) {
    return STYLES.find(style => style.id === id) || STYLES[0];
  }

  function renderStyle(style, selected) {
    return `
      <button class="mqs-style-option mqs-style-option-${style.id}${selected ? ' is-current' : ''}" type="button"
        data-template="${style.id}" ${selected ? 'aria-current="true"' : ''}>
        <span class="mqs-style-miniature" aria-hidden="true">
          <span class="mqs-style-mini-nav"></span>
          <span class="mqs-style-mini-title"></span>
          <span class="mqs-style-mini-copy"></span>
          <span class="mqs-style-mini-button"></span>
        </span>
        <span class="mqs-style-option-copy">
          ${selected ? '<em class="mqs-style-selected">Sélectionné</em>' : ''}
          <span><strong>${escapeHtml(style.name)}</strong></span>
          <b>${escapeHtml(style.subtitle)}</b>
          <small>${escapeHtml(style.previewDescription || style.description)}</small>
        </span>
      </button>
    `;
  }

  function setOpen(open) {
    panel.hidden = !open;
    scrim.hidden = !open;
    root.classList.toggle('is-open', open);
    document.body.classList.toggle('mqs-style-open', open);
    trigger.setAttribute('aria-expanded', String(open));
    if (open) close.focus({ preventScroll: true });
  }

  function selectStyle(nextStyle) {
    if (!styleIds.has(nextStyle) || nextStyle === currentStyle) {
      setOpen(false);
      return;
    }
    try {
      window.mqsTrack && window.mqsTrack('template_essaye', {
        from: currentStyle,
        to: nextStyle,
        source: 'style_switcher',
      });
    } catch (e) {}
    const url = new URL(window.location.href);
    url.searchParams.set('template', nextStyle);
    url.searchParams.set('styleChanged', '1');
    window.location.assign(url.toString());
  }

  function syncVisibility() {
    const onboardingOpen = !!document.querySelector('.mqs-pre-overlay, .mqs-onb-overlay');
    root.hidden = pricingOpen || onboardingOpen;
  }

  if (params.get('styleChanged') === '1') {
    const notice = document.createElement('div');
    notice.className = 'mqs-style-notice';
    notice.textContent = `Style ${styleById(currentStyle).name} sélectionné`;
    document.body.appendChild(notice);
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('styleChanged');
    window.history.replaceState({}, '', cleanUrl);
    setTimeout(() => notice.remove(), 2200);
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }
})();

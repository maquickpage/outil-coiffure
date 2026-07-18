/* =============================================================================
   home.js — Logique de la landing MaQuickPage.

   - Tous les boutons "Voir si mon salon..." ouvrent la même modale
   - Modale en 3 étapes : input → loading → résultat (found / notfound)
   - POST /api/landing/check avec google_maps_url + email
   - Animation scroll-driven dans le hero (10 frames jouées 1→10→1 selon scroll)
   ============================================================================= */
(function () {
  'use strict';

  // ===========================================================================
  // ANIMATION HERO (10 frames jouées 1→10→1 toutes les ~10 secondes, ~1s/cycle)
  // - Désynchronisée du scroll
  // - Float CSS permanent géré côté CSS (animation hpFloat)
  // - Respecte prefers-reduced-motion (frame 1 statique, no anim)
  // - Pause quand l'onglet est en arrière-plan (économie CPU/batterie)
  // ===========================================================================
  (function setupHeroAnime() {
    const animeImg = document.getElementById('hp-anime-img');
    if (!animeImg) return;

    const FRAME_NAMES = ['001','003','005','007','009','011','013','015','017','019'];
    const FRAMES_COUNT = FRAME_NAMES.length;
    const FRAME_INTERVAL_MS = 25;     // 25ms × ~18 transitions ≈ 450ms (x2 plus rapide)
    const PAUSE_BETWEEN_MS = 10000;   // attente entre 2 cycles ≈ 10s

    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    // Préchargement des frames (235 KB WebP total)
    const frameUrls = FRAME_NAMES.map(n => `/_assets/landing/anime/logo-${n}.webp`);
    frameUrls.forEach(url => { const i = new Image(); i.src = url; });

    let currentFrame = 0;
    let cycleTimer = null;        // setInterval handle (le cycle de frames)
    let nextCycleTimer = null;    // setTimeout handle (attente entre cycles)

    function setFrame(idx) {
      if (idx === currentFrame) return;
      currentFrame = idx;
      animeImg.src = frameUrls[idx];
    }

    /** Joue 1 cycle complet : frame 0→9→0 sur ~1s, puis programme le prochain à +10s. */
    function playOneCycle() {
      if (cycleTimer) return; // cycle déjà en cours
      let i = 0, dir = 1;
      setFrame(0);
      cycleTimer = setInterval(() => {
        i += dir;
        if (i >= FRAMES_COUNT - 1) {
          dir = -1;
          setFrame(FRAMES_COUNT - 1);
        } else if (i <= 0 && dir === -1) {
          setFrame(0);
          clearInterval(cycleTimer);
          cycleTimer = null;
          // Schedule next cycle dans ~10s
          nextCycleTimer = setTimeout(playOneCycle, PAUSE_BETWEEN_MS);
        } else {
          setFrame(i);
        }
      }, FRAME_INTERVAL_MS);
    }

    function stopAnim() {
      if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
      if (nextCycleTimer) { clearTimeout(nextCycleTimer); nextCycleTimer = null; }
    }

    // Pause quand l'onglet n'est pas visible (économie CPU/batterie)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAnim();
      else if (!cycleTimer && !nextCycleTimer) playOneCycle();
    });

    // Premier cycle après un court délai pour que la page soit posée
    setTimeout(playOneCycle, 1500);
  })();


  const $ = (id) => document.getElementById(id);

  // === Suivi funnel landing (best-effort, jamais bloquant) ===
  // window.mqsTrack est fourni par /_assets/track.js ; absent → no-op.
  const track = (ev, meta) => { try { window.mqsTrack && window.mqsTrack(ev, meta || null); } catch (e) { /* silencieux */ } };

  // Beacon « vrai navigateur » : envoyé dès le chargement. Distingue les humains
  // (JS exécuté) du bruit serveur (bots/scanners qui ne lancent jamais le JS —
  // le landing_view serveur les compte tous). Porte la provenance : hostname du
  // referrer (null = accès direct / favori / lien app).
  (function trackReady() {
    let ref = null;
    try { if (document.referrer) ref = new URL(document.referrer).hostname; } catch (e) { /* silencieux */ }
    track('landing_ready', { ref });
  })();

  // Profondeur de scroll : renvoie le maximum seulement s'il a progressé depuis
  // le dernier masquage (un retour d'app mobile ne fige plus la première valeur).
  (function setupScrollDepth() {
    let maxPct = 0, sentPct = 0;
    function onScroll() {
      const doc = document.documentElement;
      const scrollable = (doc.scrollHeight - doc.clientHeight);
      const pct = scrollable > 0 ? Math.round((doc.scrollTop || window.pageYOffset || 0) / scrollable * 100) : 100;
      if (pct > maxPct) maxPct = Math.min(100, pct);
    }
    function flush() {
      if (maxPct <= sentPct) return;
      sentPct = maxPct;
      track('landing_scroll', { pct: maxPct });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    onScroll();
  })();

  // === État ===
  let opened = false;

  // === Refs ===
  const modal = $('hp-modal');
  const modalClose = $('hp-modal-close');
  const form = $('hp-form');
  const inputUrl = $('hp-input-url');
  const inputEmail = $('hp-input-email');
  const submitBtn = $('hp-submit');
  const formError = $('hp-form-error');
  const stepInput = modal.querySelector('[data-step="input"]');
  const stepLoading = modal.querySelector('[data-step="loading"]');
  const stepFound = modal.querySelector('[data-step="found"]');
  const stepNotFound = modal.querySelector('[data-step="notfound"]');
  const foundTitle = $('hp-found-title');
  const foundMsg = $('hp-found-msg');
  const foundLink = $('hp-found-link');
  const notFoundClose = $('hp-notfound-close');

  // === Open / Close ===
  function openModal() {
    if (opened) return;
    opened = true;
    track('landing_check_open');
    modal.hidden = false;
    showStep('input');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => modal.classList.add('hp-modal-open'));
    });
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onEsc);
    setTimeout(() => inputUrl?.focus(), 250);
  }

  function closeModal() {
    if (!opened) return;
    opened = false;
    modal.classList.remove('hp-modal-open');
    document.removeEventListener('keydown', onEsc);
    document.body.style.overflow = '';
    setTimeout(() => {
      modal.hidden = true;
      // Reset form
      form.reset();
      formError.hidden = true;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Rechercher mon salon';
      showStep('input');
    }, 280);
  }

  function onEsc(e) { if (e.key === 'Escape') closeModal(); }

  // === Step navigation ===
  function showStep(name) {
    [stepInput, stepLoading, stepFound, stepNotFound].forEach(el => {
      el.hidden = el.dataset.step !== name;
    });
  }

  // === Form submit ===
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const googleUrl = (inputUrl.value || '').trim();
    const email = (inputEmail.value || '').trim().toLowerCase();

    // Validation client-side basique (server-side fait le vrai check)
    if (!googleUrl) {
      return showError('Collez le lien Google Maps de votre salon.');
    }
    if (!/google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs/i.test(googleUrl)) {
      return showError('Ce lien ne semble pas venir de Google Maps. Suivez le mini-tuto ci-dessus.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return showError('Entrez une adresse e-mail valide.');
    }

    formError.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '…';
    track('landing_check_submit');
    showStep('loading');

    try {
      const res = await fetch('/api/landing/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ google_maps_url: googleUrl, email }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showStep('input');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Rechercher mon salon';
        return showError(data.error || 'Une erreur est survenue. Réessayez dans quelques minutes.');
      }

      if (data.found) {
        // Salon trouvé : affiche le bouton Visiter
        const ville = data.ville ? ` à ${data.ville}` : '';
        foundTitle.textContent = `${data.salon_name || 'Votre salon'}${ville}`;
        foundMsg.textContent = data.message || 'Votre site démo est prêt.';
        foundLink.href = data.demo_url;
        showStep('found');
      } else {
        // Pas trouvé : ajout à la waitlist
        showStep('notfound');
      }
    } catch (err) {
      console.error(err);
      showStep('input');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Rechercher mon salon';
      showError('Erreur réseau. Vérifiez votre connexion et réessayez.');
    }
  });

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

  // === Wire-up des CTAs ===
  ['hp-cta-nav', 'hp-cta-hero', 'hp-cta-coverage', 'hp-cta-pricing'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const which = id.replace('hp-cta-', ''); // nav | hero | coverage | pricing
    el.addEventListener('click', () => { track('landing_cta', { which }); openModal(); });
  });

  modalClose.addEventListener('click', closeModal);
  notFoundClose.addEventListener('click', closeModal);

  // Backdrop click
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // Auto-focus input lorsqu'on ouvre les 4 CTAs
})();

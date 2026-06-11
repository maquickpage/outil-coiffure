/* =============================================================================
   Modal pricing — script standalone exposant window.MqsPricingModal
   Etat machine 3 steps :
     A : choix d'un des 3 plans (TWO_YEAR / ONE_YEAR / FLEX)
     B : choix du domaine (suggestions GPT pre-generees + check OVH temps reel)
     C : email + redirection Stripe Checkout
   ============================================================================= */

(function () {
  'use strict';

  // === Configuration des plans (synchronisee avec Stripe price metadata) ===
  const PLANS = [
    {
      key: 'TWO_YEAR',
      eyebrow: 'Engagement 2 ans',
      monthlyPriceTtc: 9.90,
      description: 'Le meilleur tarif sur 24 mois.',
      cta: 'Choisir',
      isPopular: false,
      features: [
        'Site 100 % personnalisable',
        'Domaine .fr ou .com offert',
        'Hébergement haute performance',
      ],
    },
    {
      key: 'ONE_YEAR',
      eyebrow: 'Le plus choisi',
      monthlyPriceTtc: 17.90,
      description: 'Engagement 12 mois, le bon compromis.',
      cta: 'Choisir',
      isPopular: true,
      features: [
        'Site 100 % personnalisable',
        'Domaine .fr ou .com offert',
        'Hébergement haute performance',
      ],
    },
    {
      key: 'FLEX',
      eyebrow: 'Sans engagement',
      monthlyPriceTtc: 29.00,
      description: 'Résiliable à tout moment.',
      cta: 'Choisir',
      isPopular: false,
      features: [
        'Site 100 % personnalisable',
        'Domaine .fr ou .com offert',
        'Hébergement haute performance',
      ],
    },
  ];

  // === Version des CGV en cours ===
  // Bumper cette version à chaque modification substantielle des CGV pour forcer
  // une nouvelle acceptation explicite (et tracer l'historique en base).
  const CGV_VERSION = '1.0';

  // === Mapping plan → fichier CGV ===
  const CGV_FILES = {
    TWO_YEAR: '/legal/cgv-2y.html',
    ONE_YEAR: '/legal/cgv-1y.html',
    FLEX: '/legal/cgv-flex.html',
  };

  // === Etat de la modal ===
  const state = {
    modalEl: null,
    step: 'A',                // 'A' | 'B' | 'C'
    selectedPlan: null,       // ex 'TWO_YEAR'
    selectedHostname: null,   // ex 'salonjean.fr'
    selectedHostnameInfo: null, // { hostname, priceEurTtc, isIncluded, supplementEurTtc }
    suggestions: [],          // resultats /api/domain/suggestions/:slug
    customResult: null,       // dernier resultat /api/domain/check-custom
    customError: null,
    customQuery: '',          // dernière saisie utilisateur (pour la garder visible en cas d'erreur)
    loading: false,
    email: '',
    cgvAccepted: false,       // case CGV cochée
    submitting: false,
    salonSlug: null,
  };

  // === Utils ===
  function formatEur(amount) {
    if (amount == null) return '?';
    return amount.toFixed(2).replace('.', ',') + ' €';
  }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getSlugFromUrl() {
    // Match /preview/{slug} (site public) ET /admin/{slug} (menu d'édition coiffeur).
    // Le slug est toujours le 2ème segment de l'URL dans les deux cas.
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    const parts = path.split('/');
    if ((parts[0] === 'preview' || parts[0] === 'admin') && parts[1]) return parts[1];
    return null;
  }

  function planByKey(key) {
    return PLANS.find(p => p.key === key);
  }

  // ===========================================================================
  // RENDERING (re-render full modal content on step change)
  // ===========================================================================

  function renderModal() {
    if (!state.modalEl) return;
    const inner = state.modalEl.querySelector('#mqs-modal');
    if (!inner) return;

    // Préserve le scroll de la liste de domaines (Step B) à travers les
    // re-renders. Sans ça, cliquer pour sélectionner un domaine après scroll
    // remettait l'utilisateur tout en haut de la liste — il perdait de vue
    // le domaine qu'il venait de choisir.
    const prevList = inner.querySelector('.mqs-domain-list');
    const savedListScrollTop = prevList ? prevList.scrollTop : 0;
    const wasOnStepB = !!prevList;

    inner.innerHTML = `
      <button id="mqs-modal-close" type="button" aria-label="Fermer">
        <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      ${state.step === 'A' ? renderStepA() : ''}
      ${state.step === 'B' ? renderStepB() : ''}
      ${state.step === 'C' ? renderStepC() : ''}
    `;
    bindStepEvents();

    // Restore scroll uniquement si on était ET qu'on reste sur Step B
    // (transitions A→B / B→C / B→A : on veut scrollTop=0 = comportement par défaut)
    if (wasOnStepB && state.step === 'B' && savedListScrollTop > 0) {
      const newList = inner.querySelector('.mqs-domain-list');
      if (newList) newList.scrollTop = savedListScrollTop;
    }
  }

  // ---------- STEP A : choix du plan ----------
  function renderStepA() {
    const plansHtml = PLANS.map(p => renderPlanCardA(p)).join('');
    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 1 / 3</span>
        <h2 class="mqs-step-title">Choisissez votre formule</h2>
        <p class="mqs-step-sub">
          Tous les plans incluent le site, le domaine, l'hébergement
          et le support — sans frais de mise en place.
        </p>
      </div>
      <div class="mqs-plans">${plansHtml}</div>
      <div class="mqs-modal-footer">
        <p class="mqs-trust">
          <strong>Sans frais de mise en place</strong> · Site en ligne sous 5 minutes ·
          Hébergé en Europe
        </p>
      </div>
    `;
  }

  function renderPlanCardA(plan) {
    const featuresHtml = plan.features.map(f => `
      <li>
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${escapeHtml(f)}</span>
      </li>
    `).join('');
    const classes = ['mqs-plan'];
    if (plan.isPopular) classes.push('mqs-plan-popular');
    return `
      <div class="${classes.join(' ')}" data-plan="${plan.key}">
        <span class="mqs-plan-eyebrow">${escapeHtml(plan.eyebrow)}</span>
        <div class="mqs-plan-price-line">
          <span class="mqs-plan-price">${formatEur(plan.monthlyPriceTtc)}</span>
          <span class="mqs-plan-period">/mois</span>
        </div>
        <p class="mqs-plan-description">${escapeHtml(plan.description)}</p>
        <button class="mqs-plan-cta" type="button" data-plan-cta="${plan.key}">${escapeHtml(plan.cta)}</button>
        <ul class="mqs-plan-features">${featuresHtml}</ul>
      </div>
    `;
  }

  // ---------- STEP B : choix du domaine ----------
  function renderStepB() {
    const plan = planByKey(state.selectedPlan);
    if (!plan) return '<p>Erreur : plan non sélectionné.</p>';

    // Toutes les suggestions sont rendues — l'affichage est limité à 4 rows
    // visibles via CSS (max-height + overflow-y auto), pour que la modale ne
    // grandisse pas verticalement et reste tenable sans scroll global.
    let suggestionsHtml = '';
    if (state.loading && state.suggestions.length === 0) {
      // Phase initiale, on n'a même pas le preview → skeleton (4 rows pour
      // matcher la fenêtre visible)
      suggestionsHtml = renderSkeletonRows(4);
    } else if (state.suggestions.length === 0) {
      suggestionsHtml = `
        <p class="mqs-empty-state">
          Aucune suggestion disponible pour le moment. Tape ton propre nom ci-dessous.
        </p>`;
    } else {
      // On a au moins le preview (noms visibles, available=null → spinner par row)
      // OU le résultat complet (available=true/false → badge réel)
      suggestionsHtml = state.suggestions.map(s => renderDomainRow(s, plan)).join('');
    }

    const customRow = renderCustomRow(plan);
    const continueDisabled = state.selectedHostname ? '' : 'disabled';

    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 2 / 3</span>
        <h2 class="mqs-step-title">Comment vos clients vous trouveront</h2>
        <p class="mqs-step-sub">
          Choisissez votre adresse web — on s'occupe du reste.
        </p>
      </div>

      <div class="mqs-domain-list">
        ${suggestionsHtml}
      </div>

      <div class="mqs-domain-divider">ou</div>

      ${customRow}

      <div class="mqs-modal-footer mqs-footer-stepb">
        <button class="mqs-btn-back" type="button" id="mqs-back-btn">← Retour</button>
        <button class="mqs-btn-continue" type="button" id="mqs-continue-btn" ${continueDisabled}>
          Continuer →
        </button>
      </div>

      <p class="mqs-trust">
        🔒 Domaine offert · Renouvelable · Hébergé en Europe
      </p>
    `;
  }

  function renderSkeletonRows(n) {
    let html = '';
    for (let i = 0; i < n; i++) {
      html += `
        <div class="mqs-domain-row mqs-skeleton">
          <span class="mqs-skel-text"></span>
          <span class="mqs-skel-badge"></span>
        </div>`;
    }
    return html;
  }

  function renderDomainRow(s, plan) {
    const isSelected = state.selectedHostname === s.hostname;
    const isPending = s.available === null || s.available === undefined;
    const taken = s.available === false;
    let badge;
    if (isPending) {
      badge = `<span class="mqs-badge mqs-badge-pending"><span class="mqs-mini-spinner"></span> Vérification…</span>`;
    } else if (taken) {
      badge = `<span class="mqs-badge mqs-badge-pris">Déjà pris</span>`;
    } else {
      badge = `<span class="mqs-badge mqs-badge-offert">Offert</span>`;
    }
    const classes = ['mqs-domain-row'];
    if (isSelected) classes.push('mqs-domain-selected');
    if (taken) classes.push('mqs-domain-taken');
    if (isPending) classes.push('mqs-domain-pending');
    const interactive = (taken || isPending)
      ? `aria-disabled="true"`
      : `role="button" tabindex="0"`;
    return `
      <div class="${classes.join(' ')}" data-hostname="${escapeHtml(s.hostname)}" ${interactive}>
        <span class="mqs-domain-name">${escapeHtml(s.hostname)}</span>
        ${badge}
      </div>
    `;
  }

  function renderCustomRow(plan) {
    let resultHtml = '';
    if (state.customError) {
      resultHtml = `<p class="mqs-custom-error">${escapeHtml(state.customError)}</p>`;
    } else if (state.customResult) {
      const r = state.customResult;
      if (!r.available) {
        // Erreur spécifique selon la raison
        let msg = '❌ Ce nom n\'est pas disponible. Essayez-en un autre.';
        if (r.reason === 'tld_not_allowed') msg = '❌ Seules les extensions .fr et .com sont supportées.';
        else if (r.reason === 'price_too_high') msg = '❌ Ce domaine est en tarif premium. Choisissez-en un autre ou contactez-nous.';
        else if (r.reason && r.reason.startsWith('transfer')) msg = '❌ Ce domaine est déjà enregistré. Choisissez-en un autre.';
        resultHtml = `<p class="mqs-custom-error">${escapeHtml(msg)}</p>`;
      } else {
        const isSelected = state.selectedHostname === r.hostname;
        // Tout domaine accepté est offert
        const badge = `<span class="mqs-badge mqs-badge-offert">Offert</span>`;
        resultHtml = `
          <div class="mqs-domain-row ${isSelected ? 'mqs-domain-selected' : ''}" data-hostname="${escapeHtml(r.hostname)}" role="button" tabindex="0">
            <span class="mqs-domain-name">${escapeHtml(r.hostname)}</span>
            ${badge}
          </div>
        `;
      }
    }

    // On ouvre le volet automatiquement s'il y a déjà une saisie/résultat,
    // pour ne pas masquer l'interaction en cours.
    const isOpen = state.customResult || state.customError || state.customQuery;
    return `
      <details class="mqs-custom-block" ${isOpen ? 'open' : ''}>
        <summary class="mqs-custom-toggle">
          <span class="mqs-custom-toggle-icon" aria-hidden="true">＋</span>
          <span class="mqs-custom-toggle-label">Choisir mon nom de domaine moi-même</span>
        </summary>
        <div class="mqs-custom-content">
          <div class="mqs-custom-input-row">
            <input
              type="text"
              id="mqs-custom-input"
              class="mqs-custom-input"
              placeholder="monsalon"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(state.customQuery || '')}"
            />
            <select id="mqs-custom-tld" class="mqs-custom-tld">
              <option value=".fr">.fr</option>
              <option value=".com">.com</option>
            </select>
            <button id="mqs-custom-check-btn" type="button" class="mqs-btn-check">Vérifier</button>
          </div>
          <div class="mqs-custom-result">${resultHtml}</div>
        </div>
      </details>
    `;
  }

  // ---------- STEP C : email + paiement ----------
  function renderStepC() {
    const plan = planByKey(state.selectedPlan);
    const hostname = state.selectedHostname;
    const info = state.selectedHostnameInfo;
    const supplementLabel = 'Domaine offert';
    const cgvUrl = CGV_FILES[state.selectedPlan] || '/legal/cgv-flex.html';
    const cgvLabel = state.selectedPlan === 'TWO_YEAR'
      ? 'Conditions Générales de Vente (engagement 2 ans)'
      : state.selectedPlan === 'ONE_YEAR'
        ? 'Conditions Générales de Vente (engagement 1 an)'
        : 'Conditions Générales de Vente (sans engagement)';

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email);
    const submitDisabled = (state.submitting || !emailValid || !state.cgvAccepted) ? 'disabled' : '';

    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 3 / 3</span>
        <h2 class="mqs-step-title">Dernière étape : votre email</h2>
        <p class="mqs-step-sub">
          On vous envoie le récapitulatif et l'accès à votre espace après paiement.
        </p>
      </div>

      <div class="mqs-summary">
        <div class="mqs-summary-row">
          <span class="mqs-summary-label">Formule</span>
          <span class="mqs-summary-value">${escapeHtml(plan.eyebrow)} · ${formatEur(plan.monthlyPriceTtc)}/mois</span>
        </div>
        <div class="mqs-summary-row">
          <span class="mqs-summary-label">Domaine</span>
          <span class="mqs-summary-value">${escapeHtml(hostname)}</span>
        </div>
        <div class="mqs-summary-row mqs-summary-note">
          <span class="mqs-summary-label">&nbsp;</span>
          <span class="mqs-summary-sub">${escapeHtml(supplementLabel)}</span>
        </div>
      </div>

      <div class="mqs-email-block">
        <label class="mqs-custom-label" for="mqs-email-input">Votre email</label>
        <input
          type="email"
          id="mqs-email-input"
          class="mqs-custom-input mqs-email-input"
          placeholder="vous@example.com"
          value="${escapeHtml(state.email)}"
          autocomplete="email"
          required
        />
      </div>

      <div class="mqs-cgv-block">
        <label class="mqs-cgv-label" for="mqs-cgv-checkbox">
          <input
            type="checkbox"
            id="mqs-cgv-checkbox"
            class="mqs-cgv-checkbox"
            ${state.cgvAccepted ? 'checked' : ''}
          />
          <span class="mqs-cgv-text">
            J'ai lu et j'accepte les
            <a href="${cgvUrl}" target="_blank" rel="noopener" class="mqs-cgv-link">${escapeHtml(cgvLabel)}</a>.
          </span>
        </label>
      </div>

      <div class="mqs-modal-footer mqs-footer-stepc">
        <button class="mqs-btn-back" type="button" id="mqs-back-btn">← Retour</button>
        <button class="mqs-btn-continue" type="button" id="mqs-submit-btn" ${submitDisabled}>
          ${state.submitting ? '... Redirection vers le paiement' : 'Procéder au paiement →'}
        </button>
      </div>

      <p class="mqs-trust">
        🔒 Paiement sécurisé Stripe · TVA incluse · Conformité RGPD
      </p>
    `;
  }

  // ===========================================================================
  // EVENT BINDING (re-bound on each renderModal call)
  // ===========================================================================

  function bindStepEvents() {
    const m = state.modalEl;
    if (!m) return;
    m.querySelector('#mqs-modal-close')?.addEventListener('click', closeModal);

    if (state.step === 'A') {
      m.querySelectorAll('.mqs-plan-cta').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectPlanAndAdvance(btn.dataset.planCta);
        });
      });
      m.querySelectorAll('.mqs-plan').forEach(card => {
        card.addEventListener('click', (e) => {
          // Click sur la card (hors bouton) sélectionne uniquement (pas avancer)
          if (e.target.closest('.mqs-plan-cta')) return;
          // Pour A on n'a pas de "select-only", on avance directement
          selectPlanAndAdvance(card.dataset.plan);
        });
      });
    }

    if (state.step === 'B') {
      m.querySelector('#mqs-back-btn')?.addEventListener('click', () => goToStep('A'));
      m.querySelector('#mqs-continue-btn')?.addEventListener('click', () => {
        if (state.selectedHostname) {
          try { window.mqsTrack && window.mqsTrack('etape_email', { hostname: state.selectedHostname }); } catch (e) {}
          goToStep('C');
        }
      });
      m.querySelectorAll('.mqs-domain-row[data-hostname]').forEach(row => {
        // Skip les rows "déjà pris" : non-cliquables
        if (row.classList.contains('mqs-domain-taken') || row.getAttribute('aria-disabled') === 'true') return;
        row.addEventListener('click', () => selectDomain(row.dataset.hostname));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectDomain(row.dataset.hostname);
          }
        });
      });
      m.querySelector('#mqs-custom-check-btn')?.addEventListener('click', onCustomCheck);
      m.querySelector('#mqs-custom-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCustomCheck();
        }
      });
      // Persiste la saisie en cours dans state.customQuery (sans re-render
      // pour ne pas perdre focus/curseur). Garantit que l'input garde sa
      // valeur après les re-render déclenchés par d'autres interactions.
      m.querySelector('#mqs-custom-input')?.addEventListener('input', (e) => {
        state.customQuery = e.target.value;
      });
      // Quand l'utilisateur ferme le volet "custom" manuellement (clic sur
      // la croix du summary), on purge l'état pour qu'aucun message d'erreur
      // périmé ne réapparaisse à la prochaine ouverture / re-render.
      // Invariant : un message d'erreur ne doit JAMAIS être visible avec un
      // champ de recherche vide.
      m.querySelector('.mqs-custom-block')?.addEventListener('toggle', (e) => {
        if (!e.target.open) {
          state.customError = null;
          state.customResult = null;
          state.customQuery = '';
        }
      });
    }

    if (state.step === 'C') {
      m.querySelector('#mqs-back-btn')?.addEventListener('click', () => goToStep('B'));

      // Helper : recompute enable/disable du bouton "Procéder au paiement"
      // (utilisé à la fois par l'event email et par l'event CGV checkbox).
      const refreshSubmitState = () => {
        const btn = m.querySelector('#mqs-submit-btn');
        if (!btn) return;
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email);
        btn.disabled = !emailOk || !state.cgvAccepted || state.submitting;
      };

      const emailInput = m.querySelector('#mqs-email-input');
      if (emailInput) {
        emailInput.addEventListener('input', () => {
          state.email = emailInput.value;
          // Ne pas re-render à chaque keystroke (on garde le focus + cursor)
          refreshSubmitState();
        });
      }

      const cgvCheckbox = m.querySelector('#mqs-cgv-checkbox');
      if (cgvCheckbox) {
        cgvCheckbox.addEventListener('change', () => {
          state.cgvAccepted = cgvCheckbox.checked;
          refreshSubmitState();
        });
      }

      m.querySelector('#mqs-submit-btn')?.addEventListener('click', onSubmitCheckout);
    }

    // Backdrop click ferme la modale
    state.modalEl.addEventListener('click', (e) => {
      if (e.target === state.modalEl) closeModal();
    });
  }

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  async function selectPlanAndAdvance(planKey) {
    const plan = planByKey(planKey);
    if (!plan) return;
    // Tracking (best-effort) : a choisi un plan → arrive sur l'écran domaines.
    try { window.mqsTrack && window.mqsTrack('etape_domaine', { plan: planKey }); } catch (e) {}
    state.selectedPlan = planKey;
    state.step = 'B';
    state.suggestions = [];
    state.selectedHostname = null;
    state.selectedHostnameInfo = null;
    state.customResult = null;
    state.customError = null;
    state.customQuery = '';
    state.loading = true;
    state.suggestions = [];
    // Si l'utilisateur revient en arrière et change de plan, l'acceptation des CGV
    // précédentes ne s'applique plus (chaque plan a un contrat distinct).
    state.cgvAccepted = false;
    renderModal();

    if (!state.salonSlug) state.salonSlug = getSlugFromUrl();
    if (!state.salonSlug) {
      state.loading = false;
      state.customError = 'Erreur : impossible de détecter le salon depuis l\'URL.';
      renderModal();
      return;
    }

    // Étape 1 : preview INSTANTANÉ (juste les noms, pas de check OVH)
    //          → permet d'afficher les domaines avec un spinner par ligne
    //          + pré-remplir l'email du salon (scrappé du CSV) si dispo
    try {
      const preview = await fetch(`/api/domain/suggestions-preview/${encodeURIComponent(state.salonSlug)}`);
      if (preview.ok) {
        const data = await preview.json();
        state.suggestions = data.suggestions || [];
        // Pré-remplit l'email seulement si l'utilisateur n'a pas déjà tapé qqch.
        // (évite d'écraser une saisie en cours s'il revient en arrière depuis Step C).
        if (!state.email && data.salonEmail) {
          state.email = data.salonEmail;
        }
        // available reste null → frontend affichera spinner
        renderModal();
      }
    } catch {} // best-effort, on tombe sur le call suivant si raté

    // Étape 2 : full (avec check OVH, ~5-10s)
    try {
      const res = await fetch(`/api/domain/suggestions/${encodeURIComponent(state.salonSlug)}?plan=${encodeURIComponent(planKey)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        state.loading = false;
        state.customError = err.error || `Erreur ${res.status}`;
        renderModal();
        return;
      }
      const data = await res.json();
      state.suggestions = data.suggestions || [];
      state.loading = false;

      // Pré-sélection du 1er .fr disponible (= pattern UX best-practice)
      const firstFrAvail = state.suggestions.find(s => s.tld === '.fr' && s.available);
      const firstAvail = firstFrAvail || state.suggestions.find(s => s.available);
      if (firstAvail) {
        state.selectedHostname = firstAvail.hostname;
        state.selectedHostnameInfo = firstAvail;
      }
      renderModal();
    } catch (err) {
      state.loading = false;
      state.customError = 'Erreur réseau, réessayez dans 1 minute.';
      renderModal();
    }
  }

  function selectDomain(hostname) {
    // Cherche les infos dans suggestions, sinon dans customResult
    let info = state.suggestions.find(s => s.hostname === hostname);
    const isFromCustom = !info && state.customResult && state.customResult.hostname === hostname;
    if (isFromCustom) {
      info = state.customResult;
    }
    // Refuse la sélection d'un domaine indisponible
    if (info && info.available === false) return;
    state.selectedHostname = hostname;
    state.selectedHostnameInfo = info || null;
    // Si la sélection vient d'une suggestion régulière (pas du résultat custom),
    // on nettoie l'état du volet "custom" pour qu'aucun message d'erreur
    // périmé ne reste affiché (le volet se refermera automatiquement au
    // prochain renderModal car isOpen sera false).
    if (!isFromCustom) {
      state.customError = null;
      state.customResult = null;
      state.customQuery = '';
    }
    renderModal();
  }

  async function onCustomCheck() {
    const m = state.modalEl;
    if (!m) return;
    const input = m.querySelector('#mqs-custom-input');
    const tld = m.querySelector('#mqs-custom-tld').value;
    const raw = (input?.value || '').trim().toLowerCase();
    // Conserve la saisie dans state pour qu'elle reste affichée même après
    // le re-render qui suit (sinon l'input se réinitialiserait à vide alors
    // que le message d'erreur, lui, resterait visible — violation de l'invariant).
    state.customQuery = raw;
    if (!raw) {
      state.customError = 'Tapez un nom avant de vérifier.';
      renderModal();
      return;
    }
    // Concat nom + tld choisi
    const hostname = raw.includes('.') ? raw : `${raw}${tld}`;

    state.customError = null;
    state.customResult = null;
    state.loading = false;
    // Indique loading via le bouton "Vérifier"
    const btn = m.querySelector('#mqs-custom-check-btn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }

    try {
      const res = await fetch('/api/domain/check-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: state.salonSlug,
          plan: state.selectedPlan,
          hostname,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        state.customError = data.error || `Erreur ${res.status}`;
        renderModal();
        return;
      }
      state.customResult = data;
      // Si dispo, on auto-sélectionne ce domaine
      if (data.available) {
        state.selectedHostname = data.hostname;
        state.selectedHostnameInfo = data;
      }
      renderModal();
    } catch (err) {
      state.customError = 'Erreur réseau, réessayez.';
      renderModal();
    }
  }

  async function onSubmitCheckout() {
    if (state.submitting) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email)) return;
    if (!state.cgvAccepted) return;
    // Tracking (best-effort) : a cliqué "Procéder au paiement".
    try { window.mqsTrack && window.mqsTrack('paiement_initie', { plan: state.selectedPlan, hostname: state.selectedHostname }); } catch (e) {}
    state.submitting = true;
    renderModal();

    try {
      const res = await fetch('/api/checkout/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: state.salonSlug,
          plan: state.selectedPlan,
          hostname: state.selectedHostname,
          email: state.email,
          cgv_accepted: true,
          cgv_version: CGV_VERSION,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        state.submitting = false;
        state.customError = data.error || 'Erreur création de session de paiement';
        renderModal();
        return;
      }
      // Redirection vers Stripe Checkout
      window.location.href = data.url;
    } catch (err) {
      state.submitting = false;
      state.customError = 'Erreur réseau lors du paiement.';
      renderModal();
    }
  }

  function goToStep(stepKey) {
    state.step = stepKey;
    renderModal();
  }

  // ===========================================================================
  // OPEN/CLOSE
  // ===========================================================================

  function openModal() {
    if (state.modalEl) return;
    // Reset state à chaque ouverture
    state.step = 'A';
    state.selectedPlan = null;
    state.selectedHostname = null;
    state.selectedHostnameInfo = null;
    state.suggestions = [];
    state.customResult = null;
    state.customError = null;
    state.customQuery = '';
    state.loading = false;
    state.email = '';
    state.cgvAccepted = false;
    state.submitting = false;
    state.salonSlug = getSlugFromUrl();

    const div = document.createElement('div');
    div.id = 'mqs-modal-backdrop';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-modal', 'true');
    div.innerHTML = `<div id="mqs-modal" tabindex="-1"></div>`;
    document.body.appendChild(div);
    state.modalEl = div;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onEscapeKey);

    renderModal();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => state.modalEl.classList.add('mqs-modal-open'));
    });

    // Notifie le banner (top ribbon + bottom bar) de se cacher pendant la modal
    window.dispatchEvent(new CustomEvent('mqs-pricing-modal-open'));

    // Tracking (best-effort) : a ouvert la modale = a vu l'écran des tarifs (étape A).
    try { window.mqsTrack && window.mqsTrack('pricing_ouvert'); } catch (e) {}
  }

  function closeModal() {
    if (!state.modalEl) return;
    state.modalEl.classList.remove('mqs-modal-open');
    document.removeEventListener('keydown', onEscapeKey);
    document.body.style.overflow = '';
    setTimeout(() => {
      if (state.modalEl && state.modalEl.parentNode) {
        state.modalEl.parentNode.removeChild(state.modalEl);
      }
      state.modalEl = null;
    }, 300);
    // Notifie le banner qu'il peut ré-apparaître
    window.dispatchEvent(new CustomEvent('mqs-pricing-modal-close'));
  }

  function onEscapeKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  // === API publique ===
  window.MqsPricingModal = { open: openModal, close: closeModal };
})();

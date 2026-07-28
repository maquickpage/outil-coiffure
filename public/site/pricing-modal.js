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
  // Ordre (brief page-tarifs §5.1) : 12 mois « Le plus choisi » en tête/centre,
  // 24 mois recadré sur l'économie (—66 % vs sans engagement, « Engagement 24 mois »
  // gardé lisible en ligne secondaire — jamais masqué), sans engagement en dernier.
  // Droit commercial commun aux 3 formules : demande possible dans les 30 jours,
  // première mensualité non remboursée, aucun prélèvement ni engagement ensuite.
  const PLANS = [
    {
      key: 'TWO_YEAR',
      title: '24 mois',
      eyebrow: 'Prix le plus bas',
      monthlyPriceTtc: 9.90,
      discount: '−66 %',
      discountReference: 'par rapport au sans engagement à 29 €/mois',
      description: 'Le meilleur tarif si vous savez déjà que vous restez.',
      monthlySaving: '19,10 € par mois',
      saving: '458,40 € sur 24 mois',
      note: 'Engagement 24 mois',
      cta: 'Voir le récapitulatif',
      isPopular: false,
    },
    {
      key: 'ONE_YEAR',
      title: '12 mois',
      eyebrow: 'Le plus choisi',
      monthlyPriceTtc: 17.90,
      discount: '−38 %',
      discountReference: 'par rapport au sans engagement à 29 €/mois',
      description: 'Le bon compromis entre remise et souplesse.',
      monthlySaving: '11,10 € par mois',
      saving: '133,20 € sur 12 mois',
      note: 'Engagement 12 mois',
      cta: 'Voir le récapitulatif',
      isPopular: true,
    },
    {
      key: 'FLEX',
      title: 'Sans engagement',
      eyebrow: 'Liberté totale',
      monthlyPriceTtc: 29.00,
      discount: '',
      discountReference: 'Tarif de référence',
      description: 'Pour garder une liberté totale, mois par mois.',
      monthlySaving: 'Résiliable à tout moment',
      saving: 'Aucune durée minimum',
      note: 'Sans engagement',
      cta: 'Voir le récapitulatif',
      isPopular: false,
    },
  ];

  // === Version des CGV en cours ===
  // Bumper cette version à chaque modification substantielle des CGV pour forcer
  // une nouvelle acceptation explicite (et tracer l'historique en base).
  const CGV_VERSION = '1.1';

  // === Mapping plan → fichier CGV ===
  const CGV_FILES = {
    TWO_YEAR: '/legal/cgv-2y.html',
    ONE_YEAR: '/legal/cgv-1y.html',
    FLEX: '/legal/cgv-flex.html',
  };

  const TEMPLATE_LABELS = Object.fromEntries(
    (window.__MQS_TEMPLATES__ || []).map(template => [template.id, `${template.name} — ${template.subtitle}`])
  );

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
    checkoutError: null,
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

  function isCheckoutDemoMode() {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocal && new URLSearchParams(window.location.search).get('checkoutDemo') === '1';
  }

  function planByKey(key) {
    return PLANS.find(p => p.key === key);
  }

  function currentTemplate() {
    const requested = new URLSearchParams(window.location.search).get('template');
    const fromView = window.__SALON_VIEW__ && window.__SALON_VIEW__.template;
    const validTemplates = new Set(['classic', 'contrast', 'drama']);
    return validTemplates.has(requested) ? requested : (validTemplates.has(fromView) ? fromView : 'classic');
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
      ${renderFunnelTabs()}
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

  function renderFunnelTabs() {
    return `
      <nav class="mqs-funnel-tabs" aria-label="Progression">
        <button type="button" class="${state.step === 'A' ? 'is-active' : ''}" data-funnel-step="A">1 · Domaine</button>
        <button type="button" class="${state.step === 'B' ? 'is-active' : ''}" data-funnel-step="B" ${state.selectedHostname ? '' : 'disabled'}>2 · Formules</button>
        <button type="button" class="${state.step === 'C' ? 'is-active' : ''}" data-funnel-step="C" ${state.selectedPlan ? '' : 'disabled'}>3 · Récapitulatif</button>
      </nav>
    `;
  }

  // ---------- STEP A : choix du domaine (1er — brief page-tarifs : domaine AVANT prix) ----------
  // Ordre décidé : on laisse d'abord le coiffeur s'approprier son adresse web
  // (engagement faible, forte projection) puis on montre le prix à l'étape 2.
  function renderStepA() {
    // Toutes les suggestions sont rendues — l'affichage est limité à 4 rows
    // visibles via CSS (max-height + overflow-y auto).
    let suggestionsHtml = '';
    if (state.loading && state.suggestions.filter(s => s.available === true).length === 0) {
      suggestionsHtml = renderSkeletonRows(4);
    } else if (state.suggestions.filter(s => s.available === true).length === 0) {
      suggestionsHtml = `
        <p class="mqs-empty-state">
          Aucune suggestion vérifiée pour le moment. Recherchez le nom de votre choix.
        </p>`;
    } else {
      suggestionsHtml = state.suggestions
        .filter(s => s.available === true)
        .map(s => renderDomainRow(s, null))
        .join('');
    }

    const customRow = renderCustomRow(null);
    const continueDisabled = state.selectedHostname ? '' : 'disabled';

    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 1 / 3</span>
        <h2 class="mqs-step-title">Choisissez l'adresse de votre site</h2>
        <p class="mqs-step-sub">
          Nous avons déjà vérifié ces suggestions pour vous.
        </p>
        <p class="mqs-domain-offer-note"><s>15 €/an</s> offert avec votre formule.</p>
      </div>

      <section class="mqs-domain-section" aria-labelledby="mqs-suggestions-title">
        <h3 id="mqs-suggestions-title" class="mqs-domain-section-title">Ces adresses web sont disponibles pour vous <span>— En voir plus</span></h3>
        <div class="mqs-domain-list">
          ${suggestionsHtml}
        </div>
      </section>

      <section class="mqs-domain-section mqs-domain-custom-section" aria-labelledby="mqs-custom-title">
        <h3 id="mqs-custom-title" class="mqs-domain-section-title">Vous avez un autre nom en tête ?</h3>
        <p class="mqs-domain-section-help">Recherchez votre propre adresse. Nous vérifierons sa disponibilité en direct.</p>
        ${customRow}
      </section>

      <div class="mqs-modal-footer mqs-footer-stepb mqs-footer-solo">
        <button class="mqs-btn-continue" type="button" id="mqs-continue-btn" ${continueDisabled}>
          ${state.selectedHostname ? 'Continuer →' : 'Voir mes options'}
        </button>
      </div>

    `;
  }

  function renderPlanCardA(plan) {
    const classes = ['mqs-plan'];
    if (plan.isPopular) classes.push('mqs-plan-popular');
    const flexStatus = plan.key === 'TWO_YEAR'
      ? '<p class="mqs-plan-flex-status">Résiliable sans frais pendant 30 jours,<br>puis à l’échéance des 24 mois.</p>'
      : plan.key === 'ONE_YEAR'
        ? '<p class="mqs-plan-flex-status">Résiliable sans frais pendant 30 jours,<br>puis à l’échéance des 12 mois.</p>'
        : '<p class="mqs-plan-flex-status">Résiliable à tout moment.</p>';
    const offerBadge = plan.key === 'FLEX'
      ? '<span class="mqs-plan-discount mqs-plan-freedom">Liberté totale</span>'
      : `<span class="mqs-plan-discount">${escapeHtml(plan.discount)}</span>`;
    return `
      <div class="${classes.join(' ')}" data-plan="${plan.key}">
        <div class="mqs-plan-heading">
          <strong class="mqs-plan-title${plan.key === 'FLEX' ? ' mqs-plan-title-flex' : ''}">${escapeHtml(plan.title)}</strong>
          ${plan.key === 'FLEX' ? '' : `<span class="mqs-plan-eyebrow">${escapeHtml(plan.eyebrow)}</span>`}
        </div>
        <div class="mqs-plan-price-line">
          <span class="mqs-plan-price">${formatEur(plan.monthlyPriceTtc)}</span>
          <span class="mqs-plan-period">TTC / mois</span>
        </div>
        <div class="mqs-plan-offer">${offerBadge}</div>
        ${flexStatus}
        <p class="mqs-plan-description">${escapeHtml(plan.description)}</p>
        <button class="mqs-plan-cta" type="button" data-plan-cta="${plan.key}">${escapeHtml(plan.cta)}</button>
      </div>
    `;
  }

  // ---------- STEP B : choix de la formule (2e — après le domaine) ----------
  function renderStepB() {
    const plansHtml = PLANS.map(p => renderPlanCardA(p)).join('');
    const domainNote = state.selectedHostname
      ? `<p class="mqs-step-domain-note">Votre adresse : <strong>${escapeHtml(state.selectedHostname)}</strong> · offerte</p>`
      : '';
    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 2 / 3</span>
        <h2 class="mqs-step-title">Un site en ligne, sans rien gérer vous-même</h2>
        <p class="mqs-step-sub">
          Nous gérons le domaine, l'hébergement, la maintenance et vos mises à jour.
        </p>
        ${domainNote}
      </div>

      <section class="mqs-value-anchor" aria-label="Offre de lancement">
        <span class="mqs-value-anchor-brand">Offre de lancement</span>
        <h3>Installation &amp; mise en ligne offertes</h3>
        <div class="mqs-value-anchor-line"><span>Création et configuration du site</span><strong>600 €</strong></div>
        <div class="mqs-value-anchor-line"><span>Domaine, connexion et mise en ligne</span><strong>15 €</strong></div>
        <div class="mqs-value-anchor-total"><span>À payer aujourd'hui pour le lancement</span><span class="mqs-launch-price"><s>615 €</s><strong>0 €</strong></span></div>
      </section>

      <div class="mqs-plans-heading"><h3>Choisissez votre durée</h3><p>Le service est le même dans les trois formules. Seule la durée d’engagement change — et donc votre remise sur le tarif sans engagement (29 €/mois).</p></div>

      <div class="mqs-plans">${plansHtml}</div>
      <p class="mqs-plans-footnote">Tarifs TTC par mois. Aucun frais de mise en service.</p>

      <div class="mqs-modal-footer mqs-footer-plan">
        <button class="mqs-btn-back" type="button" id="mqs-back-btn">← Modifier le domaine</button>
      </div>
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
      badge = `<span class="mqs-badge mqs-badge-offert">Disponible · offert</span>`;
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
        const badge = `<span class="mqs-badge mqs-badge-offert">Disponible · offert</span>`;
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
          <span class="mqs-custom-toggle-label">Rechercher mon propre domaine</span>
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
    const cgvUrl = CGV_FILES[state.selectedPlan] || '/legal/cgv-flex.html';
    const cgvLabel = state.selectedPlan === 'TWO_YEAR'
      ? 'Conditions Générales de Vente (engagement 2 ans)'
      : state.selectedPlan === 'ONE_YEAR'
        ? 'Conditions Générales de Vente (engagement 1 an)'
        : 'Conditions Générales de Vente (sans engagement)';

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email);
    const submitDisabled = (state.submitting || !emailValid || !state.cgvAccepted) ? 'disabled' : '';
    const commitmentLabel = state.selectedPlan === 'TWO_YEAR'
      ? 'Engagement 24 mois'
      : state.selectedPlan === 'ONE_YEAR'
        ? 'Engagement 12 mois'
        : 'Sans engagement';
    const commitmentDuration = state.selectedPlan === 'FLEX'
      ? 'sans engagement'
      : state.selectedPlan === 'TWO_YEAR' ? '24 mois' : '12 mois';
    const template = currentTemplate();
    const afterFirstMonth = state.selectedPlan === 'FLEX'
      ? 'Après ces 30 jours, la formule reste résiliable à tout moment, avec effet à la prochaine échéance mensuelle.'
      : `Après ces 30 jours, l’engagement de ${commitmentDuration} prévu par la formule s’applique.`;
    const firstMonthCommitment = state.selectedPlan === 'FLEX'
      ? 'Aucun prélèvement supplémentaire ne sera effectué.'
      : `L’engagement de ${commitmentDuration} sera entièrement levé et aucun prélèvement supplémentaire ne sera effectué.`;

    return `
      <div class="mqs-step-header mqs-payment-header">
        <span class="mqs-step-eyebrow">Étape 3 / 3</span>
        <h2 class="mqs-step-title">Vérifiez avant de continuer</h2>
        <p class="mqs-step-sub">
          Vérifiez votre formule, puis continuez vers le paiement sécurisé Stripe.
        </p>
      </div>

      <div class="mqs-payment-layout">
        <section class="mqs-order-card" aria-label="Récapitulatif de votre abonnement">
          <div class="mqs-order-topline">
            <span class="mqs-order-kicker">Votre formule · ${escapeHtml(plan.title)}</span>
            ${plan.isPopular ? '<span class="mqs-order-popular">Le plus choisi</span>' : ''}
          </div>
          <div class="mqs-order-price-line">
            <strong class="mqs-order-price">${formatEur(plan.monthlyPriceTtc)}</strong>
            <span class="mqs-order-period">TTC / mois</span>
          </div>

          <div class="mqs-order-domain">
            <span class="mqs-order-domain-icon" aria-hidden="true">www</span>
            <span>
              <small>Votre adresse web</small>
              <strong>${escapeHtml(hostname)}</strong>
            </span>
            <span class="mqs-order-included">Offert</span>
          </div>

          <ul class="mqs-order-includes">
            <li><span aria-hidden="true">✓</span> Site personnalisé déjà créé</li>
            <li><span aria-hidden="true">✓</span> Domaine ${escapeHtml(hostname)}</li>
            <li><span aria-hidden="true">✓</span> 3 designs inclus</li>
            <li><span aria-hidden="true">✓</span> Hébergement et maintenance</li>
            <li><span aria-hidden="true">✓</span> Mises à jour</li>
          </ul>
          <div class="mqs-order-installation">
            <span>
              <strong>Installation et mise en ligne</strong>
              <small><s>Valeur 615 €</s></small>
            </span>
            <span class="mqs-order-installation-price"><strong>0 €</strong></span>
          </div>
          <div class="mqs-order-total-wrap">
            <p class="mqs-order-total"><span>À régler sur Stripe aujourd'hui</span><strong>${formatEur(plan.monthlyPriceTtc)}</strong></p>
            <p class="mqs-order-total"><span>Puis</span><strong>${formatEur(plan.monthlyPriceTtc)}/mois</strong></p>
            ${state.selectedPlan === 'FLEX' ? '<p class="mqs-order-total"><span>Résiliation</span><strong>À tout moment</strong></p>' : ''}
            <small>Aucun frais d'installation ajouté au paiement · résiliable selon CGV.</small>
          </div>

          <p class="mqs-first-month-note">
            <strong>Résiliable pendant le premier mois.</strong>
            ${escapeHtml(firstMonthCommitment)}
            <a href="/faq#resiliation" target="_blank" rel="noopener">Voir la FAQ MaQuickPage</a>
          </p>
        </section>

        <section class="mqs-checkout-card" aria-label="Coordonnées et paiement">
          <div class="mqs-checkout-heading">
            <span class="mqs-checkout-lock" aria-hidden="true">
              🔒
            </span>
            <span><strong>Continuer vers Stripe</strong><small>Le clic ne débite pas immédiatement<br>votre carte.</small></span>
          </div>

          <div class="mqs-email-block">
            <label class="mqs-custom-label" for="mqs-email-input">Email professionnel</label>
            <input
              type="email"
              id="mqs-email-input"
              class="mqs-custom-input mqs-email-input"
              placeholder="contact@studio-eclat-lyon.fr"
              value="${escapeHtml(state.email)}"
              autocomplete="email"
              required
            />
            <p class="mqs-email-help">Le reçu et les accès à votre site seront envoyés à cette adresse.</p>
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
                <a href="${cgvUrl}" target="_blank" rel="noopener" class="mqs-cgv-link">Conditions Générales de Vente</a>
                (${state.selectedPlan === 'FLEX' ? 'sans engagement' : `engagement ${commitmentDuration}`}).
              </span>
            </label>
          </div>

          <button class="mqs-payment-cta" type="button" id="mqs-submit-btn" ${submitDisabled}>
            <span>${state.submitting ? 'Redirection en cours...' : `Continuer sur Stripe · ${formatEur(plan.monthlyPriceTtc)} aujourd'hui`}</span>
            ${state.submitting ? '' : '<span aria-hidden="true">→</span>'}
          </button>
          ${state.checkoutError ? `<p class="mqs-checkout-error" role="alert">${escapeHtml(state.checkoutError)}</p>` : ''}
          <p class="mqs-payment-fineprint">Vous pourrez vérifier une dernière fois le montant avant de confirmer. Paiement sécurisé et chiffré par Stripe.</p>
        </section>
      </div>

      <button class="mqs-btn-back mqs-payment-back" type="button" id="mqs-back-btn">← Modifier ma formule</button>
    `;
  }

  // ===========================================================================
  // EVENT BINDING (re-bound on each renderModal call)
  // ===========================================================================

  function bindStepEvents() {
    const m = state.modalEl;
    if (!m) return;
    m.querySelector('#mqs-modal-close')?.addEventListener('click', closeModal);
    m.querySelector('.mqs-drawer-scrim')?.addEventListener('click', closeModal);
    m.querySelector('[data-funnel-step="A"]')?.addEventListener('click', () => goToStep('A'));
    m.querySelector('[data-funnel-step="B"]')?.addEventListener('click', () => goToStep('B'));
    m.querySelector('[data-funnel-step="C"]:not([disabled])')?.addEventListener('click', () => goToStep('C'));

    // STEP A = choix du domaine (1er)
    if (state.step === 'A') {
      m.querySelector('#mqs-continue-btn')?.addEventListener('click', () => {
        if (state.selectedHostname) {
          // Domaine choisi → on montre les tarifs (étape 2). « etape_prix » = a vu
          // les prix (métrique clé du brief : Saw pricing). « etape_domaine » gardé
          // pour la continuité de l'entonnoir admin (stage 4).
          try { window.mqsTrack && window.mqsTrack('etape_domaine', { hostname: state.selectedHostname }); } catch (e) {}
          try { window.mqsTrack && window.mqsTrack('etape_prix', { hostname: state.selectedHostname }); } catch (e) {}
          goToStep('B');
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

    // STEP B = choix de la formule (2e)
    if (state.step === 'B') {
      m.querySelector('#mqs-back-btn')?.addEventListener('click', () => goToStep('A'));
      m.querySelectorAll('.mqs-plan-cta').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectPlanAndGoEmail(btn.dataset.planCta);
        });
      });
      m.querySelectorAll('.mqs-plan').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.mqs-plan-cta')) return;
          selectPlanAndGoEmail(card.dataset.plan);
        });
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
          // Tracking (best-effort) : a coché "J'ai lu et accepté les CGV".
          if (cgvCheckbox.checked) {
            try { window.mqsTrack && window.mqsTrack('cgv_accepte', { plan: state.selectedPlan }); } catch (e) {}
          }
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

  // Le coiffeur a choisi sa formule (étape 2) → écran email/paiement (étape 3).
  function selectPlanAndGoEmail(planKey) {
    const plan = planByKey(planKey);
    if (!plan) return;
    // Changer de plan invalide l'acceptation CGV précédente (contrat distinct par plan).
    if (state.selectedPlan !== planKey) state.cgvAccepted = false;
    state.selectedPlan = planKey;
    state.step = 'C';
    // Tracking (best-effort) : a choisi un plan → arrive sur l'écran email/paiement.
    try { window.mqsTrack && window.mqsTrack('etape_email', { plan: planKey, hostname: state.selectedHostname }); } catch (e) {}
    renderModal();
  }

  // Charge les suggestions de domaine dès l'ouverture (le domaine est la 1re étape).
  // Le plan n'affecte PAS le résultat domaine (toujours offert — cf src/routes/checkout.js),
  // on passe donc un plan par défaut pour l'appel API.
  async function fetchDomainSuggestions() {
    const DEFAULT_PLAN = 'ONE_YEAR';
    if (!state.salonSlug) state.salonSlug = getSlugFromUrl();
    if (!state.salonSlug) {
      state.loading = false;
      state.customError = 'Erreur : impossible de détecter le salon depuis l\'URL.';
      renderModal();
      return;
    }

    // Étape 1 : preview INSTANTANÉ (juste les noms, pas de check OVH)
    //          + pré-remplir l'email du salon (scrappé du CSV) si dispo
    try {
      const preview = await fetch(`/api/domain/suggestions-preview/${encodeURIComponent(state.salonSlug)}`);
      if (preview.ok) {
        const data = await preview.json();
        const previewSuggestions = (data.suggestions || []).map(s => isCheckoutDemoMode()
          ? { ...s, available: true, isIncluded: true, priceEurTtc: 0, supplementEurTtc: 0 }
          : s);
        // L'ouverture depuis la bubble transmet déjà les résultats OVH vérifiés.
        // Ne pas les remplacer par le preview instantané, dont les statuts peuvent
        // être encore indéterminés, avant l'arrivée du résultat OVH complet.
        if (!state.suggestions.some(s => s.available === true)) {
          state.suggestions = previewSuggestions;
        }
        if (!state.email && data.salonEmail) {
          state.email = data.salonEmail;
        }
        if (isCheckoutDemoMode() && state.suggestions[0]) {
          state.selectedHostname = state.suggestions[0].hostname;
          state.selectedHostnameInfo = state.suggestions[0];
          state.loading = false;
        }
        renderModal();
      } else if (isCheckoutDemoMode()) {
        seedCheckoutDemoSuggestions();
      }
    } catch {
      if (isCheckoutDemoMode()) seedCheckoutDemoSuggestions();
    }

    // Démo UI locale : les candidats pré-générés suffisent pour parcourir le
    // funnel. Aucun appel OVH ni achat de domaine n'est effectué.
    if (isCheckoutDemoMode() && state.suggestions.length > 0) return;

    // Étape 2 : full (avec check OVH, ~5-10s)
    try {
      const res = await fetch(`/api/domain/suggestions/${encodeURIComponent(state.salonSlug)}?plan=${DEFAULT_PLAN}`);
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

      // Pré-sélection du 1er .fr disponible (= pattern UX best-practice).
      // Ne pas écraser un choix déjà fait si l'utilisateur a interagi.
      const firstFrAvail = state.suggestions.find(s => s.tld === '.fr' && s.available);
      const firstAvail = firstFrAvail || state.suggestions.find(s => s.available);
      if (firstAvail && !state.selectedHostname) {
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

  function seedCheckoutDemoSuggestions() {
    const safeSlug = String(state.salonSlug || 'mon-salon')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mon-salon';
    state.suggestions = [
      { hostname: `${safeSlug}.fr`, tld: '.fr', available: true, isIncluded: true, priceEurTtc: 0 },
      { hostname: `${safeSlug}-coiffure.fr`, tld: '.fr', available: true, isIncluded: true, priceEurTtc: 0 },
    ];
    state.selectedHostname = state.suggestions[0].hostname;
    state.selectedHostnameInfo = state.suggestions[0];
    state.loading = false;
    renderModal();
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
    // Tracking (best-effort) : a tapé un domaine perso (signal d'intention fort).
    try { window.mqsTrack && window.mqsTrack('domaine_perso', { hostname: hostname }); } catch (e) {}

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
          // Domaine choisi AVANT le plan → plan par défaut (n'affecte pas le résultat).
          plan: state.selectedPlan || 'ONE_YEAR',
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
    state.checkoutError = null;
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
          template: currentTemplate(),
          cgv_accepted: true,
          cgv_version: CGV_VERSION,
          checkout_demo: isCheckoutDemoMode(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        state.submitting = false;
        state.checkoutError = data.error || 'La connexion à Stripe a échoué. Aucun paiement n\'a été effectué. Réessayez dans quelques instants.';
        renderModal();
        return;
      }
      // Redirection vers Stripe Checkout
      window.location.href = data.url;
    } catch (err) {
      state.submitting = false;
      state.checkoutError = 'La connexion à Stripe a échoué. Aucun paiement n\'a été effectué. Réessayez dans quelques instants.';
      renderModal();
    }
  }

  function goToStep(stepKey) {
    state.step = stepKey;
    renderModal();
    const modal = state.modalEl?.querySelector('#mqs-modal');
    if (modal) modal.scrollTop = 0;
  }

  // ===========================================================================
  // OPEN/CLOSE
  // ===========================================================================

  function openModal(source, context) {
    if (state.modalEl) {
      state.modalEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Reset state à chaque ouverture
    state.step = 'A';
    state.selectedPlan = null;
    state.selectedHostname = null;
    state.selectedHostnameInfo = null;
    const seededSuggestions = Array.isArray(context?.verifiedSuggestions)
      ? context.verifiedSuggestions.filter(item => item?.available === true)
      : [];
    state.suggestions = seededSuggestions;
    state.customResult = null;
    state.customError = null;
    state.customQuery = '';
    state.loading = seededSuggestions.length === 0;
    state.email = '';
    state.cgvAccepted = false;
    state.submitting = false;
    state.checkoutError = null;
    state.salonSlug = getSlugFromUrl();
    if (seededSuggestions[0]) {
      state.selectedHostname = seededSuggestions[0].hostname;
      state.selectedHostnameInfo = seededSuggestions[0];
    }
    state.openSource = source || 'unknown';
    state.presentation = window.location.pathname.indexOf('/preview/') === 0 ? 'drawer' : 'modal';

    const div = document.createElement('div');
    div.id = state.presentation === 'drawer' ? 'mqs-pricing-drawer' : 'mqs-modal-backdrop';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-label', 'Choisir un domaine, une formule et mettre le site en ligne');
    div.setAttribute('aria-modal', 'true');
    if (state.presentation === 'drawer') {
      div.innerHTML = `<button class="mqs-drawer-scrim" type="button" aria-label="Fermer les formules"></button><div id="mqs-modal" tabindex="-1"></div>`;
    } else {
      div.innerHTML = `<div id="mqs-modal" tabindex="-1"></div>`;
    }
    document.body.appendChild(div);
    state.modalEl = div;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onEscapeKey);

    renderModal();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        state.modalEl.classList.add('mqs-modal-open');
        state.modalEl.querySelector('#mqs-modal')?.focus({ preventScroll: true });
      });
    });

    // Notifie le banner (top ribbon + bottom bar) de se cacher pendant la modal
    window.dispatchEvent(new CustomEvent('mqs-pricing-modal-open'));

    // Tracking (best-effort) : a ouvert le flow tarifs (étape 1 = domaine).
    try { window.mqsTrack && window.mqsTrack('pricing_ouvert', { source: state.openSource }); } catch (e) {}

    // Charge les domaines suggérés pour l'étape 1 (domaine d'abord).
    fetchDomainSuggestions();
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
      state.presentation = null;
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

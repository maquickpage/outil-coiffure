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
      // 2e ligne de l'option à l'étape 2 : durée + rang commercial.
      optionSub: '24 mois · le plus bas',
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
      optionSub: '12 mois · le plus choisi',
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
      optionSub: 'Résiliable à tout moment',
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
    selectedPlan: null,       // ex 'TWO_YEAR' — formule VALIDÉE (bouton Continuer)
    // Formule mise en surbrillance à l'étape 2, pas encore validée. Cliquer une
    // option ne fait plus basculer d'écran : on choisit, puis on confirme. Sans
    // ça, explorer les prix propulsait à l'étape suivante par accident.
    pendingPlan: null,
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

      <div class="mqs-modal-footer mqs-footer-stepb">
        <button class="mqs-btn-back" type="button" id="mqs-close-btn">← Revenir au site</button>
        <button class="mqs-btn-continue" type="button" id="mqs-continue-btn" ${continueDisabled}>
          ${state.selectedHostname ? 'Continuer →' : 'Voir mes options'}
        </button>
      </div>

    `;
  }

  // ---------- STEP B : choix de la formule (2e — après le domaine) ----------
  function renderStepB() {
    // Point d'entrée unique de l'étape : quel que soit le chemin (bouton de
    // l'étape 1, onglet du haut, retour depuis l'étape 3), une formule est
    // toujours en surbrillance.
    syncPendingPlan();
    return `
      <div class="mqs-step-header">
        <span class="mqs-step-eyebrow">Étape 2 / 3</span>
        <h2 class="mqs-step-title">Choisissez votre formule</h2>
        <p class="mqs-step-sub">
          Création du site, domaine, mise en ligne : offerts. Il ne reste que l’abonnement.
        </p>
      </div>

      <!-- La classe .mqs-value-anchor est conservée : le CSS s'en sert comme
           sélecteur contextuel « je suis à l'étape 2 » (cf. pricing-modal.css,
           bloc #mqs-pricing-drawer:has(.mqs-value-anchor)). Le modificateur
           -compact lui donne sa nouvelle forme, une seule ligne. -->
      <section class="mqs-value-anchor mqs-value-anchor-compact" aria-label="Offre de lancement">
        <span class="mqs-offer-label">Installation et mise en ligne</span>
        <span class="mqs-offer-price"><s>615 €</s><strong>0 €</strong></span>
      </section>

      <div class="mqs-plans-heading"><h3>Combien de temps ?</h3></div>

      <div class="mqs-plan-options">${PLANS.map(renderPlanOption).join('')}</div>
      <p class="mqs-plans-footnote">Vous pouvez tout annuler sous 30 jours, sans frais.</p>

      <!-- Même barre collante qu'à l'étape 1 : le bouton de validation reste
           atteignable quelle que soit la position de scroll. -->
      <div class="mqs-modal-footer mqs-footer-stepb">
        <button class="mqs-btn-back" type="button" id="mqs-back-btn">← Modifier le domaine</button>
        <button class="mqs-btn-continue" type="button" id="mqs-plan-continue-btn">Continuer →</button>
      </div>
    `;
  }

  // Option de formule : prix dominant en haut, durée et rang en dessous, remise
  // en pastille à droite. Deux niveaux plutôt qu'un seul parce qu'en 320 px,
  // tout aligner obligerait à rapetisser le prix — or c'est lui qu'on vient lire.
  function renderPlanOption(plan) {
    const isFlex = plan.key === 'FLEX';
    // Le signe moins est isolé pour pouvoir l'espacer du nombre (cf. .mqs-sign) :
    // collés, « −66 » devient illisible dans une petite pastille.
    const off = isFlex
      ? '<span class="mqs-plan-off is-plain">Liberté<br>totale</span>'
      : `<span class="mqs-plan-off">${plan.discount.replace(/^−/, '<span class="mqs-sign">−</span>')}</span>`;
    const isSelected = state.pendingPlan === plan.key;
    return `
      <button class="mqs-plan-option${isSelected ? ' is-selected' : ''}" type="button"
        data-plan-cta="${plan.key}" aria-pressed="${isSelected}">
        <span class="mqs-plan-option-main">
          <span class="mqs-plan-option-row">
            <span class="mqs-plan-option-price">${formatEur(plan.monthlyPriceTtc)}</span>
            <span class="mqs-plan-option-per">/mois</span>
          </span>
          <span class="mqs-plan-option-sub">${escapeHtml(plan.optionSub)}</span>
        </span>
        ${off}
      </button>
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
      // Libellé court : « Disponible · offert » mangeait la ligne et tronquait
      // le nom de domaine sur mobile. L'info « offert » reste portée par la
      // note « 15 €/an offert avec votre formule » juste au-dessus.
      badge = `<span class="mqs-badge mqs-badge-offert" title="Disponible · offert avec votre formule">Dispo</span>`;
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
        // Tout domaine accepté est offert (libellé court, cf. renderDomainRow)
        const badge = `<span class="mqs-badge mqs-badge-offert" title="Disponible · offert avec votre formule">Dispo</span>`;
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
  // Présentation « ticket de caisse » : à cette étape le coiffeur ne veut plus
  // être convaincu, il veut vérifier un montant. Une colonne de lignes chiffrées
  // se lit en trois secondes.
  function renderStepC() {
    const plan = planByKey(state.selectedPlan);
    const hostname = state.selectedHostname;
    const cgvUrl = CGV_FILES[state.selectedPlan] || '/legal/cgv-flex.html';
    const price = formatEur(plan.monthlyPriceTtc);

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email);
    const canSubmit = !state.submitting && emailValid && state.cgvAccepted;
    const commitmentDuration = state.selectedPlan === 'FLEX'
      ? 'sans engagement'
      : state.selectedPlan === 'TWO_YEAR' ? '24 mois' : '12 mois';

    // Prestations incluses : rattachées à la ligne « Abonnement » qu'elles
    // détaillent, en puces à coche sur 2 lignes plutôt qu'en liste verticale.
    const includes = [
      'Site personnalisé déjà créé',
      '3 designs inclus',
      'Hébergement et maintenance',
      'Mises à jour',
    ];

    return `
      <div class="mqs-step-header mqs-payment-header">
        <span class="mqs-step-eyebrow">Étape 3 / 3</span>
        <h2 class="mqs-step-title">Votre commande</h2>
      </div>

      <div class="mqs-payment-layout">
        <section class="mqs-ticket" aria-label="Récapitulatif de votre abonnement">
          <p class="mqs-ticket-title">Détail</p>
          <div class="mqs-ticket-line">
            <span>Abonnement ${escapeHtml(plan.title)}</span><strong>${price}</strong>
          </div>
          <ul class="mqs-ticket-detail">
            ${includes.map(i => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
          <div class="mqs-ticket-line">
            <span>Domaine ${escapeHtml(hostname)}</span><strong><s>15 €</s>0 €</strong>
          </div>
          <div class="mqs-ticket-line">
            <span>Installation et mise en ligne</span><strong><s>615 €</s>0 €</strong>
          </div>
          <div class="mqs-ticket-rule"></div>
          <div class="mqs-ticket-total">
            <span class="mqs-ticket-total-labels">
              <span>Total aujourd’hui</span>
              <small>puis ${price}/mois</small>
            </span>
            <strong>${price}</strong>
          </div>
          <p class="mqs-ticket-note">Annulable sans frais sous 30 jours.</p>
        </section>

        <section class="mqs-checkout-card" aria-label="Coordonnées et paiement">
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
            <p class="mqs-email-help">Reçu et accès envoyés à cette adresse.</p>
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

          ${state.checkoutError ? `<p class="mqs-checkout-error" role="alert">${escapeHtml(state.checkoutError)}</p>` : ''}
          <p class="mqs-payment-fineprint">Paiement Stripe sécurisé.</p>
          <!-- Rempli au clic sur le bouton verrouillé, pour dire ce qui manque
               au lieu de laisser deviner. -->
          <p class="mqs-payment-hint" id="mqs-payment-hint" role="status" aria-live="polite"></p>
        </section>
      </div>

      <!-- Barre identique aux étapes 1 et 2 : action principale au-dessus,
           retour en dessous, toujours sous le pouce quelle que soit la position
           de scroll. -->
      <div class="mqs-modal-footer mqs-footer-stepb mqs-footer-pay">
        <button class="mqs-btn-back" type="button" id="mqs-back-btn">← Modifier ma formule</button>
        <!-- Volontairement PAS l'attribut disabled : un bouton désactivé
             n'émet aucun clic, on ne pourrait pas expliquer ce qui bloque. -->
        <button class="mqs-payment-cta${canSubmit ? '' : ' is-locked'}" type="button" id="mqs-submit-btn"
          aria-disabled="${canSubmit ? 'false' : 'true'}">
          <!-- Retour à la ligne explicite AVANT le montant : sans lui, le texte
               se coupait n'importe où et séparait le nombre de son symbole €
               (« 17,90 / € aujourd'hui »). Le montant est insécable. -->
          <span>${state.submitting ? 'Redirection en cours...' : `Continuer sur Stripe<br><span class="mqs-payment-cta-amount">${price} aujourd'hui</span>`}</span>
          ${state.submitting ? '' : '<span aria-hidden="true">→</span>'}
        </button>
      </div>
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
      // Le retour de la 1re étape sort du tunnel : même place que « Modifier le
      // domaine » / « Modifier ma formule » aux étapes suivantes.
      m.querySelector('#mqs-close-btn')?.addEventListener('click', closeModal);
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
      // Cliquer une option la met en surbrillance, sans changer d'écran : on
      // met à jour les classes en place plutôt que de re-render, pour ne pas
      // faire sauter le scroll sous le doigt.
      const options = m.querySelectorAll('.mqs-plan-option');
      options.forEach(btn => {
        btn.addEventListener('click', () => {
          state.pendingPlan = btn.dataset.planCta;
          options.forEach(other => {
            const on = other === btn;
            other.classList.toggle('is-selected', on);
            other.setAttribute('aria-pressed', String(on));
          });
        });
      });
      // C'est le bouton de la barre collante qui valide et fait avancer.
      m.querySelector('#mqs-plan-continue-btn')?.addEventListener('click', () => {
        selectPlanAndGoEmail(state.pendingPlan);
      });
    }

    if (state.step === 'C') {
      m.querySelector('#mqs-back-btn')?.addEventListener('click', () => goToStep('B'));
      // Helper : recompute enable/disable du bouton "Procéder au paiement"
      // (utilisé à la fois par l'event email et par l'event CGV checkbox).
      // Le bouton n'est jamais `disabled` : il reste cliquable pour pouvoir
      // dire ce qui manque (cf. onSubmitCheckout). `is-locked` porte l'aspect
      // grisé, `aria-disabled` l'information pour les lecteurs d'écran.
      const refreshSubmitState = () => {
        const btn = m.querySelector('#mqs-submit-btn');
        if (!btn) return;
        const locked = !canSubmitNow();
        btn.classList.toggle('is-locked', locked);
        btn.setAttribute('aria-disabled', String(locked));
        if (!locked) clearPaymentHint();
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
  // Surbrillance de départ à l'étape 2 : la formule déjà validée si l'on
  // revient en arrière, sinon celle mise en avant (« Le plus choisi »).
  function syncPendingPlan() {
    if (state.pendingPlan && planByKey(state.pendingPlan)) return;
    const popular = PLANS.find(p => p.isPopular) || PLANS[0];
    state.pendingPlan = state.selectedPlan || popular.key;
  }

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

  function canSubmitNow() {
    return !state.submitting
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email)
      && state.cgvAccepted;
  }

  function clearPaymentHint() {
    const hint = state.modalEl?.querySelector('#mqs-payment-hint');
    if (hint) hint.textContent = '';
  }

  // Le bouton verrouillé reste cliquable : plutôt que de laisser le coiffeur
  // deviner ce qui bloque, on nomme ce qui manque et on l'emmène au bon champ.
  function showPaymentHint() {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email);
    const hint = state.modalEl?.querySelector('#mqs-payment-hint');
    const message = !emailOk && !state.cgvAccepted
      ? 'Renseignez votre email et acceptez les conditions générales pour continuer.'
      : !emailOk
        ? 'Renseignez votre email professionnel pour continuer.'
        : 'Acceptez les conditions générales de vente pour continuer.';
    if (hint) hint.textContent = message;

    // On repart d'une ardoise propre : sans ça, un second clic rapide laissait
    // le champ précédent encore surligné en même temps que le nouveau.
    state.modalEl?.querySelectorAll('.mqs-field-attention')
      .forEach(el => el.classList.remove('mqs-field-attention'));

    const target = !emailOk
      ? state.modalEl?.querySelector('#mqs-email-input')
      : state.modalEl?.querySelector('#mqs-cgv-checkbox');
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Sur mobile, focus() ouvrirait le clavier par-dessus la case CGV : on ne
    // le fait que pour le champ email, où c'est justement ce qu'on veut.
    if (!emailOk) target.focus({ preventScroll: true });
    target.classList.add('mqs-field-attention');
    setTimeout(() => target.classList.remove('mqs-field-attention'), 1600);
  }

  async function onSubmitCheckout() {
    if (!canSubmitNow()) {
      if (!state.submitting) showPaymentHint();
      return;
    }
    clearPaymentHint();
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

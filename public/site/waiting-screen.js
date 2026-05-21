/* =============================================================================
   Waiting screen post-paiement Stripe
   - Détecte ?signup=success sur l'URL au chargement
   - Affiche un overlay avec checklist animée
   - Poll /api/signup/status toutes les 3s
   - Quand status=live, redirige vers le live_hostname
   ============================================================================= */

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  if (!params.has('signup')) return;
  const signupResult = params.get('signup'); // 'success' | 'cancelled'
  const sessionId = params.get('session_id');

  const STEPS = [
    { id: 'paid',         label: 'Paiement confirmé' },
    { id: 'domain',       label: 'Achat de votre domaine' },
    { id: 'dns',          label: 'Configuration DNS' },
    { id: 'ssl',          label: 'Génération du certificat HTTPS' },
    { id: 'live',         label: 'Mise en ligne' },
  ];

  function getSlugFromUrl() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    if (parts[0] === 'preview' && parts[1]) return parts[1];
    return null;
  }

  function buildOverlay() {
    const div = document.createElement('div');
    div.id = 'mqs-waiting-overlay';
    div.innerHTML = `
      <div class="mqs-waiting-card">
        ${signupResult === 'cancelled' ? renderCancelled() : renderProvisioning()}
      </div>
    `;
    return div;
  }

  function renderCancelled() {
    return `
      <h2 class="mqs-waiting-title">Paiement annulé</h2>
      <p class="mqs-waiting-sub">
        Aucun débit n'a été effectué. Vous pouvez retenter à tout moment.
      </p>
      <button id="mqs-waiting-close" class="mqs-waiting-cta" type="button">Fermer</button>
    `;
  }

  function renderProvisioning() {
    const stepsHtml = STEPS.map((s, i) => `
      <li class="mqs-waiting-step" data-step="${s.id}">
        <span class="mqs-step-icon"><span class="mqs-spinner"></span></span>
        <span class="mqs-step-label">${s.label}</span>
      </li>
    `).join('');

    return `
      <span class="mqs-waiting-eyebrow">Configuration en cours</span>
      <h2 class="mqs-waiting-title">Votre site arrive…</h2>
      <p class="mqs-waiting-sub">
        Nous configurons votre domaine et votre site.
        Cela prend généralement <strong>moins de 5 minutes</strong>.
      </p>
      <ul class="mqs-waiting-steps">${stepsHtml}</ul>
      <p class="mqs-waiting-note">
        Vous pouvez fermer cette fenêtre — nous vous enverrons un email à la fin.
      </p>
    `;
  }

  function setStepDone(id) {
    const el = document.querySelector(`.mqs-waiting-step[data-step="${id}"]`);
    if (!el) return;
    el.classList.add('mqs-step-done');
    el.classList.remove('mqs-step-active');
    const icon = el.querySelector('.mqs-step-icon');
    if (icon) icon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="#10B981" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // Marque une étape comme "en cours" (= spinner visible + classe .mqs-step-active
  // pour mettre en avant la ligne avec un style typo gras et un fond léger).
  function setStepActive(id) {
    const el = document.querySelector(`.mqs-waiting-step[data-step="${id}"]`);
    if (!el || el.classList.contains('mqs-step-done')) return;
    el.classList.add('mqs-step-active');
    const icon = el.querySelector('.mqs-step-icon');
    if (icon) icon.innerHTML = `<span class="mqs-spinner"></span>`;
  }

  function setAllStepsDone() {
    STEPS.forEach(s => setStepDone(s.id));
  }

  // Mapping step backend → UI : quelle étape afficher comme "done" et laquelle
  // est "active" (spinner). Le backend expose ces steps via /api/signup/status.
  //   - init / ovh_register / ovh_poll : achat domaine OVH en cours
  //   - ovh_dns                        : config DNS en cours
  //   - sync_falkenstein               : sync vers le serveur LIVE
  //   - verify_live                    : Caddy obtient le cert + Helsinki poll
  //   - finalize                       : flip subscription_status=live en DB
  //   - done                           : terminé (subscription=live)
  function applyStepProgress(backendStep) {
    setStepDone('paid'); // toujours done à ce stade (la waiting screen démarre après Stripe success)

    const map = {
      init:             { done: [],                              active: 'domain' },
      ovh_register:     { done: [],                              active: 'domain' },
      ovh_poll:         { done: [],                              active: 'domain' },
      ovh_dns:          { done: ['domain'],                      active: 'dns' },
      sync_falkenstein: { done: ['domain', 'dns'],               active: 'ssl' },
      verify_live:      { done: ['domain', 'dns'],               active: 'ssl' },
      finalize:         { done: ['domain', 'dns', 'ssl'],        active: 'live' },
      done:             { done: ['domain', 'dns', 'ssl', 'live'], active: null },
    };
    const m = map[backendStep];
    if (!m) {
      // step inconnu (peut arriver si le job en mémoire a expiré ou serveur restart) :
      // on laisse 'paid' done et on met 'domain' en active par défaut.
      setStepActive('domain');
      return;
    }
    m.done.forEach(id => setStepDone(id));
    if (m.active) setStepActive(m.active);
  }

  function showFinalSuccess(liveHostname) {
    const card = document.querySelector('.mqs-waiting-card');
    if (!card) return;
    card.innerHTML = `
      <div class="mqs-success-icon">
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="#10B981" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h2 class="mqs-waiting-title">Votre site est en ligne</h2>
      <p class="mqs-waiting-sub">
        Votre site est accessible à : <strong>${escapeHtml('https://' + liveHostname)}</strong>
      </p>
      <a href="https://${escapeHtml(liveHostname)}" class="mqs-waiting-cta">Voir mon site →</a>
      <p class="mqs-waiting-note">
        Un email récapitulatif vient de vous être envoyé.
      </p>
    `;
  }

  function showError(msg) {
    const card = document.querySelector('.mqs-waiting-card');
    if (!card) return;
    card.innerHTML = `
      <h2 class="mqs-waiting-title">Configuration en cours</h2>
      <p class="mqs-waiting-sub">
        Nous rencontrons un délai inhabituel. Pas d'inquiétude — un humain prend
        le relais et vous serez contacté(e) par email dans l'heure.
      </p>
      <p class="mqs-waiting-note">${escapeHtml(msg || '')}</p>
      <button id="mqs-waiting-close" class="mqs-waiting-cta" type="button">Fermer</button>
    `;
    document.getElementById('mqs-waiting-close')?.addEventListener('click', closeOverlay);
  }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  let pollInterval = null;
  let elapsedSec = 0;
  // 25 min max (DNS .fr peut prendre jusqu'à 30 min de propagation publique,
  // surtout en cas de cache OS résolveur obsolète chez les resolvers publics).
  const TIMEOUT_SEC = 25 * 60;

  async function pollStatus() {
    elapsedSec += 4;
    if (elapsedSec > TIMEOUT_SEC) {
      clearInterval(pollInterval);
      showError('Configuration plus longue que prévu — vous recevrez un email dès que le site est en ligne (généralement 15-30 min). Vous pouvez fermer cette fenêtre.');
      return;
    }

    const slug = getSlugFromUrl();
    let url = '/api/signup/status?';
    if (sessionId) url += 'session_id=' + encodeURIComponent(sessionId);
    else if (slug) url += 'slug=' + encodeURIComponent(slug);
    else { showError('Slug introuvable.'); clearInterval(pollInterval); return; }

    try {
      const res = await fetch(url);
      if (!res.ok) return; // retry au prochain tick
      const data = await res.json();
      // data : { status, step?, error?, liveHostname?, ... }
      //   - status : 'pending' | 'provisioning' | 'live' | 'error' (depuis subscription_status DB)
      //   - step   : étape détaillée du provisioning en mémoire ('ovh_dns', 'verify_live', etc.)
      //              Peut être null si le job en mémoire n'existe plus (serveur restart, etc.)
      if (data.status === 'live') {
        clearInterval(pollInterval);
        setAllStepsDone();
        setTimeout(() => showFinalSuccess(data.liveHostname), 800);
        return;
      }
      if (data.status === 'error') {
        clearInterval(pollInterval);
        showError(data.error || 'Erreur de configuration côté serveur.');
        return;
      }
      // 'pending' ou 'provisioning' → on update la progression visuelle selon le step réel
      applyStepProgress(data.step);
    } catch (err) {
      // Réseau : retry au prochain tick
    }
  }

  function closeOverlay() {
    const overlay = document.getElementById('mqs-waiting-overlay');
    if (overlay) overlay.remove();
    document.body.style.overflow = '';
    // Cleanup URL pour éviter de re-déclencher au refresh
    const url = new URL(window.location.href);
    url.searchParams.delete('signup');
    url.searchParams.delete('session_id');
    window.history.replaceState({}, document.title, url.toString());
  }

  function start() {
    const overlay = buildOverlay();
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    if (signupResult === 'cancelled') {
      document.getElementById('mqs-waiting-close')?.addEventListener('click', closeOverlay);
      return;
    }

    // Démarre le polling
    pollStatus();
    pollInterval = setInterval(pollStatus, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

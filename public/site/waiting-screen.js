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
        Cela prend généralement <strong>quelques minutes</strong>.
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

  // Écran de sortie "on prend le relais".
  //
  // Volontairement SANS message d'erreur technique : le client vient de payer,
  // afficher "OVH domain xxx not ready within 300000ms" ne lui apprend rien et
  // lui fait croire qu'il a perdu son argent. Ce qu'il doit savoir tient en
  // trois points : son paiement est enregistré, quelqu'un s'en occupe, il sera
  // prévenu par email. Le détail technique reste dans les logs et dans
  // l'alerte admin.
  function showHandoff() {
    const card = document.querySelector('.mqs-waiting-card');
    if (!card) return;
    card.innerHTML = `
      <h2 class="mqs-waiting-title">Votre site arrive — nous prenons le relais</h2>
      <p class="mqs-waiting-sub">
        L'enregistrement de votre adresse web prend plus de temps que d'habitude
        chez notre registrar. <strong>Votre paiement est bien enregistré</strong> et
        votre site est prêt : il attend uniquement son adresse.
      </p>
      <p class="mqs-waiting-note">
        Vous pouvez fermer cette fenêtre. Vous recevrez un email dès que votre site
        est en ligne — en général dans l'heure.
      </p>
      <button id="mqs-waiting-close" class="mqs-waiting-cta" type="button">Fermer</button>
    `;
    document.getElementById('mqs-waiting-close')?.addEventListener('click', closeOverlay);
  }

  // Le registrar traîne mais le provisioning tourne toujours : on garde la
  // checklist et on remplace la promesse "moins de 5 minutes" par la vérité,
  // sinon le client regarde un spinner en se demandant si c'est planté.
  let delayNoticeShown = false;
  function showRegistrarDelayNotice() {
    if (delayNoticeShown) return;
    delayNoticeShown = true;
    const sub = document.querySelector('.mqs-waiting-sub');
    if (sub) {
      sub.innerHTML = `L'enregistrement de votre adresse web prend un peu plus de temps
        que d'habitude. Votre paiement est bien enregistré et votre site est prêt —
        il attend uniquement son adresse.`;
    }
    const note = document.querySelector('.mqs-waiting-note');
    if (note) {
      note.textContent = 'Vous pouvez fermer cette fenêtre : nous vous envoyons un email dès que votre site est en ligne.';
    }
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
      showHandoff();
      return;
    }

    const slug = getSlugFromUrl();
    let url = '/api/signup/status?';
    if (sessionId) url += 'session_id=' + encodeURIComponent(sessionId);
    else if (slug) url += 'slug=' + encodeURIComponent(slug);
    else { showHandoff(); clearInterval(pollInterval); return; }

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
        showHandoff();
        return;
      }
      // 'pending' ou 'provisioning' → on update la progression visuelle selon le step réel
      if (data.registrarDelay) showRegistrarDelayNotice();
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

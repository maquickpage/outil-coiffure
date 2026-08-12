/* =============================================================================
   Écran de retour après paiement Stripe
   - Détecte ?signup=success sur l'URL au chargement
   - Poll /api/signup/status jusqu'à connaître l'adresse du site
   - Affiche « votre site est en ligne » avec le lien pour l'ouvrir

   Il n'y a plus de checklist ni de compte à rebours : le site est publié sur
   son adresse provisoire dans les secondes qui suivent le paiement, et la
   réservation du nom de domaine se termine en arrière-plan. On n'a donc plus
   d'attente à meubler — juste une adresse à annoncer.
   ============================================================================= */

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  if (!params.has('signup')) return;
  const signupResult = params.get('signup'); // 'success' | 'cancelled'
  const sessionId = params.get('session_id');

  function getSlugFromUrl() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    if (parts[0] === 'preview' && parts[1]) return parts[1];
    return null;
  }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function buildOverlay() {
    const div = document.createElement('div');
    div.id = 'mqs-waiting-overlay';
    div.innerHTML = `
      <div class="mqs-waiting-card">
        ${signupResult === 'cancelled' ? renderCancelled() : renderPublishing()}
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

  // État transitoire : quelques secondes, le temps que le serveur publie le
  // site et nous renvoie son adresse.
  function renderPublishing() {
    return `
      <span class="mqs-waiting-eyebrow">Paiement confirmé</span>
      <h2 class="mqs-waiting-title">Mise en ligne de votre site…</h2>
      <p class="mqs-waiting-sub">Encore quelques secondes.</p>
      <p class="mqs-waiting-note"><span class="mqs-spinner"></span></p>
    `;
  }

  const CHECK_ICON = `<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="#10B981" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  /**
   * @param {string} hostname   adresse à ouvrir
   * @param {string|null} finalHostname  domaine définitif encore en cours de
   *        réservation ; absent une fois la bascule faite.
   */
  function showOnline(hostname, finalHostname) {
    const card = document.querySelector('.mqs-waiting-card');
    if (!card) return;
    const pending = finalHostname && finalHostname !== hostname;
    card.innerHTML = `
      <div class="mqs-success-icon">${CHECK_ICON}</div>
      <h2 class="mqs-waiting-title">Votre site est en ligne</h2>
      <p class="mqs-waiting-sub">
        Il est accessible dès maintenant à l'adresse <strong>${escapeHtml(hostname)}</strong>.
      </p>
      <a href="https://${escapeHtml(hostname)}" class="mqs-waiting-cta">Voir mon site →</a>
      <p class="mqs-waiting-note">
        ${pending
          ? `Votre adresse définitive <strong>${escapeHtml(finalHostname)}</strong> est en cours de
             réservation : comptez de quelques minutes à 24 heures. Votre site basculera dessus
             automatiquement, vous n'avez rien à faire. Un email de confirmation vient de vous être envoyé.`
          : `Un email de confirmation vient de vous être envoyé.`}
      </p>
    `;
  }

  // Filet : le serveur n'a pas répondu à temps. Le site est probablement en
  // ligne quand même — l'email fait foi, donc on n'inquiète personne.
  function showEmailFallback() {
    const card = document.querySelector('.mqs-waiting-card');
    if (!card) return;
    card.innerHTML = `
      <h2 class="mqs-waiting-title">Votre paiement est confirmé</h2>
      <p class="mqs-waiting-sub">
        Votre site est en cours de mise en ligne. Vous recevez un email avec son adresse
        dans quelques instants.
      </p>
      <button id="mqs-waiting-close" class="mqs-waiting-cta" type="button">Fermer</button>
    `;
    document.getElementById('mqs-waiting-close')?.addEventListener('click', closeOverlay);
  }

  let pollInterval = null;
  let elapsedSec = 0;
  // Court : on n'attend qu'une écriture en base, pas un registrar.
  const TIMEOUT_SEC = 120;
  const POLL_MS = 2000;

  async function pollStatus() {
    elapsedSec += POLL_MS / 1000;
    if (elapsedSec > TIMEOUT_SEC) {
      clearInterval(pollInterval);
      showEmailFallback();
      return;
    }

    const slug = getSlugFromUrl();
    let url = '/api/signup/status?';
    if (sessionId) url += 'session_id=' + encodeURIComponent(sessionId);
    else if (slug) url += 'slug=' + encodeURIComponent(slug);
    else { clearInterval(pollInterval); showEmailFallback(); return; }

    try {
      const res = await fetch(url);
      if (!res.ok) return; // retry au prochain tick
      const data = await res.json();

      // Bascule déjà faite : on annonce directement le domaine définitif.
      if (data.status === 'live' && data.liveHostname) {
        clearInterval(pollInterval);
        showOnline(data.liveHostname, null);
        return;
      }
      // Cas normal : le site vit sur son adresse provisoire.
      if (data.tempHostname) {
        clearInterval(pollInterval);
        showOnline(data.tempHostname, data.liveHostname);
        return;
      }
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

    pollStatus();
    pollInterval = setInterval(pollStatus, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

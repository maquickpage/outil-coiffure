// Nav admin unifiée : surligne l'onglet courant + traduit les libellés + câble la déconnexion.
// Chargé sur toutes les pages admin. S'appuie sur les data-path des .anav-tab.
(function () {
  var LANG_KEY = 'outil-coiffure-lang';
  var curLang = 'fr';
  try { curLang = localStorage.getItem(LANG_KEY) || 'fr'; } catch (e) {}
  if (curLang !== 'fr' && curLang !== 'en' && curLang !== 'zh') curLang = 'fr';

  // Libellés de navigation par data-path (FR = source ; EN/ZH = traductions).
  // L'emoji fait partie du libellé (conservé tel quel dans chaque langue).
  var NAV_LABELS = {
    '/admin':                    { fr: 'Tableau de bord',  en: 'Dashboard',      zh: '仪表盘' },
    '/admin/photos.html':        { fr: 'Photos',           en: 'Photos',         zh: '照片' },
    '/admin/stats':              { fr: 'Suivi',            en: 'Tracking',       zh: '追踪' },
    '/admin/nouveau-salon.html': { fr: '➕ Nouveau salon', en: '➕ New salon',    zh: '➕ 新增沙龙' },
    '/admin/calling.html':       { fr: '☎️ Prospection',   en: '☎️ Prospecting', zh: '☎️ 电话勘查' }
  };
  var LOGOUT_LABEL = { fr: 'Déconnexion', en: 'Log out', zh: '登出' };

  var path = (location.pathname || '/admin').replace(/\/+$/, '') || '/admin';
  var best = null, bestLen = -1;
  Array.prototype.forEach.call(document.querySelectorAll('.anav-tab'), function (t) {
    var p = (t.getAttribute('data-path') || '').replace(/\/+$/, '');
    if (!p) return;
    // Traduit le libellé de l'onglet selon la langue courante.
    var lbl = NAV_LABELS[p];
    if (lbl && lbl[curLang]) t.textContent = lbl[curLang];
    // Surligne l'onglet courant (data-path le plus spécifique gagne).
    if ((path === p || path.indexOf(p + '/') === 0 || path.indexOf(p) === 0) && p.length > bestLen) {
      best = t; bestLen = p.length;
    }
  });
  if (best) best.classList.add('active');

  var lo = document.getElementById('anav-logout');
  if (lo) {
    if (LOGOUT_LABEL[curLang]) lo.textContent = LOGOUT_LABEL[curLang];
    lo.addEventListener('click', function (e) {
      e.preventDefault();
      fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(function () {})
        .then(function () { location.href = '/admin/login'; });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.anav .lang-btn'), function (b) {
    b.classList.toggle('active', b.getAttribute('data-lang') === curLang);
    b.addEventListener('click', function () {
      try { localStorage.setItem(LANG_KEY, b.getAttribute('data-lang')); } catch (e) {}
      location.reload();
    });
  });
})();

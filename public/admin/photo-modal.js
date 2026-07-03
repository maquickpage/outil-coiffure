/* =====================================================================
   Modale photos salon (héros + galerie + avis IA) — module PARTAGÉ.
   Extrait de stats.html pour être réutilisé par le cockpit calling.html.
   Auto-contenu : injecte son CSS + son HTML au premier open(), possède son
   propre toast. S'appuie sur les endpoints /admin/api/picker/* existants.

   Usage : PhotoModal.open(slug, nomAffiché)
   ===================================================================== */
(function (global) {
  'use strict';

  var CSS = ''
    + '#pm-wrap{position:fixed;inset:0;background:rgba(10,10,10,.62);z-index:190;display:none;align-items:flex-start;justify-content:center;padding:24px 12px;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
    + '#pm-wrap.on{display:flex;}'
    + '#pm{background:#fff;border-radius:16px;max-width:980px;width:100%;box-shadow:0 16px 60px rgba(0,0,0,.35);overflow:hidden;color:#15130E;font-size:15px;line-height:1.4;}'
    + '#pm-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #e7e2d6;position:sticky;top:0;background:#fff;z-index:2;}'
    + '#pm-head .nm{font-weight:800;font-size:16px;}'
    + '#pm-head .sub{font-size:12.5px;color:#8a8270;}'
    + '#pm-close{margin-left:auto;border:none;background:#f0ece1;border-radius:8px;font-size:16px;cursor:pointer;padding:6px 11px;}'
    + '#pm-body{padding:16px 18px;}'
    + '#pm-body .pm-msg{text-align:center;color:#8a8270;padding:40px 20px;}'
    + '.pm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}'
    + '.pm-it{border:1px solid #e7e2d6;border-radius:11px;overflow:hidden;background:#faf8f2;}'
    + '.pm-im{position:relative;aspect-ratio:4/3;cursor:zoom-in;background:#eee;}'
    + '.pm-im img{width:100%;height:100%;object-fit:cover;display:block;}'
    + '.pm-im.ai{outline:3px solid #C8A24B;outline-offset:-3px;}'
    + '.pm-tag{position:absolute;font-size:10px;font-weight:700;border-radius:5px;padding:1px 6px;color:#fff;}'
    + '.pm-tag.star{top:5px;left:5px;background:rgba(168,132,47,.95);}'
    + '.pm-tag.ld{bottom:5px;left:5px;background:rgba(192,57,43,.88);}'
    + '.pm-tag.cur{top:5px;right:5px;background:rgba(19,138,54,.92);}'
    + '.pm-acts{display:flex;align-items:center;gap:6px;padding:7px 8px;}'
    + '.pm-hero-btn{flex:1;border:1.5px solid #e7e2d6;background:#fff;border-radius:7px;padding:5px 8px;font-size:12px;font-weight:700;cursor:pointer;}'
    + '.pm-hero-btn:hover{border-color:#C8A24B;background:#fdf3dc;}'
    + '.pm-gal{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#5b6470;cursor:pointer;user-select:none;}'
    + '#pm-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 18px;border-top:1px solid #e7e2d6;position:sticky;bottom:0;background:#fff;}'
    + '#pm-foot select{padding:7px 9px;border:1.5px solid #e7e2d6;border-radius:8px;font-size:13px;background:#fff;}'
    + '.pm-btn{border:1.5px solid #e7e2d6;background:#fff;border-radius:9px;padding:8px 14px;font-size:13.5px;font-weight:700;cursor:pointer;}'
    + '.pm-btn.gold{background:#C8A24B;border-color:#C8A24B;color:#fff;}'
    + '.pm-btn.danger{color:#c0392b;border-color:#e3b4ae;}'
    + '.pm-btn.danger:hover{background:#fdecea;border-color:#c0392b;}'
    + '.pm-btn:disabled{opacity:.45;cursor:not-allowed;}'
    + '#pm-status{font-size:12.5px;color:#8a8270;}'
    + '#pm-zoom{position:fixed;inset:0;background:rgba(10,10,10,.9);display:none;align-items:center;justify-content:center;z-index:210;cursor:zoom-out;padding:18px;}'
    + '#pm-zoom.on{display:flex;}'
    + '#pm-zoom img{max-width:96vw;max-height:92vh;border-radius:8px;}'
    + '#pm-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(90px);background:#1a1a1a;color:#fff;padding:11px 20px;border-radius:11px;font-size:14px;font-weight:600;transition:transform .25s;z-index:230;max-width:90vw;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
    + '#pm-toast.on{transform:translateX(-50%) translateY(0);}';

  var HTML = ''
    + '<div id="pm">'
    +   '<div id="pm-head">'
    +     '<div><div class="nm" id="pm-nm">…</div><div class="sub" id="pm-sub"></div></div>'
    +     '<button id="pm-close">✕ Fermer</button>'
    +   '</div>'
    +   '<div id="pm-body"><div class="pm-msg">Chargement des photos…</div></div>'
    +   '<div id="pm-foot">'
    +     '<select id="pm-pos"><option value="centre">Cadrage héro : centre</option><option value="haut">Cadrage héro : haut</option><option value="bas">Cadrage héro : bas</option></select>'
    +     '<button class="pm-btn" id="pm-ai">🤖 Avis de l\'IA</button>'
    +     '<button class="pm-btn danger" id="pm-reset" title="Remet le héro et la galerie aux images du mode démo (retire les photos Google appliquées)">↺ Réinitialiser</button>'
    +     '<span style="flex:1"></span>'
    +     '<span id="pm-status"></span>'
    +     '<button class="pm-btn" id="pm-gal-replace" disabled title="Ne garde que les photos cochées (retire les photos du mode démo)">Remplacer la galerie (0)</button>'
    +     '<button class="pm-btn gold" id="pm-gal-add" disabled title="Ajoute les photos cochées en tête de la galerie actuelle (garde les photos déjà en place)">＋ Ajouter à la galerie (0)</button>'
    +   '</div>'
    + '</div>';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var built = false;
  var pmState = { slug: null, photos: [], sel: {}, aiPick: null, heroCurrent: null };

  function toast(m, ms) {
    var t = $('pm-toast'); t.textContent = m; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, ms || 3500);
  }
  function pmApi(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {})).then(function (r) {
      if (r.status === 401) throw new Error('Session expirée — reconnecte-toi à l\'admin.');
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('http ' + r.status)); return j; });
    });
  }

  function ensureDom() {
    if (built) return; built = true;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var wrap = document.createElement('div'); wrap.id = 'pm-wrap'; wrap.innerHTML = HTML; document.body.appendChild(wrap);
    var zoom = document.createElement('div'); zoom.id = 'pm-zoom'; zoom.innerHTML = '<img id="pm-zoom-img" src="" alt="">';
    zoom.onclick = function () { zoom.classList.remove('on'); };
    document.body.appendChild(zoom);
    var tst = document.createElement('div'); tst.id = 'pm-toast'; document.body.appendChild(tst);

    $('pm-close').onclick = function () { wrap.classList.remove('on'); };
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.classList.remove('on'); });
    $('pm-gal-add').onclick = function () { applyGalleryMode('append'); };
    $('pm-gal-replace').onclick = function () { applyGalleryMode('replace'); };
    $('pm-reset').onclick = function () {
      if (!confirm('Réinitialiser les photos de ce salon ?\n\nLe héro et la galerie repassent aux images du mode démo, et les photos Google que tu as appliquées sont retirées.\n\n(Les autres réglages du site — services, avis, contact — ne changent pas.)')) return;
      var b = $('pm-reset'); b.disabled = true; b.textContent = 'Réinitialisation…';
      $('pm-status').textContent = 'Retour aux images de démo…';
      pmApi('/admin/api/picker/salon/' + encodeURIComponent(pmState.slug) + '/reset-images', { method: 'POST' })
        .then(function (r) {
          toast(r.changed ? 'Photos réinitialisées (mode démo) ✓ — screenshot en recapture' : 'Déjà en mode démo, rien à réinitialiser');
          open(pmState.slug, $('pm-nm').textContent); // recharge l'état démo
        })
        .catch(function (e) { toast('Erreur : ' + e.message); $('pm-status').textContent = ''; b.disabled = false; b.textContent = '↺ Réinitialiser'; });
    };
    $('pm-ai').onclick = function () {
      var b = $('pm-ai'); b.disabled = true; b.textContent = '🤖 Analyse en cours…';
      $('pm-status').textContent = 'L\'IA examine les photos (~15-30 s)…';
      pmApi('/admin/api/picker/salon/' + encodeURIComponent(pmState.slug) + '/score', { method: 'POST' })
        .then(function (r) {
          b.disabled = false; b.textContent = '🤖 Avis de l\'IA';
          var res = r.result || {};
          pmState.aiPick = res.selected_photo_id ? { photo_id: res.selected_photo_id, reasoning: res.reasoning } : { photo_id: null, reasoning: res.reasoning || res.overall_assessment };
          $('pm-status').textContent = res.selected_photo_id ? '⭐ L\'IA a choisi' : 'L\'IA : aucune photo idéale';
          renderPm();
        })
        .catch(function (e) { b.disabled = false; b.textContent = '🤖 Avis de l\'IA'; $('pm-status').textContent = ''; toast('Erreur IA : ' + e.message); });
    };
  }

  function open(slug, name) {
    ensureDom();
    pmState = { slug: slug, photos: [], sel: {}, aiPick: null, heroCurrent: null };
    $('pm-nm').textContent = name || slug;
    $('pm-sub').textContent = slug;
    $('pm-status').textContent = '';
    $('pm-body').innerHTML = '<div class="pm-msg">Chargement des photos…</div>';
    $('pm-wrap').classList.add('on');
    pmApi('/admin/api/picker/salon/' + encodeURIComponent(slug) + '/photos').then(function (j) {
      pmState.photos = j.photos || []; pmState.aiPick = j.ai_pick; pmState.heroCurrent = j.hero_current;
      if (j.reason && !pmState.photos.length) { $('pm-body').innerHTML = '<div class="pm-msg">' + esc(j.reason) + '</div>'; updateGalBtn(); return; }
      renderPm();
    }).catch(function (e) { $('pm-body').innerHTML = '<div class="pm-msg">Erreur : ' + esc(e.message) + '</div>'; });
  }

  function renderPm() {
    var ph = pmState.photos;
    if (!ph.length) { $('pm-body').innerHTML = '<div class="pm-msg">Aucune photo scrapée trouvée pour ce salon.</div>'; updateGalBtn(); return; }
    var aiId = pmState.aiPick && pmState.aiPick.photo_id;
    var h = '<div style="font-size:12.5px;color:#8a8270;margin-bottom:10px">' + ph.length + ' photo' + (ph.length > 1 ? 's' : '') + ' · clic sur l\'image = zoom · « basse déf » = à éviter en héro' + (pmState.heroCurrent ? ' · <span style="color:#138a36;font-weight:700">héro déjà personnalisé ✓</span>' : '') + '</div>';
    h += '<div class="pm-grid">';
    ph.forEach(function (p) {
      var isAi = p.photo_id === aiId;
      h += '<div class="pm-it"><div class="pm-im' + (isAi ? ' ai' : '') + '" data-lg="' + esc(p.lg) + '">'
        + '<img loading="lazy" src="' + esc(p.th) + '" alt="">'
        + (isAi ? '<span class="pm-tag star">⭐ choix IA</span>' : '')
        + (p.lowdef ? '<span class="pm-tag ld">basse déf</span>' : '')
        + '</div><div class="pm-acts">'
        + '<button class="pm-hero-btn" data-hero="' + esc(p.photo_id) + '">Définir héro</button>'
        + '<label class="pm-gal"><input type="checkbox" data-gal="' + esc(p.photo_id) + '"' + (pmState.sel[p.photo_id] ? ' checked' : '') + '> galerie</label>'
        + '</div></div>';
    });
    h += '</div>';
    if (pmState.aiPick && pmState.aiPick.reasoning) h += '<div style="font-size:13px;color:#5b6470;font-style:italic;margin-top:12px">🤖 «&nbsp;' + esc(pmState.aiPick.reasoning) + '&nbsp;»</div>';
    $('pm-body').innerHTML = h;
    Array.prototype.forEach.call($('pm-body').querySelectorAll('.pm-im'), function (im) {
      im.onclick = function () { $('pm-zoom-img').src = im.getAttribute('data-lg'); $('pm-zoom').classList.add('on'); };
    });
    Array.prototype.forEach.call($('pm-body').querySelectorAll('[data-hero]'), function (b) {
      b.onclick = function () {
        b.disabled = true; b.textContent = 'Application…';
        $('pm-status').textContent = 'Recadrage + upload en cours…';
        pmApi('/admin/api/picker/salon/' + encodeURIComponent(pmState.slug) + '/hero', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo_id: b.getAttribute('data-hero'), position: $('pm-pos').value }) })
          .then(function () { toast('Héro appliqué ✓ — la démo est à jour, screenshot en recapture'); $('pm-status').textContent = 'Héro appliqué ✓'; pmState.heroCurrent = '✓'; renderPm(); })
          .catch(function (e) { toast('Erreur héro : ' + e.message); b.disabled = false; b.textContent = 'Définir héro'; $('pm-status').textContent = ''; });
      };
    });
    Array.prototype.forEach.call($('pm-body').querySelectorAll('[data-gal]'), function (c) {
      c.onchange = function () { pmState.sel[c.getAttribute('data-gal')] = c.checked; updateGalBtn(); };
    });
    updateGalBtn();
  }

  function selectedGal() { return Object.keys(pmState.sel).filter(function (k) { return pmState.sel[k]; }); }
  function updateGalBtn() {
    var n = selectedGal().length;
    var addB = $('pm-gal-add'), repB = $('pm-gal-replace');
    var over = n > 12;
    addB.textContent = over ? ('Max 12 (' + n + ')') : ('＋ Ajouter à la galerie (' + n + ')');
    repB.textContent = over ? ('Max 12 (' + n + ')') : ('Remplacer la galerie (' + n + ')');
    addB.disabled = repB.disabled = (n === 0 || over);
  }
  function applyGalleryMode(mode) {
    var ids = selectedGal();
    if (!ids.length) return;
    var addB = $('pm-gal-add'), repB = $('pm-gal-replace');
    addB.disabled = repB.disabled = true;
    (mode === 'append' ? addB : repB).textContent = mode === 'append' ? 'Ajout…' : 'Remplacement…';
    $('pm-status').textContent = 'Recadrage + upload de ' + ids.length + ' image(s)…';
    pmApi('/admin/api/picker/salon/' + encodeURIComponent(pmState.slug) + '/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo_ids: ids, mode: mode }) })
      .then(function (r) {
        toast(mode === 'append' ? ('Galerie enrichie : +' + r.added + ' photo(s) en tête · ' + r.count + ' au total ✓') : ('Galerie remplacée (' + r.count + ' image' + (r.count > 1 ? 's' : '') + ') ✓'));
        $('pm-status').textContent = 'Galerie mise à jour ✓'; pmState.sel = {}; renderPm();
      })
      .catch(function (e) { toast('Erreur galerie : ' + e.message); $('pm-status').textContent = ''; updateGalBtn(); });
  }

  global.PhotoModal = { open: open };
})(window);

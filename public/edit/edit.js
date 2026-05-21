// ====================================================================
// PAGE EDITION COIFFEUR — /edit/{slug}?token=xxx
// ====================================================================

const DAY_LABELS = {
  monday: 'Lundi', tuesday: 'Mardi', wednesday: 'Mercredi',
  thursday: 'Jeudi', friday: 'Vendredi', saturday: 'Samedi', sunday: 'Dimanche'
};

const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// --- Etat applicatif ---
const state = {
  slug: '',
  token: '',
  view: null,         // reponse complete de l'API (defaults + overrides merges)
  draft: null,        // copie locale modifiable (= content)
  noteAvis: null,     // note Google brute du salon
  hasGoogleNote: false
};

// --- Routing : extraire slug + token de l'URL ---
function parseUrl() {
  // Pattern : /admin/{slug}?token=xxx (nouveau, maquickpage.fr)
  // ou      : /edit/{slug}?token=xxx (ancien, conserve pour les liens deja envoyes)
  const path = window.location.pathname;
  const m = path.match(/^\/(?:admin|edit)\/([^/]+)/);
  if (!m) return null;
  const params = new URLSearchParams(window.location.search);
  return { slug: m[1], token: params.get('token') || '' };
}

// --- Toast ---
let toastTimer = null;
function toast(message, type = 'success') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast visible ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// --- API helpers ---
// Si state.token est vide (= site live, cookie auth), on omet le query param ;
// le serveur lit alors le cookie `mqs_session`. Sur les démos Helsinki, le
// token reste obligatoire en URL.
function tokenQS() {
  return state.token ? `?token=${encodeURIComponent(state.token)}` : '';
}
function tokenQSExtra(extra) {
  // Pour les paths avec query déjà présent, on append &token=...
  if (!state.token) return '';
  return `&token=${encodeURIComponent(state.token)}`;
}

async function apiGet() {
  const res = await fetch(`/api/edit/${encodeURIComponent(state.slug)}${tokenQS()}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erreur' }));
    const e = new Error(err.error || 'Erreur ' + res.status);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function apiPut(overrides) {
  const res = await fetch(`/api/edit/${encodeURIComponent(state.slug)}${tokenQS()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erreur' }));
    throw new Error(err.error || 'Erreur sauvegarde');
  }
  return res.json();
}

async function apiResetOverrides() {
  const res = await fetch(`/api/edit/${encodeURIComponent(state.slug)}/overrides${tokenQS()}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('Erreur reset');
  return res.json();
}

async function apiUploadImage(blob, kind) {
  const fd = new FormData();
  fd.append('image', blob, `${kind}.jpg`);
  fd.append('kind', kind);
  const res = await fetch(`/api/edit/${encodeURIComponent(state.slug)}/upload-image${tokenQS()}`, {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erreur upload' }));
    throw new Error(err.error || 'Erreur upload');
  }
  return res.json();
}

// ===========================================================
// CROP IMAGE (Cropper.js + compression canvas)
// ===========================================================
let cropper = null;
let cropResolve = null;

// Helper : masquer/afficher la CTA bar MaQuickPage (banner.js) en démo.
// On réutilise les events existants pricing-modal-open/close — sans impact
// sur les sites coiffeur live (banner.js exit là-bas via isDemoHost).
function dispatchOverlayOpen() {
  window.dispatchEvent(new CustomEvent('mqs-pricing-modal-open'));
}
function dispatchOverlayClose() {
  window.dispatchEvent(new CustomEvent('mqs-pricing-modal-close'));
}

function openCropModal(imageSrc, aspectRatio = 16/9) {
  return new Promise((resolve) => {
    cropResolve = resolve;
    const modal = $('crop-modal');
    const img = $('cropper-image');
    img.src = imageSrc;
    modal.hidden = false;
    dispatchOverlayOpen();

    if (cropper) cropper.destroy();
    cropper = new Cropper(img, {
      aspectRatio,
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      guides: true,
      movable: true,
      zoomable: true,
      rotatable: false,
      scalable: false
    });
  });
}

function closeCropModal(result) {
  $('crop-modal').hidden = true;
  dispatchOverlayClose();
  if (cropper) { cropper.destroy(); cropper = null; }
  if (cropResolve) { cropResolve(result); cropResolve = null; }
}

$('btn-crop-cancel').onclick = () => closeCropModal(null);
$('btn-crop-confirm').onclick = async () => {
  if (!cropper) return closeCropModal(null);
  // Recuperer le canvas crope, puis re-compresser via toBlob JPEG
  const canvas = cropper.getCroppedCanvas({
    maxWidth: 1920,
    maxHeight: 1920,
    imageSmoothingQuality: 'high'
  });
  canvas.toBlob((blob) => closeCropModal(blob), 'image/jpeg', 0.85);
};

// ===========================================================
// CONFIRM MODAL
// ===========================================================
function confirmDialog(title, message) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-modal').hidden = false;
    dispatchOverlayOpen();
    const cleanup = (val) => {
      $('confirm-modal').hidden = true;
      dispatchOverlayClose();
      $('btn-confirm-ok').onclick = null;
      $('btn-confirm-cancel').onclick = null;
      resolve(val);
    };
    $('btn-confirm-ok').onclick = () => cleanup(true);
    $('btn-confirm-cancel').onclick = () => cleanup(false);
  });
}

// ===========================================================
// CLIENT-SIDE COMPRESSION (galerie : pas de crop, juste resize)
// ===========================================================
async function compressImageFile(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const ratio = img.width / img.height;
        let w = img.width, h = img.height;
        if (Math.max(w, h) > maxDim) {
          if (w >= h) { w = maxDim; h = Math.round(maxDim / ratio); }
          else { h = maxDim; w = Math.round(maxDim * ratio); }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Compression failed')), 'image/jpeg', quality);
      };
      img.onerror = () => reject(new Error('Image invalide'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Lecture impossible'));
    reader.readAsDataURL(file);
  });
}

// ===========================================================
// RENDU INITIAL
// ===========================================================
function renderAll() {
  const c = state.draft;
  $('edit-brand-name').textContent = state.view.nom || c.hero.title || 'Mon salon';

  // Bouton "Voir mon site" : comportement différent selon contexte
  //   - DEMO (maquickpage.fr/admin) : href vers /preview/{slug}?token=...
  //     (même onglet, ce qui permet de revenir via "Modifier mon site")
  //   - LIVE (custom hostname) : href vers / direct (= root canonique),
  //     OUVRE UN NOUVEL ONGLET pour ne pas perdre la session admin du coiffeur.
  const previewLink = $('preview-link');
  if (isLiveSite()) {
    previewLink.href = `${getPublicBaseUrl()}/`;
    previewLink.target = '_blank';
    previewLink.rel = 'noopener noreferrer';
  } else {
    previewLink.href = `${getPublicBaseUrl()}/preview/${state.slug}?token=${encodeURIComponent(state.token)}`;
    previewLink.removeAttribute('target');
    previewLink.removeAttribute('rel');
  }

  renderHero(c.hero);
  renderIntro(c.intro);
  renderServices(c.services);
  renderGallery(c.gallery);
  renderTestimonials(c.testimonials);
  renderContact(c.contact, c.socials);

  // Signal à l'onboarding qu'on est dans le VRAI éditeur (= pas la page 401
  // qui sert le même HTML mais sans données). Sur DEMO, le tuto auto-démarre
  // après cet event. Sur LIVE, l'event est ignoré (no auto-launch).
  window.dispatchEvent(new CustomEvent('mqs-editor-ready'));
}

// Helper : détecte si on est sur un site coiffeur LIVE (custom hostname Falkenstein)
// vs DEMO (maquickpage.fr). Utilisé par renderAll() pour adapter le preview-link
// et par onboarding.js pour décider du auto-launch du tuto.
function isLiveSite() {
  const host = (window.location.hostname || '').toLowerCase();
  return host !== 'maquickpage.fr'
      && host !== 'www.maquickpage.fr'
      && host !== 'localhost'
      && host !== '127.0.0.1';
}

function getPublicBaseUrl() {
  // En prod, public et admin coiffeur sont sur le meme host (maquickpage.fr)
  // L'agency admin est sur outil.maquickpage.fr — dans ce cas, on revient sur maquickpage.fr
  const host = window.location.host;
  if (host.startsWith('outil.')) {
    return window.location.protocol + '//' + host.slice('outil.'.length);
  }
  return window.location.origin;
}

// ----- HERO -----
function renderHero(hero) {
  $('hero-tagline').value = hero.tagline || '';
  $('hero-title').value = hero.title || '';
  $('hero-subtitle').value = hero.subtitle || '';
  $('hero-image-preview').src = hero.backgroundImage || '';
}

$('btn-hero-image').onclick = () => $('hero-file-input').click();
$('hero-file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const blob = await openCropModal(ev.target.result, 16/9);
    if (!blob) return;
    try {
      toast('Envoi de l\'image…', 'success');
      const result = await apiUploadImage(blob, 'hero');
      $('hero-image-preview').src = result.url;
      state.draft.hero.backgroundImage = result.url;
      toast(`Image envoyée (${result.sizeKb} Ko)`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};

function collectHero() {
  return {
    tagline: $('hero-tagline').value.trim(),
    title: $('hero-title').value.trim(),
    subtitle: $('hero-subtitle').value.trim(),
    backgroundImage: state.draft.hero.backgroundImage
  };
}

// ----- INTRO -----
function renderIntro(intro) {
  $('intro-title').value = intro.title || '';
  $('intro-description').value = intro.description || '';
  $('intro-show-rating').checked = intro.showRating !== false;
  $('intro-fallback').value = intro.ratingFallback || '';

  // Bloc Satisfaction (nouveaux champs)
  if ($('intro-show-satisfaction')) {
    $('intro-show-satisfaction').checked = intro.showSatisfaction !== false; // par defaut affiche
  }
  if ($('intro-satisfaction-value')) {
    $('intro-satisfaction-value').value = intro.satisfactionValue || '100%';
  }
  if ($('intro-satisfaction-label')) {
    $('intro-satisfaction-label').value = intro.satisfactionLabel || 'Satisfaction';
  }

  const note = state.noteAvis;
  const hasNote = note != null && Number.isFinite(note);
  state.hasGoogleNote = hasNote;

  const status = $('intro-rating-status');
  if (!hasNote) {
    status.textContent = 'Vous n\'avez pas de note Google enregistrée. La phrase ci-dessous s\'affichera à la place.';
    $('intro-show-rating').checked = false;
    $('intro-show-rating').disabled = true;
  } else if (note < 4) {
    status.textContent = `Votre note Google actuelle (${note}/5) est inférieure à 4. Pour valoriser votre salon, nous recommandons de masquer la note et d'afficher une phrase commerciale.`;
    $('intro-show-rating').disabled = true;
    $('intro-show-rating').checked = false;
  } else {
    status.textContent = `Votre note Google actuelle : ${note}/5. Vous pouvez choisir de l'afficher ou de la remplacer par une phrase commerciale.`;
    $('intro-show-rating').disabled = false;
  }

  toggleIntroFallback();
  $('intro-show-rating').onchange = toggleIntroFallback;
}

function toggleIntroFallback() {
  const showRating = $('intro-show-rating').checked;
  $('intro-fallback-block').style.display = showRating ? 'none' : 'block';
}

function collectIntro() {
  return {
    title: $('intro-title').value.trim(),
    description: $('intro-description').value.trim(),
    showRating: $('intro-show-rating').checked && state.hasGoogleNote && state.noteAvis >= 4,
    ratingFallback: $('intro-fallback').value.trim(),
    showSatisfaction: $('intro-show-satisfaction')?.checked !== false,
    satisfactionValue: ($('intro-satisfaction-value')?.value || '').trim() || '100%',
    satisfactionLabel: ($('intro-satisfaction-label')?.value || '').trim() || 'Satisfaction'
  };
}

// ----- SERVICES (accordeon par service) -----
function renderServices(services) {
  const list = $('services-list');
  list.innerHTML = '';
  state.servicesArr = (services.items || []).slice();
  state.servicesArr.forEach((s, i) => list.appendChild(buildServiceItem(s, i)));
  updateServicesCount();
}

function buildServiceItem(s, idx) {
  const item = document.createElement('details');
  item.className = 'service-item';
  item.dataset.idx = idx;
  // Auto-open les nouveaux services (sans nom) pour qu'on voit qu'on peut editer
  if (!s.name) item.open = true;

  const placeholderName = s.name ? escapeAttr(s.name) : 'Service sans nom';
  const nameEmpty = s.name ? '' : 'empty';
  const priceDisplay = s.price ? escapeAttr(s.price) : '';

  item.innerHTML = `
    <summary class="service-item-summary">
      <span class="accordion-chevron"></span>
      <span class="service-name-display ${nameEmpty}">${placeholderName}</span>
      ${priceDisplay ? `<span class="service-price-display">${priceDisplay}</span>` : ''}
      <button class="btn-remove-service" title="Supprimer ce service" type="button" aria-label="Supprimer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </summary>
    <div class="service-item-body">
      <input type="text" placeholder="Nom du service (ex : Coupe Femme)" value="${escapeAttr(s.name || '')}" data-field="name" maxlength="80">
      <input type="text" placeholder="Description (optionnelle)" value="${escapeAttr(s.description || '')}" data-field="description" maxlength="200">
      <input type="text" placeholder="Tarif (ex : 35€ ou À partir de 35€)" value="${escapeAttr(s.price || '')}" data-field="price" maxlength="40">
    </div>
  `;

  // Bouton suppression (eviter que clic ne ferme/ouvre le details)
  const removeBtn = item.querySelector('.btn-remove-service');
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.servicesArr.splice(idx, 1);
    renderServices({ items: state.servicesArr });
  });

  // Mise a jour live du resume quand on tape dans les champs
  const nameInput = item.querySelector('[data-field="name"]');
  const priceInput = item.querySelector('[data-field="price"]');
  const nameDisplay = item.querySelector('.service-name-display');

  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim();
    if (v) {
      nameDisplay.textContent = v;
      nameDisplay.classList.remove('empty');
    } else {
      nameDisplay.textContent = 'Service sans nom';
      nameDisplay.classList.add('empty');
    }
  });
  priceInput.addEventListener('input', () => {
    const v = priceInput.value.trim();
    // BUG FIX : re-query le span à chaque input. La variable figée au load
    // restait null tant que le prix initial était vide → chaque keystroke
    // créait un NOUVEAU span → accumulation des valeurs dans le titre.
    let displayEl = item.querySelector('.service-price-display');
    if (v) {
      if (!displayEl) {
        const sum = item.querySelector('.service-item-summary');
        displayEl = document.createElement('span');
        displayEl.className = 'service-price-display';
        sum.insertBefore(displayEl, removeBtn);
      }
      displayEl.textContent = v;
    } else if (displayEl) {
      // Si la valeur a été vidée, retirer le span pour ne pas laisser un
      // élément vide qui prend de l'espace dans le titre.
      displayEl.remove();
    }
  });

  return item;
}

function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

function updateServicesCount() {
  const n = state.servicesArr.length;
  const el = $('services-count');
  if (n >= 20) el.textContent = `${n} services (maximum atteint)`;
  else el.textContent = `${n} service${n > 1 ? 's' : ''}`;
  $('btn-add-service').disabled = n >= 20;
}

$('btn-add-service').onclick = () => {
  if (state.servicesArr.length >= 20) return;
  state.servicesArr.push({ id: 's' + Date.now(), name: '', description: '', price: '' });
  renderServices({ items: state.servicesArr });
  // Focus le nouveau champ
  const last = $('services-list').lastElementChild;
  last.querySelector('input').focus();
};

function collectServices() {
  const items = $$('#services-list .service-item').map((item, i) => {
    const name = item.querySelector('[data-field="name"]').value.trim();
    const description = item.querySelector('[data-field="description"]').value.trim();
    const price = item.querySelector('[data-field="price"]').value.trim();
    return { id: state.servicesArr[i]?.id || ('s' + Date.now() + i), name, description, price };
  }).filter(s => s.name);
  return { title: 'Nos Services', items };
}

// ----- GALLERY -----
function renderGallery(gallery) {
  // Layout
  $$('input[name="gallery-layout"]').forEach(r => r.checked = (r.value === (gallery.layout || 'grid')));
  state.galleryImages = (gallery.images || []).slice();
  rebuildGalleryTiles();
}

// Instance Sortable conservée pour pouvoir la détruire/recréer entre les renders
let gallerySortable = null;

function rebuildGalleryTiles() {
  const list = $('gallery-images-list');
  list.innerHTML = '';

  state.galleryImages.forEach((url) => {
    const tile = document.createElement('div');
    tile.className = 'gallery-image-tile sortable-tile';
    tile.dataset.url = url;
    tile.innerHTML = `
      <img src="${escapeAttr(url)}" alt="" draggable="false">
      <button class="tile-remove" title="Supprimer" type="button">×</button>
      <span class="drag-handle" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <circle cx="6" cy="5" r="1.5"/><circle cx="6" cy="10" r="1.5"/><circle cx="6" cy="15" r="1.5"/>
          <circle cx="14" cy="5" r="1.5"/><circle cx="14" cy="10" r="1.5"/><circle cx="14" cy="15" r="1.5"/>
        </svg>
      </span>
    `;
    tile.querySelector('.tile-remove').onclick = (e) => {
      e.stopPropagation();
      const idx = state.galleryImages.indexOf(url);
      if (idx >= 0) state.galleryImages.splice(idx, 1);
      rebuildGalleryTiles();
    };
    // Bloque le menu contextuel système (clic droit desktop + long press mobile
    // qui propose "Ouvrir l'image", "Copier", "Prévisualiser"…) pour ne pas
    // interférer avec le drag&drop.
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
    list.appendChild(tile);
  });

  const limit = 50;
  const reached = state.galleryImages.length >= limit;
  if (!reached) {
    const addTile = document.createElement('div');
    addTile.className = 'gallery-image-tile add-tile';
    addTile.dataset.addTile = 'true';
    addTile.innerHTML = '<span>+</span>';
    addTile.onclick = () => $('gallery-file-input').click();
    list.appendChild(addTile);
  }
  $('gallery-limit-warning').hidden = !reached;

  // === SortableJS desktop + mobile, avec long-press 200ms sur touch ===
  if (gallerySortable) { gallerySortable.destroy(); gallerySortable = null; }
  if (typeof window.Sortable === 'function') {
    gallerySortable = window.Sortable.create(list, {
      animation: 180,
      filter: '.add-tile, .tile-remove',
      preventOnFilter: false,
      // 200ms de long-press sur touch avant de pouvoir drag (évite que le scroll
      // vertical déclenche un drag par accident). Sur souris : pas de delay.
      delay: 200,
      delayOnTouchOnly: true,
      touchStartThreshold: 4,
      // forceFallback rend le drag&drop indépendant de l'API native HTML5,
      // ce qui évite certains comportements buggés sur mobile (notamment
      // l'apparition du menu contextuel système quand le browser pense qu'on
      // veut interagir avec l'image en sous-jacent).
      forceFallback: true,
      fallbackTolerance: 4,
      ghostClass: 'tile-drag-ghost',
      chosenClass: 'tile-drag-chosen',
      onEnd: () => {
        const newOrder = Array.from(list.querySelectorAll('.sortable-tile'))
          .map(el => el.dataset.url).filter(Boolean);
        state.galleryImages = newOrder;
      },
    });
  }
}

$('gallery-file-input').onchange = async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;

  const limit = 50;
  const remaining = limit - state.galleryImages.length;
  if (remaining <= 0) {
    toast('Limite de 12 photos atteinte.', 'error');
    return;
  }
  const toUpload = files.slice(0, remaining);
  if (files.length > remaining) {
    toast(`Seulement ${remaining} photo(s) ajoutées (limite atteinte).`, 'error');
  } else {
    toast(`Envoi de ${toUpload.length} photo(s)…`, 'success');
  }

  for (const file of toUpload) {
    try {
      // Pré-compression client : 1280px max côté long (= 1024 cible serveur + marge)
      // pour réduire la bande passante upload, surtout sur 4G mobile.
      // Le serveur recompresse ensuite à 1024px / qualité 80.
      const blob = await compressImageFile(file, 1280, 0.82);
      const result = await apiUploadImage(blob, 'gallery');
      state.galleryImages.push(result.url);
      rebuildGalleryTiles();
    } catch (err) {
      toast(`Erreur sur "${file.name}" : ${err.message}`, 'error');
    }
  }
  toast('Photos ajoutées.', 'success');
};

function collectGallery() {
  const layout = $$('input[name="gallery-layout"]').find(r => r.checked)?.value || 'grid';
  return { layout, images: state.galleryImages.slice(), title: 'Galerie' };
}

// ----- TESTIMONIALS (accordeon par avis) -----
function renderTestimonials(testimonials) {
  const list = $('testimonials-list');
  const items = (testimonials.items || []).slice(0, 3);
  while (items.length < 3) items.push({ id: 't' + (items.length+1), text: '', author: '', date: '' });

  list.innerHTML = '';
  items.forEach((t, i) => {
    const item = document.createElement('details');
    item.className = 'testimonial-item';
    if (!t.text) item.open = true; // ouvert pour les avis vides

    const preview = t.text ? `« ${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''} »` : '';

    item.innerHTML = `
      <summary class="testimonial-item-summary">
        <span class="accordion-chevron"></span>
        <span class="testimonial-item-num">${i+1}</span>
        <span class="testimonial-item-title">Avis n°${i+1}</span>
        <span class="testimonial-item-preview">${escapeAttr(preview)}</span>
      </summary>
      <div class="testimonial-item-body">
        <textarea placeholder="Ex : Une expérience top, équipe adorable, je recommande !" data-field="text" maxlength="350">${escapeAttr(t.text || '')}</textarea>
        <div class="testimonial-meta">
          <input type="text" placeholder="Prénom + initiale (ex : Marie L.)" data-field="author" value="${escapeAttr(t.author || '')}" maxlength="40">
          <input type="text" placeholder="Date (ex : Il y a 2 semaines)" data-field="date" value="${escapeAttr(t.date || '')}" maxlength="30">
        </div>
      </div>
    `;

    // Mise a jour live du preview du sommaire
    const textArea = item.querySelector('[data-field="text"]');
    const previewEl = item.querySelector('.testimonial-item-preview');
    textArea.addEventListener('input', () => {
      const v = textArea.value.trim();
      previewEl.textContent = v ? `« ${v.slice(0, 60)}${v.length > 60 ? '…' : ''} »` : '';
    });

    list.appendChild(item);
  });
}

function collectTestimonials() {
  const items = $$('#testimonials-list .testimonial-item').map((item, i) => ({
    id: 't' + (i+1),
    text: item.querySelector('[data-field="text"]').value.trim(),
    author: item.querySelector('[data-field="author"]').value.trim(),
    date: item.querySelector('[data-field="date"]').value.trim()
  })).filter(t => t.text);
  return { title: 'Avis Clients', items };
}

// ----- CONTACT + SOCIALS -----
function renderContact(contact, socials) {
  $('contact-address').value = contact.address || '';
  $('contact-address2').value = contact.addressLine2 || '';
  $('contact-phone').value = contact.phone || '';
  $('contact-email').value = contact.email || '';
  if ($('contact-booking-url')) $('contact-booking-url').value = contact.bookingUrl || '';

  const hours = contact.hours || {};
  const hg = $('hours-grid');
  hg.innerHTML = '';
  for (const [k, label] of Object.entries(DAY_LABELS)) {
    const v = hours[k];
    let display = '';
    if (!v || v === 'closed' || v === null) display = 'Fermé';
    else display = String(v).replace(/-am-/g, ':00 - ').replace(/-am$/g, ':00').replace(/-pm-/g, ':00 - ').replace(/-pm$/g, ':00').replace(/^(\d+)(\d{2})/, '$1h$2').replace(/(\d+):00/g, '$1h').replace(/-/g, ' à ');
    const row = document.createElement('label');
    row.innerHTML = `<span class="day">${label}</span><input type="text" data-day="${k}" value="${escapeAttr(display)}" placeholder="9h - 18h ou 9h - 12h, 14h - 19h" maxlength="80">`;
    hg.appendChild(row);
  }

  $$('.social-row').forEach(r => {
    const k = r.dataset.social;
    const s = socials[k] || {};
    r.querySelector('input[type="url"]').value = s.url || '';
    r.querySelector('.edit-toggle input').checked = s.enabled !== false && !!s.url;
  });
}

function collectContact() {
  const hours = {};
  $$('.hours-grid input').forEach(inp => {
    const v = inp.value.trim();
    hours[inp.dataset.day] = v && v.toLowerCase() !== 'fermé' && v.toLowerCase() !== 'ferme' ? v : 'closed';
  });
  return {
    address: $('contact-address').value.trim(),
    addressLine2: $('contact-address2').value.trim(),
    phone: $('contact-phone').value.trim(),
    email: $('contact-email').value.trim(),
    bookingUrl: ($('contact-booking-url')?.value || '').trim(),
    hours,
    title: 'Venez nous rendre visite',
    description: state.draft.contact.description,
    latitude: state.draft.contact.latitude,
    longitude: state.draft.contact.longitude
  };
}

function collectSocials() {
  const out = {};
  $$('.social-row').forEach(r => {
    const k = r.dataset.social;
    const url = r.querySelector('input[type="url"]').value.trim();
    const enabled = r.querySelector('.edit-toggle input').checked;
    out[k] = { url, enabled: enabled && !!url };
  });
  return out;
}

// ===========================================================
// SAVE PER SECTION
// ===========================================================
async function save(section) {
  const overrides = {};
  if (section === 'hero') overrides.hero = collectHero();
  if (section === 'intro') overrides.intro = collectIntro();
  if (section === 'services') overrides.services = collectServices();
  if (section === 'gallery') overrides.gallery = collectGallery();
  if (section === 'testimonials') overrides.testimonials = collectTestimonials();
  if (section === 'contact') {
    overrides.contact = collectContact();
    overrides.socials = collectSocials();
  }

  // Merge avec les overrides existants pour ne pas perdre les autres sections
  const existing = state.view.has_overrides ? extractCurrentOverrides() : {};
  const merged = { ...existing, ...overrides };

  const btn = document.querySelector(`.btn-save[data-section="${section}"]`);
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enregistrement…';

  try {
    const res = await apiPut(merged);
    state.view = res.view;
    state.draft = state.view.content;
    toast('Modifications enregistrées ✓', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// On reconstruit les overrides actuels en re-collectant chaque section depuis l'UI
// (simple et evite de stocker un etat overrides partout)
function extractCurrentOverrides() {
  return {
    hero: collectHero(),
    intro: collectIntro(),
    services: collectServices(),
    gallery: collectGallery(),
    testimonials: collectTestimonials(),
    contact: collectContact(),
    socials: collectSocials()
  };
}

$$('.btn-save').forEach(b => b.onclick = () => save(b.dataset.section));

// ===========================================================
// TABS
// ===========================================================
$$('.edit-tab').forEach(tab => {
  tab.onclick = () => {
    $$('.edit-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $$('.edit-section').forEach(s => s.classList.toggle('active', s.dataset.section === target));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
});

// ===========================================================
// LOAD
// ===========================================================
async function load() {
  try {
    const view = await apiGet();
    state.view = view;
    state.draft = view.content;
    state.noteAvis = view.note_avis;
    renderAll();
    $('edit-loader').classList.add('fade');
    setTimeout(() => $('edit-loader').remove(), 400);
  } catch (e) {
    // 401 / 403 : pas d'auth → form magic link recovery (uniquement sur custom
    // hostname = site live ; sur démo Helsinki on garde l'ancien message)
    const isCustomHostname = !/^maquickpage\.fr$|^localhost$|^127\.0\.0\.1$/i.test(location.hostname);
    if ((e.status === 401 || e.status === 403) && isCustomHostname) {
      return showRecoveryForm();
    }
    document.body.innerHTML = `
      <div style="max-width:480px;margin:80px auto;padding:32px;background:white;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.1);font-family:sans-serif;text-align:center;">
        <h1 style="font-family:'Cormorant Garamond',serif;color:#cf222e;font-size:2rem;margin-bottom:16px;">Accès refusé</h1>
        <p style="color:#6b6b6b;line-height:1.5;">${escapeAttr(e.message)}</p>
        <p style="color:#6b6b6b;font-size:0.9rem;margin-top:16px;">Vérifiez le lien d'édition que vous avez reçu, ou contactez-nous pour en obtenir un nouveau.</p>
      </div>
    `;
  }
}

// ===========================================================
// MAGIC LINK RECOVERY FORM
// ===========================================================
// Affiché quand pas d'auth valide (pas de cookie session ni de token).
// Le coiffeur entre son email → on POST /api/auth/request-magic-link →
// il reçoit un lien qui pose le cookie + le redirige sur /admin/{slug}.
function showRecoveryForm(message) {
  document.body.innerHTML = `
    <div style="max-width:480px;margin:80px auto;padding:36px;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.12);font-family:'Montserrat',sans-serif;">
      <h1 style="font-family:'Cormorant Garamond',serif;color:#0E1014;font-size:1.8rem;margin:0 0 8px;">Accès à votre espace</h1>
      <p style="color:#6b6b6b;font-size:0.95rem;line-height:1.55;margin:0 0 24px;">${escapeAttr(message || 'Saisissez l\'email associé à votre site pour recevoir un lien de connexion.')}</p>
      <form id="recover-form" style="display:flex;flex-direction:column;gap:14px;">
        <input id="recover-email" type="email" required autofocus placeholder="votre@email.com"
          style="padding:14px 16px;border:1.5px solid #d4d4d8;border-radius:8px;font-size:15px;font-family:inherit;outline:none;"/>
        <button type="submit" id="recover-submit"
          style="background:#0E1014;color:#fff;border:0;padding:14px;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit;">
          Recevoir mon lien de connexion
        </button>
        <p id="recover-feedback" style="color:#16a34a;font-size:0.9rem;margin:4px 0 0;display:none;"></p>
      </form>
      <p style="color:#9ca3af;font-size:0.8rem;margin:24px 0 0;text-align:center;">
        MaQuickPage — <a href="mailto:contact@maquickpage.fr" style="color:#9ca3af;">contact@maquickpage.fr</a>
      </p>
    </div>
  `;
  const form = document.getElementById('recover-form');
  const submit = document.getElementById('recover-submit');
  const feedback = document.getElementById('recover-feedback');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('recover-email').value.trim();
    if (!email) return;
    submit.disabled = true;
    submit.textContent = 'Envoi en cours…';
    try {
      const res = await fetch('/api/auth/request-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      feedback.style.display = 'block';
      feedback.textContent = data.message || 'Si l\'email correspond, vous recevrez un lien dans quelques minutes.';
      submit.textContent = 'Lien envoyé ✓';
    } catch (err) {
      feedback.style.color = '#dc2626';
      feedback.style.display = 'block';
      feedback.textContent = 'Erreur réseau. Réessayez dans un instant.';
      submit.disabled = false;
      submit.textContent = 'Recevoir mon lien de connexion';
    }
  });
}

// ===========================================================
// INIT
// ===========================================================
const parsed = parseUrl();
if (!parsed) {
  // URL malformée
  showRecoveryForm('URL invalide. Saisissez votre email pour recevoir un lien.');
} else {
  state.slug = parsed.slug;
  state.token = parsed.token || ''; // token optionnel (cookie session possible)
  // Tentative de chargement. Si 401 (= pas de cookie + pas de token), on
  // affiche le form magic link.
  load().catch(() => {});
}

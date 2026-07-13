const DAY_LABELS = {
  monday: 'Lundi', tuesday: 'Mardi', wednesday: 'Mercredi',
  thursday: 'Jeudi', friday: 'Vendredi', saturday: 'Samedi', sunday: 'Dimanche'
};

function getSlugFromUrl() {
  // Pattern : /preview/{slug}
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  const parts = path.split('/');
  if (parts[0] === 'preview' && parts[1]) return parts[1];
  return null;
}

async function fetchSalon(slug) {
  const res = await fetch(`/api/salon/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error('Salon introuvable');
  return res.json();
}

const $ = id => document.getElementById(id);
const setText = (id, t) => { const el = $(id); if (el && t != null) el.textContent = t; };
const setHtml = (id, h) => { const el = $(id); if (el && h != null) el.innerHTML = h; };
const escapeHtml = s => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function buildShortName(nom) {
  if (!nom) return { main: 'Salon', sub: 'Coiffure' };
  const cleaned = nom.replace(/\s*-\s*(coiffeur|coiffure|salon de coiffure|hairdresser|barber).*/i, '').trim();
  const words = cleaned.split(/\s+/);
  if (words.length === 1) return { main: words[0], sub: 'Coiffure' };
  if (words.length === 2) return { main: words[0], sub: words[1] };
  const mid = Math.ceil(words.length / 2);
  return { main: words.slice(0, mid).join(' '), sub: words.slice(mid).join(' ') };
}

function humanizeHours(v) {
  if (!v) return '';
  let s = String(v);
  // Format scrap.io : "9-am-5-pm" = 9h-17h, "1030-am-630-pm" = 10h30-18h30
  if (/-am-?|-pm-?/.test(s)) {
    // PM : ajoute 12h (sauf 12-pm = midi)
    s = s.replace(/(\d+)-pm/g, (m, digits) => {
      const isHHMM = digits.length >= 3;
      const h = isHHMM ? parseInt(digits.slice(0, -2), 10) : parseInt(digits, 10);
      const min = isHHMM ? digits.slice(-2) : '00';
      const h24 = (h === 12 ? 12 : h + 12);
      return min === '00' ? `${h24}h` : `${h24}h${min}`;
    });
    // AM : laisse tel quel (sauf 12-am = minuit)
    s = s.replace(/(\d+)-am/g, (m, digits) => {
      const isHHMM = digits.length >= 3;
      const h = isHHMM ? parseInt(digits.slice(0, -2), 10) : parseInt(digits, 10);
      const min = isHHMM ? digits.slice(-2) : '00';
      const h24 = (h === 12 ? 0 : h);
      return min === '00' ? `${h24}h` : `${h24}h${min}`;
    });
    return s.replace(/-/g, ' - ');
  }
  // Format propre (tapé par coiffeur ou DEFAULT_HOURS) : on affiche tel quel
  return s;
}

function formatHours(json) {
  if (!json) return '<p>Sur rendez-vous</p>';
  const rows = [];
  for (const [k, label] of Object.entries(DAY_LABELS)) {
    const v = json[k];
    if (!v || v === 'closed' || v === null) {
      // 'closed' = override explicite du coiffeur (le scrap est mergé en backend)
      rows.push(`<div class="day">${label}</div><div class="hours closed">Fermé</div>`);
    } else {
      rows.push(`<div class="day">${label}</div><div class="hours">${escapeHtml(humanizeHours(v))}</div>`);
    }
  }
  return `<div class="opening-hours-table">${rows.join('')}</div>`;
}

const SOCIAL_SVG = {
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.5" y2="6.51"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.16a8.16 8.16 0 0 0 4.77 1.52V6.23a4.85 4.85 0 0 1-1.84-.54z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.6-.46-5.32a2.78 2.78 0 0 0-2-2C18.84 4.27 12 4.27 12 4.27s-6.84 0-8.54.46a2.78 2.78 0 0 0-2 2A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.33 2.78 2.78 0 0 0 2 1.95c1.7.47 8.54.47 8.54.47s6.84 0 8.54-.47a2.78 2.78 0 0 0 2-1.95C23 15.6 23 12 23 12z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="#fff"/></svg>'
};

function buildSocialIcons(socials) {
  if (!socials) return '';
  const out = [];
  for (const k of ['facebook', 'instagram', 'tiktok', 'youtube']) {
    const s = socials[k];
    if (s && s.enabled !== false && s.url) {
      out.push(`<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" aria-label="${k}">${SOCIAL_SVG[k]}</a>`);
    }
  }
  return out.join('');
}

function buildTestimonials(testimonials) {
  const row = $('testimonials-row');
  if (!row) return;
  const items = (testimonials.items || []).slice(0, 3);
  const stars = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'.repeat(5);
  row.innerHTML = items.map(t => `
    <div class="testimonial-card">
      <div class="testimonial-stars">${stars}</div>
      <p class="testimonial-text">"${escapeHtml(t.text)}"</p>
      <div class="testimonial-author">
        <span class="author-name">${escapeHtml(t.author || 'Client satisfait')}</span>
        ${t.date ? `<span class="author-date">${escapeHtml(t.date)}</span>` : ''}
      </div>
    </div>
  `).join('');

  setupTestimonialsCarousel(items.length);
}

let testimonialsIndex = 0;
let testimonialsCleanup = null;

function setupTestimonialsCarousel(total) {
  const wrapper = $('testimonials-wrapper');
  const grid = $('testimonials-row');
  const prev = $('testimonials-prev');
  const next = $('testimonials-next');
  const dots = $('testimonials-dots');
  if (!wrapper || !grid || total === 0) return;

  // Cleanup previous listeners
  if (testimonialsCleanup) { testimonialsCleanup(); testimonialsCleanup = null; }

  function isMobile() { return window.innerWidth <= 640; }

  function applyTransform() {
    if (!isMobile()) {
      grid.style.transform = '';
      return;
    }
    const card = grid.querySelector('.testimonial-card');
    if (!card) return;
    const cardWidth = card.offsetWidth;
    const gap = 24;
    grid.style.transform = `translateX(-${testimonialsIndex * (cardWidth + gap)}px)`;
  }

  function maxIndex() { return Math.max(0, total - 1); }

  function updateView() {
    const mobile = isMobile();
    wrapper.classList.toggle('is-carousel', mobile);

    if (!mobile) {
      prev.hidden = true;
      next.hidden = true;
      dots.innerHTML = '';
      grid.style.transform = '';
      return;
    }

    if (testimonialsIndex > maxIndex()) testimonialsIndex = maxIndex();

    prev.hidden = false;
    next.hidden = false;
    prev.disabled = testimonialsIndex === 0;
    next.disabled = testimonialsIndex >= maxIndex();

    applyTransform();

    dots.innerHTML = Array.from({ length: total }, (_, i) =>
      `<button class="carousel-dot ${i === testimonialsIndex ? 'active' : ''}" data-i="${i}" aria-label="Avis ${i+1}"></button>`
    ).join('');
    dots.querySelectorAll('button').forEach(b => {
      b.onclick = () => { testimonialsIndex = parseInt(b.dataset.i); updateView(); };
    });
  }

  prev.onclick = () => { testimonialsIndex = Math.max(0, testimonialsIndex - 1); updateView(); };
  next.onclick = () => { testimonialsIndex = Math.min(maxIndex(), testimonialsIndex + 1); updateView(); };

  // Swipe touch
  let startX = 0;
  const onTouchStart = e => { startX = e.touches[0].clientX; };
  const onTouchEnd = e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) next.onclick();
    else prev.onclick();
  };
  grid.addEventListener('touchstart', onTouchStart, { passive: true });
  grid.addEventListener('touchend', onTouchEnd, { passive: true });

  const onResize = () => updateView();
  window.addEventListener('resize', onResize);

  testimonialsCleanup = () => {
    window.removeEventListener('resize', onResize);
    grid.removeEventListener('touchstart', onTouchStart);
    grid.removeEventListener('touchend', onTouchEnd);
  };

  setTimeout(updateView, 50);
}

let galleryShownCount = 6;
let galleryAllImages = [];

function buildGallery(gallery) {
  const grid = $('gallery-grid');
  const loadMore = $('gallery-load-more');
  if (!grid) return;

  galleryAllImages = (gallery.images || []).slice();
  galleryShownCount = Math.min(6, galleryAllImages.length);

  const isMasonry = gallery.layout === 'masonry';
  grid.classList.toggle('layout-masonry', isMasonry);

  renderGalleryItems();

  if (galleryAllImages.length > 6) {
    loadMore.hidden = false;
    $('btn-load-more').onclick = () => {
      galleryShownCount = Math.min(galleryShownCount + 6, galleryAllImages.length);
      renderGalleryItems();
      if (galleryShownCount >= galleryAllImages.length) loadMore.hidden = true;
    };
  } else {
    loadMore.hidden = true;
  }
}

function renderGalleryItems() {
  const grid = $('gallery-grid');
  const visible = galleryAllImages.slice(0, galleryShownCount);
  grid.innerHTML = visible.map((img, i) => `
    <div class="gallery-item" data-index="${i}">
      <img src="${escapeHtml(img)}" alt="Réalisation ${i+1}" loading="lazy">
      <div class="gallery-overlay"><span>AGRANDIR</span></div>
    </div>
  `).join('');
  grid.querySelectorAll('.gallery-item').forEach(item => {
    item.addEventListener('click', () => openLightbox(galleryAllImages, parseInt(item.dataset.index)));
  });
}

function openLightbox(images, index) {
  let lb = document.querySelector('.lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = '<button class="lightbox-close">&times;</button><img alt="">';
    document.body.appendChild(lb);
    lb.querySelector('.lightbox-close').onclick = () => lb.classList.remove('active');
    lb.addEventListener('click', e => { if (e.target === lb) lb.classList.remove('active'); });
  }
  lb.querySelector('img').src = images[index];
  lb.classList.add('active');
}

let servicesIndex = 0;
function buildServices(services) {
  const grid = $('services-grid');
  if (!grid) return;
  const items = (services.items || []).slice(0, 20);
  const isCarousel = items.length > 4;
  const wrapper = $('services-wrapper');
  wrapper.classList.toggle('is-carousel', isCarousel);

  grid.innerHTML = items.map((s, i) => `
    <div class="service-card" data-index="${i}">
      <h3>${escapeHtml(s.name)}</h3>
      <p>${escapeHtml(s.description || '')}</p>
      <span class="service-price">${escapeHtml(s.price || '')}</span>
    </div>
  `).join('');

  if (isCarousel) {
    setupServicesCarousel(items.length);
  } else {
    $('services-prev').hidden = true;
    $('services-next').hidden = true;
    $('services-dots').innerHTML = '';
  }
}

function setupServicesCarousel(total) {
  const grid = $('services-grid');
  const prev = $('services-prev');
  const next = $('services-next');
  const dots = $('services-dots');

  prev.hidden = false;
  next.hidden = false;

  function getPerView() {
    const w = window.innerWidth;
    if (w < 640) return 1;
    if (w < 960) return 2;
    return 4;
  }

  function getMaxIndex() {
    const perView = getPerView();
    return Math.max(0, total - perView);
  }

  function updateView() {
    const perView = getPerView();
    const maxIndex = getMaxIndex();
    if (servicesIndex > maxIndex) servicesIndex = maxIndex;
    const cardWidth = grid.querySelector('.service-card')?.offsetWidth || 0;
    const gap = 24;
    grid.style.transform = `translateX(-${servicesIndex * (cardWidth + gap)}px)`;
    prev.disabled = servicesIndex === 0;
    next.disabled = servicesIndex >= maxIndex;

    const dotCount = maxIndex + 1;
    dots.innerHTML = Array.from({ length: dotCount }, (_, i) =>
      `<button class="carousel-dot ${i === servicesIndex ? 'active' : ''}" data-i="${i}" aria-label="Page ${i+1}"></button>`
    ).join('');
    dots.querySelectorAll('button').forEach(b => {
      b.onclick = () => { servicesIndex = parseInt(b.dataset.i); updateView(); };
    });
  }

  prev.onclick = () => { servicesIndex = Math.max(0, servicesIndex - 1); updateView(); };
  next.onclick = () => { servicesIndex = Math.min(getMaxIndex(), servicesIndex + 1); updateView(); };

  // Swipe touch
  let startX = 0;
  grid.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  grid.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) next.onclick();
    else prev.onclick();
  }, { passive: true });

  window.addEventListener('resize', updateView);
  setTimeout(updateView, 50);
}

function applyHeroImage(src) {
  if (!src) return;
  const hero = document.querySelector('.hero');
  if (hero) hero.style.backgroundImage = `url('${src}')`;
}

/* Mesure dynamique de la hauteur du "header" (navbar + ribbon éventuel) et
   du "scroll bottom" (flèche DÉCOUVRIR), puis pose top/bottom directement
   sur .hero-content (desktop uniquement). Le contenu interne se tasse
   ensuite automatiquement via container queries (cqh units).

   Note : on a essayé d'exposer ces valeurs en CSS variables sur :root pour
   laisser le CSS faire `top: var(--mqs-header-h)`, mais Chrome ne recalc
   pas le `top` quand la var change si l'élément est en container-type:size
   (bug de stale layout). On set donc top/bottom directement en JS — la
   transition `transition: top, bottom` du CSS continue à animer le glissement. */
function syncHeroBounds() {
  const nav = document.querySelector('.navbar');
  const ribbon = document.getElementById('mqs-ribbon');
  const scroll = document.querySelector('.hero-scroll');
  const content = document.querySelector('.hero-content');
  if (!content) return;
  // Desktop only — on n'écrase pas le layout mobile.
  if (window.matchMedia('(max-width: 768px)').matches) {
    content.style.top = '';
    content.style.bottom = '';
    return;
  }
  if (nav) {
    const navH = Math.round(nav.getBoundingClientRect().height);
    const ribbonH = ribbon ? Math.round(ribbon.getBoundingClientRect().height) : 0;
    content.style.top = `${navH + ribbonH}px`;
  }
  if (scroll) {
    const scrollH = Math.round(scroll.getBoundingClientRect().height);
    const scrollBottom = parseInt(getComputedStyle(scroll).bottom, 10) || 40;
    content.style.bottom = `${scrollH + scrollBottom}px`;
  }
}

// Init au load + re-sync au resize + à l'arrivée du ribbon (banner.js dispatche
// l'event après avoir mounté le ribbon → fait re-mesurer ici).
let _heroBoundsTimer = null;
function _scheduleHeroSync() {
  if (_heroBoundsTimer) clearTimeout(_heroBoundsTimer);
  _heroBoundsTimer = setTimeout(syncHeroBounds, 50);
}
window.addEventListener('resize', _scheduleHeroSync);
window.addEventListener('mqs-header-changed', syncHeroBounds);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncHeroBounds, { once: true });
} else {
  syncHeroBounds();
}
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(syncHeroBounds).catch(() => {});
}


function renderSalon(view) {
  const c = view.content;
  const shortName = buildShortName(c.hero.title || view.nom);
  const ville = view.ville || '';

  document.title = `${c.hero.title || view.nom}${ville ? ` — ${ville}` : ''}`;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc && c.intro?.description) metaDesc.content = c.intro.description.slice(0, 160);

  setText('logo-text', shortName.main);
  setText('logo-sub', shortName.sub);
  setText('footer-logo-text', shortName.main);
  setText('footer-logo-sub', shortName.sub);
  setText('footer-name', c.hero.title || view.nom);
  setText('footer-tagline', `Votre salon de coiffure${ville ? ` à ${ville}` : ''}`);
  setText('footer-year', new Date().getFullYear());

  // HERO (note Google retiree)
  setText('hero-tagline', c.hero.tagline);
  setText('hero-title', c.hero.title);
  setText('hero-subtitle', c.hero.subtitle);
  applyHeroImage(c.hero.backgroundImage);
  // Le contenu du hero s'auto-tasse via container queries CSS (cf. styles.css
  // → .hero-content { container-type: size } + cqh units sur titre/marges).
  // Aucune mesure JS nécessaire.

  // INTRO (note Google si >=4, sinon fallback commercial)
  setText('intro-title', c.intro.title);
  setText('intro-description', c.intro.description);
  const ratingBlock = $('stat-rating-block');
  if (c.intro.showRating && view.note_avis >= 4) {
    setText('stat-rating', `${view.note_avis}/5`);
    ratingBlock.querySelector('.stat-label').textContent = 'Note Google';
  } else {
    // Fallback commercial : on remplace le bloc note par un bloc texte vendeur
    ratingBlock.classList.add('stat-fallback');
    ratingBlock.innerHTML = `<span class="stat-fallback-text">${escapeHtml(c.intro.ratingFallback || '')}</span>`;
  }

  // Bloc Satisfaction (toggle + valeurs editables)
  const satisfactionBlock = $('stat-satisfaction-block');
  if (satisfactionBlock) {
    if (c.intro.showSatisfaction === false) {
      satisfactionBlock.style.display = 'none';
    } else {
      satisfactionBlock.style.display = '';
      setText('stat-satisfaction-value', c.intro.satisfactionValue || '100%');
      setText('stat-satisfaction-label', c.intro.satisfactionLabel || 'Satisfaction');
    }
  }

  // SERVICES
  buildServices(c.services);

  // GALERIE (avec bouton "Afficher plus")
  buildGallery(c.gallery);

  // TESTIMONIALS (3 fixes editables)
  buildTestimonials(c.testimonials);

  // CONTACT
  setText('contact-title', c.contact.title);
  setText('contact-description', c.contact.description);

  // Mode salon vs coiffeur à domicile (défaut : 'address' = comportement historique).
  // Si mode === 'zone' : on affiche serviceArea au lieu de l'adresse + on adapte le label.
  // Code défensif : 10 k salons scrapés historiques n'ont aucun de ces fields → 'address'.
  const contactMode = c.contact?.mode === 'zone' ? 'zone' : 'address';
  const addr = c.contact.address;
  const addr2 = c.contact.addressLine2;
  // Toujours re-set explicitement le label (sinon un re-render après bascule
  // zone → address garderait l'ancien libellé "Zone d'intervention").
  const labelStrong = $('contact-address-block')?.querySelector('strong');
  if (labelStrong) labelStrong.textContent = (contactMode === 'zone') ? 'Zone d\'intervention' : 'Adresse';
  if (contactMode === 'zone') {
    const serviceArea = c.contact.serviceArea || '';
    setHtml('contact-address', escapeHtml(serviceArea) || 'Sur demande');
  } else {
    setHtml('contact-address', [addr, addr2].filter(Boolean).map(escapeHtml).join('<br>') || 'Adresse non renseignée');
  }

  if (c.contact.phone) {
    const phoneEl = $('contact-phone');
    phoneEl.textContent = c.contact.phone;
    phoneEl.href = `tel:${c.contact.phone.replace(/\s/g, '')}`;
  } else {
    $('contact-phone-block').style.display = 'none';
  }

  // Bouton "Reserver" : URL de reservation en ligne si disponible, sinon scroll vers #contact
  const navCta = $('nav-cta');
  if (navCta) {
    const bookingUrl = c.contact.bookingUrl;
    if (bookingUrl) {
      navCta.href = bookingUrl;
      navCta.target = '_blank';
      navCta.rel = 'noopener';
      navCta.removeAttribute('data-scroll-fallback');
    } else {
      navCta.href = '#contact';
      navCta.removeAttribute('target');
      navCta.removeAttribute('rel');
      navCta.dataset.scrollFallback = '1';
    }
  }

  if (c.contact.email) {
    const emailEl = $('contact-email');
    emailEl.textContent = c.contact.email;
    emailEl.href = `mailto:${c.contact.email}`;
  } else {
    $('contact-email-block').style.display = 'none';
  }

  setHtml('contact-hours', formatHours(c.contact.hours));

  // RESEAUX SOCIAUX
  const socials = buildSocialIcons(c.socials);
  setHtml('social-icons', socials);
  setHtml('footer-social', socials);

  // MAP : trois cas de figure
  //   1. mode='zone' + hideMap=true → carte masquée complètement (opt-in)
  //   2. mode='zone' (par défaut) → carte centrée sur la VILLE (addressLine2)
  //      avec un zoom plus large (z=12) pour voir la ville + alentours.
  //      Pas de marker sur une adresse précise : on protège la vie privée du
  //      coiffeur à domicile, tout en confirmant visuellement sa zone géo.
  //   3. mode='address' (défaut historique) → carte sur lat/lng OU adresse
  //      complète avec zoom rapproché (z=15). Comportement inchangé.
  const mapContainer = document.querySelector('.contact-map');
  const mapIframe = $('map-iframe');
  if (contactMode === 'zone' && c.contact?.hideMap) {
    if (mapContainer) mapContainer.style.display = 'none';
    if (mapIframe) mapIframe.removeAttribute('src');
  } else {
    if (mapContainer) mapContainer.style.display = '';
    if (mapIframe) {
      if (contactMode === 'zone') {
        // Focaliser sur la ville (addressLine2 contient typiquement
        // "69380 Chasselay") avec zoom large pour vue de la zone.
        const cityOnly = (addr2 || '').trim();
        if (cityOnly) {
          mapIframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(cityOnly)}&z=12&output=embed`;
        } else if (c.contact.latitude && c.contact.longitude) {
          mapIframe.src = `https://maps.google.com/maps?q=${c.contact.latitude},${c.contact.longitude}&z=12&output=embed`;
        }
      } else if (c.contact.latitude && c.contact.longitude) {
        mapIframe.src = `https://maps.google.com/maps?q=${c.contact.latitude},${c.contact.longitude}&z=15&output=embed`;
      } else if (addr || addr2) {
        mapIframe.src = `https://maps.google.com/maps?q=${encodeURIComponent([addr, addr2].filter(Boolean).join(', '))}&z=15&output=embed`;
      }
    }
  }
}

function setupNavbar() {
  const navbar = $('navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    if (window.pageYOffset > 50) navbar.classList.add('scrolled');
    else navbar.classList.remove('scrolled');
  });
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        e.preventDefault();
        window.scrollTo({ top: target.getBoundingClientRect().top + window.pageYOffset - 80, behavior: 'smooth' });
      }
    });
  });

  const mobileBtn = document.querySelector('.mobile-menu-btn');
  if (mobileBtn) {
    function closeMenu(menu) {
      menu.classList.remove('active');
      mobileBtn.classList.remove('is-open');
      mobileBtn.setAttribute('aria-expanded', 'false');
    }
    function openMenu(menu) {
      menu.classList.add('active');
      mobileBtn.classList.add('is-open');
      mobileBtn.setAttribute('aria-expanded', 'true');
    }

    mobileBtn.addEventListener('click', () => {
      let menu = document.querySelector('.mobile-menu');
      if (!menu) {
        menu = document.createElement('div');
        menu.className = 'mobile-menu';
        menu.innerHTML = '<a href="#accueil">Accueil</a><a href="#services">Services</a><a href="#galerie">Galerie</a><a href="#avis">Avis</a><a href="#contact">Contact</a>';
        document.body.appendChild(menu);
        menu.querySelectorAll('a').forEach(a => a.onclick = () => closeMenu(menu));
        openMenu(menu);
      } else if (menu.classList.contains('active')) {
        closeMenu(menu);
      } else {
        openMenu(menu);
      }
    });
  }
}

(async () => {
  setupNavbar();
  const slug = getSlugFromUrl();
  // APERÇU LOCAL uniquement : ?fixture=salon-classique charge un salon d'exemple
  // depuis ../_fixtures/. En production ce paramètre n'existe pas — le rendu passe
  // par window.__SALON_VIEW__ (injecté par le serveur) exactement comme ci-dessous.
  const fixture = new URLSearchParams(window.location.search).get('fixture');
  // Stratégie de chargement de la vue salon :
  //   0. APERÇU : ?fixture={nom} → charge ../_fixtures/{nom}.json (dev design uniquement).
  //   1. Si SSR a injecté window.__SALON_VIEW__ (= custom hostname Falkenstein) :
  //      on l'utilise directement, pas de fetch (rendering instantané).
  //   2. Si slug dans URL (= /preview/{slug} sur Helsinki) : fetch /api/salon/{slug}.
  //   3. Sinon (= landing maquickpage.fr root) : on ne rend rien (pas un salon).
  try {
    if (window.__SALON_VIEW__) {
      renderSalon(window.__SALON_VIEW__);
    } else if (fixture) {
      const res = await fetch(`../_fixtures/${encodeURIComponent(fixture)}.json`);
      if (!res.ok) throw new Error(`Fixture introuvable : ${fixture}`);
      renderSalon(await res.json());
    } else if (slug) {
      const view = await fetchSalon(slug);
      renderSalon(view);
    }
  } catch (e) {
    console.error('Erreur chargement salon:', e);
  } finally {
    const overlay = $('loading-overlay');
    if (overlay) {
      setTimeout(() => overlay.classList.add('fade'), 100);
      setTimeout(() => overlay.remove(), 500);
    }
  }
})();

// === Tracking profondeur de scroll (best-effort, uniquement sur /preview/) ===
// Envoie le % de scroll max atteint quand l'utilisateur quitte/masque la page.
// Permet de savoir "jusqu'où il a fait défiler la maquette". Non bloquant.
(function () {
  'use strict';
  try {
    const path = (window.location.pathname || '').replace(/^\/+|\/+$/g, '');
    if (path.split('/')[0] !== 'preview') return;
    let maxPct = 0, sent = false;
    function compute() {
      const doc = document.documentElement;
      const scrollable = (doc.scrollHeight - window.innerHeight);
      const pct = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 100;
      if (pct > maxPct) maxPct = Math.min(100, pct);
    }
    window.addEventListener('scroll', compute, { passive: true });
    function flush() {
      // N'envoie l'event QUE si le visiteur a réellement scrollé (>0%).
      // Un "vu sans scroller" est déjà couvert par preview_ouvert → évite
      // les events scroll_max à 0% (bruit + faux "a scrollé").
      if (sent || maxPct <= 0) return;
      sent = true;
      try { window.mqsTrack && window.mqsTrack('scroll_max', { pct: maxPct }); } catch (e) {}
    }
    // sendBeacon fiable sur visibilitychange (mobile) + pagehide (desktop)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  } catch (e) { /* silencieux */ }
})();

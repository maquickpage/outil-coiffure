/* ============================================================================
   hydrate.js — TEMPLATE « drama »
   ----------------------------------------------------------------------------
   Données → DOM. Remplit UNIQUEMENT les conteneurs du contrat (../CONTRACT.md
   §3) et ne touche jamais au markup SEO que le serveur lit au build.

   Chargement de la vue salon (identique aux autres templates) :
     1. window.__SALON_VIEW__ injecté par le serveur (prod)         → rendu direct
     2. ?fixture={nom} → ../_fixtures/{nom}.json (APERÇU LOCAL seulement)
     3. /preview/{slug} → fetch /api/salon/{slug}
   Robustesse obligatoire : tout champ peut être vide/null → on masque le bloc,
   jamais de trou. note_avis < 4 → fallback commercial. mode "zone" → coiffeur
   à domicile (zone d'intervention, pas d'adresse précise).
   ============================================================================ */
(function () {
  "use strict";

  var DAYS = { monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi", friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche" };

  var ICONS = {
    facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 3a5.5 5.5 0 0 0 4.5 4.9v3a8.5 8.5 0 0 1-4.5-1.3v6.4a6 6 0 1 1-6-6c.34 0 .67.03 1 .09v3.1a3 3 0 1 0 2 2.8V3h3z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.5-.45-5.2a2.7 2.7 0 0 0-1.9-1.9C18.95 4.5 12 4.5 12 4.5s-6.95 0-8.65.4a2.7 2.7 0 0 0-1.9 1.9C1 8.5 1 12 1 12s0 3.5.45 5.2a2.7 2.7 0 0 0 1.9 1.9c1.7.4 8.65.4 8.65.4s6.95 0 8.65-.4a2.7 2.7 0 0 0 1.9-1.9C23 15.5 23 12 23 12zM10 15.5v-7l6 3.5-6 3.5z"/></svg>'
  };

  function $(id) { return document.getElementById(id); }

  /* Nom lisible de la plateforme de réservation, pour un libellé de lien plus
     parlant que « Réserver en ligne » quand on la reconnaît. */
  var BOOKING_PLATFORMS = [
    ["planity", "Planity"], ["treatwell", "Treatwell"], ["booksy", "Booksy"],
    ["reservio", "Reservio"], ["cituro", "Cituro"], ["settime", "SetTime"],
    ["rdv360", "RDV360"], ["merci-yanis", "Merci Yanis"]
  ];
  function bookingLinkLabel(url) {
    var host = String(url || "").toLowerCase();
    for (var i = 0; i < BOOKING_PLATFORMS.length; i++) {
      if (host.indexOf(BOOKING_PLATFORMS[i][0]) !== -1) return "Réserver sur " + BOOKING_PLATFORMS[i][1];
    }
    return "Réserver en ligne";
  }

  /* Ligne « Rendez-vous en ligne » de la section contact : c'est le SEUL
     endroit du site qui renvoie vers la plateforme de réservation du salon.
     Masquée tant qu'aucun lien n'est enregistré. */
  function applyBookingLine(bookingUrl) {
    var block = $("contact-booking-block");
    var link = $("contact-booking");
    if (!block || !link) return;
    if (isEmpty(bookingUrl)) {
      block.style.display = "none";
      document.body.classList.remove("mqs-has-booking");
      return;
    }
    link.href = bookingUrl;
    link.textContent = bookingLinkLabel(bookingUrl);
    block.style.display = "";
    document.body.classList.add("mqs-has-booking");
  }
  function txt(id, v) { var e = $(id); if (e && v != null) e.textContent = v; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  /* Masque un bloc "maskable" proprement (sans laisser de trou). */
  function mask(id, keep) { var e = $(id); if (e) e.hidden = !keep; }
  function isEmpty(v) { return v == null || (typeof v === "string" && v.trim() === ""); }

  /* Horaires : les données scrapées (scrap.io) arrivent parfois au format
     "9-am-5-pm" / "1030-am-630-pm". Les données propres (tapées par le coiffeur
     ou DEFAULT) sont déjà en "9h - 19h" → affichées telles quelles. */
  function humanizeHours(v) {
    if (isEmpty(v)) return "";
    var s = String(v);
    if (/-am-?|-pm-?/.test(s)) {
      s = s.replace(/(\d+)-pm/g, function (m, digits) {
        var isHHMM = digits.length >= 3;
        var h = isHHMM ? parseInt(digits.slice(0, -2), 10) : parseInt(digits, 10);
        var min = isHHMM ? digits.slice(-2) : "00";
        var h24 = (h === 12 ? 12 : h + 12);
        return min === "00" ? h24 + "h" : h24 + "h" + min;
      });
      s = s.replace(/(\d+)-am/g, function (m, digits) {
        var isHHMM = digits.length >= 3;
        var h = isHHMM ? parseInt(digits.slice(0, -2), 10) : parseInt(digits, 10);
        var min = isHHMM ? digits.slice(-2) : "00";
        var h24 = (h === 12 ? 0 : h);
        return min === "00" ? h24 + "h" : h24 + "h" + min;
      });
      return s.replace(/-/g, " - ");
    }
    return s;
  }

  /* ---- carrousel services mobile ------------------------------------------
     1 slide PAR CATÉGORIE (Femmes / Hommes / Autres), chaque slide = la liste
     des prestations de la catégorie. Actif uniquement ≤ 768px ET s'il y a
     plus d'une catégorie ; sinon liste normale (grille desktop inchangée). */
  var CATEGORY_ORDER = ["femme", "homme", "autres"];
  var CATEGORY_LABELS = { femme: "Femmes", homme: "Hommes", autres: "Autres" };
  var servicesItems = [];
  var servicesPage = 0;
  var servicesMode = null; /* 'list' | 'carousel' */
  var servicesResizeBound = false;

  function serviceCategory(s) {
    return CATEGORY_ORDER.indexOf(s.category) !== -1 ? s.category : "autres";
  }
  /* [{ cat, label, items }] — catégories non vides, ordre fixe. */
  function categoryPages(items) {
    return CATEGORY_ORDER.map(function (cat) {
      return {
        cat: cat,
        label: CATEGORY_LABELS[cat],
        items: items.filter(function (s) { return serviceCategory(s) === cat; })
      };
    }).filter(function (p) { return p.items.length > 0; });
  }

  function serviceCardHtml(s, globalIndex) {
    var num = String(globalIndex + 1).padStart(2, "0");
    return '<article class="service-card">' +
             '<span class="service-num">' + num + "</span>" +
             '<div class="service-body">' +
               '<h3 class="service-name">' + esc(s.name) + "</h3>" +
               (isEmpty(s.description) ? "" : '<p class="service-desc">' + esc(s.description) + "</p>") +
             "</div>" +
             (isEmpty(s.price) ? "" : '<span class="service-price">' + esc(s.price) + "</span>") +
           "</article>";
  }

  function buildServices(items) {
    var section = $("services");
    var grid = $("services-grid");
    if (!grid) return;
    servicesItems = items.slice(0, 20);
    if (servicesItems.length === 0) { if (section) section.style.display = "none"; return; }
    if (section) section.style.display = "";
    servicesMode = null;
    renderServices();
    if (!servicesResizeBound) {
      servicesResizeBound = true;
      var timer = null;
      window.addEventListener("resize", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(renderServices, 120);
      });
    }
  }

  /* En-tête du carrousel : [◀] Nom de la catégorie [▶]. Les flèches étaient
     centrées verticalement sur toute la hauteur du slide, donc perdues au
     milieu d'une longue liste ; ici elles encadrent le titre, en haut, toujours
     visibles. Le libellé garde la classe .services-cat-label pour hériter de la
     typo propre au template. */
  function ensureCarouselHead(wrapper, prev, next) {
    if (!wrapper) return null;
    var head = wrapper.querySelector(".services-carousel-head");
    if (head) return head;
    head = document.createElement("div");
    head.className = "services-carousel-head";
    var label = document.createElement("p");
    label.className = "services-cat-label services-carousel-cat";
    head.appendChild(prev);
    head.appendChild(label);
    head.appendChild(next);
    wrapper.insertBefore(head, wrapper.firstChild);
    return head;
  }

  function renderServices() {
    var grid = $("services-grid");
    var wrapper = $("services-wrapper");
    var prev = $("services-prev");
    var next = $("services-next");
    var dots = $("services-dots");
    if (!grid) return;

    var mobile = window.matchMedia("(max-width: 768px)").matches;
    var pages = categoryPages(servicesItems);
    /* Une seule catégorie mais liste longue → carrousel quand même, par pages
       de 4 sans en-tête de catégorie (sinon la liste redevient interminable). */
    if (pages.length === 1 && servicesItems.length > 4) {
      pages = [];
      for (var pi = 0; pi < servicesItems.length; pi += 4) {
        pages.push({ label: "", items: servicesItems.slice(pi, pi + 4) });
      }
    }
    var useCarousel = mobile && pages.length > 1;
    if (wrapper) wrapper.classList.toggle("is-carousel", useCarousel);

    if (!useCarousel) {
      if (servicesMode !== "list") {
        grid.innerHTML = servicesItems.map(function (s, i) { return serviceCardHtml(s, i); }).join("");
        servicesMode = "list";
      }
      grid.style.transform = "";
      /* Retour en liste (rotation de l'écran, passage sur tablette) : on rend la
         main au flux normal, sinon la hauteur figée par le carrousel persiste. */
      var clipReset = wrapper && wrapper.querySelector(".services-clip");
      if (clipReset) clipReset.style.height = "";
      var headReset = wrapper && wrapper.querySelector(".services-carousel-head");
      if (headReset) headReset.hidden = true;
      if (prev) prev.hidden = true;
      if (next) next.hidden = true;
      if (dots) dots.innerHTML = "";
      return;
    }

    if (servicesMode !== "carousel") {
      /* Numérotation locale à chaque slide (01, 02, …) — une numérotation
         globale laisserait des trous visibles dans les catégories.
         Le nom de catégorie sort du slide pour rejoindre l'en-tête fixe, entre
         les deux flèches : il ne défile donc plus avec le contenu. */
      grid.innerHTML = pages.map(function (p) {
        return '<div class="services-page">' +
                 p.items.map(function (s, i) { return serviceCardHtml(s, i); }).join("") +
               "</div>";
      }).join("");
      servicesMode = "carousel";
    }
    var head = ensureCarouselHead(wrapper, prev, next);
    if (head) head.hidden = false;
    if (servicesPage > pages.length - 1) servicesPage = pages.length - 1;

    /* Les pages sont des flex items côte à côte : sans ça le conteneur prend la
       hauteur de la plus longue et toutes les pages s'étirent dessus. Résultat,
       en passant d'une catégorie très fournie à une catégorie courte, on tombait
       sur un grand vide avec deux lignes tout en haut. On fige donc la hauteur
       du clip sur celle de la page affichée (animée par la transition CSS). */
    function syncHeight() {
      var clip = wrapper && wrapper.querySelector(".services-clip");
      var active = grid.querySelectorAll(".services-page")[servicesPage];
      if (!clip || !active) return;
      clip.style.height = active.offsetHeight + "px";
    }

    function update() {
      var page = grid.querySelector(".services-page");
      var gap = 24;
      var step = page ? page.offsetWidth + gap : 0;
      grid.style.transform = "translateX(-" + (servicesPage * step) + "px)";
      syncHeight();
      var label = head && head.querySelector(".services-carousel-cat");
      /* Pas de libellé quand les pages ne sont pas des catégories (cas « une
         seule catégorie, liste longue » découpée en paquets) → rang affiché. */
      if (label) label.textContent = pages[servicesPage].label || (servicesPage + 1) + " / " + pages.length;
      prev.hidden = false;
      next.hidden = false;
      prev.disabled = servicesPage === 0;
      next.disabled = servicesPage >= pages.length - 1;
      dots.innerHTML = pages.map(function (p, di) {
        return '<button class="carousel-dot' + (di === servicesPage ? " active" : "") + '" data-i="' + di + '" aria-label="' + (p.label || "Page " + (di + 1)) + '"></button>';
      }).join("");
      dots.querySelectorAll("button").forEach(function (b) {
        b.onclick = function () { servicesPage = parseInt(b.dataset.i, 10); update(); };
      });
    }
    prev.onclick = function () { if (servicesPage > 0) { servicesPage--; update(); } };
    next.onclick = function () { if (servicesPage < pages.length - 1) { servicesPage++; update(); } };

    var startX = 0;
    grid.ontouchstart = function (e) { startX = e.touches[0].clientX; };
    grid.ontouchend = function (e) {
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) < 40) return;
      if (dx < 0) next.onclick(); else prev.onclick();
    };

    update();
    /* Les hauteurs bougent après coup (polices web, retour à la ligne d'un nom
       de prestation long) → on remesure quand elles sont prêtes. */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeight).catch(function () {});
    requestAnimationFrame(syncHeight);
  }

  function hydrate(view) {
    var c = view.content || {};
    var hero = c.hero || {}, intro = c.intro || {}, contact = c.contact || {};

    /* Option éditeur « photos en couleur » : désactive les filtres N&B (CSS
       body.photos-color). Défaut = monochrome (signature du template). */
    document.body.classList.toggle("photos-color", !!(c.design && c.design.monochromePhotos === false));

    /* ---- brand / logo ---- */
    txt("logo-text", view.nom || hero.title || "Salon");
    txt("logo-sub", view.ville || "Coiffure");
    txt("footer-logo-text", view.nom || hero.title || "Salon");
    txt("footer-logo-sub", view.ville || "Coiffure");
    txt("footer-name", view.nom || hero.title || "Salon");
    /* Même formule que classic/contrast — « Bienvenue à … » (titre d'intro)
       lisait bizarrement en signature de footer. */
    txt("footer-tagline", "Votre salon de coiffure" + (view.ville ? " à " + view.ville : ""));
    txt("footer-year", new Date().getFullYear());

    /* ---- hero ---- */
    txt("hero-tagline", hero.tagline);
    txt("hero-title", hero.title || view.nom);
    txt("hero-subtitle", hero.subtitle);
    if (hero.backgroundImage) {
      document.documentElement.style.setProperty("--hero-image", "url('" + hero.backgroundImage + "')");
    }

    /* ---- CTA « Réserver » : TOUJOURS vers #contact, même si le salon a un lien
       de réservation en ligne. Aucun bouton de la page ne doit faire sortir le
       visiteur du site ; la réservation en ligne se fait depuis la ligne dédiée
       de la section contact. ---- */
    var cta = $("nav-cta");
    if (cta) {
      cta.href = "#contact"; cta.removeAttribute("target"); cta.removeAttribute("rel");
    }
    applyBookingLine(contact.bookingUrl);

    /* ---- intro ---- */
    txt("intro-title", intro.title);
    txt("intro-description", intro.description);

    /* ---- stats : note Google seulement si showRating ET note >= 4, sinon fallback ---- */
    var rating = view.note_avis;
    var showRating = intro.showRating && typeof rating === "number" && rating >= 4;
    if (showRating) {
      mask("stat-rating-block", true);
      txt("stat-rating", rating.toFixed(1).replace(".", ","));
    } else if (!isEmpty(intro.ratingFallback)) {
      var block = $("stat-rating-block");
      if (block) {
        block.hidden = false;
        block.classList.add("stat-fallback");
        block.innerHTML = '<span class="stat-fallback-text">' + esc(intro.ratingFallback) + "</span>";
      }
    } else {
      mask("stat-rating-block", false);
    }
    if (intro.showSatisfaction !== false && !isEmpty(intro.satisfactionValue)) {
      mask("stat-satisfaction-block", true);
      txt("stat-satisfaction-value", intro.satisfactionValue);
      txt("stat-satisfaction-label", intro.satisfactionLabel || "Satisfaction");
    } else {
      mask("stat-satisfaction-block", false);
    }

    /* ---- services (liste numérotée, prix doré à droite)
       Desktop/tablette : liste 2 colonnes / 1 colonne.
       Mobile : la liste complète est trop longue → carrousel par pages de
       4 prestations (swipe + flèches + points), numérotation continue. ---- */
    buildServices((c.services && c.services.items) || []);

    /* ---- gallery (grid | masonry, bouton « Afficher plus ») ---- */
    var gg = $("gallery-grid");
    var gallerySection = $("galerie");
    var imgs = (c.gallery && c.gallery.images) || [];
    if (gg) {
      if (imgs.length === 0) { if (gallerySection) gallerySection.style.display = "none"; }
      else {
        if (gallerySection) gallerySection.style.display = "";
        var visible = c.gallery.visibleCount || imgs.length;
        gg.classList.toggle("layout-masonry", (c.gallery.layout || "grid") === "masonry");
        gg.innerHTML = imgs.map(function (src, i) {
          var hide = i >= visible ? ' data-extra="1" hidden' : "";
          return '<a class="gallery-item" href="' + esc(src) + '"' + hide + '><img src="' + esc(src) + '" alt="Réalisation ' + (i + 1) + '" loading="lazy"><span class="gallery-overlay"></span></a>';
        }).join("");
        var more = $("gallery-load-more");
        if (more) {
          if (imgs.length > visible) {
            more.hidden = false;
            var btn = $("btn-load-more");
            if (btn) btn.addEventListener("click", function () {
              gg.querySelectorAll('[data-extra="1"]').forEach(function (el) { el.hidden = false; });
              more.hidden = true;
            });
          } else { more.hidden = true; }
        }
      }
    }

    /* ---- testimonials ---- */
    var tr = $("testimonials-row");
    var avisSection = $("avis");
    /* 3 avis max — même plafond que l'éditeur admin et les autres templates. */
    var tItems = ((c.testimonials && c.testimonials.items) || []).slice(0, 3);
    if (tr) {
      if (tItems.length === 0) { if (avisSection) avisSection.style.display = "none"; }
      else {
        if (avisSection) avisSection.style.display = "";
        var star = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.6 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg>';
        tr.innerHTML = tItems.map(function (t) {
          return '<article class="testimonial-card">' +
                   '<div class="testimonial-stars">' + star + star + star + star + star + "</div>" +
                   '<p class="testimonial-text">' + esc(t.text) + "</p>" +
                   '<div class="testimonial-author">' +
                     '<span class="author-name">' + esc(t.author || "Client satisfait") + "</span>" +
                     (isEmpty(t.date) ? "" : '<span class="author-date">' + esc(t.date) + "</span>") +
                   "</div>" +
                 "</article>";
        }).join("");
      }
    }

    /* ---- contact ---- */
    txt("contact-title", contact.title);
    var cd = $("contact-description"); if (cd) cd.textContent = contact.description || "";

    var isZone = contact.mode === "zone";
    var labelStrong = $("contact-address-block") && $("contact-address-block").querySelector("strong");
    if (labelStrong) labelStrong.textContent = isZone ? "Zone d'intervention" : "Adresse";
    if (isZone) {
      /* Coiffeur à domicile : zone d'intervention, jamais l'adresse précise. */
      mask("contact-address-block", true);
      txt("contact-address", contact.serviceArea || contact.addressLine2 || view.ville || "Sur demande");
    } else if (!isEmpty(contact.address) || !isEmpty(contact.addressLine2)) {
      mask("contact-address-block", true);
      var addr = [contact.address, contact.addressLine2].filter(function (x) { return !isEmpty(x); }).join(", ");
      txt("contact-address", addr);
    } else {
      mask("contact-address-block", false);
    }

    if (!isEmpty(contact.phone)) {
      mask("contact-phone-block", true);
      var ph = $("contact-phone");
      if (ph) { ph.textContent = contact.phone; ph.href = "tel:" + contact.phone.replace(/\s+/g, ""); }
    } else { mask("contact-phone-block", false); }

    if (!isEmpty(contact.email)) {
      mask("contact-email-block", true);
      var em = $("contact-email");
      if (em) { em.textContent = contact.email; em.href = "mailto:" + contact.email; }
    } else { mask("contact-email-block", false); }

    /* ---- hours ---- */
    var ch = $("contact-hours");
    if (ch && contact.hours) {
      var rows = Object.keys(DAYS).map(function (k) {
        var v = contact.hours[k];
        if (isEmpty(v)) return "";
        var closed = v === "closed";
        return '<span class="day">' + DAYS[k] + "</span>" +
               '<span class="hours' + (closed ? " closed" : "") + '">' + (closed ? "Fermé" : esc(humanizeHours(v))) + "</span>";
      }).join("");
      ch.innerHTML = '<div class="opening-hours-table">' + rows + "</div>";
    }

    /* ---- socials (contact + footer) ---- */
    function socialHTML() {
      var socials = c.socials || {};
      return Object.keys(socials).map(function (k) {
        var s = socials[k];
        if (!s || s.enabled === false || isEmpty(s.url)) return "";
        return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" aria-label="' + k + '">' + (ICONS[k] || "") + "</a>";
      }).join("");
    }
    /* Aucun réseau → conteneurs masqués (pas de marge fantôme). */
    var socialsHtml = socialHTML();
    var si = $("social-icons"); if (si) { si.innerHTML = socialsHtml; si.style.display = socialsHtml ? "" : "none"; }
    var fs = $("footer-social"); if (fs) { fs.innerHTML = socialsHtml; fs.style.display = socialsHtml ? "" : "none"; }

    /* ---- map ----
       - zone + hideMap → carte masquée (opt-in coiffeur à domicile)
       - zone → vue large centrée sur la zone, SANS marqueur (vie privée)
       - address → vue rapprochée avec marqueur */
    var mapContainer = document.querySelector(".contact-map");
    var map = $("map-iframe");
    if (isZone && contact.hideMap) {
      if (mapContainer) mapContainer.style.display = "none";
      if (map) map.removeAttribute("src");
    } else if (map) {
      if (mapContainer) mapContainer.style.display = "";
      var lat = contact.latitude, lng = contact.longitude;
      var addrQuery = [contact.address, contact.addressLine2].filter(function (x) { return !isEmpty(x); }).join(", ");
      if (typeof lat === "number" && typeof lng === "number") {
        var d = isZone ? 0.06 : 0.01; /* zone : cadrage plus large */
        var bbox = (lng - d) + "," + (lat - d) + "," + (lng + d) + "," + (lat + d);
        var src = "https://www.openstreetmap.org/export/embed.html?bbox=" + bbox + "&layer=mapnik";
        if (!isZone) src += "&marker=" + lat + "," + lng;
        map.src = src;
      } else if (!isZone && addrQuery) {
        /* Parité avec classic/contrast : pas de lat/lng mais une adresse →
           embed Google Maps (le filtre N&B du conteneur s'applique pareil). */
        map.src = "https://maps.google.com/maps?q=" + encodeURIComponent(addrQuery) + "&z=15&output=embed";
      } else if (isZone && !isEmpty(contact.addressLine2)) {
        map.src = "https://maps.google.com/maps?q=" + encodeURIComponent(contact.addressLine2.trim()) + "&z=12&output=embed";
      } else if (mapContainer) {
        mapContainer.style.display = "none";
      }
    }

    /* ---- fade du voile de chargement ---- */
    var lo = $("loading-overlay");
    if (lo) { lo.classList.add("fade"); setTimeout(function () { lo.style.display = "none"; }, 400); }
  }

  /* ---- chargement de la vue salon --------------------------------------- */
  function getSlugFromUrl() {
    var path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    var parts = path.split("/");
    return (parts[0] === "preview" && parts[1]) ? parts[1] : null;
  }

  /* ---- menu mobile (parité classic/contrast : le bouton hamburger doit
     ouvrir un menu plein écran, sinon la nav est morte sur mobile) ---- */
  function setupMobileMenu() {
    var btn = document.querySelector(".mobile-menu-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var menu = document.querySelector(".mobile-menu");
      if (!menu) {
        menu = document.createElement("div");
        menu.className = "mobile-menu";
        menu.innerHTML = '<a href="#accueil">Accueil</a><a href="#services">Services</a><a href="#galerie">Galerie</a><a href="#avis">Avis</a><a href="#contact">Contact</a>';
        document.body.appendChild(menu);
        menu.querySelectorAll("a").forEach(function (a) {
          a.addEventListener("click", function () { menu.classList.remove("active"); btn.classList.remove("is-open"); });
        });
      }
      var open = menu.classList.toggle("active");
      btn.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function boot() {
    setupMobileMenu();
    var fixture = new URLSearchParams(window.location.search).get("fixture");
    var slug = getSlugFromUrl();
    if (window.__SALON_VIEW__) {
      hydrate(window.__SALON_VIEW__);
    } else if (fixture) {
      fetch("../_fixtures/" + encodeURIComponent(fixture) + ".json")
        .then(function (r) { if (!r.ok) throw new Error("Fixture introuvable : " + fixture); return r.json(); })
        .then(hydrate)
        .catch(function (e) { console.error("Erreur chargement salon:", e); var lo = $("loading-overlay"); if (lo) lo.style.display = "none"; });
    } else if (slug) {
      fetch("/api/salon/" + encodeURIComponent(slug))
        .then(function (r) { if (!r.ok) throw new Error("Salon introuvable"); return r.json(); })
        .then(hydrate)
        .catch(function (e) { console.error("Erreur chargement salon:", e); var lo = $("loading-overlay"); if (lo) lo.style.display = "none"; });
    } else {
      var lo = $("loading-overlay"); if (lo) lo.style.display = "none";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
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

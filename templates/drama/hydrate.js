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

  function hydrate(view) {
    var c = view.content || {};
    var hero = c.hero || {}, intro = c.intro || {}, contact = c.contact || {};

    /* ---- brand / logo ---- */
    txt("logo-text", view.nom || hero.title || "Salon");
    txt("logo-sub", view.ville || "Coiffure");
    txt("footer-logo-text", view.nom || hero.title || "Salon");
    txt("footer-logo-sub", view.ville || "Coiffure");
    txt("footer-name", view.nom || hero.title || "Salon");
    txt("footer-tagline", intro.title || "Salon de coiffure");
    txt("footer-year", new Date().getFullYear());

    /* ---- hero ---- */
    txt("hero-tagline", hero.tagline);
    txt("hero-title", hero.title || view.nom);
    txt("hero-subtitle", hero.subtitle);
    if (hero.backgroundImage) {
      document.documentElement.style.setProperty("--hero-image", "url('" + hero.backgroundImage + "')");
    }

    /* ---- CTA « Réserver » : lien de réservation si dispo, sinon scroll contact ---- */
    var cta = $("nav-cta");
    if (cta) {
      if (!isEmpty(contact.bookingUrl)) {
        cta.href = contact.bookingUrl; cta.target = "_blank"; cta.rel = "noopener";
      } else {
        cta.href = "#contact"; cta.removeAttribute("target"); cta.removeAttribute("rel");
      }
    }

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

    /* ---- services (liste numérotée, prix doré à droite) ---- */
    var sg = $("services-grid");
    var servicesSection = $("services");
    var sItems = (c.services && c.services.items) || [];
    if (sg) {
      if (sItems.length === 0) { if (servicesSection) servicesSection.style.display = "none"; }
      else {
        if (servicesSection) servicesSection.style.display = "";
        sg.innerHTML = sItems.map(function (s, i) {
          var num = String(i + 1).padStart(2, "0");
          return '<article class="service-card">' +
                   '<span class="service-num">' + num + "</span>" +
                   '<div class="service-body">' +
                     '<h3 class="service-name">' + esc(s.name) + "</h3>" +
                     (isEmpty(s.description) ? "" : '<p class="service-desc">' + esc(s.description) + "</p>") +
                   "</div>" +
                   (isEmpty(s.price) ? "" : '<span class="service-price">' + esc(s.price) + "</span>") +
                 "</article>";
        }).join("");
      }
    }

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
    var tItems = (c.testimonials && c.testimonials.items) || [];
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
    var si = $("social-icons"); if (si) si.innerHTML = socialHTML();
    var fs = $("footer-social"); if (fs) fs.innerHTML = socialHTML();

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
      if (typeof lat === "number" && typeof lng === "number") {
        var d = isZone ? 0.06 : 0.01; /* zone : cadrage plus large */
        var bbox = (lng - d) + "," + (lat - d) + "," + (lng + d) + "," + (lat + d);
        var src = "https://www.openstreetmap.org/export/embed.html?bbox=" + bbox + "&layer=mapnik";
        if (!isZone) src += "&marker=" + lat + "," + lng;
        map.src = src;
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

  function boot() {
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

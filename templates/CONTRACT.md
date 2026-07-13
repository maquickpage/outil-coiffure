# Contrat des templates — à lire avant de créer un modèle

Un template MaQuickPage n'est pas une page HTML libre : c'est une **peau**
posée sur des **données** (un salon) et enveloppée par la **plateforme**
(SEO + vente). Tant que tu respectes ce contrat, un même salon peut passer
d'un template à l'autre **sans aucune migration de données**, et le site
fonctionne aussi bien en démo qu'une fois le coiffeur devenu client payant.

Ce fichier décrit **ce que tu dois respecter**. Le reste (couleurs, polices,
disposition, animations) est 100 % libre.

---

## 1. Le partage des responsabilités

```
┌─────────────────────────────────────────────────────────────┐
│  PLATEFORME (déjà géré côté serveur — tu n'y touches pas)    │
│   • <head> SEO : title, meta description, Open Graph,        │
│     JSON-LD HairSalon, canonical, robots                     │
│   • window.__SALON_VIEW__ = les données du salon (injectées) │
│   • Chrome de vente : bannière CTA « Activer mon site »,     │
│     modale de prix, écran d'attente, onboarding, tracking    │
├─────────────────────────────────────────────────────────────┤
│  TON TEMPLATE (ce que tu fournis)                            │
│   • index.html  → le <body> du salon + les polices + le CSS  │
│   • styles.css  → tout le design                             │
│   • hydrate.js  → données → DOM (tu pars du classic)         │
│   • template.json → métadonnées                              │
└─────────────────────────────────────────────────────────────┘
```

**Tu ne mets JAMAIS dans un template :** les balises SEO `<title>`/`<meta
description>`/OG/JSON-LD (la plateforme les réécrit), ni les scripts de vente
(bannière, modale de prix…). La plateforme les injecte autour de ton HTML.

---

## 2. Les données : l'objet `view`

Toutes les données arrivent dans un seul objet JS global : `window.__SALON_VIEW__`.
En aperçu local, il est chargé depuis `_fixtures/*.json`. **Regarde
`_fixtures/salon-classique.json` : c'est la forme exacte, exhaustive.**

Structure (les champs que ton template peut afficher) :

```
view = {
  slug, nom, nom_original, ville,
  note_avis (nombre|null), nb_avis, lien_google_maps, meta_description,
  content: {
    hero:    { title, tagline, subtitle, backgroundImage, showRating },
    intro:   { title, description, showRating, ratingFallback,
               showSatisfaction, satisfactionValue, satisfactionLabel },
    services:     { title, items: [ {id, name, description, price} ] },
    gallery:      { title, layout: "grid"|"masonry", visibleCount, images: [url] },
    testimonials: { title, items: [ {id, text, author, date} ] },
    contact: {
      title, description,
      mode: "address"|"zone",     // "zone" = coiffeur à domicile
      address, addressLine2,       // mode "address"
      serviceArea, hideMap,        // mode "zone"
      phone, email,
      hours: { monday..sunday : "9h - 19h" | "closed" },
      latitude, longitude, bookingUrl
    },
    socials: {
      facebook:  { url, enabled },
      instagram: { url, enabled },
      tiktok:    { url, enabled },
      youtube:   { url, enabled }
    }
  },
  has_overrides
}
```

**Règles de robustesse (obligatoires — 10 000+ salons réels, données trouées) :**

- Tout champ peut être vide/`null`. Un champ vide **ne doit pas** casser la page :
  cache le bloc concerné (c'est ce que fait `hydrate.js` : `display:none` sur le
  téléphone/email/carte manquants).
- `note_avis` : n'affiche « Note Google » **que si `showRating` est vrai ET
  `note_avis >= 4`**, sinon affiche `intro.ratingFallback` (texte commercial).
- `contact.mode === "zone"` : affiche `serviceArea` au lieu de l'adresse, libellé
  « Zone d'intervention », et carte centrée sur la ville (pas de marqueur précis).
- `gallery.layout` : `grid` (défaut) ou `masonry`. Ton CSS doit gérer les deux
  (classe `.layout-masonry` ajoutée sur la grille).
- `hours` : une valeur peut être `"closed"` (→ afficher « Fermé »).

Tu **n'inventes pas** de nouveau champ sans prévenir : ajouter un champ, c'est
toucher au back (`src/defaults.js`) + à la console d'édition. À discuter ensemble.

---

## 3. Le HTML : les `id` obligatoires

Deux mécanismes lisent ton HTML **par `id`**. Si tu renommes/supprimes un `id`
de cette liste, ça casse en silence (SEO qui ne s'injecte plus, ou section vide).

### Injectés par le SERVEUR pour le SEO (`src/ssr.js`) — NE PAS renommer

`logo-text`, `logo-sub`, `footer-logo-text`, `footer-logo-sub`, `footer-name`,
`footer-tagline`, `hero-tagline`, `hero-title`, `hero-subtitle`, `intro-title`,
`intro-description`, `contact-address`, `contact-phone`, `contact-email`.

> `hero-title` **doit rester le `<h1>`** de la page (un seul H1, signal SEO fort).

### Remplis par `hydrate.js` (données) — conteneurs et blocs

- Conteneurs listes : `services-grid`, `gallery-grid`, `testimonials-row`,
  `contact-hours`, `social-icons`, `footer-social`.
- Carrousels : `services-wrapper`/`services-prev`/`services-next`/`services-dots` ;
  idem `testimonials-*` ; galerie `gallery-load-more`/`btn-load-more`.
- Blocs masquables : `contact-phone-block`, `contact-email-block`,
  `contact-address-block`, `stat-rating-block`, `stat-satisfaction-block`.
- Divers : `nav-cta` (bouton Réserver), `map-iframe`, `stat-rating`,
  `stat-satisfaction-value`, `stat-satisfaction-label`, `footer-year`,
  `loading-overlay`.

Tu peux **déplacer** ces éléments, changer leurs balises, leur style, ajouter du
markup autour. Tu dois juste **conserver l'`id` et sa nature** (un `<a>` pour
`contact-phone`, un `<iframe>` pour `map-iframe`, etc.).

> Si ton design change vraiment la structure (ex. pas de carrousel services),
> tu adaptes `hydrate.js` en conséquence : c'est TON fichier, tu as le droit.
> Garde juste la même logique de robustesse (champs vides → masqués).

---

## 4. La chrome de vente (ne pas la reproduire, ne pas la gêner)

En prod, la plateforme ajoute par-dessus ton template : la **bannière CTA**
(haut de page) et la **modale de prix**. C'est ce qui transforme une démo en
client. Tu n'as rien à coder pour ça, mais :

- Ne mets pas de `position:fixed` en haut qui masquerait la bannière.
- `hydrate.js` mesure déjà la hauteur du header/bannière pour caler le hero
  (fonction `syncHeroBounds`) — garde l'event `mqs-header-changed` si tu
  réécris cette partie.

---

## 5. Créer un nouveau template — pas à pas

1. Copier `templates/classic/` → `templates/<mon-nom>/`.
2. Modifier `template.json` (id, name, description, fonts).
3. Refaire `styles.css` et réorganiser `index.html` (en gardant les `id` du §3).
4. Adapter `hydrate.js` **seulement si** la structure diverge.
5. Ajouter `<mon-nom>` dans `_preview/index.html` (tableau `TEMPLATES`).
6. Prévisualiser : servir `templates/` en HTTP puis ouvrir `_preview/`
   (voir README). Tester les 2 fixtures (salon **et** domicile) + les 3 largeurs.
7. Checklist avant PR : voir §6.

---

## 6. Checklist « bon à intégrer »

- [ ] Rendu OK avec `salon-classique` **et** `salon-domicile`.
- [ ] Testé desktop / tablette / mobile.
- [ ] Un seul `<h1>` = `hero-title`.
- [ ] Téléphone / email / carte absents → bloc masqué, pas de trou.
- [ ] Note < 4 ou absente → fallback commercial affiché (pas « —/5 »).
- [ ] Galerie testée en `grid` et `masonry`.
- [ ] Mode `zone` : « Zone d'intervention » affichée, pas d'adresse précise.
- [ ] Aucune balise SEO ni script de vente ajoutés dans le template.
- [ ] Tous les `id` du §3 présents.

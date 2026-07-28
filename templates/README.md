# Templates MaQuickPage — atelier design

Ce dossier est l'**atelier des templates** de sites coiffeur. On y crée les
modèles qu'on présente aux prospects (démos) et que les clients payants
utilisent une fois en ligne. Un même salon peut changer de template sans perdre
ses données : design et contenu sont séparés.

> 👉 **Avant de créer un template, lire [`CONTRACT.md`](./CONTRACT.md).** C'est
> court et ça évite 100 % des pièges (SEO, données trouées, chrome de vente).

## Arborescence

```
templates/
├── CONTRACT.md          ← le contrat à respecter (à lire en premier)
├── README.md            ← ce fichier
├── _preview/            ← harnais d'aperçu local (ne pas livrer, outil interne)
│   └── index.html
├── _fixtures/           ← salons d'exemple (données réelles anonymisées)
│   ├── salon-classique.json   (salon en boutique, Lyon)
│   └── salon-domicile.json    (coiffeuse à domicile — mode « zone »)
└── classic/             ← LE template de référence (point de départ)
    ├── index.html       ← le <body> du salon (garder les id="…")
    ├── styles.css       ← tout le design
    ├── hydrate.js       ← données → DOM
    └── template.json    ← métadonnées du template
```

## Prévisualiser (30 secondes)

Le fetch des fixtures est bloqué en `file://` : il faut servir le dossier en HTTP.
Depuis `templates/` :

```bash
npx serve          # (ou : python -m http.server 8080)
```

Puis ouvrir l'URL affichée en ajoutant `/_preview/` — ex. `http://localhost:3000/_preview/`.
Tu peux choisir le template, le salon d'exemple, et la largeur d'écran.

Astuce : pour ouvrir un template seul, utilise l'**URL-dossier** (slash final, sans
`index.html`) sinon le serveur perd le paramètre : `…/classic/?fixture=salon-classique`.

## Créer un nouveau template

```bash
cp -r classic mon-template
```

1. Édite `mon-template/template.json` (id, name, description, fonts).
2. Refais `styles.css` et réorganise `index.html` — **en gardant les `id`**
   listés dans `CONTRACT.md` §3.
3. N'adapte `hydrate.js` que si tu changes vraiment la structure.
4. Ajoute `mon-template` dans `_preview/index.html` (tableau `TEMPLATES` en bas).
5. Teste avec les **deux** fixtures et les **trois** largeurs.
6. Déroule la checklist de `CONTRACT.md` §6, puis ouvre une Pull Request.

## Ce qui vit ailleurs dans le repo (pour info)

Le template s'intègre à l'appli principale ; ces fichiers sont le « côté prod »
et te donnent le contexte si besoin :

- `src/defaults.js` — construit l'objet `view` (le contrat de données).
- `src/ssr.js` — injecte le SEO + les données côté serveur (utilise les `id`).
- `public/site/` — l'emplacement du template **actuellement en production**
  (`index.html` + `styles.css` + `main.js`). `classic/` en est la version
  « atelier » nettoyée. La bascule multi-template côté serveur est le chantier
  suivant (champ `template` par salon + sélecteur dans l'admin).
- `public/edit/` — la console où le coiffeur édite ses données (indépendante du
  template, sauf l'option galerie grid/masonry).

## Règle d'or

Design libre, **contrat sacré**. Tant que les `id` et la forme des données sont
respectés, ton template marche partout : démo, site payant, et bascule d'un
modèle à l'autre sans migration.

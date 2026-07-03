/* =====================================================================
   Arbres de conversation d'appel — MaQuickPage (vente de sites aux coiffeurs)
   4 APPROCHES au choix (écoles de cold calling), partageant les mêmes
   nœuds d'objections/closing ; seule l'ouverture (opener + pitch) change.
   Source unique de vérité pour : le mode guidé, la vue carte, le catalogue
   envoyé au copilote IA, et les arguments clés affichés dans l'UI.

   ⚠️ CHIFFRES VÉRIFIÉS dans le code produit (checkout.js / pricing-modal.js /
   CGV) le 2026-07-02 — si le pricing change, mettre à jour ICI et dans le
   system prompt du copilote (src/routes/calling.js) :
     9,90 €/mois TTC (engagement 24 mois, -65% vs flex) · 17,90 €/mois (12 mois,
     « le plus choisi ») · 29 €/mois sans engagement · zéro frais de mise en
     service · domaine .fr/.com offert, AU NOM DU CLIENT, transférable ·
     en ligne < 5 min après paiement.
   ===================================================================== */
(function (global) {
  'use strict';

  /* --------- Arguments clés (affichés dans l'UI, à connaître par cœur) ----- */
  var SALES_ARGS = [
    { t: 'Le site est DÉJÀ fait', d: 'Démo complète et unique : vraies photos Google choisies par IA, avis et note Google, horaires, texte pro. Regarder est gratuit, sans CB.' },
    { t: 'En ligne en 5 minutes', d: 'Après validation : domaine, HTTPS et publication 100% automatiques, avec écran de progression. Ils sont à quelques clics d\'exister sur Google.' },
    { t: 'Le moins cher du marché', d: '9,90 €/mois (engagement 2 ans, -65%) · 17,90 €/mois (1 an, le plus choisi) · 29 €/mois SANS engagement. TVA incluse.' },
    { t: 'Zéro frais d\'installation', d: 'Mise en service offerte (levier : « normalement 500 €, offerte aux 100 premiers salons du lancement »). Domaine et hébergement inclus.' },
    { t: 'Le domaine leur appartient', d: '.fr ou .com enregistré AU NOM du client, transférable s\'il part. Contrairement aux agences qui gardent le domaine en otage.' },
    { t: 'Zéro travail, admin ultra simple', d: '6 sections, modifiable depuis le téléphone « comme Instagram », visite guidée intégrée. Pensé pour un coiffeur, pas un informaticien.' },
    { t: 'Visible sur Google (SEO)', d: 'Étoiles et horaires directement dans les résultats Google (données structurées), sitemap, référencement soigné.' },
    { t: 'Responsive mobile', d: 'Parfait sur téléphone — là où leurs clients cherchent. Hébergé en Europe, HTTPS, sauvegardes.' },
  ];

  /* --------- Nœuds PARTAGÉS (objections, closing, fins) --------------------
     Chaque approche y injecte ses propres nœuds `opener` et `pitch`.        */
  var SHARED = {
    start: {
      id: 'start', phase: 'Ouverture', label: 'Qui décroche ?',
      summary: 'Filtrer standard/employé vs gérant',
      say: "Bonjour ! Je cherche à joindre le ou la responsable du salon, s'il vous plaît ?",
      branches: [
        { label: "C'est moi / le gérant", to: 'opener' },
        { label: 'Employé / standard', to: 'gatekeeper' },
        { label: 'Pas là maintenant', to: 'callback' },
      ],
    },
    gatekeeper: {
      id: 'gatekeeper', phase: 'Ouverture', label: 'Barrage (employé)',
      summary: 'Passer au décideur sans forcer',
      say: "Je comprends. Quel serait le meilleur moment pour joindre le responsable ? C'est au sujet du site internet du salon — il y a du nouveau le concernant.",
      branches: [
        { label: 'Passe le gérant', to: 'opener' },
        { label: 'Donne un créneau', to: 'callback' },
        { label: 'Refuse / filtre', to: 'end_npr' },
      ],
    },
    obj_temps: {
      id: 'obj_temps', phase: 'Objection', label: '« Pas le temps »',
      summary: 'Reconnaître + zéro travail + envoyer le lien',
      say: "Je comprends, vous êtes en plein rush. Justement : il n'y a RIEN à faire de votre côté, le site est déjà fait. Je vous envoie le lien par SMS, vous regardez ce soir entre deux clients. C'est quoi votre numéro ?",
      branches: [
        { label: 'OK, donne le numéro', to: 'close_link' },
        { label: 'Toujours non', to: 'obj_besoin' },
        { label: 'Rappelez plus tard', to: 'callback' },
      ],
    },
    obj_deja_site: {
      id: 'obj_deja_site', phase: 'Objection', label: '« J\'ai déjà un site »',
      summary: 'Explorer, puis comparer + argument domaine à leur nom',
      say: "Ah, très bien — il est à jour, et vous arrivez à le modifier vous-même ? … Comparez juste 2 minutes avec le nôtre : souvent plus moderne, modifiable depuis votre téléphone, et à partir de 9,90 € par mois. Et détail qui compte : le domaine est à VOTRE nom, vous restez propriétaire. Je vous envoie le lien pour comparer ?",
      branches: [
        { label: 'OK, je compare', to: 'close_link' },
        { label: "J'en suis content", to: 'obj_besoin' },
        { label: 'Combien le vôtre ?', to: 'obj_prix' },
      ],
    },
    obj_prix: {
      id: 'obj_prix', phase: 'Objection', label: '« Ça coûte combien ? »',
      summary: 'Chiffres EXACTS + zéro frais + regarder d\'abord',
      say: "Trois formules, tout compris : 9,90 € par mois sur 2 ans — le moins cher du marché —, 17,90 € sur 1 an, ou 29 € sans aucun engagement. Zéro frais d'installation, domaine et hébergement inclus. Mais regardez d'abord le site : s'il ne vous plaît pas, le prix n'a aucune importance. Je vous l'envoie ?",
      tip: 'Chiffres exacts, TVA incluse. Ne JAMAIS négocier le prix au téléphone — ramener vers la démo.',
      branches: [
        { label: 'OK, envoyez', to: 'close_link' },
        { label: 'Trop cher', to: 'obj_besoin' },
        { label: 'Je vais réfléchir', to: 'levier_lancement' },
      ],
    },
    obj_besoin: {
      id: 'obj_besoin', phase: 'Objection', label: '« Pas besoin / pas envie »',
      summary: 'Poke the bear : Google décide, étoiles dans les résultats',
      say: "Je comprends. Juste une chose : aujourd'hui les clients regardent Google avant de choisir leur coiffeur. Avec ce site, vos étoiles et vos horaires apparaissent directement dans les résultats Google. Sans ça, ils tombent souvent chez le voisin. Regarder prend 2 minutes et ne coûte rien — je vous envoie le lien ?",
      branches: [
        { label: "OK, d'accord", to: 'close_link' },
        { label: 'Non merci', to: 'end_lost' },
        { label: 'Ne me rappelez plus', to: 'end_npr' },
      ],
    },
    obj_arnaque: {
      id: 'obj_arnaque', phase: 'Objection', label: '« C\'est de la pub / une arnaque »',
      summary: 'Rassurer : rien à payer pour regarder, il juge seul',
      say: "Je comprends la méfiance, vous devez être très sollicité. Concrètement : je ne vous demande ni carte bleue ni engagement, juste de regarder une page qui existe déjà, faite à partir de votre fiche Google. Vous jugez par vous-même, et si ça ne vous plaît pas, ça s'arrête là. Je vous envoie le lien ?",
      branches: [
        { label: 'OK, montrez', to: 'close_link' },
        { label: 'Non', to: 'end_lost' },
      ],
    },
    levier_lancement: {
      id: 'levier_lancement', phase: 'Closing', label: '🎁 Levier : mise en service offerte',
      summary: 'Ancrage 500 € + rareté quantité justifiée (lancement)',
      say: "Une dernière chose : la mise en service, en agence c'est facilement 500 €. Nous, on l'offre aux 100 premiers salons parce qu'on lance le service — domaine compris, à votre nom. Vous risquez juste 5 minutes à regarder le site. Je vous l'envoie ?",
      tip: '« 100 premiers, parce qu\'on lance » = rareté crédible et réutilisable. Ne JAMAIS dire « offre valable cette semaine » (intenable au rappel).',
      branches: [
        { label: 'OK, envoyez', to: 'close_link' },
        { label: 'Non merci', to: 'end_lost' },
      ],
    },
    close_link: {
      id: 'close_link', phase: 'Closing', label: 'Envoyer le lien (le prochain pas)',
      summary: 'Canal + envoi PENDANT l\'appel + rappel programmé',
      say: "Parfait ! Je vous l'envoie tout de suite — plutôt SMS ou e-mail ? … C'est parti. Petit plus : si le site vous plaît, il peut être en ligne en 5 minutes, tout est automatique. Je vous rappelle dans 2 jours pour avoir votre avis, ça vous va ?",
      tip: 'Envoie le lien PENDANT l\'appel (« vous l\'avez reçu ? ») et programme le rappel dans le cockpit.',
      branches: [
        { label: 'Accepte le rappel', to: 'end_win' },
        { label: 'Regardera de lui-même', to: 'end_win' },
        { label: 'Hésite encore', to: 'levier_lancement' },
        { label: 'Finalement non', to: 'obj_besoin' },
      ],
    },
    callback: {
      id: 'callback', phase: 'Closing', label: 'Rappel à programmer',
      summary: 'Convenir d\'un créneau précis',
      say: "Aucun souci. Quel est le meilleur moment pour vous rappeler ? Je le note et je vous rappelle pile à ce moment-là.",
      branches: [
        { label: 'Donne un créneau', to: 'end_win' },
        { label: 'Refuse', to: 'end_lost' },
      ],
    },
    end_win: {
      id: 'end_win', phase: 'Fin', label: '✅ Prochain pas obtenu',
      summary: 'Lien envoyé / rappel calé',
      say: "Bravo ! Dans le cockpit : marque « Démo envoyée » ou « À rappeler » + la date. Envoie le lien immédiatement, tant que c'est chaud.",
      branches: [],
    },
    end_lost: {
      id: 'end_lost', phase: 'Fin', label: 'Perdu (pour l\'instant)',
      summary: 'Pas intéressé aujourd\'hui',
      say: "OK. Marque « Pas intéressé ». Un « non » = un « pas maintenant » : tu pourras retenter dans quelques semaines.",
      branches: [],
    },
    end_npr: {
      id: 'end_npr', phase: 'Fin', label: '🚫 Ne pas rappeler',
      summary: 'Opposition définitive (on respecte)',
      say: "Note « Ne pas rappeler » dans le cockpit — on respecte, il ne ressortira plus jamais dans la file d'appel.",
      branches: [],
    },
  };

  /* --------- Les 4 approches (écoles) : chacune apporte opener + pitch ----- */
  var APPROACHES = {
    permission: {
      key: 'permission', name: '🤝 Permission 30 s', school: 'Permission-based — Jason Bay',
      desc: "L'approche par défaut, la plus sûre pour débuter : demander 30 secondes désarme la défense et transforme le monologue en conversation acceptée.",
      style: "poli, respectueux du temps, micro-accords successifs",
      opening: {
        opener: {
          id: 'opener', phase: 'Ouverture', label: 'Permission (30 s)',
          summary: 'Aveu du cold call + demande de 30 secondes',
          say: "Bonjour [NOM], [TOI] de MaQuickPage. Je vous appelle à l'improviste — vous êtes sûrement en plein rush… Vous m'accordez 30 secondes que je vous dise pourquoi j'appelle, et après vous me dites si ça vaut le coup ?",
          tip: 'Le « oui » aux 30 s engage à écouter vraiment. Enchaîne fort : la raison d\'appel doit claquer.',
          branches: [
            { label: '« Oui, allez-y »', to: 'pitch' },
            { label: "« C'est pour quoi ? »", to: 'pitch' },
            { label: 'Pas le temps', to: 'obj_temps' },
            { label: 'Pas intéressé', to: 'obj_besoin' },
            { label: 'Méfiant', to: 'obj_arnaque' },
          ],
        },
        pitch: {
          id: 'pitch', phase: 'Pitch', label: 'Raison + twist « déjà fait »',
          summary: 'Raison côté prospect, puis le site qui existe déjà',
          say: "Aujourd'hui, les clients cherchent leur coiffeur sur Google avant de pousser la porte. En préparant votre secteur, on a déjà créé le site de votre salon — il existe, avec vos vraies photos et vos avis Google. Vous avez déjà quelque chose en ligne aujourd'hui ?",
          branches: [
            { label: 'Curieux / intéressé', to: 'close_link' },
            { label: "J'ai déjà un site", to: 'obj_deja_site' },
            { label: 'Ça coûte combien ?', to: 'obj_prix' },
            { label: 'Pas besoin', to: 'obj_besoin' },
            { label: 'Envoyez un mail', to: 'close_link' },
          ],
        },
      },
    },
    curiosity: {
      key: 'curiosity', name: '🐻 Piquer la curiosité', school: 'Poke the Bear — Josh Braun',
      desc: "Casser le schéma du démarcheur, puis une question qui bouscule le statu quo. Réussi quand c'est LUI qui demande « c'est quoi votre truc ? ».",
      style: "curieux, questions neutres, silences assumés, zéro pitch frontal",
      opening: {
        opener: {
          id: 'opener', phase: 'Ouverture', label: 'Question inhabituelle',
          summary: 'Pattern interrupt + question sur le statu quo Google',
          say: "Bonjour, c'est [TOI] — on ne se connaît pas, et vous n'attendiez pas mon appel. Je peux vous poser une question un peu inhabituelle ? … Quand quelqu'un tape « coiffeur + [VILLE] » sur Google, vous savez ce qui s'affiche pour votre salon ?",
          tip: 'Laisse-le répondre VRAIMENT. Reformule ce qu\'il dit (« donc tout passe par le bouche-à-oreille… ») avant le poke.',
          branches: [
            { label: 'Répond / écoute', to: 'pitch' },
            { label: '« Aucune idée »', to: 'pitch' },
            { label: 'Pas le temps', to: 'obj_temps' },
            { label: 'Refus sec', to: 'obj_besoin' },
          ],
        },
        pitch: {
          id: 'pitch', phase: 'Pitch', label: 'Le poke — « il existe déjà »',
          summary: 'Teaser sans tout dévoiler, mesurer l\'intrigue',
          say: "En fait, je vous appelle parce qu'on a déjà fabriqué une page web pour votre salon — elle existe, en ligne, avec vos photos Google. Ça vous intrigue, ou pas du tout ?",
          branches: [
            { label: 'Intrigué', to: 'close_link' },
            { label: "J'ai déjà un site", to: 'obj_deja_site' },
            { label: 'Ça coûte combien ?', to: 'obj_prix' },
            { label: 'Pas du tout', to: 'obj_besoin' },
            { label: 'Méfiant', to: 'obj_arnaque' },
          ],
        },
      },
    },
    direct: {
      key: 'direct', name: '🎯 Direct et assumé', school: 'Straight Line (adouci) — J. Belfort',
      desc: "Annoncer la couleur en 20 secondes : l'offre en chiffres exacts, zéro blabla, UN seul pas suivant. Pour le volume et les pragmatiques.",
      style: "énergique, direct, chiffres précis, un seul CTA répété calmement",
      opening: {
        opener: {
          id: 'opener', phase: 'Ouverture', label: 'Tout en 20 secondes',
          summary: 'Offre + chiffres + désamorçage + CTA unique',
          say: "Bonjour, [TOI] de MaQuickPage. Je vais être direct : on a déjà fabriqué un site internet pour votre salon — il est prêt, avec vos photos et vos avis Google. C'est moins de 10 € par mois, zéro frais d'installation, et je ne vends rien au téléphone : je veux juste vous envoyer le lien pour que vous y jetiez un œil. Je vous l'envoie par SMS ?",
          tip: 'Énergie et certitude, mais UN seul CTA : le lien. Jamais de pression prix au téléphone.',
          branches: [
            { label: 'OK, envoyez', to: 'close_link' },
            { label: 'Combien exactement ?', to: 'obj_prix' },
            { label: "J'ai déjà un site", to: 'obj_deja_site' },
            { label: 'Pas intéressé', to: 'obj_besoin' },
            { label: 'Méfiant', to: 'obj_arnaque' },
          ],
        },
        pitch: {
          id: 'pitch', phase: 'Pitch', label: 'Relance valeur (si hésite)',
          summary: '5 minutes, domaine à son nom, simple comme Instagram',
          say: "Concrètement : s'il vous plaît, il est en ligne en 5 minutes — domaine inclus, à VOTRE nom — et vous le modifiez vous-même, aussi simplement qu'Instagram. Le regarder ne coûte rien. Je vous envoie le lien ?",
          branches: [
            { label: 'OK, envoyez', to: 'close_link' },
            { label: 'Non', to: 'obj_besoin' },
          ],
        },
      },
    },
    voss: {
      key: 'voss', name: '🧊 Le « non » qui ouvre', school: 'No-oriented — Chris Voss',
      desc: "Les gens se sentent en sécurité en disant « non » : chaque demande est formulée pour qu'un « non » fasse avancer. Pour les prospects méfiants.",
      style: "calme, posé, silences, questions où « non » = avancer, reformulations empathiques",
      opening: {
        opener: {
          id: 'opener', phase: 'Ouverture', label: '« Je tombe mal ? »',
          summary: 'Ouverture no-oriented + vrai silence',
          say: "Bonjour, c'est [TOI]. Je tombe mal ? … (laisse un vrai silence)",
          tip: 'Le silence est l\'outil. S\'il dit « non, ça va » → il t\'a donné la permission. S\'il dit « oui » → propose un créneau.',
          branches: [
            { label: '« Non, ça va, allez-y »', to: 'pitch' },
            { label: '« Oui, très mal »', to: 'callback' },
            { label: '« C\'est pour quoi ? »', to: 'pitch' },
            { label: 'Méfiant', to: 'obj_arnaque' },
          ],
        },
        pitch: {
          id: 'pitch', phase: 'Pitch', label: 'La question « absurde »',
          summary: 'Raison en une phrase + CTA no-oriented',
          say: "Je vous appelle parce qu'on a préparé un site pour votre salon — il est déjà en ligne, avec vos photos. Est-ce que ce serait une idée absurde que je vous envoie juste le lien par SMS, pour que vous regardiez entre deux clients ?",
          tip: 'S\'il objecte : reformule sans combattre (« on dirait que vous avez déjà été échaudé par ce genre d\'appels »).',
          branches: [
            { label: '« Non, pas absurde »', to: 'close_link' },
            { label: "J'ai déjà un site", to: 'obj_deja_site' },
            { label: 'Ça coûte combien ?', to: 'obj_prix' },
            { label: '« Oui, absurde »', to: 'obj_besoin' },
          ],
        },
      },
    },
  };

  var PHASES = ['Ouverture', 'Pitch', 'Objection', 'Closing', 'Fin'];

  function treeFor(key) {
    var ap = APPROACHES[key] || APPROACHES.permission;
    var nodes = {};
    Object.keys(SHARED).forEach(function (k) { nodes[k] = SHARED[k]; });
    Object.keys(ap.opening).forEach(function (k) { nodes[k] = ap.opening[k]; });
    return {
      key: ap.key, name: ap.name, school: ap.school, desc: ap.desc, style: ap.style,
      startId: 'start', nodes: nodes, phases: PHASES,
      catalog: function () {
        return Object.keys(nodes).map(function (k) {
          return { id: nodes[k].id, label: nodes[k].label, summary: nodes[k].summary };
        });
      },
    };
  }

  /* --------- Mode guidé : monte le composant dans un conteneur ----------
     mountGuided(el, tree, opts) → { goTo(id), current(), reset() }       */
  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function mountGuided(el, tree, opts) {
    opts = opts || {};
    var NODES = tree.nodes;
    var history = [];
    var currentId = tree.startId;

    function render() {
      var n = NODES[currentId] || NODES[tree.startId];
      var isEnd = !n.branches || !n.branches.length;
      var h = '';
      h += '<div class="cg-top">';
      h += '<span class="cg-phase cg-ph-' + esc(n.phase) + '">' + esc(n.phase) + '</span>';
      if (history.length) h += '<button class="cg-nav" data-back="1">← Retour</button>';
      h += '<button class="cg-nav" data-restart="1">↺ Recommencer</button>';
      h += '</div>';
      h += '<div class="cg-label">' + esc(n.label) + '</div>';
      h += '<div class="cg-say">' + esc(n.say) + '</div>';
      if (n.tip) h += '<div class="cg-tip">💡 ' + esc(n.tip) + '</div>';
      if (isEnd) {
        h += '<div class="cg-end">— fin de branche —</div>';
      } else {
        h += '<div class="cg-branch-lab">Le prospect répond…</div><div class="cg-branches">';
        n.branches.forEach(function (b, i) {
          h += '<button class="cg-branch" data-to="' + esc(b.to) + '" data-i="' + i + '">' + esc(b.label) + '</button>';
        });
        h += '</div>';
      }
      el.innerHTML = h;

      Array.prototype.forEach.call(el.querySelectorAll('[data-to]'), function (btn) {
        btn.onclick = function () { go(btn.getAttribute('data-to')); };
      });
      var bk = el.querySelector('[data-back]'); if (bk) bk.onclick = function () { back(); };
      var rs = el.querySelector('[data-restart]'); if (rs) rs.onclick = function () { reset(); };

      if (opts.onNode) try { opts.onNode(n); } catch (e) {}
    }

    function go(id) { if (!NODES[id]) return; history.push(currentId); currentId = id; render(); }
    function back() { if (history.length) { currentId = history.pop(); render(); } }
    function reset() { history = []; currentId = tree.startId; render(); }
    function goTo(id) { if (!NODES[id] || id === currentId) return; history.push(currentId); currentId = id; render(); }

    render();
    return { goTo: goTo, current: function () { return NODES[currentId]; }, reset: reset };
  }

  global.CALL_TREES = {
    list: Object.keys(APPROACHES).map(function (k) {
      var a = APPROACHES[k];
      return { key: a.key, name: a.name, school: a.school, desc: a.desc };
    }),
    get: treeFor,
    defaultKey: 'permission',
  };
  global.SALES_ARGS = SALES_ARGS;
  global.mountGuided = mountGuided;
})(window);

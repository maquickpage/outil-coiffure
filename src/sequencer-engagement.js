// Engagement maquette par lead — jointure PURE (aucun accès DB, aucun fetch), pour que
// chaque règle du « Gate 0 » du plan tracking (bibiproject/03-email-outreach/infra/
// sequencer-tracking-ux-plan.md) soit testable unitairement.
//
// Pourquoi ce fichier existe : le 2026-08-16, « ces désinscriptions sont-elles des humains ? »
// a coûté des heures et produit deux conclusions fausses, parce que trois sources
// (leads des nœuds, preview_events, sequencer_leads) n'étaient jointes qu'à la main, avec des
// fuseaux mélangés (nœuds = heure de Paris, portail = UTC) et un champ `updated_at` pris
// pour une heure d'envoi.
//
// Règles encodées ici :
//   G1  seuls les events POSTÉRIEURS au premier envoi comptent (photos, démo cockpit, QA
//       touchent le slug avant tout envoi) ;
//   G3  entonnoir en slugs DISTINCTS ; slug partagé signalé sur la ligne ;
//   G4  first_sent_at absent = INCONNU, pas « jamais envoyé » ;
//   G5/G9 deux convertisseurs, un par source, tous deux tz-aware — jamais d'offset fixe ;
//   vocabulaire : activite_humaine / ouverture_non_confirmee / pas_de_trace / slug_incoherent.
//   Le mot « robot » n'existe pas ici : l'absence de trace est une inconnue.

// ---------- Temps (G5 / G9) ----------
const TZ = 'Europe/Paris';
const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function offsetMinAt(epochMs) {
  const g = {};
  for (const p of fmtParts.formatToParts(new Date(epochMs))) g[p.type] = p.value;
  const asUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
  return Math.round((asUtc - epochMs) / 60000);
}
// Chaîne « heure de Paris » telle que les nœuds l'émettent ("2026-08-14 16:55" ou avec :ss).
export function parisToEpoch(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let off = offsetMinAt(guess);
  let e = guess - off * 60000;
  const off2 = offsetMinAt(e);            // 2e passe : la 1re a pu tomber de l'autre côté du DST
  if (off2 !== off) e = guess - off2 * 60000;
  return e;
}
// Chaîne UTC telle que SQLite datetime('now') l'écrit ("2026-08-14 16:54:46").
export function utcToEpoch(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}
// Affichage : toujours Paris, "YYYY-MM-DD HH:MM".
export function epochToParis(epochMs) {
  if (epochMs == null || isNaN(epochMs)) return '';
  const g = {};
  for (const p of fmtParts.formatToParts(new Date(epochMs))) g[p.type] = p.value;
  return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}`;
}

// ---------- Règles d'engagement ----------
export const HUMAN_EVENTS = new Set([
  'preview_ouvert', 'paywall_peek_viewed', 'pricing_ouvert', 'scroll_max',
  'editeur_ouvert', 'editeur_modifie'
]);
const PRIX = new Set(['paywall_peek_viewed', 'pricing_ouvert']);
const EDIT = new Set(['editeur_ouvert', 'editeur_modifie']);
export const SILENCE_APRES_MS = 3 * 86400000;

export function normaliserEmail(e) { return String(e || '').trim().toLowerCase(); }
const isMobile = ua => /iPhone|Android|Mobile/i.test(String(ua || ''));

// État d'un lead à partir de SES events post-envoi (déjà filtrés humains par le classifieur).
//   activite_humaine        : prix vu / scroll / édition, OU >= 2 events (deux passages)
//   ouverture_non_confirmee : un seul preview_ouvert nu — SafeLinks & co. ouvrent les URLs
//                             avec un UA de navigateur ; une ouverture isolée ne prouve rien
//   pas_de_trace            : rien après l'envoi — inconnu, pas « robot »
export function etatDepuisEvents(evs) {
  if (!evs.length) return 'pas_de_trace';
  const deep = evs.some(e => PRIX.has(e.event) || e.event === 'scroll_max' || EDIT.has(e.event));
  if (deep || evs.length >= 2) return 'activite_humaine';
  return 'ouverture_non_confirmee';
}

/**
 * @param leads    [{email, salon_slug, status, current_step, first_sent_at, last_sent_at, sends, mailbox, node_id}]
 *                 — issus des nœuds (heure de Paris), déjà aplatis.
 * @param events   [{slug, event, ts, user_agent}] — preview_events déjà classés HUMAIN.
 * @param registre [{email, salon_slug}] — sequencer_leads.
 * @param nowMs    horloge injectée (tests).
 */
export function calculerEngagement({ leads, events, registre, nowMs = Date.now() }) {
  const reg = new Map(registre.map(r => [normaliserEmail(r.email), r.salon_slug || '']));

  // events humains par slug, triés
  const evBySlug = new Map();
  for (const ev of events) {
    if (!HUMAN_EVENTS.has(ev.event) || !ev.slug) continue;
    const t = utcToEpoch(ev.ts); if (t == null) continue;
    let arr = evBySlug.get(ev.slug); if (!arr) evBySlug.set(ev.slug, arr = []);
    arr.push({ ...ev, t });
  }
  for (const arr of evBySlug.values()) arr.sort((a, b) => a.t - b.t);

  // slugs partagés (G3) — plusieurs emails sur le même slug côté nœuds
  const emailsParSlug = new Map();
  for (const l of leads) {
    if (!l.salon_slug) continue;
    let s = emailsParSlug.get(l.salon_slug); if (!s) emailsParSlug.set(l.salon_slug, s = new Set());
    s.add(normaliserEmail(l.email));
  }

  const par_email = {};
  const funnelSlugs = { contactes: new Set(), ouvert: new Set(), prix_vu: new Set() };
  const outcomes = { repondu: 0, desinscrit: 0, en_cours: 0, silence: 0, inconnu: 0 };
  let hors_portail = 0, slug_incoherent = 0;
  const seen = new Set();

  for (const l of leads) {
    const email = normaliserEmail(l.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const step = Number(l.current_step) || 0;
    const slug = l.salon_slug || '';
    const inReg = reg.has(email);
    if (!inReg) hors_portail++;
    const regSlug = inReg ? reg.get(email) : null;
    const incoherent = inReg && regSlug && slug && regSlug !== slug;
    if (incoherent) slug_incoherent++;

    const sent = parisToEpoch(l.first_sent_at);
    const contacted = step >= 1 || !!sent;
    if (!contacted) continue; // en file : rien à mesurer

    if (!sent) { outcomes.inconnu++; }          // G4 : envoyé (step>=1) mais sans horodatage → inconnu, jamais « non envoyé »
    else funnelSlugs.contactes.add(slug || email);

    // G1 : events après le premier envoi seulement (si envoi inconnu, aucune borne fiable → pas de trace)
    const evs = sent && slug ? (evBySlug.get(slug) || []).filter(e => e.t >= sent) : [];
    const etat = incoherent ? 'slug_incoherent' : etatDepuisEvents(evs);
    const partage = slug ? (emailsParSlug.get(slug)?.size || 1) > 1 : false;

    let act = null;
    if (evs.length) {
      act = {
        ouvertures: evs.filter(e => e.event === 'preview_ouvert').length,
        prix_vu:    evs.filter(e => PRIX.has(e.event)).length,
        scrolls:    evs.filter(e => e.event === 'scroll_max').length,
        editions:   evs.filter(e => EDIT.has(e.event)).length,
        premier:    epochToParis(evs[0].t),
        dernier:    epochToParis(evs[evs.length - 1].t),
        delai_premier_min: Math.floor((evs[0].t - sent) / 60000),   // « +37 min », pas arrondi vers le haut
        appareil:   evs.some(e => isMobile(e.user_agent)) ? 'mobile' : 'ordinateur'
      };
      if (slug && !incoherent) {
        funnelSlugs.ouvert.add(slug);
        if (act.prix_vu) funnelSlugs.prix_vu.add(slug);
      }
    }

    // issues (à côté de l'entonnoir, pas dedans)
    const st = String(l.status || '');
    let issue = '';
    if (st === 'replied') { outcomes.repondu++; issue = 'repondu'; }
    else if (st === 'unsubscribed') { outcomes.desinscrit++; issue = 'desinscrit'; }
    else if (st === 'stopped') { issue = 'stoppe'; /* arrêt manuel/suppression : ni succès ni silence */ }
    else if (st === 'completed') {
      const lastSent = parisToEpoch(l.last_sent_at) ?? sent;
      const silent = lastSent != null && (nowMs - lastSent) >= SILENCE_APRES_MS && evs.length === 0;
      if (silent) { outcomes.silence++; issue = 'silence'; } else { outcomes.en_cours++; issue = 'en_cours'; }
    }
    else if (sent) { outcomes.en_cours++; issue = 'en_cours'; }

    par_email[email] = {
      etat, issue, slug, slug_partage: partage, hors_portail: !inReg,
      first_sent_at: sent ? epochToParis(sent) : '', activite: act
    };
  }

  const n = k => funnelSlugs[k].size;
  return {
    par_email,
    funnel: {
      contactes: n('contactes'), ouvert: n('ouvert'), prix_vu: n('prix_vu'),
      inconnu: outcomes.inconnu,
      pct_ouvert:  n('contactes') ? Math.round(100 * n('ouvert')  / n('contactes')) : 0,
      pct_prix_vu: n('contactes') ? Math.round(100 * n('prix_vu') / n('contactes')) : 0
    },
    outcomes,
    hors_portail,
    slug_incoherent
  };
}

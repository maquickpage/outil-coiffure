// Routes de prospection téléphonique (onglet ☎️ Prospection).
// Montées DANS admin.js APRÈS requireAuth → tout est derrière le login admin.
//
//   GET    /api/calling/list?status=&q=&due=1     → file d'appel (join salons)
//   GET    /api/calling/stats                      → KPIs du dashboard
//   GET    /api/calling/next?status=&q=            → prochaine fiche à appeler
//   POST   /api/calling/search  {query}            → cherche des salons DB à ajouter
//   POST   /api/calling/add     {slug, added_from} → ajoute au pipeline + résout le tél
//   GET    /api/calling/:slug                       → détail + historique des appels
//   POST   /api/calling/:slug/outcome  {outcome, note, next_call_at} → enregistre un appel
//   POST   /api/calling/:slug/update   {...}         → édition manuelle d'une fiche
//   POST   /api/calling/:slug/resolve-phone          → (re)cherche le numéro sur Google
//   DELETE /api/calling/:slug                        → retire du pipeline (garde l'historique)
import express from 'express';
import db from '../db.js';
import { searchText, placeDetails, isPlacesConfigured } from '../places-client.js';
import { sendRaw, isEnabled as isEmailEnabled } from '../email-sender.js';

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://maquickpage.fr').replace(/\/$/, '');

// Statuts valides du pipeline.
const STATUSES = ['a_appeler', 'rappeler', 'interesse', 'demo_envoyee', 'gagne', 'perdu', 'ne_pas_rappeler'];
// Un « résultat d'appel » (bouton du cockpit) → statut résultant.
const OUTCOME_STATUS = {
  no_answer: 'rappeler',       // pas de réponse
  voicemail: 'rappeler',       // messagerie
  busy: 'rappeler',            // occupé
  callback: 'rappeler',        // à rappeler (rendez-vous téléphonique)
  wrong_number: 'rappeler',    // mauvais numéro → à re-résoudre
  interested: 'interesse',     // intéressé
  demo_sent: 'demo_envoyee',   // démo/lien envoyé
  not_interested: 'perdu',     // pas intéressé
  do_not_call: 'ne_pas_rappeler', // opposition définitive
  won: 'gagne',                // devenu client
};
// Résultats où quelqu'un a réellement décroché (pour le taux de décroché).
const REACHED = new Set(['callback', 'interested', 'demo_sent', 'not_interested', 'do_not_call', 'won']);

// --- Helpers ---------------------------------------------------------------

// Décore une ligne (calling_prospects JOIN salons) pour le front.
function decorate(row) {
  if (!row) return null;
  const cacheBuster = row.screenshot_generated_at ? '?v=' + encodeURIComponent(row.screenshot_generated_at) : '';
  return {
    slug: row.slug,
    nom: row.nom_clean || row.nom || row.slug,
    ville: row.ville || '',
    code_postal: row.code_postal || '',
    adresse: row.adresse || '',
    email: row.email || '',
    telephone: row.telephone || '',
    phone_source: row.phone_source || '',
    status: row.status,
    priority: row.priority || 0,
    attempts: row.attempts || 0,
    next_call_at: row.next_call_at || null,
    last_outcome: row.last_outcome || '',
    last_called_at: row.last_called_at || null,
    notes: row.notes || '',
    do_not_call: !!row.do_not_call,
    added_from: row.added_from || '',
    subscription_status: row.subscription_status || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    screenshot: row.screenshot_path ? row.screenshot_path + cacheBuster : '',
    preview_url: `${PUBLIC_BASE}/preview/${row.slug}${row.edit_token ? '?token=' + encodeURIComponent(row.edit_token) : ''}`,
    maps_url: row.lien_google_maps || (row.adresse ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((row.nom_clean || row.nom || '') + ' ' + (row.adresse || ''))}` : ''),
  };
}

const SELECT_JOIN = `
  SELECT cp.*, s.nom, s.nom_clean, s.ville, s.code_postal, s.adresse, s.email,
         s.screenshot_path, s.screenshot_generated_at, s.edit_token, s.subscription_status,
         s.google_id, s.lien_google_maps
  FROM calling_prospects cp
  JOIN salons s ON s.slug = cp.slug
`;

function getProspect(slug) {
  return db.prepare(`${SELECT_JOIN} WHERE cp.slug = ?`).get(slug);
}

// Cherche un numéro de téléphone via Google Places (best-effort, jamais bloquant).
// Renvoie { telephone, source:'google', place_id } ou null.
async function resolvePhoneViaGoogle(salon) {
  if (!isPlacesConfigured()) return null;
  try {
    if (salon.google_id) {
      const p = await placeDetails(salon.google_id);
      const tel = p.nationalPhoneNumber || p.internationalPhoneNumber || '';
      if (tel) return { telephone: tel, source: 'google', place_id: salon.google_id };
    }
    const q = [salon.nom_clean || salon.nom, salon.code_postal, salon.ville].filter(Boolean).join(' ');
    if (q.trim()) {
      const results = await searchText(q, { max: 3 });
      const hit = results.find((r) => r.nationalPhoneNumber || r.internationalPhoneNumber);
      if (hit) return { telephone: hit.nationalPhoneNumber || hit.internationalPhoneNumber, source: 'google', place_id: hit.id };
    }
  } catch (e) {
    console.warn(`[calling] resolvePhone ${salon.slug} fail: ${e.message}`);
  }
  return null;
}

// --- Routes de liste / stats (à définir AVANT /:slug) ----------------------

// File d'appel filtrable. due=1 => uniquement les rappels dus (next_call_at <= maintenant).
router.get('/api/calling/list', (req, res) => {
  const status = (req.query.status || '').trim();
  const q = (req.query.q || '').trim();
  const dueOnly = req.query.due === '1' || req.query.due === 'true';

  let where = '1=1';
  const params = {};
  if (status && STATUSES.includes(status)) { where += ' AND cp.status = @status'; params.status = status; }
  if (q) {
    where += ' AND (s.nom LIKE @q OR s.nom_clean LIKE @q OR s.ville LIKE @q OR cp.telephone LIKE @q)';
    params.q = `%${q}%`;
  }
  if (dueOnly) {
    where += " AND cp.next_call_at IS NOT NULL AND cp.next_call_at <= datetime('now') AND cp.status NOT IN ('gagne','perdu','ne_pas_rappeler')";
  }

  // Tri file : rappels dus d'abord, puis priorité, puis rappel programmé le plus proche, puis récence.
  const rows = db.prepare(`${SELECT_JOIN} WHERE ${where}
    ORDER BY
      (cp.next_call_at IS NOT NULL AND cp.next_call_at <= datetime('now')) DESC,
      cp.priority DESC,
      (cp.next_call_at IS NULL) ASC,
      cp.next_call_at ASC,
      cp.updated_at DESC
  `).all(params);

  res.json({ rows: rows.map(decorate) });
});

// KPIs du dashboard calling.
router.get('/api/calling/stats', (req, res) => {
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  db.prepare('SELECT status, COUNT(*) AS n FROM calling_prospects GROUP BY status').all()
    .forEach((r) => { byStatus[r.status] = r.n; });
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const due = db.prepare(`SELECT COUNT(*) AS n FROM calling_prospects
    WHERE next_call_at IS NOT NULL AND next_call_at <= datetime('now')
      AND status NOT IN ('gagne','perdu','ne_pas_rappeler')`).get().n;

  const logsToday = db.prepare("SELECT outcome FROM call_logs WHERE date(created_at) = date('now')").all();
  const callsToday = logsToday.length;
  const reachedToday = logsToday.filter((l) => REACHED.has(l.outcome)).length;
  const reachRate = callsToday ? Math.round((reachedToday / callsToday) * 100) : 0;

  res.json({
    total,
    by_status: byStatus,
    due,
    calls_today: callsToday,
    reached_today: reachedToday,
    reach_rate: reachRate,
    won: byStatus.gagne,
    interested: byStatus.interesse + byStatus.demo_envoyee,
    places_configured: isPlacesConfigured(),
  });
});

// === Copilote IA temps réel : jeton Speech + guidage LLM ========================
// Réutilise la ressource Azure johannfoundry (AIServices = OpenAI + Speech).
const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || 'https://johannfoundry.cognitiveservices.azure.com').replace(/\/$/, '');
const AZURE_KEY = process.env.AZURE_OPENAI_KEY || '';
const AZURE_COPILOT_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4-mini-coiffeurs-app';
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'francecentral';

// Jeton éphémère (~10 min) pour le SDK Speech côté navigateur : la clé reste au serveur.
router.get('/api/calling/speech-token', async (req, res) => {
  if (!AZURE_KEY) return res.status(503).json({ error: 'AZURE_OPENAI_KEY non configurée sur le serveur' });
  try {
    const r = await fetch(`https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Length': '0' },
    });
    if (!r.ok) return res.status(502).json({ error: `Speech token ${r.status}` });
    res.json({ token: await r.text(), region: SPEECH_REGION });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Copilote : à partir de la dernière phrase du prospect (+ contexte roulant),
// classe l'intention, choisit le nœud le plus pertinent et propose une réplique
// courte dans le STYLE de l'approche choisie. Catalogue de nœuds fourni par le
// front (source unique = call-tree.js).
// ⚠️ FAITS PRODUIT vérifiés dans checkout.js/pricing-modal.js/CGV le 2026-07-02 —
// si le pricing change, mettre à jour ICI et dans call-tree.js.
const COPILOT_FACTS = `FAITS PRODUIT (chiffres EXACTS, n'en invente jamais d'autres) :
- Le site du salon existe DÉJÀ : vraies photos Google choisies par IA, avis + note Google, horaires, texte pro. Le regarder est gratuit, sans CB.
- S'il valide : en ligne en moins de 5 minutes, tout est automatique (domaine, HTTPS, publication).
- Prix TTC tout compris : 9,90 €/mois (engagement 24 mois, -65 %), 17,90 €/mois (12 mois, « le plus choisi »), 29 €/mois SANS engagement.
- Zéro frais de mise en service. Levier de closing : « en agence c'est ~500 € ; offerte aux 100 premiers salons parce qu'on lance » (jamais « cette semaine »).
- Domaine .fr/.com offert, enregistré AU NOM du client, transférable s'il part (contrairement aux agences).
- Admin ultra simple : 6 sections, modifiable depuis le téléphone « comme Instagram ».
- SEO : étoiles et horaires visibles directement dans les résultats Google. Responsive mobile. Hébergé en Europe, HTTPS, sauvegardes.`;

router.post('/api/calling/copilot', async (req, res) => {
  if (!AZURE_KEY) return res.status(503).json({ error: 'AZURE_OPENAI_KEY non configurée sur le serveur' });
  const b = req.body || {};
  const utterance = String(b.utterance || '').trim();
  if (!utterance) return res.status(400).json({ error: 'utterance requis' });
  const nodes = Array.isArray(b.nodes) ? b.nodes : [];
  const context = (Array.isArray(b.context) ? b.context : []).slice(-5).map((s) => String(s).slice(0, 300));
  const currentNode = String(b.current_node || '');
  const salon = b.salon || {};
  const approach = b.approach || {};
  const catalog = nodes.map((n) => `- ${n.id}: ${n.label}${n.summary ? ' — ' + n.summary : ''}`).join('\n');
  const system = `Tu es le copilote TEMPS RÉEL d'un commercial au téléphone. Produit : MaQuickPage — sites web déjà créés pour salons de coiffure.
${COPILOT_FACTS}
OBJECTIF DE L'APPEL : que le prospect regarde la démo (accord d'envoi du lien SMS/email) ou un rappel programmé — PAS vendre au téléphone.
STYLE DE VENTE CHOISI : ${approach.name || 'Permission 30 s'} — ${approach.style || 'poli, respectueux du temps'}. Tes suggestions doivent coller à ce style.
La conversation avance vite : réponds COURT (1 à 2 phrases parlées, naturelles, immédiatement prononçables). Méthode : reconnaître ce que dit le prospect, puis rediriger vers le prochain pas.
À partir de la DERNIÈRE phrase du prospect (le contexte précédent est fourni) :
1) intention (objection_temps, objection_prix, objection_deja_site, objection_besoin, mefiance, question, signal_achat, refus, hors_sujet…) ;
2) node_id le plus pertinent de l'arbre ci-dessous (id EXACT) ;
3) suggestion courte dans le style choisi.
Réponds UNIQUEMENT en JSON : {"node_id":"<id>","intent":"<intention>","suggestion":"<réplique courte>"}.
Arbre (${approach.name || 'défaut'}) :
${catalog}`;
  const user = `Salon : ${salon.nom || '?'}${salon.ville ? ' (' + salon.ville + ')' : ''}. Nœud affiché : ${currentNode || '?'}.
${context.length ? 'Répliques précédentes du prospect :\n' + context.map((c) => `- "${c}"`).join('\n') + '\n' : ''}DERNIÈRE phrase du prospect : "${utterance}"`;
  try {
    const r = await fetch(`${AZURE_ENDPOINT}/openai/deployments/${AZURE_COPILOT_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`, {
      method: 'POST', headers: { 'api-key': AZURE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_completion_tokens: 250,
        response_format: { type: 'json_object' },
      }),
    });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: `Azure ${r.status}: ${t.slice(0, 200)}` }); }
    const data = await r.json();
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch {}
    res.json({ node_id: parsed.node_id || null, intent: parsed.intent || '', suggestion: parsed.suggestion || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slugs déjà dans le pipeline (état persistant du bouton 📞 dans le Suivi).
router.get('/api/calling/slugs', (req, res) => {
  res.json({ slugs: db.prepare('SELECT slug FROM calling_prospects').all().map((r) => r.slug) });
});

// Prochaine fiche à appeler (respecte les filtres status/q). Exclut les fiches
// closes et les rappels programmés dans le futur.
router.get('/api/calling/next', (req, res) => {
  const status = (req.query.status || '').trim();
  const q = (req.query.q || '').trim();
  const exclude = (req.query.exclude || '').trim(); // slug déjà en cours à l'écran

  let where = "cp.status NOT IN ('gagne','perdu','ne_pas_rappeler')";
  const params = {};
  if (status && STATUSES.includes(status)) { where += ' AND cp.status = @status'; params.status = status; }
  if (q) { where += ' AND (s.nom LIKE @q OR s.nom_clean LIKE @q OR s.ville LIKE @q)'; params.q = `%${q}%`; }
  if (exclude) { where += ' AND cp.slug != @exclude'; params.exclude = exclude; }
  // Un rappel programmé dans le futur n'est pas « à appeler maintenant ».
  where += " AND (cp.next_call_at IS NULL OR cp.next_call_at <= datetime('now'))";

  const row = db.prepare(`${SELECT_JOIN} WHERE ${where}
    ORDER BY
      (cp.next_call_at IS NOT NULL AND cp.next_call_at <= datetime('now')) DESC,
      cp.priority DESC,
      cp.attempts ASC,
      cp.next_call_at ASC,
      cp.updated_at DESC
    LIMIT 1
  `).get(params);

  res.json({ prospect: decorate(row) });
});

// Recherche de salons en base pour les ajouter au calling (autocomplétion).
router.post('/api/calling/search', (req, res) => {
  const q = (req.body && req.body.query ? String(req.body.query) : '').trim();
  if (!q) return res.json({ results: [] });
  const rows = db.prepare(`
    SELECT s.slug, s.nom, s.nom_clean, s.ville, s.code_postal, s.telephone,
           (SELECT 1 FROM calling_prospects cp WHERE cp.slug = s.slug) AS in_calling
    FROM salons s
    WHERE s.nom LIKE @q OR s.nom_clean LIKE @q OR s.ville LIKE @q OR s.slug LIKE @q
    ORDER BY s.id DESC
    LIMIT 20
  `).all({ q: `%${q}%` });
  res.json({
    results: rows.map((r) => ({
      slug: r.slug,
      nom: r.nom_clean || r.nom,
      ville: r.ville || '',
      code_postal: r.code_postal || '',
      telephone: r.telephone || '',
      in_calling: !!r.in_calling,
    })),
  });
});

// Ajoute un salon au pipeline calling + résout son numéro (DB → Google Places).
router.post('/api/calling/add', async (req, res) => {
  const slug = (req.body && req.body.slug ? String(req.body.slug) : '').trim();
  const addedFrom = (req.body && req.body.added_from ? String(req.body.added_from) : 'manuel').trim();
  if (!slug) return res.status(400).json({ error: 'slug requis' });

  const salon = db.prepare(`SELECT slug, nom, nom_clean, ville, code_postal, adresse, telephone,
    email, google_id, subscription_status FROM salons WHERE slug = ?`).get(slug);
  if (!salon) return res.status(404).json({ error: 'Salon introuvable' });

  const existing = getProspect(slug);
  if (existing) return res.json({ ok: true, already: true, prospect: decorate(existing) });

  // Résolution du numéro : DB d'abord, sinon Google Places.
  let telephone = salon.telephone || '';
  let phoneSource = telephone ? 'db' : '';
  if (!telephone) {
    const g = await resolvePhoneViaGoogle(salon);
    if (g) {
      telephone = g.telephone;
      phoneSource = 'google';
      // Backfill : on garde le numéro trouvé dans la fiche salon si elle était vide.
      try { db.prepare('UPDATE salons SET telephone = ?, updated_at = datetime(\'now\') WHERE slug = ? AND (telephone IS NULL OR telephone = \'\')').run(telephone, slug); } catch {}
    }
  }

  // Priorité : les clients potentiels chauds (statut d'abonnement) remontent.
  const priority = salon.subscription_status ? 1 : 0;

  db.prepare(`INSERT INTO calling_prospects (slug, status, telephone, phone_source, priority, added_from)
    VALUES (?, 'a_appeler', ?, ?, ?, ?)`).run(slug, telephone || null, phoneSource || null, priority, addedFrom);

  res.json({ ok: true, already: false, prospect: decorate(getProspect(slug)) });
});

// --- Routes sur une fiche (/:slug) -----------------------------------------

router.get('/api/calling/:slug', (req, res) => {
  const row = getProspect(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Fiche introuvable' });
  const logs = db.prepare('SELECT id, outcome, note, next_call_at, created_at FROM call_logs WHERE slug = ? ORDER BY created_at DESC, id DESC').all(req.params.slug);
  res.json({ prospect: decorate(row), logs });
});

// Enregistre le résultat d'un appel.
router.post('/api/calling/:slug/outcome', (req, res) => {
  const slug = req.params.slug;
  const b = req.body || {};
  const outcome = String(b.outcome || '').trim();
  if (!OUTCOME_STATUS[outcome]) return res.status(400).json({ error: 'outcome invalide' });

  const prospect = db.prepare('SELECT * FROM calling_prospects WHERE slug = ?').get(slug);
  if (!prospect) return res.status(404).json({ error: 'Fiche introuvable' });

  const note = b.note != null ? String(b.note).trim() : '';
  const status = OUTCOME_STATUS[outcome];

  // Date de rappel : fournie par le front, sinon défaut +2 jours pour les statuts « rappeler ».
  let nextCall = b.next_call_at ? String(b.next_call_at).trim() : null;
  if (!nextCall && status === 'rappeler') {
    nextCall = db.prepare("SELECT datetime('now','+2 days') AS d").get().d;
  }
  if (status !== 'rappeler') nextCall = null; // intéressé/gagné/perdu → plus de rappel auto

  db.prepare('INSERT INTO call_logs (slug, outcome, note, next_call_at) VALUES (?, ?, ?, ?)')
    .run(slug, outcome, note || null, nextCall);

  db.prepare(`UPDATE calling_prospects
    SET status = ?, attempts = attempts + 1, last_outcome = ?, last_called_at = datetime('now'),
        next_call_at = ?, do_not_call = ?, updated_at = datetime('now')
    WHERE slug = ?`)
    .run(status, outcome, nextCall, outcome === 'do_not_call' ? 1 : prospect.do_not_call, slug);

  res.json({ ok: true, prospect: decorate(getProspect(slug)) });
});

// Édition manuelle d'une fiche (statut, numéro, notes, priorité, rappel, NPAI).
router.post('/api/calling/:slug/update', (req, res) => {
  const slug = req.params.slug;
  const prospect = db.prepare('SELECT * FROM calling_prospects WHERE slug = ?').get(slug);
  if (!prospect) return res.status(404).json({ error: 'Fiche introuvable' });
  const b = req.body || {};

  const sets = [];
  const vals = [];
  if (typeof b.status === 'string' && STATUSES.includes(b.status)) { sets.push('status = ?'); vals.push(b.status); }
  if (typeof b.telephone === 'string') { sets.push('telephone = ?', 'phone_source = ?'); vals.push(b.telephone.trim() || null, 'manuel'); }
  if (typeof b.notes === 'string') { sets.push('notes = ?'); vals.push(b.notes); }
  if (b.priority != null) { sets.push('priority = ?'); vals.push(parseInt(b.priority, 10) || 0); }
  if ('next_call_at' in b) { sets.push('next_call_at = ?'); vals.push(b.next_call_at ? String(b.next_call_at).trim() : null); }
  if ('do_not_call' in b) {
    sets.push('do_not_call = ?'); vals.push(b.do_not_call ? 1 : 0);
    if (b.do_not_call) { sets.push('status = ?'); vals.push('ne_pas_rappeler'); }
  }
  if (!sets.length) return res.json({ ok: true, prospect: decorate(getProspect(slug)) });

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE calling_prospects SET ${sets.join(', ')} WHERE slug = ?`).run(...vals, slug);
  res.json({ ok: true, prospect: decorate(getProspect(slug)) });
});

// Envoi 1-clic de l'email « voici votre démo » (via Resend — même infra que
// les emails signup, domaine maquickpage.fr vérifié, reply-to Johann).
// Smartlead n'est PAS utilisé ici : son API ne permet pas d'envoi one-off
// hors campagne (uniquement séquences ou réponses à un fil existant).
router.post('/api/calling/:slug/send-email', async (req, res) => {
  const slug = req.params.slug;
  const prospect = db.prepare('SELECT slug FROM calling_prospects WHERE slug = ?').get(slug);
  if (!prospect) return res.status(404).json({ error: 'Fiche introuvable' });
  if (!isEmailEnabled()) return res.status(503).json({ error: 'Envoi email non configuré sur le serveur (RESEND_API_KEY manquante)' });

  const b = req.body || {};
  const to = String(b.to || '').trim();
  const subject = String(b.subject || '').trim();
  const bodyText = String(b.body || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Adresse email invalide' });
  if (!subject || !bodyText) return res.status(400).json({ error: 'Objet et message requis' });

  // Corps HTML simple : texte échappé + liens cliquables + <br>.
  const escaped = bodyText
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#002FA7">$1</a>')
    .replace(/\n/g, '<br>');
  const html = `<!DOCTYPE html><html lang="fr"><body style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;font-size:15px;line-height:1.6">${escaped}</body></html>`;

  const r = await sendRaw({ to, subject, html, text: bodyText });
  if (!r.ok) return res.status(502).json({ error: 'Envoi échoué (' + (r.reason || '?') + ')', details: r.details || null });

  // Backfill : garde l'adresse dans la fiche salon si elle était vide.
  try { db.prepare("UPDATE salons SET email = ?, updated_at = datetime('now') WHERE slug = ? AND (email IS NULL OR email = '')").run(to, slug); } catch {}
  db.prepare("UPDATE calling_prospects SET updated_at = datetime('now') WHERE slug = ?").run(slug);
  res.json({ ok: true, id: r.id || null });
});

// Force une (re)recherche du numéro sur Google Places.
router.post('/api/calling/:slug/resolve-phone', async (req, res) => {
  const slug = req.params.slug;
  const salon = db.prepare('SELECT slug, nom, nom_clean, ville, code_postal, google_id FROM salons WHERE slug = ?').get(slug);
  if (!salon) return res.status(404).json({ error: 'Salon introuvable' });
  if (!isPlacesConfigured()) return res.status(409).json({ error: 'Google Places non configuré' });
  const g = await resolvePhoneViaGoogle(salon);
  if (!g) return res.json({ ok: true, found: false });
  db.prepare("UPDATE calling_prospects SET telephone = ?, phone_source = 'google', updated_at = datetime('now') WHERE slug = ?").run(g.telephone, slug);
  try { db.prepare("UPDATE salons SET telephone = ? WHERE slug = ? AND (telephone IS NULL OR telephone = '')").run(g.telephone, slug); } catch {}
  res.json({ ok: true, found: true, telephone: g.telephone, prospect: decorate(getProspect(slug)) });
});

// Retire un salon du pipeline (l'historique d'appels est conservé).
router.delete('/api/calling/:slug', (req, res) => {
  const r = db.prepare('DELETE FROM calling_prospects WHERE slug = ?').run(req.params.slug);
  res.json({ ok: true, removed: r.changes });
});

export default router;

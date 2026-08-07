// Séquenceur cold-email self-hosted — control plane côté portail.
// Chaque « nœud » = un projet Apps Script déployé en web app sous UNE boîte Gmail
// (bibiproject/03-email-outreach/infra/mvp/Code.gs). Le portail ne stocke aucun lead :
// il proxifie vers les nœuds (POST JSON {token, action, ...}) et agrège leurs réponses.
// Monté derrière requireAuth dans admin.js → tout vit sous /admin/api/sequencer/*.
import express from 'express';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import db from '../db.js';
import { COLONNES_IMPORT, normaliserEmail, filtrerLot, repartir, estUnRejeuIdentique } from '../sequencer-filters.js';
import { resoudreSignature, neutraliserSignature } from '../sequencer-signature.js';

const router = express.Router();
router.use(express.json({ limit: '20mb' }));

const NODE_TIMEOUT_MS = 45000; // Apps Script peut être lent (cold start + Sheets)
const NODE_RETRIES = 3;        // relances sur échec de transport uniquement
const RETRY_BASE_MS = 1200;    // attente croissante entre deux essais

// Actions autorisées côté nœud — tout le reste est refusé avant de sortir du portail.
const NODE_ACTIONS = new Set(['health', 'dashboard', 'uploadCsv', 'saveSteps',
  'saveMailbox', 'setCampaign', 'stopLead', 'addSuppression',
  'listSuppression', 'removeSuppression', 'sendTest']);

function listNodes(onlyEnabled = false) {
  const rows = db.prepare('SELECT * FROM sequencer_nodes ORDER BY mailbox').all();
  return onlyEnabled ? rows.filter(n => n.enabled) : rows;
}

function publicNode(n) {
  // Le token ne repart jamais vers le navigateur — on n'expose qu'un suffixe de contrôle.
  return {
    id: n.id, mailbox: n.mailbox, label: n.label, exec_url: n.exec_url,
    token_hint: n.api_token ? '…' + n.api_token.slice(-4) : '',
    enabled: !!n.enabled,
    last_health: n.last_health_json ? JSON.parse(n.last_health_json) : null,
    last_health_at: n.last_health_at
  };
}

// Un seul aller-retour vers le nœud. Marque les échecs de TRANSPORT (__transport)
// pour que l'appelant sache qu'une relance a du sens ; une réponse métier ok:false
// n'est jamais marquée, on ne relance pas ce que le nœud a délibérément refusé.
async function callNodeOnce(node, payload) {
  try {
    // Content-Type text/plain : Apps Script lit e.postData.contents tel quel, et le POST
    // renvoie un 302 vers script.googleusercontent.com que fetch suit par défaut.
    const res = await fetch(node.exec_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: node.api_token }),
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
      redirect: 'follow'
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch {
      // Une page HTML ici = déploiement en access "Myself" (login Google exigé), URL /exec
      // périmée, ou simple hoquet d'Apps Script (404/500 transitoires observés en série).
      return { ok: false, __transport: true, http: res.status,
        error: `réponse non-JSON (HTTP ${res.status}) — vérifier que la web app est déployée en accès "Anyone" et que l'URL /exec est à jour` };
    }
  } catch (err) {
    return { ok: false, __transport: true,
      error: err.name === 'TimeoutError' ? `timeout nœud (${Math.round(NODE_TIMEOUT_MS / 1000)}s)` : String(err.message || err) };
  }
}

// Apps Script est instable par nature : démarrages à froid, quotas, 404 passagers sur
// l'URL /exec. Sans relance, une opération parfaitement valide échoue au hasard et
// l'opérateur croit à une panne. On réessaie donc les échecs de transport, avec une
// attente croissante et un peu d'aléa pour ne pas retomber en rafale sur le même creux.
async function callNode(node, payload, { essais = NODE_RETRIES } = {}) {
  if (!NODE_ACTIONS.has(payload.action)) return { ok: false, error: 'action refusée: ' + payload.action };
  let dernier;
  for (let essai = 1; essai <= essais; essai++) {
    dernier = await callNodeOnce(node, payload);
    if (!dernier.__transport) return essai > 1 ? { ...dernier, essais: essai } : dernier;
    if (essai < essais) {
      const attente = RETRY_BASE_MS * essai + Math.floor(Math.random() * 500);
      await new Promise(r => setTimeout(r, attente));
    }
  }
  const { __transport, ...propre } = dernier;
  return { ...propre, essais };
}

// Fan-out parallèle vers plusieurs nœuds → [{node_id, mailbox, ...réponse}]
async function callNodes(nodes, payload) {
  const results = await Promise.all(nodes.map(n => callNode(n, payload)));
  return nodes.map((n, i) => ({ node_id: n.id, mailbox: n.mailbox, ...results[i] }));
}

// Même chose, mais avec un payload calculé par nœud (séquence signée au nom de la boîte).
async function callNodesEach(nodes, payloadPour) {
  const results = await Promise.all(nodes.map(n => callNode(n, payloadPour(n))));
  return nodes.map((n, i) => ({ node_id: n.id, mailbox: n.mailbox, ...results[i] }));
}


function nodeOr404(req, res) {
  const n = db.prepare('SELECT * FROM sequencer_nodes WHERE id = ?').get(req.params.id || req.body.nodeId);
  if (!n) res.status(404).json({ error: 'nœud inconnu' });
  return n;
}

// ---------- Registre des nœuds ----------
router.get('/api/sequencer/nodes', (req, res) => {
  res.json({ nodes: listNodes().map(publicNode) });
});

router.post('/api/sequencer/nodes', (req, res) => {
  const { id, mailbox, label, exec_url, api_token, enabled } = req.body || {};
  if (!mailbox || !mailbox.includes('@')) return res.status(400).json({ error: 'mailbox invalide' });
  if (!exec_url || !/^https:\/\/script\.google\.com\/.+\/exec$/.test(exec_url)) {
    return res.status(400).json({ error: 'exec_url doit être une URL Apps Script se terminant par /exec' });
  }
  if (id) {
    const existing = db.prepare('SELECT * FROM sequencer_nodes WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'nœud inconnu' });
    db.prepare(`UPDATE sequencer_nodes SET mailbox=?, label=?, exec_url=?, api_token=?, enabled=?, updated_at=datetime('now') WHERE id=?`)
      .run(mailbox.toLowerCase().trim(), label || '', exec_url.trim(),
           api_token ? api_token.trim() : existing.api_token, enabled ? 1 : 0, id);
    return res.json({ ok: true, id });
  }
  if (!api_token) return res.status(400).json({ error: 'api_token requis (initApiToken() dans l\'éditeur Apps Script)' });
  try {
    const r = db.prepare('INSERT INTO sequencer_nodes (mailbox, label, exec_url, api_token, enabled) VALUES (?,?,?,?,?)')
      .run(mailbox.toLowerCase().trim(), label || '', exec_url.trim(), api_token.trim(), enabled === false ? 0 : 1);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: /UNIQUE/.test(String(err)) ? 'cette mailbox a déjà un nœud' : String(err) });
  }
});

router.delete('/api/sequencer/nodes/:id', (req, res) => {
  db.prepare('DELETE FROM sequencer_nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/api/sequencer/nodes/:id/health', async (req, res) => {
  const n = nodeOr404(req, res); if (!n) return;
  const r = await callNode(n, { action: 'health' });
  db.prepare(`UPDATE sequencer_nodes SET last_health_json=?, last_health_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(r), n.id);
  res.json(r);
});

// ---------- Vue agrégée ----------
router.get('/api/sequencer/overview', async (req, res) => {
  const nodes = listNodes(true);
  const results = await callNodes(nodes, { action: 'dashboard' });
  // Les nœuds renvoient leur séquence signée ; l'admin doit revoir le modèle commun.
  for (let i = 0; i < results.length; i++) {
    if (results[i].ok && Array.isArray(results[i].steps)) {
      results[i].steps = neutraliserSignature(results[i].steps, nodes[i]);
    }
  }
  const agg = { total: 0, queued: 0, active: 0, replied: 0, stopped: 0, unsubscribed: 0,
                failed: 0, completed: 0, step1: 0, step2: 0, step3: 0, step4: 0, step5: 0 };
  for (const r of results) {
    if (r.ok && r.stat) for (const k of Object.keys(agg)) agg[k] += Number(r.stat[k]) || 0;
  }
  // Capacité réelle : ce qui décide du rythme d'une campagne, ce n'est pas le nombre de
  // leads mais la somme des plafonds journaliers des boîtes JOIGNABLES. Un nœud à terre
  // retire sa part de capacité sans prévenir, d'où le calcul à partir des seules réponses
  // valides. « jours_restants » traduit la file d'attente en délai, seule unité qui parle
  // quand on planifie une campagne.
  let capaciteJour = 0, boites = 0;
  for (const r of results) {
    if (!r.ok || !Array.isArray(r.mailboxes)) continue;
    for (const mb of r.mailboxes) {
      if (mb.paused) continue;
      capaciteJour += Number(mb.daily_cap) || 0;
      boites++;
    }
  }
  const capacite = {
    boites_actives: boites,
    envois_par_jour: capaciteJour,
    en_file: agg.queued,
    jours_restants: capaciteJour > 0 ? Math.ceil(agg.queued / capaciteJour) : null,
    noeuds_injoignables: results.filter(r => !r.ok).length
  };

  res.json({
    nodes_registered: listNodes().map(publicNode),
    nodes: results,
    aggregate: agg,
    capacite,
    leads_confies: db.prepare('SELECT COUNT(*) n FROM sequencer_leads').get().n,
    all_ok: results.length > 0 && results.every(r => r.ok)
  });
});

// ---------- Actions campagne / séquence / boîtes / leads ----------
// nodeId présent → nœud ciblé ; absent → broadcast à tous les nœuds actifs.
router.post('/api/sequencer/campaign', async (req, res) => {
  const status = req.body.status === 'running' ? 'running' : 'paused';
  const targets = req.body.nodeId
    ? [db.prepare('SELECT * FROM sequencer_nodes WHERE id = ?').get(req.body.nodeId)].filter(Boolean)
    : listNodes(true);
  if (!targets.length) return res.status(400).json({ error: 'aucun nœud actif' });
  res.json({ results: await callNodes(targets, { action: 'setCampaign', status }) });
});

router.post('/api/sequencer/steps', async (req, res) => {
  const { steps, nodeId } = req.body || {};
  if (!Array.isArray(steps) || steps.length !== 5) return res.status(400).json({ error: '5 steps requis' });
  const targets = nodeId
    ? [db.prepare('SELECT * FROM sequencer_nodes WHERE id = ?').get(nodeId)].filter(Boolean)
    : listNodes(true);
  if (!targets.length) return res.status(400).json({ error: 'aucun nœud actif' });
  res.json({ results: await callNodesEach(targets,
    n => ({ action: 'saveSteps', steps: resoudreSignature(steps, n) })) });
});

router.post('/api/sequencer/mailbox', async (req, res) => {
  const n = nodeOr404(req, res); if (!n) return;
  res.json(await callNode(n, { action: 'saveMailbox', mailbox: req.body.mailbox || {} }));
});

router.post('/api/sequencer/lead-stop', async (req, res) => {
  const n = nodeOr404(req, res); if (!n) return;
  res.json(await callNode(n, { action: 'stopLead', leadId: req.body.leadId }));
});

router.post('/api/sequencer/suppression', async (req, res) => {
  const emails = (req.body.emails || []).map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@'));
  if (!emails.length) return res.status(400).json({ error: 'aucun email valide' });
  const targets = listNodes(true);
  if (!targets.length) return res.status(400).json({ error: 'aucun nœud actif' });
  // La suppression manuelle doit être aussi durable qu'une désinscription reçue par
  // lien : sans cette écriture, l'adresse repasserait au prochain import puisque seuls
  // les nœuds actuels la connaîtraient.
  const memoriser = db.transaction(liste => {
    const req2 = db.prepare(`INSERT INTO sequencer_unsubscribes (email, source) VALUES (?, 'suppression_manuelle')
      ON CONFLICT(email) DO NOTHING`);
    for (const e of liste) req2.run(e);
  });
  memoriser(emails);
  res.json({ results: await callNodes(targets, { action: 'addSuppression', emails }), memorises: emails.length });
});

// ---------- Envoi de test ----------
// Prévisualiser une étape sans écrire à un vrai salon. Le nœud sert les leads dans
// l'ordre de sa feuille : un lead ajouté pour tester passerait après tous les vrais
// prospects. sendTest court-circuite la file, sans toucher aux compteurs ni au statut
// de campagne, mais en empruntant le vrai chemin d'envoi (en-têtes et partie HTML
// de production). Sans ça, un test ne prouve rien.
router.post('/api/sequencer/send-test', async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!to.includes('@')) return res.status(400).json({ error: 'adresse "to" invalide' });
  const step = Number(req.body.step) || 1;
  const n = req.body.nodeId
    ? db.prepare('SELECT * FROM sequencer_nodes WHERE id = ?').get(req.body.nodeId)
    : listNodes(true)[0];
  if (!n) return res.status(400).json({ error: 'aucun nœud actif' });
  const r = await callNode(n, { action: 'sendTest', to, step, lead: req.body.lead || {} });
  res.json({ mailbox: n.mailbox, ...r });
});

// ---------- Réconciliation des listes de suppression ----------
// Une liste de suppression vit dans CHAQUE nœud. Rien ne garantit qu'elles soient
// identiques : une entrée posée sur un seul nœud y fige des leads sans que rien ne
// le signale ailleurs. Ces deux routes rendent ces listes lisibles et réversibles.
// Elles exigent les actions listSuppression/removeSuppression côté nœud ; tant qu'un
// nœud n'est pas à jour, il répond « unknown action » et c'est rapporté tel quel.
router.get('/api/sequencer/suppression', async (req, res) => {
  const nodes = listNodes(true);
  if (!nodes.length) return res.status(400).json({ error: 'aucun nœud actif' });
  const results = await callNodes(nodes, { action: 'listSuppression' });

  // Une adresse présente sur un seul nœud est le cas qui coûte des prospects :
  // elle y bloque les leads alors qu'elle circule librement sur les autres.
  const parEmail = new Map();
  for (const r of results) {
    if (!r.ok || !Array.isArray(r.emails)) continue;
    for (const e of r.emails) {
      const cle = normaliserEmail(e);
      if (!parEmail.has(cle)) parEmail.set(cle, []);
      parEmail.get(cle).push(r.mailbox);
    }
  }
  const repondants = results.filter(r => r.ok).length;
  const divergentes = [...parEmail.entries()]
    .filter(([, boites]) => boites.length < repondants)
    .map(([email, boites]) => ({ email, presente_sur: boites }));

  const centrale = new Set(db.prepare('SELECT email FROM sequencer_unsubscribes').all().map(r => normaliserEmail(r.email)));
  res.json({
    par_noeud: results.map(r => ({ mailbox: r.mailbox, ok: !!r.ok, count: r.count ?? null, error: r.error })),
    total_distinctes: parEmail.size,
    divergentes,
    absentes_de_la_liste_centrale: [...parEmail.keys()].filter(e => !centrale.has(e)).length,
    liste_centrale: centrale.size
  });
});

router.post('/api/sequencer/suppression/remove', async (req, res) => {
  const emails = (req.body.emails || []).map(normaliserEmail).filter(e => e.includes('@'));
  if (!emails.length) return res.status(400).json({ error: 'aucun email valide' });
  const nodes = listNodes(true);
  if (!nodes.length) return res.status(400).json({ error: 'aucun nœud actif' });
  const requeue = req.body.requeue !== false;   // par défaut on remet les leads en file

  const results = await callNodes(nodes, { action: 'removeSuppression', emails, requeue });
  // Le portail doit oublier l'opposition en même temps que les nœuds, sinon le filtre
  // d'import continuerait d'écarter ces adresses et le retrait n'aurait servi à rien.
  const oublier = db.transaction(liste => {
    const st = db.prepare('DELETE FROM sequencer_unsubscribes WHERE email = ?');
    for (const e of liste) st.run(e);
  });
  oublier(emails);
  res.json({ results, retirees_de_la_liste_centrale: emails.length });
});

// ---------- Import CSV ----------
// mode 'single'     : le CSV part tel quel vers le nœud choisi.
// mode 'roundrobin' : le portail pré-valide TOUT le fichier (rejet total si une ligne est sale,
//   même règle que le nœud), le découpe ligne à ligne sur les nœuds actifs, et force la colonne
//   mailbox de chaque ligne sur la boîte du nœud destinataire. Un nœud peut encore refuser sa
//   part (ex. email déjà importé chez lui) : le résultat est rapporté PAR nœud.
function lireDesinscrits() {
  return new Set(db.prepare('SELECT email FROM sequencer_unsubscribes').all().map(r => normaliserEmail(r.email)));
}
function lireDejaConfies() {
  return new Set(db.prepare('SELECT email FROM sequencer_leads').all().map(r => normaliserEmail(r.email)));
}
// N'enregistre QUE ce qu'un nœud a effectivement accepté : si le nœud a refusé son
// lot, les adresses restent disponibles pour un prochain essai.
const inscrireLead = db.prepare(`INSERT OR IGNORE INTO sequencer_leads (email, salon_slug, node_id, mailbox)
  VALUES (?, ?, ?, ?)`);
function enregistrerLot(lignes, node) {
  const tx = db.transaction(rows => {
    for (const r of rows) inscrireLead.run(normaliserEmail(r.email), String(r.salon_slug || ''), node.id, node.mailbox);
  });
  tx(lignes);
}

router.post('/api/sequencer/import', async (req, res) => {
  const { csv, nodeId, mode } = req.body || {};
  if (!csv || !csv.trim()) return res.status(400).json({ error: 'CSV vide' });

  let records;
  try {
    records = parse(csv, { columns: h => h.map(c => String(c).trim().toLowerCase()), skip_empty_lines: true, bom: true });
  } catch (err) {
    return res.status(400).json({ error: 'CSV illisible: ' + err.message });
  }
  if (!records.length) return res.status(400).json({ error: 'aucune ligne' });

  // Deux garde-fous qui n'existent qu'ici : une désinscription vaut pour TOUTES les
  // boîtes, et une adresse déjà confiée à un nœud ne doit pas partir depuis un second
  // expéditeur (double séquence = plainte quasi certaine).
  const { retenus, erreurs, ecartes } = filtrerLot(records, lireDesinscrits(), lireDejaConfies());
  if (erreurs.length) {
    return res.status(400).json({ error: `${erreurs.length} erreur(s), rien n'est importé:\n- ` + erreurs.slice(0, 25).join('\n- ') });
  }
  const filtres = { desinscrits: ecartes.desinscrits.length, deja_confies: ecartes.deja_confies.length };
  if (!retenus.length) {
    return res.status(400).json({ error: 'aucune ligne à importer après filtrage', filtres });
  }

  // ---- Envoi vers un seul nœud ----
  if (mode !== 'roundrobin') {
    const n = nodeOr404(req, res); if (!n) return;
    const lignes = retenus.map(r => COLONNES_IMPORT.map(c => String(r[c] || '')));
    let r = await callNode(n, { action: 'uploadCsv', csv: stringify([COLONNES_IMPORT, ...lignes]) });
    if (estUnRejeuIdentique(r, lignes.length)) r = { ok: true, imported: 0, rejeu: true };
    if (r.ok) enregistrerLot(retenus, n);
    return res.json({ ...r, rows_sent: lignes.length, filtres });
  }

  // ---- Répartition sur tous les nœuds actifs ----
  const nodes = listNodes(true);
  if (!nodes.length) return res.status(400).json({ error: 'aucun nœud actif' });

  const paniers = repartir(retenus, nodes);
  const results = await Promise.all(nodes.map((n, i) => {
    if (!paniers[i].length) return Promise.resolve({ ok: true, imported: 0 });
    return callNode(n, { action: 'uploadCsv', csv: stringify([COLONNES_IMPORT, ...paniers[i]]) });
  }));

  const sortie = nodes.map((n, i) => {
    let r = results[i];
    // Réponse perdue puis relance : le nœud répond « already imported » sur tout le lot.
    // Le premier envoi avait abouti, ce n'est pas un échec.
    if (estUnRejeuIdentique(r, paniers[i].length)) r = { ok: true, imported: 0, rejeu: true };
    if (r.ok) enregistrerLot(retenus.filter((_, idx) => idx % nodes.length === i), n);
    return { node_id: n.id, mailbox: n.mailbox, rows_sent: paniers[i].length, ...r };
  });

  res.json({ results: sortie, filtres });
});

export { listNodes, callNodes };
export default router;

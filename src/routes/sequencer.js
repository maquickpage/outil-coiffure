// Séquenceur cold-email self-hosted — control plane côté portail.
// Chaque « nœud » = un projet Apps Script déployé en web app sous UNE boîte Gmail
// (bibiproject/03-email-outreach/infra/mvp/Code.gs). Le portail ne stocke aucun lead :
// il proxifie vers les nœuds (POST JSON {token, action, ...}) et agrège leurs réponses.
// Monté derrière requireAuth dans admin.js → tout vit sous /admin/api/sequencer/*.
import express from 'express';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import db from '../db.js';

const router = express.Router();
router.use(express.json({ limit: '20mb' }));

const NODE_TIMEOUT_MS = 45000; // Apps Script peut être lent (cold start + Sheets)

// Actions autorisées côté nœud — tout le reste est refusé avant de sortir du portail.
const NODE_ACTIONS = new Set(['health', 'dashboard', 'uploadCsv', 'saveSteps',
  'saveMailbox', 'setCampaign', 'stopLead', 'addSuppression']);

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

async function callNode(node, payload) {
  if (!NODE_ACTIONS.has(payload.action)) return { ok: false, error: 'action refusée: ' + payload.action };
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
      // Une page HTML ici = déploiement en access "Myself" (login Google exigé) ou URL /exec périmée.
      return { ok: false, error: `réponse non-JSON (HTTP ${res.status}) — vérifier que la web app est déployée en accès "Anyone" et que l'URL /exec est à jour` };
    }
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timeout nœud (45s)' : String(err.message || err) };
  }
}

// Fan-out parallèle vers plusieurs nœuds → [{node_id, mailbox, ...réponse}]
async function callNodes(nodes, payload) {
  const results = await Promise.all(nodes.map(n => callNode(n, payload)));
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
  const agg = { total: 0, queued: 0, active: 0, replied: 0, stopped: 0, unsubscribed: 0,
                failed: 0, completed: 0, step1: 0, step2: 0, step3: 0, step4: 0, step5: 0 };
  for (const r of results) {
    if (r.ok && r.stat) for (const k of Object.keys(agg)) agg[k] += Number(r.stat[k]) || 0;
  }
  res.json({
    nodes_registered: listNodes().map(publicNode),
    nodes: results,
    aggregate: agg,
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
  res.json({ results: await callNodes(targets, { action: 'saveSteps', steps }) });
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
  res.json({ results: await callNodes(targets, { action: 'addSuppression', emails }) });
});

// ---------- Import CSV ----------
// mode 'single'     : le CSV part tel quel vers le nœud choisi.
// mode 'roundrobin' : le portail pré-valide TOUT le fichier (rejet total si une ligne est sale,
//   même règle que le nœud), le découpe ligne à ligne sur les nœuds actifs, et force la colonne
//   mailbox de chaque ligne sur la boîte du nœud destinataire. Un nœud peut encore refuser sa
//   part (ex. email déjà importé chez lui) : le résultat est rapporté PAR nœud.
router.post('/api/sequencer/import', async (req, res) => {
  const { csv, nodeId, mode } = req.body || {};
  if (!csv || !csv.trim()) return res.status(400).json({ error: 'CSV vide' });

  if (mode !== 'roundrobin') {
    const n = nodeOr404(req, res); if (!n) return;
    return res.json(await callNode(n, { action: 'uploadCsv', csv }));
  }

  const nodes = listNodes(true);
  if (!nodes.length) return res.status(400).json({ error: 'aucun nœud actif' });

  let records;
  try {
    records = parse(csv, { columns: h => h.map(c => String(c).trim().toLowerCase()), skip_empty_lines: true, bom: true });
  } catch (err) {
    return res.status(400).json({ error: 'CSV illisible: ' + err.message });
  }
  if (!records.length) return res.status(400).json({ error: 'aucune ligne' });

  const errors = [];
  const seen = new Set();
  records.forEach((r, i) => {
    const line = i + 2;
    const email = String(r.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) errors.push(`ligne ${line}: email vide/invalide`);
    else if (seen.has(email)) errors.push(`ligne ${line}: email en double dans le fichier (${email})`);
    else seen.add(email);
    if (!String(r.salon_slug || '').trim()) errors.push(`ligne ${line}: salon_slug vide`);
  });
  if (errors.length) {
    return res.status(400).json({ error: `${errors.length} erreur(s), rien n'est importé:\n- ` + errors.slice(0, 25).join('\n- ') });
  }

  const columns = ['email', 'first_name', 'salon_name', 'city', 'salon_slug',
                   'preview_url', 'preview_image_url', 'admin_url', 'mailbox'];
  const buckets = nodes.map(() => []);
  records.forEach((r, i) => {
    const nodeIdx = i % nodes.length;
    buckets[nodeIdx].push(columns.map(c => c === 'mailbox' ? nodes[nodeIdx].mailbox : String(r[c] || '')));
  });

  const results = await Promise.all(nodes.map((n, i) => {
    if (!buckets[i].length) return Promise.resolve({ ok: true, imported: 0 });
    return callNode(n, { action: 'uploadCsv', csv: stringify([columns, ...buckets[i]]) });
  }));
  res.json({ results: nodes.map((n, i) => ({ node_id: n.id, mailbox: n.mailbox, rows_sent: buckets[i].length, ...results[i] })) });
});

export default router;

// Désinscription un clic (RFC 8058) pour le séquenceur cold-email.
//
// Monté PUBLIQUEMENT (hors requireAuth) : Gmail et Outlook appellent l'URL sans cookie ni
// session, et le POST « One-Click » ne doit demander AUCUNE confirmation supplémentaire —
// sinon le bouton natif de la boîte de réception ne s'affiche pas.
//
// Le lien est auto-porteur : token = b64url(email).b64url(HMAC_SHA256(secret, email)).
// Le nœud Apps Script forge le même token (Code.gs → unsubToken_), donc aucune colonne
// supplémentaire dans la table leads et aucun aller-retour vers le nœud à l'envoi.
// Le secret est partagé : UNSUB_SECRET ici, script property du même nom sur chaque nœud.
import express from 'express';
import crypto from 'node:crypto';
import db from '../db.js';
import { listNodes, callNodes } from './sequencer.js';

const router = express.Router();

const SECRET = process.env.UNSUB_SECRET || '';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Renvoie l'email si le token est authentique, sinon null. Comparaison à temps constant.
export function verifyToken(token) {
  if (!SECRET || typeof token !== 'string' || !token.includes('.')) return null;
  const [rawPart, sigPart] = token.split('.', 2);
  let email;
  try {
    email = Buffer.from(rawPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return null; }
  if (!email || !email.includes('@')) return null;
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(email.toLowerCase()).digest());
  const a = Buffer.from(sigPart || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return email.toLowerCase();
}

function page(title, message) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1d21;background:#f6f7f9;
margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px 32px;max-width:520px}
h1{font-size:19px;margin:0 0 10px}p{margin:0 0 8px;color:#4b5563}
</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// Enregistre la désinscription en local (traçabilité de l'opposition, exigée par le RGPD)
// puis la pousse à TOUS les nœuds : la liste repoussoir est partagée, un lead déjà en file
// chez un autre nœud est stoppé au tick suivant.
async function applyUnsubscribe(email, source) {
  db.prepare(`INSERT INTO sequencer_unsubscribes (email, source) VALUES (?, ?)
              ON CONFLICT(email) DO UPDATE SET source = excluded.source,
                                               created_at = COALESCE(sequencer_unsubscribes.created_at, datetime('now'))`)
    .run(email, source);
  try {
    const nodes = listNodes(true);
    if (nodes.length) await callNodes(nodes, { action: 'addSuppression', emails: [email] });
  } catch (e) {
    // L'opposition est déjà enregistrée côté portail : on ne renvoie pas d'erreur au
    // destinataire pour un échec de propagation. Le tick de chaque nœud re-vérifie.
    console.error('[unsub] propagation nœuds échouée pour', email, e.message);
  }
}

// One-click : Gmail/Outlook POSTent sans interaction humaine. Toujours 200 côté client.
router.post('/u/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const email = verifyToken(req.params.token);
  if (!email) return res.status(400).type('html').send(page('Lien invalide', 'Ce lien de désinscription n\'est pas valide ou a expiré.'));
  await applyUnsubscribe(email, 'one-click');
  res.type('html').send(page('Désinscription enregistrée', `L'adresse <strong>${email}</strong> ne recevra plus de messages.`));
});

// Clic humain depuis le corps du message : même effet, sans étape de confirmation.
router.get('/u/:token', async (req, res) => {
  const email = verifyToken(req.params.token);
  if (!email) return res.status(400).type('html').send(page('Lien invalide', 'Ce lien de désinscription n\'est pas valide ou a expiré.'));
  await applyUnsubscribe(email, 'link');
  res.type('html').send(page('Désinscription enregistrée', `L'adresse <strong>${email}</strong> ne recevra plus de messages.`));
});

export default router;

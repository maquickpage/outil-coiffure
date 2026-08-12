/**
 * Caddy on-demand TLS — endpoint "ask"
 *
 * Caddy interroge cet endpoint avant de demander un cert Let's Encrypt pour un
 * nouveau hostname. On retourne :
 *   200 OK  → Caddy provisionne le cert (hostname autorisé)
 *   4xx     → Caddy refuse (hostname inconnu/non actif/banni)
 *
 * On accepte :
 *   - customers.maquickpage.fr (= notre fallback FQDN actuel)
 *   - customers.monsitehq.com (= legacy, conservé tant que des sites pointent dessus)
 *   - n'importe quel hostname présent en DB avec subscription_status in (live, active, trialing)
 *   - l'adresse provisoire d'un salon (temp_hostname, ex: salonjean.maquickpage.fr),
 *     sur laquelle son site vit dès le paiement en attendant la livraison du
 *     domaine par le registrar
 *
 * Sécurité :
 *   - Lecture seule (pas de modif)
 *   - Pas d'auth (Caddy ne peut pas s'authentifier sur l'ask endpoint)
 *   - Validation stricte pour ne pas hit le rate-limit Let's Encrypt sur des
 *     hostnames pirates pointés sur notre IP.
 *
 * Doc Caddy : https://caddyserver.com/docs/automatic-https#on-demand-tls
 */

import express from 'express';
import db from '../db.js';

const router = express.Router();

// Hostnames de notre infra acceptés en plus de la DB salons
// (= les FQDNs propres de Falkenstein, vu qu'on ne les a pas en table salons)
const INFRA_HOSTNAMES = new Set([
  'customers.maquickpage.fr', // actuel
  'customers.monsitehq.com',  // legacy, rétrocompat
]);

// État de subscription qui autorise la délivrance du cert SSL.
//
// IMPORTANT : 'provisioning' est inclus, sinon DEADLOCK :
//   1. Webhook Stripe → salon.subscription_status='provisioning'
//   2. Helsinki poll https://hostname/health pour confirmer que tout marche
//   3. Caddy reçoit la requête → demande à ask-endpoint si autorisé
//   4. Si 'provisioning' pas dans ACTIVE → ask retourne 403 → Caddy refuse
//      le cert → TLS handshake fail → poll Helsinki KO → status reste
//      'provisioning' éternellement → site jamais en ligne.
// → On accepte 'provisioning' (= le coiffeur a payé, on est en cours de setup),
//   ce qui permet à Caddy d'obtenir le cert PENDANT le provisioning.
const ACTIVE_STATUSES = new Set(['live', 'active', 'trialing', 'provisioning']);

router.get('/check-hostname', (req, res) => {
  const domain = (req.query.domain || '').toString().toLowerCase().trim();

  // Validation basique du format
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).send('invalid');
  }

  // Hostname infra (toujours autorisé)
  if (INFRA_HOSTNAMES.has(domain)) {
    return res.status(200).send('ok');
  }

  // Lookup en DB par live_hostname.
  //
  // Le provisioning crée DEUX records DNS : l'apex (salon-jean.fr) et www
  // (www.salon-jean.fr), tous deux → IP Falkenstein. Mais seul l'apex est
  // stocké en live_hostname. Sans le strip ci-dessous, Caddy demande un cert
  // pour www.salon-jean.fr → 404 → refus → TLS handshake fail → le visiteur
  // qui tape "www." voit un avertissement de sécurité du navigateur.
  // On autorise donc le cert pour www.{apex} dès que l'apex est connu ;
  // le redirect www → apex est fait par le middleware TENANT_ONLY de server.js.
  const apex = domain.startsWith('www.') ? domain.slice(4) : domain;

  let salon;
  try {
    salon = db.prepare(`
      SELECT slug, subscription_status, live_hostname, temp_hostname
      FROM salons
      WHERE live_hostname = ? OR temp_hostname = ?
      LIMIT 1
    `).get(apex, apex);
  } catch (err) {
    console.error('[caddy/check-hostname] DB error:', err.message);
    return res.status(500).send('db_error');
  }

  if (!salon) {
    // Pas de salon avec ce hostname → refuse (Caddy ne provisionnera pas de cert)
    console.log(`[caddy/check-hostname] ${domain} → 404 (no salon)`);
    return res.status(404).send('unknown_hostname');
  }

  if (!ACTIVE_STATUSES.has(salon.subscription_status)) {
    console.log(`[caddy/check-hostname] ${domain} → 403 (status=${salon.subscription_status})`);
    return res.status(403).send('inactive_subscription');
  }

  // OK : Caddy peut provisionner le cert pour ce hostname
  console.log(`[caddy/check-hostname] ${domain} → 200 (slug=${salon.slug})`);
  return res.status(200).send('ok');
});

export default router;

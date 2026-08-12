/**
 * Webhook Stripe : reçoit les events post-paiement et déclenche
 * l'orchestrator (achat domaine OVH + DNS + Cloudflare for SaaS).
 *
 * Idempotency : on stocke chaque event.id en DB (table stripe_events) pour
 * éviter de traiter 2× le même event si Stripe retry.
 *
 * Important : ce router DOIT être monté AVANT les middlewares JSON globaux
 * (sinon req.body est parsé et la signature Stripe ne match plus).
 */

import express from 'express';
import Stripe from 'stripe';
import db from '../db.js';
import { startProvisioning, syncSalonToFalkenstein } from '../provisioning-worker.js';
import { isTemplateId } from '../templates.js';
import { sendPaymentReceivedEmail } from '../email-sender.js';

const router = express.Router();

// Statuts Stripe considérés "actifs" (= site doit rester accessible)
const ACTIVE_STRIPE_STATUSES = new Set(['active', 'trialing']);

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET non configuré');
    return res.status(500).send('webhook secret missing');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send('stripe secret missing');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] Signature verif failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // === Idempotency : skip si déjà traité ===
  const existing = db.prepare('SELECT id FROM stripe_events WHERE id = ?').get(event.id);
  if (existing) {
    console.log('[stripe-webhook] Already processed:', event.id);
    return res.json({ received: true, duplicate: true });
  }
  db.prepare('INSERT INTO stripe_events (id, type, payload) VALUES (?, ?, ?)').run(
    event.id, event.type, JSON.stringify(event.data?.object || {}).slice(0, 5000)
  );

  // === Dispatch ===
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await onCheckoutCompleted(session);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await onSubscriptionUpdate(sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await onSubscriptionDeleted(sub);
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await onPaymentFailed(inv);
        break;
      }
      default:
        console.log('[stripe-webhook] Unhandled event type:', event.type);
    }
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err);
    // Ne jamais acquitter un event dont le traitement a échoué : Stripe doit
    // pouvoir le renvoyer. La ligne est supprimée pour libérer l'idempotency key.
    db.prepare('DELETE FROM stripe_events WHERE id = ?').run(event.id);
    return res.status(500).json({ received: false, retry: true });
  }

  res.json({ received: true });
});

async function onCheckoutCompleted(session) {
  // session.metadata = { slug, hostname, plan, supplementEurTtc }
  const slug = session.metadata?.slug;
  if (!slug) {
    throw new Error(`checkout.session.completed sans slug en metadata (${session.id})`);
  }
  const hostname = session.metadata?.hostname;
  const planKey = session.metadata?.plan;
  if (!hostname || !planKey) {
    throw new Error(`checkout.session.completed metadata incomplète (${session.id})`);
  }
  const template = session.metadata?.template;
  // Update DB : marquer le salon comme "payment_received"
  let updateResult;
  if (isTemplateId(template)) {
    updateResult = db.prepare(`
      UPDATE salons
      SET stripe_customer_id = ?, stripe_subscription_id = ?,
          subscription_status = 'provisioning', template = ?,
          signed_up_at = datetime('now'), updated_at = datetime('now')
      WHERE slug = ?
    `).run(session.customer, session.subscription, template, slug);
  } else {
    // Les sessions créées avant l'ajout du choix de design n'ont pas cette
    // metadata : préserver le template déjà enregistré au lieu de forcer Classic.
    updateResult = db.prepare(`
      UPDATE salons
      SET stripe_customer_id = ?, stripe_subscription_id = ?,
          subscription_status = 'provisioning',
          signed_up_at = datetime('now'), updated_at = datetime('now')
      WHERE slug = ?
    `).run(session.customer, session.subscription, slug);
  }
  if (updateResult.changes !== 1) {
    throw new Error(`salon introuvable pour checkout.session.completed (${slug})`);
  }

  // Nouveau signup = compteurs du watchdog remis à zéro : les relances et
  // l'email "retard" de la commande précédente ne doivent pas bloquer celle-ci.
  db.prepare(`
    UPDATE salons SET provisioning_attempts = 0, delay_notified_at = NULL WHERE slug = ?
  `).run(slug);

  // Accusé de réception du paiement, envoyé tout de suite : entre ce moment et
  // la mise en ligne il peut s'écouler jusqu'à 45 min (délai registrar), et le
  // client vient de débiter sa carte sans rien avoir reçu.
  // Fire-and-forget : un problème d'email ne doit jamais faire échouer le
  // webhook (Stripe rejouerait l'event et on relancerait un provisioning).
  const customerEmail = session.customer_email || session.customer_details?.email
    || db.prepare('SELECT owner_email FROM salons WHERE slug = ?').get(slug)?.owner_email;
  if (customerEmail) {
    const row = db.prepare('SELECT nom_clean, nom, plan FROM salons WHERE slug = ?').get(slug);
    sendPaymentReceivedEmail({
      to: customerEmail,
      salonName: row?.nom_clean || row?.nom || 'votre salon',
      hostname,
      plan: planKey,
      sessionId: session.id,
    }).catch(err => console.error('[stripe-webhook] email paiement reçu échoué (non-fatal):', err.message));
  }

  // Lance l'orchestrator (worker async, ne bloque pas la réponse webhook)
  startProvisioning({
    slug,
    hostname,
    planKey,
    customerEmail: session.customer_email || session.customer_details?.email,
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
  }).catch(err => {
    console.error('[stripe-webhook] startProvisioning failed:', err);
    // On marque le salon en error
    db.prepare(`UPDATE salons SET subscription_status='error', updated_at=datetime('now') WHERE slug=?`).run(slug);
  });
}

async function onSubscriptionUpdate(sub) {
  // sub.metadata = { slug, hostname, plan, commitment_months }
  const slug = sub.metadata?.slug;
  if (!slug) return;

  // Statut Stripe → statut interne
  // - active / trialing → 'active' (= live actif)
  // - past_due / unpaid → 'past_due' (= site suspendu pour défaut de paiement)
  // - canceled         → 'cancelled' (= annulation effective de l'abonnement)
  // - incomplete / incomplete_expired → 'pending' (= attend paiement initial)
  const stripeStatus = sub.status;
  const internalStatus = ACTIVE_STRIPE_STATUSES.has(stripeStatus) ? 'active' : stripeStatus;

  // Track suspension : si on bascule en non-actif on horodate, sinon on clear.
  const isActive = ACTIVE_STRIPE_STATUSES.has(stripeStatus);
  const current = db.prepare('SELECT subscription_status, suspended_at FROM salons WHERE slug = ?').get(slug);
  const wasActive = current && (current.subscription_status === 'active' || current.subscription_status === 'live' || current.subscription_status === 'trialing');

  if (isActive) {
    // Réactivation : on clear la suspension
    // Préserver "live" : c'est un état de provisioning, pas un statut Stripe.
    const nextStatus = current?.subscription_status === 'live' ? 'live' : internalStatus;
    db.prepare(`
      UPDATE salons SET subscription_status = ?, stripe_subscription_id = ?,
          suspended_at = NULL, suspended_reason = NULL,
          updated_at = datetime('now')
      WHERE slug = ?
    `).run(nextStatus, sub.id, slug);
    if (!wasActive) {
      console.log(`[stripe-webhook] ${slug} REACTIVATED (status=${stripeStatus})`);
    }
  } else {
    // Suspension : on horodate uniquement si on n'avait pas déjà suspended_at
    const reason = stripeStatus === 'canceled' ? 'cancelled'
                 : (stripeStatus === 'past_due' || stripeStatus === 'unpaid') ? 'payment_failed'
                 : 'inactive';
    db.prepare(`
      UPDATE salons SET subscription_status = ?, stripe_subscription_id = ?,
          suspended_at = COALESCE(suspended_at, datetime('now')),
          suspended_reason = COALESCE(suspended_reason, ?),
          updated_at = datetime('now')
      WHERE slug = ?
    `).run(internalStatus, sub.id, reason, slug);
    if (wasActive) {
      console.log(`[stripe-webhook] ${slug} SUSPENDED (status=${stripeStatus}, reason=${reason})`);
    }
  }

  // Propage vers Falkenstein pour que le site se mette à jour (suspended.html ou redev. live)
  await syncSalonToFalkenstein(slug).catch(err => {
    console.error(`[stripe-webhook] ${slug} sync Falkenstein failed:`, err.message);
  });
}

async function onSubscriptionDeleted(sub) {
  const slug = sub.metadata?.slug;
  if (!slug) return;
  db.prepare(`
    UPDATE salons
    SET subscription_status = 'cancelled',
        cancelled_at = datetime('now'),
        suspended_at = COALESCE(suspended_at, datetime('now')),
        suspended_reason = COALESCE(suspended_reason, 'cancelled'),
        updated_at = datetime('now')
    WHERE slug = ?
  `).run(slug);
  console.log(`[stripe-webhook] ${slug} CANCELLED (subscription deleted)`);

  // Propage vers Falkenstein
  await syncSalonToFalkenstein(slug).catch(err => {
    console.error(`[stripe-webhook] ${slug} sync Falkenstein failed:`, err.message);
  });
}

async function onPaymentFailed(invoice) {
  // Stripe API récente : l'abonnement peut être exposé sous parent.subscription_details.
  const subId = invoice.subscription
    || invoice.parent?.subscription_details?.subscription
    || invoice.subscription_details?.subscription;
  if (!subId) return;
  const row = db.prepare('SELECT slug FROM salons WHERE stripe_subscription_id = ?').get(subId);
  if (!row) {
    console.warn('[stripe-webhook] payment_failed pour subscription inconnu:', subId);
    return;
  }
  db.prepare(`
    UPDATE salons SET subscription_status = 'past_due',
        suspended_at = COALESCE(suspended_at, datetime('now')),
        suspended_reason = COALESCE(suspended_reason, 'payment_failed'),
        updated_at = datetime('now')
    WHERE stripe_subscription_id = ?
  `).run(subId);
  console.log(`[stripe-webhook] ${row.slug} PAYMENT_FAILED → suspended`);

  // Propage vers Falkenstein
  await syncSalonToFalkenstein(row.slug).catch(err => {
    console.error(`[stripe-webhook] ${row.slug} sync Falkenstein failed:`, err.message);
  });
}

export default router;

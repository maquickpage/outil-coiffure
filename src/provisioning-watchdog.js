/**
 * Watchdog du provisioning — reprise automatique et surveillance des sites live.
 *
 * Pourquoi ce module existe (incidents réels des 6 au 10 août 2026) :
 *
 *   1. Le job de provisioning vit EN MÉMOIRE dans le process. Un redémarrage du
 *      conteneur (déploiement, crash, OOM) pendant un provisioning laissait le
 *      salon bloqué en 'provisioning' pour toujours, sans que personne ne
 *      reprenne — même à la minute 2.
 *
 *   2. OVH a mis 18 h 40 à livrer un domaine (commande du 10/08 17:15, domaine
 *      créé le 11/08 11:50). Le worker abandonne au bout de OVH_POLL_TIMEOUT_MS,
 *      marque le salon en 'error' et s'arrête là. Le domaine finissait par
 *      arriver, mais plus personne ne terminait le travail : la cliente a payé
 *      et attendu deux jours qu'un humain relance à la main.
 *
 *   3. La délégation DNS d'un domaine client est repassée toute seule sur des
 *      NS externes plusieurs jours après la mise en ligne, rendant le site
 *      injoignable alors que tous les contrôles du provisioning étaient au vert.
 *
 * Le point commun des trois : rien ne repassait derrière. Ce watchdog est ce
 * "derrière". Il est sûr à relancer parce que chaque étape du worker est
 * idempotente (l'achat OVH vérifie d'abord le portefeuille : jamais de double
 * facturation).
 */

import db from './db.js';
import {
  startProvisioning,
  getProvisioningStatus,
  ensureOvhNameServers,
} from './provisioning-worker.js';

// Fréquence du tick. Court, parce qu'un tick ne fait presque rien quand tout
// va bien : startProvisioning refuse les doublons (job déjà 'running'), donc la
// cadence réelle des relances est celle du timeout du worker, pas celle-ci.
const TICK_MS = Number(process.env.WATCHDOG_TICK_MS || 5 * 60 * 1000);

// Au-delà, on cesse de relancer : le salon est réellement cassé et demande un
// humain. Garde-fou anti-boucle, pas une limite de temps (cf. MAX_AGE_HOURS).
const MAX_ATTEMPTS = Number(process.env.WATCHDOG_MAX_ATTEMPTS || 100);

// Fenêtre de reprise. Large exprès : un registrar peut mettre une journée, et
// un signup abandonné il y a trois semaines ne doit plus rien déclencher.
const MAX_AGE_HOURS = Number(process.env.WATCHDOG_MAX_AGE_HOURS || 7 * 24);

// La vérification de délégation DNS tape l'API OVH une fois par site live :
// inutile de la faire à chaque tick.
const DNS_CHECK_EVERY_TICKS = Number(process.env.WATCHDOG_DNS_CHECK_EVERY_TICKS || 3);

let tickCount = 0;
let running = false;

/**
 * Salons dont le provisioning s'est arrêté en cours de route.
 *
 * 'provisioning' = job perdu (redémarrage) ou toujours en cours ;
 * 'error'        = worker qui a abandonné (timeout registrar le plus souvent).
 * Dans les deux cas, relancer est le bon réflexe : si le job tourne encore,
 * startProvisioning refusera poliment.
 */
function findStalledSalons() {
  return db.prepare(`
    SELECT slug, live_hostname, plan, owner_email,
           stripe_customer_id, stripe_subscription_id,
           subscription_status, provisioning_attempts, signed_up_at
    FROM salons
    WHERE subscription_status IN ('provisioning', 'error')
      AND live_hostname IS NOT NULL
      AND plan IS NOT NULL
      AND signed_up_at IS NOT NULL
      AND signed_up_at > datetime('now', ?)
      AND COALESCE(provisioning_attempts, 0) < ?
  `).all(`-${MAX_AGE_HOURS} hours`, MAX_ATTEMPTS);
}

async function resumeStalled() {
  const salons = findStalledSalons();
  for (const salon of salons) {
    // Job déjà en cours : on le laisse finir.
    const job = getProvisioningStatus(salon.slug);
    if (job && job.state === 'running') continue;

    const attempts = (salon.provisioning_attempts || 0) + 1;
    db.prepare(`
      UPDATE salons
      SET provisioning_attempts = ?, subscription_status = 'provisioning',
          updated_at = datetime('now')
      WHERE slug = ?
    `).run(attempts, salon.slug);

    console.log(`[watchdog] reprise ${salon.slug} → ${salon.live_hostname} (tentative ${attempts}, était '${salon.subscription_status}')`);

    startProvisioning({
      slug: salon.slug,
      hostname: salon.live_hostname,
      planKey: salon.plan,
      customerEmail: salon.owner_email,
      stripeCustomerId: salon.stripe_customer_id,
      stripeSubscriptionId: salon.stripe_subscription_id,
    }).catch(err => {
      console.error(`[watchdog] reprise ${salon.slug} échouée:`, err.message);
    });
  }
}

/**
 * Vérifie que les sites en ligne sont toujours délégués aux DNS d'OVH.
 *
 * Un site peut sortir du réseau des jours après sa mise en ligne si sa
 * délégation bascule (c'est arrivé le 08/08 : NS repassés sur un DNS externe
 * sans zone, site injoignable pendant des heures sans que rien ne le signale).
 * ensureOvhNameServers ne fait rien quand la délégation est correcte.
 */
async function checkLiveDelegations() {
  const rows = db.prepare(`
    SELECT slug, live_hostname FROM salons
    WHERE subscription_status IN ('live', 'active')
      AND live_hostname IS NOT NULL
  `).all();

  for (const row of rows) {
    try {
      await ensureOvhNameServers(row.live_hostname);
    } catch (err) {
      console.error(`[watchdog] contrôle délégation ${row.live_hostname} échoué:`, err.message);
    }
  }
}

async function tick() {
  // Un tick lent (beaucoup de salons, API OVH poussive) ne doit pas se
  // chevaucher avec le suivant.
  if (running) return;
  running = true;
  try {
    await resumeStalled();
    if (tickCount % DNS_CHECK_EVERY_TICKS === 0) await checkLiveDelegations();
  } catch (err) {
    console.error('[watchdog] tick en erreur:', err.message);
  } finally {
    tickCount++;
    running = false;
  }
}

export function startWatchdog() {
  console.log(`[watchdog] démarré (tick ${TICK_MS / 1000}s, reprise jusqu'à ${MAX_AGE_HOURS}h après le paiement)`);
  // Premier passage rapide après le boot : c'est exactement le moment où on
  // récupère les jobs perdus par le redémarrage qui vient d'avoir lieu.
  setTimeout(() => { tick(); }, 30 * 1000);
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return timer;
}

export default { startWatchdog };

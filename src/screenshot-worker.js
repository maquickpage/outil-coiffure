import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import db from './db.js';

// =============================================================================
// CONFIG
// =============================================================================
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || './public/screenshots';
const INTERNAL_BASE = process.env.INTERNAL_SCREENSHOT_BASE_URL || 'http://localhost:3000';
const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 80;

// Concurrence par defaut. Avec l'architecture "un browser par worker"
// (cf. plus bas), 4 workers = 4 instances Chromium = ~800 Mo de RAM
// pour les browsers seuls. Reste large sur un VPS de 2-4 Go.
const DEFAULT_CONCURRENCY = Math.max(1, parseInt(process.env.SCREENSHOT_CONCURRENCY || '4', 10));

// Buffer final apres les waits explicites (fonts + images + reflow)
const SETTLE_MS = Math.max(0, parseInt(process.env.SCREENSHOT_SETTLE_MS || '400', 10));

// Logs verbeux pour diagnostic (mettre SCREENSHOT_DEBUG=0 pour couper)
const DEBUG = process.env.SCREENSHOT_DEBUG !== '0';

// Timeout dur par capture : si une capture ne finit pas en CAPTURE_TIMEOUT_MS,
// le watchdog force-close la page. Avec architecture per-worker, on peut aussi
// recycler le browser entier si la capture timeout (cf. WORKER_ERROR_THRESHOLD).
const CAPTURE_TIMEOUT_MS = Math.max(10000, parseInt(process.env.SCREENSHOT_TIMEOUT_MS || '30000', 10));

// Recyclage proactif du browser de chaque worker apres N captures.
// Reset l'etat (memory leak, GPU buffers, connexions zombies) avant que le
// browser ne degrade. La preuve dans les logs production : la degradation
// commencait apres ~14-15 captures sur un browser frais.
const WORKER_RECYCLE_EVERY = Math.max(0, parseInt(process.env.SCREENSHOT_BROWSER_RECYCLE || '15', 10));

// Recyclage reactif : si un worker a N captures consecutives en erreur,
// on assume que son browser est mort/figé et on le relance.
const WORKER_ERROR_THRESHOLD = Math.max(1, parseInt(process.env.SCREENSHOT_ERROR_THRESHOLD || '2', 10));

// Stagger entre les workers au demarrage : evite que les N workers tapent
// sur le serveur Express en meme temps avec leurs page.goto().
const WORKER_STAGGER_MS = Math.max(0, parseInt(process.env.SCREENSHOT_WORKER_STAGGER_MS || '300', 10));

// Options de lancement Chromium partagees
const LAUNCH_OPTS = {
  headless: true,
  // protocolTimeout = delai max pour une commande CDP. Default 180s = trop long.
  // 25s permet le fail-fast quand le renderer bloque.
  protocolTimeout: 25000,
  // En container (Coolify/Docker), il n'y a PAS de bus D-Bus systeme. Chromium
  // tente quand meme de se connecter a /run/dbus/system_bus_socket au demarrage
  // et, quand le socket n'existe pas, le process peut echouer avec :
  //   "Failed to connect to socket /run/dbus/system_bus_socket".
  // Pointer DBUS_SESSION_BUS_ADDRESS sur /dev/null dit a Chromium de ne pas
  // chercher de bus. On repart de process.env pour garder PATH, HOME, etc.
  env: {
    ...process.env,
    // Le message d'erreur cite le bus SYSTEME (/run/dbus/system_bus_socket) ET
    // Chromium tente aussi un bus SESSION. On neutralise les DEUX : aucun daemon
    // dbus ne tourne dans le container, donc on dit a Chromium de ne rien chercher.
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null',
    DBUS_SYSTEM_BUS_ADDRESS: process.env.DBUS_SYSTEM_BUS_ADDRESS || '/dev/null',
  },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    // Coupe les sous-systemes qui dependent de D-Bus / du profil utilisateur
    // et ne servent a rien pour une capture headless en container.
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--mute-audio',
  ]
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  LAUNCH_OPTS.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// =============================================================================
// CSS injecte sur chaque page : neutralise toutes animations/transitions pour
// que le screenshot capture l'etat final immediatement (pas pendant un fadeIn).
// =============================================================================
const DISABLE_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
`;

// =============================================================================
// BROWSER PARTAGE (utilise uniquement pour les captures single-shot via
// captureSalon(slug) sans batch). Le batch parallele utilise des browsers
// per-worker (cf. plus bas).
// =============================================================================
let sharedBrowser = null;

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;
  sharedBrowser = await puppeteer.launch(LAUNCH_OPTS);
  if (DEBUG) console.log(`[browser:shared] launched`);
  return sharedBrowser;
}

export async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

// =============================================================================
// Helper : amorce le pipeline rendering d'un browser frais via une capture
// "fictive" sur about:blank. Force Chromium a initialiser son compositeur,
// V8 JIT, encodeur JPEG, GPU buffers ... AVANT que les vraies captures
// concurrentes ne tapent dessus. Sans ca, les 1eres captures se serialisent.
// =============================================================================
async function warmupBrowser(browser, label = '') {
  const t0 = Date.now();
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto('about:blank', { timeout: 5000 });
    await page.screenshot({ type: 'jpeg', quality: 50 });
    if (DEBUG) console.log(`[browser${label}] warmed up in ${Date.now() - t0}ms`);
  } catch (e) {
    if (DEBUG) console.log(`[browser${label}] warmup failed (non-fatal): ${e.message}`);
  } finally {
    if (page) page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

// =============================================================================
// Attente deterministe avant capture : fonts + images + bg-image + reflow
// =============================================================================
async function waitForRenderComplete(page) {
  // 1) FONTS : forcer le chargement de chaque font-family utilisee dans le DOM
  try {
    await page.evaluate(async () => {
      if (!document.fonts) return;
      const stacks = new Set();
      for (const el of document.querySelectorAll('*')) {
        const ff = getComputedStyle(el).fontFamily;
        if (ff && ff !== 'inherit') stacks.add(ff);
      }
      const variants = ['300 16px', '400 16px', '500 16px', '600 16px', '700 16px',
                        'italic 400 16px', 'italic 700 16px'];
      const promises = [];
      for (const stack of stacks) {
        for (const v of variants) {
          promises.push(document.fonts.load(`${v} ${stack}`).catch(() => null));
        }
      }
      await Promise.allSettled(promises);
      try { await document.fonts.ready; } catch {}
    });
  } catch {}

  // 2) Force un reflow synchrone pour appliquer le swap des fonts
  try {
    await page.evaluate(() => {
      // eslint-disable-next-line no-unused-expressions
      document.body.offsetHeight;
    });
  } catch {}

  // 3) IMAGES : <img> + background-image CSS chargees et decodees
  try {
    await page.evaluate(() => new Promise(resolve => {
      const urls = new Set();
      for (const el of document.querySelectorAll('*')) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        const re = /url\((["']?)([^"'()]+)\1\)/g;
        let m;
        while ((m = re.exec(bg)) !== null) {
          if (m[2]) urls.add(m[2]);
        }
      }
      for (const img of document.images) {
        if (img.src) urls.add(img.src);
      }
      const list = Array.from(urls).filter(Boolean);
      if (list.length === 0) return resolve();

      const promises = list.map(src => new Promise(res => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        const i = new Image();
        i.onload = finish;
        i.onerror = finish;
        i.src = src;
        if (i.complete) finish();
        setTimeout(finish, 8000);
      }));
      Promise.all(promises).then(() => resolve());
    }));
  } catch {}

  // 4) Buffer final pour settle des animations residuelles
  if (SETTLE_MS > 0) await new Promise(r => setTimeout(r, SETTLE_MS));
}

// =============================================================================
// Capture sur un browser donne (utilise par captureSalon et par les workers).
// Watchdog : si la capture ne finit pas en CAPTURE_TIMEOUT_MS, on force-close
// la page (qui annule toutes les commandes CDP en cours et propage une erreur).
// =============================================================================
async function captureSalonOnBrowser(browser, slug, workerLabel = '') {
  const t0 = Date.now();
  const page = await browser.newPage();
  if (DEBUG) console.log(`[shot ${slug}]${workerLabel} start  t=${new Date(t0).toISOString()}`);

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    if (DEBUG) console.log(`[shot ${slug}]${workerLabel} watchdog fired (${CAPTURE_TIMEOUT_MS}ms) -> force close page`);
    page.close({ runBeforeUnload: false }).catch(() => {});
  }, CAPTURE_TIMEOUT_MS);

  try {
    await page.setViewport(VIEWPORT);
    const url = `${INTERNAL_BASE}/preview/${slug}?nocapture=1`;
    const tNav0 = Date.now();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 25000 });
    const tNav1 = Date.now();
    await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
    await waitForRenderComplete(page);
    const tWait1 = Date.now();

    const filename = `${slug}.jpg`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: JPEG_QUALITY,
      fullPage: false
    });
    writeFileSync(filepath, buffer);

    const relativeUrl = `/screenshots/${filename}`;
    db.prepare(`
      UPDATE salons
      SET screenshot_path = ?, screenshot_generated_at = datetime('now'), updated_at = datetime('now')
      WHERE slug = ?
    `).run(relativeUrl, slug);

    if (DEBUG) {
      const tEnd = Date.now();
      console.log(`[shot ${slug}]${workerLabel} done   nav=${tNav1 - tNav0}ms wait=${tWait1 - tNav1}ms shot=${tEnd - tWait1}ms total=${tEnd - t0}ms`);
    }
    return { slug, success: true, screenshot_path: relativeUrl };
  } catch (e) {
    const reason = timedOut ? `capture timeout (${CAPTURE_TIMEOUT_MS}ms)` : e.message;
    if (DEBUG) console.log(`[shot ${slug}]${workerLabel} error  ${reason}`);
    return { slug, success: false, error: reason };
  } finally {
    clearTimeout(watchdog);
    page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

// =============================================================================
// Capture single-shot : utilise le browser partage (utilise par /admin/screenshot/:slug)
// =============================================================================
export async function captureSalon(slug) {
  const browser = await getSharedBrowser();
  return captureSalonOnBrowser(browser, slug);
}

// =============================================================================
// RECAPTURE AUTOMATIQUE (fire-and-forget, anti-rebond)
//
// Appelee par TOUS les points qui modifient le contenu d'un salon (editeur
// coiffeur, photo-picker, edition admin du nom/presentation...). Objectif :
// des qu'un salon change (image du hero, textes, galerie...), un nouveau
// screenshot se regenere tout seul, sans batch manuel.
//
// Anti-rebond par slug : quand un coiffeur enchaine plusieurs sauvegardes en
// quelques secondes, on ne lance qu'UNE capture (la derniere), au lieu d'empiler
// autant d'instances Chromium que de sauvegardes. Le timer se reset a chaque
// appel ; la capture part RECAPTURE_DEBOUNCE_MS apres la DERNIERE modif.
// =============================================================================
const RECAPTURE_DEBOUNCE_MS = Math.max(0, parseInt(process.env.SCREENSHOT_RECAPTURE_DEBOUNCE_MS || '3000', 10));
const _recaptureTimers = new Map();

export function recaptureAsync(slug) {
  if (!slug) return;
  const existing = _recaptureTimers.get(slug);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _recaptureTimers.delete(slug);
    captureSalon(slug).catch((e) => console.warn(`[recapture] ${slug} fail: ${e.message}`));
  }, RECAPTURE_DEBOUNCE_MS);
  // Ne pas empecher le process de s'eteindre juste pour un screenshot en attente.
  if (typeof timer.unref === 'function') timer.unref();
  _recaptureTimers.set(slug, timer);
}

export async function captureBatch(slugs, onProgress) {
  // Backward compat : appelle la version parallele avec concurrence 1
  return captureBatchParallel(slugs, 1, onProgress);
}

// =============================================================================
// BATCH PARALLELE : architecture per-worker browser
//
// Chaque worker maintient SON PROPRE browser Chromium independant. Quand son
// browser degrade (memory leak, GPU buffers), il le recycle SEUL — sans
// affecter les autres workers. Trois conditions de recyclage :
//   1. Proactif : tous les WORKER_RECYCLE_EVERY captures (defaut 15)
//   2. Reactif : apres WORKER_ERROR_THRESHOLD captures consecutives en erreur
//   3. Reactif : si le browser process s'est deconnecte (crash)
//
// Chaque browser est warmed-up apres lancement (warmupBrowser) pour eviter
// la serialisation interne du pipeline Chromium au demarrage.
//
// Cout RAM : ~200 Mo par browser. Avec concurrency=4 -> ~800 Mo de browsers,
// + ~100 Mo de pages actives -> ~1 Go pendant un batch. Reste large sur un
// VPS de 2 Go.
// =============================================================================
export async function captureBatchParallel(slugs, concurrency, onProgress) {
  const c = Math.max(1, concurrency || DEFAULT_CONCURRENCY);
  const results = new Array(slugs.length);
  let nextIndex = 0;
  let completed = 0;
  const tStart = Date.now();
  if (DEBUG) console.log(`[batch] start total=${slugs.length} workers=${c} recycle=${WORKER_RECYCLE_EVERY} settle=${SETTLE_MS}ms`);

  // Lancement parallele de N workers, chacun avec son browser dedie
  const workers = Array.from({ length: Math.min(c, slugs.length) }, async (_, workerId) => {
    const label = ` w#${workerId}`;
    let browser = null;
    let captureCount = 0;
    let consecutiveErrors = 0;

    // Helper : (re)lance le browser de ce worker + warmup
    const launchBrowser = async () => {
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
      }
      const t0 = Date.now();
      browser = await puppeteer.launch(LAUNCH_OPTS);
      captureCount = 0;
      if (DEBUG) console.log(`[browser${label}] launched`);
      await warmupBrowser(browser, label);
      if (DEBUG) console.log(`[browser${label}] ready in ${Date.now() - t0}ms`);
    };

    // Stagger : decale les demarrages des workers pour ne pas saturer le
    // serveur Express avec N goto() simultanes ni Chrome avec N launch().
    if (workerId > 0 && WORKER_STAGGER_MS > 0) {
      await new Promise(r => setTimeout(r, workerId * WORKER_STAGGER_MS));
    }

    try {
      await launchBrowser();

      while (true) {
        const i = nextIndex++;
        if (i >= slugs.length) return;

        // Recyclage proactif : eviter la degradation progressive
        if (WORKER_RECYCLE_EVERY > 0 && captureCount >= WORKER_RECYCLE_EVERY) {
          if (DEBUG) console.log(`[browser${label}] proactive recycle (after ${captureCount} captures)`);
          await launchBrowser();
        }

        // Recyclage reactif : trop d'erreurs consecutives = browser zombie
        if (consecutiveErrors >= WORKER_ERROR_THRESHOLD) {
          if (DEBUG) console.log(`[browser${label}] reactive recycle (${consecutiveErrors} consecutive errors)`);
          await launchBrowser();
          consecutiveErrors = 0;
        }

        // Si le browser s'est deconnecte (crash silencieux), le relancer
        if (!browser || !browser.connected) {
          if (DEBUG) console.log(`[browser${label}] disconnected -> relaunch`);
          await launchBrowser();
        }

        if (DEBUG) console.log(`[batch${label}] -> slug ${slugs[i]} (${i + 1}/${slugs.length})`);
        captureCount++;
        const result = await captureSalonOnBrowser(browser, slugs[i], label);
        results[i] = result;
        completed++;
        if (result.success) consecutiveErrors = 0;
        else consecutiveErrors++;
        if (onProgress) onProgress({ done: completed, total: slugs.length, last: result });
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  await Promise.all(workers);
  if (DEBUG) console.log(`[batch] finished total=${slugs.length} elapsed=${Date.now() - tStart}ms`);
  return results;
}

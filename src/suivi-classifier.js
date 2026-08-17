// Classifieur bot / interne / humain pour les events maquette (preview_events).
//
// UNE seule définition, importée par le Suivi maquettes (routes/admin.js) ET par le
// séquenceur (routes/sequencer.js). Avant ce fichier, admin.js portait déjà deux copies
// de la même regex (SUIVI_BOT_RE et LANDING_BOT_RE) — la dérive avait commencé.
//
// « bot » = pas un humain : robot déclaré dans l'User-Agent, OU scanner de messagerie
// reconnu à sa plage IP (Gmail / Outlook ouvrent les liens d'un message pour les vérifier
// en se présentant comme un Chrome ordinaire — chaque email envoyé fabriquait une fausse
// visite, 23 events sur 14 salons au 2026-08-15).
// « interne » = pas un bot, mais nous : IP exclue (table suivi_excluded_ips), appareil
// exclu (suivi_excluded_devices, avec rattrapage rétroactif par signature ip|ua), ou
// action d'outreach interne (démo envoyée depuis le cockpit).
// « humain » = tout le reste.

export const BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|http-client|headless|phantom|preview|scan|proofpoint|mimecast|barracuda|safelinks|googleimageproxy|facebookexternalhit|whatsapp|bingpreview|yandex|ahrefs|semrush|monitor/i;

// Plages : Google (Gmail, Googlebot, aperçus de liens — servis depuis BEAUCOUP de plages,
// pas seulement Googlebot) et Microsoft (Exchange Online / SafeLinks).
export const SCANNER_IP_RE = /^(2607:f8b0:|2a00:1450:|2a00:1288:|66\.249\.|64\.233\.|209\.85\.|142\.250\.|74\.125\.|172\.217\.|216\.58\.|108\.177\.|173\.194\.|40\.9[2-9]\.|104\.47\.|52\.10[0-9]\.|69\.63\.|69\.171\.|31\.13\.|157\.240\.)/i;

export const INTERNAL_ACTIVITY_EVENTS = new Set(['demo_email_envoyee', 'demo_sms_copiee']);

// Une box fournit un /64 en IPv6 et les appareils y tirent une adresse dont les 64
// derniers bits changent : on compare le PRÉFIXE RÉSEAU, stable. IPv4 : inchangé.
export function ip64(ip) {
  const s = String(ip || '');
  if (!s.includes(':')) return s;
  const parts = s.split(':');
  return parts.length >= 4 && parts.slice(0, 4).every(Boolean) ? parts.slice(0, 4).join(':') + '::/64' : s;
}

// Clé de rapprochement d'un visiteur pour l'EXCLUSION (préfixe réseau + UA tronqué).
export const skey = (ip, ua) => ip64(ip) + '|' + (ua || '').slice(0, 250);

export function isBot(ua, ip) {
  return !ua || BOT_RE.test(ua) || SCANNER_IP_RE.test(String(ip || ''));
}

// Construit un classifieur à partir des tables d'exclusion. `db` peut être omis (tests) :
// on passe alors les listes directement.
export function creerClassifieur({ db, excludedIps, excludedDevices, excludedSigs } = {}) {
  if (db) {
    excludedIps = excludedIps || db.prepare('SELECT ip FROM suivi_excluded_ips').all().map(r => r.ip);
    excludedDevices = excludedDevices || db.prepare('SELECT device_id FROM suivi_excluded_devices').all().map(r => r.device_id);
    excludedSigs = excludedSigs || db.prepare(`
      SELECT g.ip, g.ua FROM suivi_device_sigs g
      JOIN suivi_excluded_devices d ON d.device_id = g.device_id
    `).all().map(r => skey(r.ip, r.ua));
  }
  const ips = new Set(excludedIps || []);
  const devices = new Set(excludedDevices || []);
  const sigs = new Set(excludedSigs || []);

  function isInternal(ev) {
    return ips.has(ev.ip) || ips.has(ip64(ev.ip))
      || (ev.device && devices.has(ev.device))
      || sigs.has(skey(ev.ip, ev.user_agent))
      || INTERNAL_ACTIVITY_EVENTS.has(ev.event);
  }

  // → 'bot' | 'internal' | 'human'
  function classify(ev) {
    if (isBot(ev.user_agent, ev.ip)) return 'bot';
    if (isInternal(ev)) return 'internal';
    return 'human';
  }

  return { classify, isBot, isInternal };
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DB_PATH || './data/salons.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  // 1. Tables (creates if absent ; pas d'index sur edit_token ici pour les vieilles BDD)
  db.exec(`
    CREATE TABLE IF NOT EXISTS salons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      nom TEXT NOT NULL,
      ville TEXT,
      code_postal TEXT,
      adresse TEXT,
      telephone TEXT,
      email TEXT,
      latitude REAL,
      longitude REAL,
      types TEXT,
      note_avis REAL,
      nb_avis TEXT,
      heures_ouverture TEXT,
      lien_facebook TEXT,
      lien_instagram TEXT,
      lien_tiktok TEXT,
      lien_youtube TEXT,
      lien_google_maps TEXT,
      meta_image TEXT,
      titre_site TEXT,
      meta_description TEXT,
      site_internet_original TEXT,
      data_json TEXT NOT NULL,
      screenshot_path TEXT,
      screenshot_generated_at TEXT,
      csv_source TEXT,
      edit_token TEXT,
      overrides_json TEXT,
      overrides_updated_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_salons_slug ON salons(slug);
    CREATE INDEX IF NOT EXISTS idx_salons_csv_source ON salons(csv_source);
    CREATE INDEX IF NOT EXISTS idx_salons_screenshot ON salons(screenshot_path);

    CREATE TABLE IF NOT EXISTS csv_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      imported_rows INTEGER NOT NULL,
      skipped_rows INTEGER NOT NULL,
      original_headers TEXT,
      imported_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS salon_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 2. Migrations idempotentes : pour les BDD existantes, ajoute les colonnes manquantes
  const cols = db.prepare("PRAGMA table_info(salons)").all().map(c => c.name);
  if (!cols.includes('edit_token')) db.exec("ALTER TABLE salons ADD COLUMN edit_token TEXT");
  if (!cols.includes('overrides_json')) db.exec("ALTER TABLE salons ADD COLUMN overrides_json TEXT");
  if (!cols.includes('overrides_updated_at')) db.exec("ALTER TABLE salons ADD COLUMN overrides_updated_at TEXT");
  if (!cols.includes('nom_clean')) db.exec("ALTER TABLE salons ADD COLUMN nom_clean TEXT");
  if (!cols.includes('nom_clean_at')) db.exec("ALTER TABLE salons ADD COLUMN nom_clean_at TEXT");
  if (!cols.includes('group_id')) {
    db.exec("ALTER TABLE salons ADD COLUMN group_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_salons_group_id ON salons(group_id)");
  }

  // === Migration signup / Stripe / live hosting (2026-05-02) ===
  // Ces colonnes pilotent le passage demo -> site live (apres paiement Stripe).
  if (!cols.includes('owner_email')) db.exec("ALTER TABLE salons ADD COLUMN owner_email TEXT");
  if (!cols.includes('plan')) db.exec("ALTER TABLE salons ADD COLUMN plan TEXT DEFAULT 'free'");
  if (!cols.includes('stripe_customer_id')) db.exec("ALTER TABLE salons ADD COLUMN stripe_customer_id TEXT");
  if (!cols.includes('stripe_subscription_id')) db.exec("ALTER TABLE salons ADD COLUMN stripe_subscription_id TEXT");
  if (!cols.includes('commitment_months')) db.exec("ALTER TABLE salons ADD COLUMN commitment_months INTEGER DEFAULT 0");
  if (!cols.includes('commitment_until')) db.exec("ALTER TABLE salons ADD COLUMN commitment_until TEXT");
  if (!cols.includes('subscription_status')) db.exec("ALTER TABLE salons ADD COLUMN subscription_status TEXT");
  if (!cols.includes('live_hostname')) db.exec("ALTER TABLE salons ADD COLUMN live_hostname TEXT");
  if (!cols.includes('signup_session_id')) db.exec("ALTER TABLE salons ADD COLUMN signup_session_id TEXT");
  if (!cols.includes('signed_up_at')) db.exec("ALTER TABLE salons ADD COLUMN signed_up_at TEXT");
  if (!cols.includes('cancelled_at')) db.exec("ALTER TABLE salons ADD COLUMN cancelled_at TEXT");

  // === Adresse provisoire (mise en ligne immédiate au paiement) ===
  // temp_hostname : sous-domaine sur lequel le site vit entre le paiement et la
  // livraison du domaine par le registrar (ex: quickpagefrance.maquickpage.fr).
  // Conservé après la bascule : c'est lui qui porte la redirection permanente
  // vers l'adresse définitive, pour les liens déjà partagés par le coiffeur.
  if (!cols.includes('temp_hostname')) db.exec("ALTER TABLE salons ADD COLUMN temp_hostname TEXT");
  // Verrou d'envoi de l'email « votre site est en ligne » : le watchdog peut
  // repasser plusieurs fois sur un même salon, le client ne doit le recevoir
  // qu'une fois.
  if (!cols.includes('online_email_sent_at')) db.exec("ALTER TABLE salons ADD COLUMN online_email_sent_at TEXT");
  // Lien vers la facture Stripe (page hébergée ou PDF), mis dans l'email de
  // confirmation pour que le client l'obtienne sans avoir à la demander.
  if (!cols.includes('invoice_url')) db.exec("ALTER TABLE salons ADD COLUMN invoice_url TEXT");

  // === Reprise automatique du provisioning (watchdog) ===
  // provisioning_attempts  : nombre de relances déjà tentées (plafonné, cf.
  //                          provisioning-watchdog.js) pour ne pas boucler
  //                          indéfiniment sur un salon réellement cassé.
  // delay_notified_at      : ISO datetime de l'envoi de l'email "retard" au
  //                          client. Persisté en DB (et pas seulement en
  //                          mémoire du job) sinon chaque relance du worker
  //                          renverrait le même email au client.
  if (!cols.includes('provisioning_attempts')) db.exec("ALTER TABLE salons ADD COLUMN provisioning_attempts INTEGER DEFAULT 0");
  if (!cols.includes('delay_notified_at')) db.exec("ALTER TABLE salons ADD COLUMN delay_notified_at TEXT");
  // Alerte admin envoyée à 12 h, avant le mot au client à 24 h.
  if (!cols.includes('admin_delay_notified_at')) db.exec("ALTER TABLE salons ADD COLUMN admin_delay_notified_at TEXT");

  // === Acceptation des CGV (preuve horodatée — exigence légale FR/RGPD) ===
  // cgv_accepted_at : ISO datetime UTC de la coche utilisateur
  // cgv_version     : version textuelle du contrat accepté (ex: '1.0')
  // cgv_accepted_ip : IP du client au moment de l'acceptation (preuve forensique)
  if (!cols.includes('cgv_accepted_at')) db.exec("ALTER TABLE salons ADD COLUMN cgv_accepted_at TEXT");
  if (!cols.includes('cgv_version')) db.exec("ALTER TABLE salons ADD COLUMN cgv_version TEXT");
  if (!cols.includes('cgv_accepted_ip')) db.exec("ALTER TABLE salons ADD COLUMN cgv_accepted_ip TEXT");

  // === Suspension automatique pour défaut de paiement / annulation ===
  // suspended_at  : ISO datetime UTC où on a basculé en mode suspendu
  // suspended_reason : 'payment_failed' | 'cancelled' | 'manual' | null
  if (!cols.includes('suspended_at')) db.exec("ALTER TABLE salons ADD COLUMN suspended_at TEXT");
  if (!cols.includes('suspended_reason')) db.exec("ALTER TABLE salons ADD COLUMN suspended_reason TEXT");

  // === Template du site salon (design kit templates/) ===
  // 'classic' (défaut = site historique public/site) | 'contrast' | 'drama'.
  // Choisi via l'éditeur admin (/admin/{slug}) ; lu par ssr.js au rendu.
  if (!cols.includes('template')) db.exec("ALTER TABLE salons ADD COLUMN template TEXT DEFAULT 'classic'");

  // === Récupération d'accès admin (magic link via /recover) ===
  // Le coiffeur entre son email sur maquickpage.fr/recover, on génère un token
  // single-use valable 10 min, et on lui envoie un email avec le lien.
  if (!cols.includes('recovery_token')) db.exec("ALTER TABLE salons ADD COLUMN recovery_token TEXT");
  if (!cols.includes('recovery_token_expires_at')) db.exec("ALTER TABLE salons ADD COLUMN recovery_token_expires_at TEXT");
  // Index pour lookup O(log n) du token au moment du clic
  db.exec("CREATE INDEX IF NOT EXISTS idx_salons_recovery_token ON salons(recovery_token) WHERE recovery_token IS NOT NULL");

  // === Landing page lookup (via /api/landing/check) ===
  // Stocke chaque tentative de lookup d'un salon (= leads chauds qui ont
  // collé leur URL Google Maps + email sur la home).
  db.exec(`
    CREATE TABLE IF NOT EXISTS landing_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      google_maps_url TEXT,
      salon_slug TEXT,
      found INTEGER DEFAULT 0,
      ip TEXT,
      user_agent TEXT,
      email_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_landing_leads_email ON landing_leads(email);
    CREATE INDEX IF NOT EXISTS idx_landing_leads_salon ON landing_leads(salon_slug);
  `);

  // === Salons demandés mais pas encore scrappés (waitlist) ===
  // Quand un coiffeur arrive sur la landing mais qu'on ne trouve pas son salon
  // dans la DB, on enregistre sa demande pour scraper Google Maps et lui créer
  // un site démo dans les 48h.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_demos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      google_maps_url TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_demos_status ON pending_demos(status);
    CREATE INDEX IF NOT EXISTS idx_pending_demos_email ON pending_demos(email);
  `);

  // === Domain suggestions (pré-générées par GPT, sans extension TLD) ===
  // Format JSON : [{"name":"salonjean","rank":1}, ...] (10 entries)
  if (!cols.includes('domain_suggestions_json')) db.exec("ALTER TABLE salons ADD COLUMN domain_suggestions_json TEXT");
  if (!cols.includes('domain_suggestions_at')) db.exec("ALTER TABLE salons ADD COLUMN domain_suggestions_at TEXT");

  // Lien Cloudflare for SaaS : custom_hostname id retourné par CF API
  if (!cols.includes('cloudflare_hostname_id')) db.exec("ALTER TABLE salons ADD COLUMN cloudflare_hostname_id TEXT");

  // Idempotency : table des Stripe events deja traites (evite double-deploiement
  // si Stripe retry le webhook).
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(type);
  `);

  // === Suivi funnel maquettes (tracking visites + comportement) ===
  // Marquage "envoyé en cold-mail" (date du batch Smartlead). Permet de savoir
  // côté DB quels salons sont déjà partis, sans ouvrir Smartlead.
  if (!cols.includes('cold_mail_sent_at')) db.exec("ALTER TABLE salons ADD COLUMN cold_mail_sent_at TEXT");
  // Campagne Smartlead d'origine (W3 | W6 | W6-2-GrandEst | W7 | relance…).
  // C'est CETTE colonne qui fait foi pour « déjà contacté » : cold_mail_sent_at
  // reste NULL pour les campagnes dont on n'a pas la date exacte (seul l'export
  // W7 en fournit une), donc filtrer sur la date raterait W3/W6/W6-2.
  if (!cols.includes('cold_mail_campaign')) db.exec("ALTER TABLE salons ADD COLUMN cold_mail_campaign TEXT");
  // Audit de l'adresse email (2026-07-30). NULL = adresse retenue pour le cold-mail.
  // Sinon motif d'écartement : sans_email, nature_invalide, sans_serveur_mail,
  // dns_incertain, plateforme_ou_agence, domaine_sans_lien, doublon,
  // siege_de_chaine, plafond_domaine. Aucune adresse n'est effacée : seul ce
  // motif est posé, donc l'écartement reste réversible.
  if (!cols.includes('email_audit')) db.exec("ALTER TABLE salons ADD COLUMN email_audit TEXT");
  if (!cols.includes('email_audit_at')) db.exec("ALTER TABLE salons ADD COLUMN email_audit_at TEXT");
  // Événements de visite : 1 ligne par event (preview_ouvert, editeur_ouvert,
  // editeur_modifie, pricing_ouvert, etape_prix/domaine/email, paiement_initie,
  // scroll_max…). Table ISOLÉE, aucun lien FK dur (slug en texte). Purge 90j
  // possible via DELETE WHERE ts < date. Écriture best-effort (jamais bloquante).
  db.exec(`
    CREATE TABLE IF NOT EXISTS preview_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      event TEXT NOT NULL,
      slug TEXT,
      token TEXT,
      src TEXT,
      meta TEXT,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_preview_events_slug ON preview_events(slug);
    CREATE INDEX IF NOT EXISTS idx_preview_events_event ON preview_events(event);
    CREATE INDEX IF NOT EXISTS idx_preview_events_ts ON preview_events(ts);

    -- IP internes (toi/QA) exclues de l'entonnoir prospect du Suivi maquettes.
    -- Ajoutées en 1 clic depuis /admin/stats.html (« exclure mon trafic »).
    CREATE TABLE IF NOT EXISTS suivi_excluded_ips (
      ip TEXT PRIMARY KEY,
      added_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // === Prospection téléphonique (onglet ☎️ Prospection) ===
  // calling_prospects : 1 ligne = 1 salon dans le pipeline d'appels (UNIQUE slug).
  //   status : a_appeler | rappeler | interesse | demo_envoyee | gagne | perdu | ne_pas_rappeler
  //   telephone : numéro résolu (DB scrap ou Google Places), éditable à la main.
  //   phone_source : 'db' | 'google' | 'manuel' (traçabilité).
  //   next_call_at : date/heure de rappel programmé (fait remonter la fiche dans la file).
  //   do_not_call : 1 = opposition définitive (Bloctel/démarchage FR) → masqué de la file.
  // call_logs : historique — 1 ligne par appel passé (jamais supprimée).
  db.exec(`
    CREATE TABLE IF NOT EXISTS calling_prospects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'a_appeler',
      telephone TEXT,
      phone_source TEXT,
      priority INTEGER DEFAULT 0,
      next_call_at TEXT,
      attempts INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_called_at TEXT,
      notes TEXT,
      do_not_call INTEGER DEFAULT 0,
      added_from TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (slug) REFERENCES salons(slug) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_calling_status ON calling_prospects(status);
    CREATE INDEX IF NOT EXISTS idx_calling_next ON calling_prospects(next_call_at) WHERE next_call_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      outcome TEXT NOT NULL,
      note TEXT,
      next_call_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_call_logs_slug ON call_logs(slug);
    CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at DESC);
  `);

  // 3. Index sur edit_token : seulement maintenant que la colonne existe
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_edit_token ON salons(edit_token) WHERE edit_token IS NOT NULL");
  // Index sur live_hostname : lookup rapide par domaine custom
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_live_hostname ON salons(live_hostname) WHERE live_hostname IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_salons_subscription_status ON salons(subscription_status) WHERE subscription_status IS NOT NULL");

  // 4. Backfill : nom_clean doit TOUJOURS etre rempli (initialement = nom).
  //    Cela rend la colonne "Nom final" editable de facon homogene cote admin.
  db.exec("UPDATE salons SET nom_clean = nom WHERE nom_clean IS NULL OR nom_clean = ''");

  // === Photo picker (2026-06-13) : photos Google scrapées + scoring IA ===
  // google_id était jusqu'ici uniquement dans data_json → colonne dédiée pour
  // joindre salons ↔ salon_photos (index photos servies depuis /data/salon-photos).
  if (!cols.includes('google_id')) db.exec("ALTER TABLE salons ADD COLUMN google_id TEXT");
  db.exec("UPDATE salons SET google_id = json_extract(data_json, '$.google_id') WHERE (google_id IS NULL OR google_id = '') AND data_json IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_salons_google_id ON salons(google_id) WHERE google_id IS NOT NULL");

  db.exec(`
    -- Index des photos scrapées (1 ligne = 1 photo, renditions _lg/_th sur le volume).
    -- Rempli depuis /data/salon-photos/photos-index.json (import au boot ou via API).
    CREATE TABLE IF NOT EXISTS salon_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT NOT NULL,
      dir TEXT NOT NULL,                -- nom du dossier (= google_id avec ':' -> '_')
      photo_id TEXT NOT NULL,
      kind TEXT,                        -- 'place' | 'ugc' | 'legacy'
      position INTEGER,
      w INTEGER, h INTEGER,
      lowdef INTEGER DEFAULT 0,         -- 1 si côté long < 1000px (à éviter en héro)
      lg_kb INTEGER, th_kb INTEGER,
      phash TEXT,                       -- dHash sharp, calculé à la demande (dédup visuelle)
      nom TEXT, ville TEXT, csv_source TEXT,
      UNIQUE(google_id, photo_id)
    );
    CREATE INDEX IF NOT EXISTS idx_salon_photos_gid ON salon_photos(google_id);

    -- 1 scoring = 1 run gpt-4o vision sur les photos d'un salon
    CREATE TABLE IF NOT EXISTS picker_scorings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT NOT NULL,
      slug TEXT,                        -- slug du salon en DB au moment du scoring (si matché)
      selected_photo_id TEXT,           -- NULL si "aucune ne convient"
      overall_score REAL,
      reasoning TEXT,
      per_photo_scores TEXT,            -- JSON [{photo_id, score, main_strength, main_weakness}]
      criteria_version_id INTEGER,
      rag_examples_used INTEGER DEFAULT 0,
      model_used TEXT,
      tokens_input INTEGER, tokens_output INTEGER,
      cost_eur REAL, latency_ms INTEGER,
      applied_hero_at TEXT,             -- date d'application comme héro (si fait)
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_picker_scorings_gid ON picker_scorings(google_id);
    CREATE INDEX IF NOT EXISTS idx_picker_scorings_created ON picker_scorings(created_at DESC);

    -- Feedback humain (👍/👎/✏️ + commentaire) → enrichit le RAG few-shot
    CREATE TABLE IF NOT EXISTS picker_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scoring_id INTEGER NOT NULL,
      google_id TEXT NOT NULL,
      photo_id TEXT,
      rating TEXT NOT NULL,             -- 'good' | 'bad' | 'edit'
      comment TEXT,
      corrected_photo_id TEXT,
      embedding_json TEXT,
      embedding_dims INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (scoring_id) REFERENCES picker_scorings(id) ON DELETE CASCADE
    );

    -- Critères versionnés (une seule version active)
    CREATE TABLE IF NOT EXISTS picker_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      rubric_json TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Descriptions visuelles + embeddings (cache, 1 fois par photo)
    CREATE TABLE IF NOT EXISTS picker_photo_desc (
      photo_db_id INTEGER PRIMARY KEY,  -- = salon_photos.id
      description TEXT NOT NULL,
      tags_json TEXT,
      embedding_json TEXT,
      embedding_dims INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (photo_db_id) REFERENCES salon_photos(id) ON DELETE CASCADE
    );
  `);

  // Seed des critères par défaut (mêmes 6 critères que salon-hero-picker local)
  const critCount = db.prepare('SELECT COUNT(*) AS c FROM picker_criteria').get();
  if (critCount.c === 0) {
    const defaults = [
      { name: 'sujet_intérieur_salon', weight: 30, description: "La photo montre l'intérieur, la vitrine, la déco ou l'ambiance du salon. PAS un selfie/portrait, PAS un avant/après coiffure, PAS un mannequin de tête isolé." },
      { name: 'format_paysage', weight: 25, description: "La composition fonctionne en paysage 16:9 pour un fond hero. Capable d'être cropée largement sans perdre le sujet. Pas un portrait étroit, pas un sujet centré bord-à-bord." },
      { name: 'pas_de_visage_reconnaissable', weight: 15, description: "Pas de visage reconnaissable de client ou employé en gros plan (problème RGPD + neutralité). Dos, silhouette, mannequin OK." },
      { name: 'lumière_correcte', weight: 15, description: "Lumière équilibrée. Pas trop sombre ni surexposée. Pas de zones brûlées ou noires marquées." },
      { name: 'qualité_technique', weight: 10, description: "Image nette, pas floue, pas pixelisée. Pas de filtre Instagram extrême ni de texte/watermark gênant." },
      { name: 'ambiance_marque', weight: 5, description: "Vibe pro et chaleureuse, cohérente avec une marque de salon. Évite les photos trop personnelles ou tristes." }
    ];
    db.prepare('INSERT INTO picker_criteria (label, rubric_json, is_active) VALUES (?, ?, 1)')
      .run('v1 initial — 6 critères défaut', JSON.stringify(defaults));
  }
}

// Nœuds du séquenceur cold-email self-hosted (1 nœud = 1 projet Apps Script = 1 boîte Gmail).
// L'URL /exec + le token API sont saisis dans l'onglet « Nœuds » de /admin/sequencer.html.
db.exec(`
  CREATE TABLE IF NOT EXISTS sequencer_unsubscribes (
    email TEXT PRIMARY KEY,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sequencer_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox TEXT NOT NULL UNIQUE,
    label TEXT,
    exec_url TEXT NOT NULL,
    api_token TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_health_json TEXT,
    last_health_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );

  -- Registre portail des leads dispatchés vers les nœuds. Le nœud reste la source
  -- de vérité de l'ENVOI ; cette table répond à trois besoins que le nœud ne peut
  -- pas couvrir, parce qu'il ne voit que sa propre boîte :
  --   1. dédoublonnage ENTRE nœuds (un salon ne doit jamais recevoir deux séquences
  --      depuis deux expéditeurs différents, c'est un déclencheur anti-spam) ;
  --   2. exclusion des prochains exports (sinon on réimporte les mêmes à chaque fois) ;
  --   3. piste d'audit : qui a été confié à quelle boîte, et quand.
  -- L'email est la clé : c'est la seule identité que voient les serveurs de réception.
  CREATE TABLE IF NOT EXISTS sequencer_leads (
    email TEXT PRIMARY KEY,
    salon_slug TEXT,
    node_id INTEGER,
    mailbox TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sequencer_leads_slug ON sequencer_leads(salon_slug);
  CREATE INDEX IF NOT EXISTS idx_sequencer_leads_node ON sequencer_leads(node_id);
`);

initSchema();

if (process.argv[2] === 'init') {
  console.log('DB schema initialized at', DB_PATH);
  process.exit(0);
}

export default db;

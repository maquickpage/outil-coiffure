# Troubleshooting opérationnel — MaQuickPage

Guide rapide pour les incidents les plus probables pendant la campagne.

## Accès rapide

| Serveur | SSH | Coolify dashboard |
|---|---|---|
| Helsinki (landing, admin agence, Stripe webhook) | `ssh root@app.3high.fr` | http://app.3high.fr:8000 |
| Falkenstein (sites coiffeur LIVE + Caddy) | `ssh root@138.201.152.222` | http://138.201.152.222:8000 |

Tokens API et secrets : voir `~/.claude/projects/.../memory/access_overview.md`.

---

## 🟥 INCIDENT 1 — Le paiement passe mais l'email ne part pas

**Symptômes** : le coiffeur paie sur Stripe, voit la waiting-screen, mais ne reçoit jamais l'email "site en ligne".

**Diagnostic** (dans l'ordre) :

```bash
# 1. Le webhook Stripe a-t-il bien été reçu ?
ssh root@app.3high.fr "docker logs $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) 2>&1 | grep -i 'webhook\|stripe' | tail -30"

# 2. Le provisioning a-t-il démarré ?
ssh root@app.3high.fr "docker logs $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) 2>&1 | grep '\[provisioning\]' | tail -30"

# 3. Resend a-t-il accepté l'envoi ?
ssh root@app.3high.fr "docker logs $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) 2>&1 | grep 'email-sender' | tail -10"

# 4. Dashboard Resend : https://resend.com/emails (vérifier le statut delivered/bounced/spam)
```

**Causes courantes** :
- Webhook Stripe signature invalide → vérifier `STRIPE_WEBHOOK_SECRET` matche le dashboard Stripe
- Provisioning bloqué sur OVH (achat domaine) → relancer via `scripts/resume-provisioning.mjs`
- Resend bounce → check le dashboard Resend, peut-être quota dépassé ou domaine mal vérifié

**Action de secours** :
```bash
# Renvoyer manuellement l'email "site en ligne"
ssh root@app.3high.fr "docker exec $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) node -e \"
import('./src/email-sender.js').then(async (m) => {
  import('./src/routes/admin-recover.js').then(async (a) => {
    const slug = 'SLUG_ICI';
    const setupToken = a.generateRecoveryToken(slug, 24*60);
    // ... lookup row + sendSignupSuccessEmail
  });
});
\""
```

---

## 🟥 INCIDENT 2 — Le coiffeur ne peut plus accéder à son site

**Symptômes** : le coiffeur clique le lien dans son email → 401 ou page d'erreur.

**Diagnostic** :

```bash
# 1. Le hostname custom répond-il ?
curl -sI https://son-salon.fr/admin/son-slug

# 2. Le slug existe-t-il en DB Falkenstein ?
ssh root@138.201.152.222 "docker exec $(docker ps --format '{{.Names}}' | grep e10dhrfu | head -1) node -e \"
const r = require('better-sqlite3')('/data/salons.db').prepare('SELECT slug, owner_email, subscription_status, live_hostname FROM salons WHERE slug=?').get('SLUG');
console.log(JSON.stringify(r, null, 2));
\""

# 3. Le cookie session est-il valide ?
# → le coiffeur doit demander un magic link via le form 401
```

**Causes courantes** :
- Lien email expiré (>24h après réception) → le coiffeur va sur `/admin/son-slug` → form magic link
- Lien déjà utilisé (single-use) → idem, demander un nouveau magic link
- Cookie cassé / SESSION_SECRET changé → idem
- Subscription suspended (`subscription_status` != live/active/trialing) → vérifier Stripe + suspended_reason

**Action de secours** :
```bash
# Générer manuellement un magic link
ssh root@138.201.152.222 "docker exec $(docker ps --format '{{.Names}}' | grep e10dhrfu | head -1) node -e \"
import('./src/routes/admin-recover.js').then(({generateRecoveryToken}) => {
  const token = generateRecoveryToken('SLUG_ICI', 60);  // 60 min de validité
  console.log('https://son-salon.fr/admin/SLUG_ICI?token=' + token);
});
\""
```

---

## 🟥 INCIDENT 3 — Le DNS du salon ne propage pas (site coiffeur 404)

**Symptômes** : le coiffeur a payé, OVH a acheté le domaine, mais `https://son-salon.fr` ne répond pas.

**Diagnostic** :

```bash
# 1. Le DNS résout-il ?
nslookup son-salon.fr 8.8.8.8
# → doit retourner 138.201.152.222 (Falkenstein)

# 2. Caddy connaît-il ce hostname ?
ssh root@138.201.152.222 "docker logs caddy 2>&1 | grep son-salon.fr | tail -20"

# 3. Le salon a-t-il subscription_status = 'live' ?
ssh root@138.201.152.222 "docker exec $(docker ps --format '{{.Names}}' | grep e10dhrfu | head -1) node -e \"
console.log(require('better-sqlite3')('/data/salons.db').prepare('SELECT subscription_status FROM salons WHERE live_hostname=?').get('son-salon.fr'));
\""
```

**Causes courantes** :
- DNS pas propagé (TTL en cours) → attendre 1-6h
- Caddy a un cache stale → reload via `ssh root@138.201.152.222 /opt/caddy/start-caddy.sh`
- Le hostname n'est pas dans la table salons (provisioning incomplet) → relancer

**Action de secours** :
```bash
# Forcer Caddy à re-provisionner le cert
ssh root@138.201.152.222 "docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

---

## 🟥 INCIDENT 4 — Site coiffeur LIVE down (502 Bad Gateway)

**Symptômes** : Caddy répond mais en 502 → l'app backend ne répond pas.

**Diagnostic** :

```bash
# 1. Le container app Falkenstein tourne-t-il ?
ssh root@138.201.152.222 "docker ps --filter 'name=e10dhrfu'"

# 2. Health check
ssh root@138.201.152.222 "curl -sI http://localhost:3000/health"  # via container internal name
ssh root@138.201.152.222 "curl -sI https://customers.maquickpage.fr/health"

# 3. Caddy pointe-t-il sur le bon container ?
ssh root@138.201.152.222 "cat /opt/caddy/Caddyfile | grep reverse_proxy"
```

**Action de secours** :
```bash
# Re-générer le Caddyfile avec le bon container actuel
ssh root@138.201.152.222 "/opt/caddy/start-caddy.sh"
```

Si le container Falkenstein est crashé :
```bash
# Restart via Coolify API. Le token n'est PAS dans ce dépôt : il est dans le
# gestionnaire de mots de passe de l'équipe (entrée « Coolify Falkenstein »).
# Exporter la variable avant de lancer la commande.
export COOLIFY_FALKENSTEIN_TOKEN='<coller le token>'
curl -sX POST "http://138.201.152.222:8000/api/v1/applications/e10dhrfu7kn5rrjywb9nm1bu/restart" \
  -H "Authorization: Bearer $COOLIFY_FALKENSTEIN_TOKEN"
```

> ⚠️ **Ne jamais écrire un token en clair dans ce dépôt : il est PUBLIC.**
> Un token Coolify porte l'habilitation `root`, il donne donc l'administration
> complète de l'instance, y compris la lecture des variables d'environnement
> (clés Stripe, accès base). Le token précédent, publié ici du 18 mai au 3 août
> 2026, a été révoqué et remplacé le 2026-08-03.

---

## 🟥 INCIDENT 5 — Stripe a payé mais le site n'est pas créé

**Symptômes** : le coiffeur voit `success` sur Stripe checkout, mais le site `son-salon.fr` n'existe pas, et il n'a pas reçu d'email.

**Diagnostic** :

```bash
# 1. Le webhook est-il arrivé sur Helsinki ?
ssh root@app.3high.fr "docker logs $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) 2>&1 | grep -E 'stripe|webhook' | tail -30"

# 2. Si non, vérifier Stripe dashboard → Webhooks → tentatives de delivery
# https://dashboard.stripe.com/webhooks

# 3. Status du salon en DB Helsinki
ssh root@app.3high.fr "docker exec $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) node -e \"
console.log(require('better-sqlite3')('/data/salons.db').prepare('SELECT slug, subscription_status, status, stripe_subscription_id, live_hostname, suspended_reason FROM salons WHERE owner_email=?').get('EMAIL'));
\""
```

**Action de secours** : relancer le provisioning manuellement
```bash
ssh root@app.3high.fr "cd /app && SLUG=salon-xxx HOSTNAME=salon-xxx.fr node scripts/resume-provisioning.mjs"
```

---

## 🟥 INCIDENT 6 — Restauration backup DB

**Symptômes** : la DB salons.db a été corrompue ou perdue.

**Backups disponibles** :
- Helsinki local : `/opt/backups/helsinki/salons-YYYY-MM-DD_HHMM.db.gz` (30 derniers jours)
- Falkenstein local : `/opt/backups/falkenstein/salons-YYYY-MM-DD_HHMM.db.gz` (30 derniers jours)
- Cross : `/backups/helsinki/` sur Falkenstein, `/backups/falkenstein/` sur Helsinki

**Procédure de restauration** :

```bash
# 1. Stopper l'app
curl -sX POST "http://app.3high.fr:8000/api/v1/applications/w00kgwgkwk8kw44kg0wsg8cs/stop" -H "Authorization: Bearer ..."

# 2. Décompresser un backup vers le volume
ssh root@app.3high.fr "
  zcat /opt/backups/helsinki/salons-2026-XX-XX_XXXX.db.gz > /var/lib/docker/volumes/outil-coiffure-data/_data/salons.db
  # Supprimer les fichiers WAL résiduels pour démarrer propre
  rm -f /var/lib/docker/volumes/outil-coiffure-data/_data/salons.db-wal
  rm -f /var/lib/docker/volumes/outil-coiffure-data/_data/salons.db-shm
"

# 3. Restart
curl -sX POST "http://app.3high.fr:8000/api/v1/applications/w00kgwgkwk8kw44kg0wsg8cs/start" -H "Authorization: Bearer ..."

# 4. Vérifier
ssh root@app.3high.fr "docker exec $(docker ps --format '{{.Names}}' | grep w00kgwgkwk8kw44 | head -1) node -e \"console.log(require('better-sqlite3')('/data/salons.db').prepare('SELECT COUNT(*) c FROM salons').get())\""
```

---

## 🟥 INCIDENT 7 — Webhook Stripe rate-limit ou retry storm

**Symptômes** : Stripe dashboard montre des centaines de webhooks en retry.

**Diagnostic** :

```bash
# Endpoint répond-il en moins de 15s (Stripe timeout) ?
curl -sX POST -m 30 https://maquickpage.fr/webhook/stripe \
  -H 'Content-Type: application/json' -H 'Stripe-Signature: fake' \
  -d '{}' -w '\nHTTP=%{http_code}\nTIME=%{time_total}\n'
```

**Causes** :
- Endpoint trop lent (> 15s) → Stripe retry
- Endpoint répond 5xx → Stripe retry
- Cloudflare interfère ? (devrait pas mais à check)

**Action** : si retry storm en cours, désactiver le webhook 1 min sur Stripe dashboard pour casser la cascade, fix, puis ré-activer + manual replay si besoin.

---

## 📋 Liens utiles

- Stripe LIVE dashboard : https://dashboard.stripe.com
- Resend dashboard : https://resend.com/emails
- OVH manager : https://www.ovh.com/manager
- Cloudflare dashboard : https://dash.cloudflare.com → maquickpage.fr
- Hetzner Cloud Console : https://console.hetzner.cloud (project: outil-coiffure-clients)
- Coolify Helsinki : http://app.3high.fr:8000
- Coolify Falkenstein : http://138.201.152.222:8000

## 🆘 Si rien ne marche

1. **Stop la campagne mailing** d'abord (pour ne pas générer plus de paiements pendant l'incident)
2. **Vérifier la status page Cloudflare/Hetzner/Stripe** (incidents généraux)
3. **Rollback le dernier deploy** via Coolify API si récent
4. **Restaurer le backup** de la veille (cf. INCIDENT 6)

---

*Dernière mise à jour : 2026-05-18 — pendant la mise en place de la campagne.*

/**
 * Email-sender léger : utilise Resend HTTP API directement (pas de SDK).
 *
 * - No-op gracieux si RESEND_API_KEY n'est pas défini (log warning, pas d'erreur)
 * - Templates fixes : signup_success, signup_cancelled, provisioning_error
 * - Sender FROM doit être un domaine vérifié dans Resend (ex: hello@maquickpage.fr)
 *
 * Pour activer :
 *   1. https://resend.com/api-keys → créer une clé restricted "Sending access"
 *   2. https://resend.com/domains → ajouter maquickpage.fr + DKIM via API Cloudflare
 *   3. Set env vars sur Coolify :
 *        RESEND_API_KEY=re_xxx
 *        RESEND_FROM_EMAIL=hello@maquickpage.fr
 *        RESEND_REPLY_TO=johann.metagora@gmail.com
 */

const RESEND_API = 'https://api.resend.com/emails';

export function isEnabled() {
  return !!process.env.RESEND_API_KEY;
}

function getFrom() {
  return process.env.RESEND_FROM_EMAIL || 'noreply@maquickpage.fr';
}
function getReplyTo() {
  return process.env.RESEND_REPLY_TO || null;
}

export async function sendRaw({ to, subject, html, text }) {
  if (!isEnabled()) {
    console.log(`[email-sender] RESEND_API_KEY missing — skip email to ${to} subject="${subject}"`);
    return { ok: false, reason: 'no_api_key' };
  }
  if (!to || !subject || (!html && !text)) {
    return { ok: false, reason: 'missing_fields' };
  }

  const body = {
    from: getFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || undefined,
    text: text || undefined,
  };
  const replyTo = getReplyTo();
  if (replyTo) body.reply_to = replyTo;

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[email-sender] Resend error:', data);
      return { ok: false, reason: 'api_error', details: data };
    }
    console.log(`[email-sender] Sent to ${to} id=${data.id} subject="${subject}"`);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[email-sender] Network error:', err.message);
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

// === Templates ============================================================

function escapeHtml(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Layout commun aux emails transactionnels (wrapper <table> = standard email,
 * cf. Stripe/Linear : évite que Gmail/Outlook détachent le footer du contenu).
 * `body` = le HTML du contenu, inséré tel quel dans la carte blanche.
 */
function renderEmailLayout({ subject, body }) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f5;">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%; background: #ffffff; border-radius: 12px; padding: 30px;">
        <tr><td>
${body}
          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">
          <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0 0 24px;">
            Une question ? Répondez à cet email ou écrivez à <a href="mailto:contact@maquickpage.fr" style="color: #6b7280;">contact@maquickpage.fr</a>.<br>
            MaQuickPage — KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610 · 61 rue de Lyon, 75012 Paris<br>
            <a href="https://maquickpage.fr/legal/cgv.html" style="color: #9ca3af;">CGV</a> ·
            <a href="https://maquickpage.fr/legal/mentions-legales.html" style="color: #9ca3af;">Mentions légales</a> ·
            <a href="https://maquickpage.fr/legal/privacy.html" style="color: #9ca3af;">Confidentialité</a>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" style="padding-top: 12px;">
              <a href="https://maquickpage.fr/" style="text-decoration: none; border: 0;">
                <img src="https://maquickpage.fr/_assets/email/logo-signature.png" alt="MaQuickPage" width="100" height="100"
                     style="display: block; width: 100px; height: 100px; border: 0; outline: none; text-decoration: none;">
              </a>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;
}

const PLAN_LABELS = {
  TWO_YEAR: '9,90 € TTC/mois (engagement 24 mois)',
  ONE_YEAR: '17,90 € TTC/mois (engagement 12 mois)',
  FLEX: '29 € TTC/mois (sans engagement)',
};

/**
 * Email #1 du parcours : envoyé dès que le site est en ligne sur son adresse
 * provisoire, quelques secondes après le paiement.
 *
 * C'est le message le plus important du parcours. Il ne dit plus « votre
 * commande est en cours de traitement » mais « c'est fait » : le coiffeur vient
 * de payer, il obtient immédiatement un site qu'il peut voir, montrer et
 * modifier. La réservation de son nom de domaine devient une formalité qui se
 * règle en arrière-plan, et non plus une attente qu'il subit.
 *
 * Il sert aussi de confirmation de commande — référence, récapitulatif de ce
 * qui est acheté, moyen de paiement, contact — repris mot pour mot des lignes
 * affichées au checkout : ce que le client a lu avant de payer doit être ce
 * qu'il relit dans sa boîte mail.
 */
export async function sendSiteOnlineEmail({ to, salonName, tempHostname, finalHostname, plan, sessionId, slug, setupToken }) {
  const planLabel = PLAN_LABELS[plan] || plan || '';
  const ref = sessionId ? sessionId.slice(-8).toUpperCase() : null;
  const siteUrl = `https://${tempHostname}`;
  const adminUrl = setupToken
    ? `https://${tempHostname}/admin/${encodeURIComponent(slug)}?token=${encodeURIComponent(setupToken)}`
    : `https://${tempHostname}/admin/${encodeURIComponent(slug)}`;
  const subject = 'Votre site est en ligne';

  const body = `
          <h1 style="font-size: 24px; margin: 0 0 16px; color: #1a1a1a;">Merci ${escapeHtml(salonName)}, votre site est en ligne.</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            Il est accessible dès maintenant, et vous pouvez déjà le modifier.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border: 1px solid #e5e7eb; border-radius: 12px; margin: 24px 0;">
            <tr><td style="padding: 20px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Votre site</p>
              <p style="margin: 0 0 16px; font-size: 18px; font-weight: 600;">
                <a href="${siteUrl}" style="color: #0a0a0a; text-decoration: none;">${escapeHtml(tempHostname)}</a>
              </p>
              <a href="${siteUrl}" style="display: inline-block; background: #0a0a0a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Voir mon site →</a>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FAF6EC; border-left: 4px solid #F4A300; border-radius: 0 8px 8px 0; margin: 0 0 24px;">
            <tr><td style="padding: 18px 20px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #002FA7; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Votre adresse définitive arrive</p>
              <p style="margin: 0; font-size: 14px; color: #4b5563; line-height: 1.6;">
                <strong style="color:#1a1a1a;">${escapeHtml(finalHostname)}</strong> est en cours de réservation auprès
                des organismes officiels des noms de domaine. Leur délai va de quelques minutes à 24 heures.
                Dès que l'adresse est disponible, votre site bascule dessus automatiquement et vous recevez un email.
                <strong style="color:#1a1a1a;">Vous n'avez rien à faire</strong>, et votre site reste accessible sans interruption.
              </p>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border: 1px solid #e5e7eb; border-radius: 12px; margin: 0 0 24px;">
            <tr><td style="padding: 20px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Modifier votre site</p>
              <p style="margin: 0 0 12px; font-size: 14px; color: #4b5563; line-height: 1.5;">
                Textes, photos, prestations, horaires : tout se modifie depuis votre espace.
                Vos modifications sont conservées lors du passage à votre adresse définitive.
                Le lien ci-dessous est valable <strong>24 heures</strong> ; ensuite vous restez connecté(e) 30 jours.
              </p>
              <a href="${adminUrl}" style="display: inline-block; background: #0a0a0a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Accéder à mon espace →</a>
            </td></tr>
          </table>

          <p style="font-size: 14px; color: #6b7280; line-height: 1.9; margin: 0 0 16px;">
            <strong style="color:#1a1a1a;">Récapitulatif</strong><br>
            Adresse définitive : ${escapeHtml(finalHostname)} — offerte la 1<sup>re</sup> année<br>
            Adresse actuelle : ${escapeHtml(tempHostname)}<br>
            Formule : ${escapeHtml(planLabel)}<br>
            Paiement : carte bancaire via Stripe${ref ? `<br>Référence : ${escapeHtml(ref)}` : ''}
          </p>

          <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 16px;">
            Votre abonnement comprend votre site personnalisé, 3 designs au choix, le nom de domaine
            offert la première année, l'hébergement en Allemagne et la maintenance, les mises à jour,
            l'installation et la mise en ligne.
          </p>

          <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0;">
            Besoin d'une facture ou d'une modification ? Répondez directement à cet email, nous vous répondons personnellement.
          </p>`;

  const text = `Merci ${salonName}, votre site est en ligne.

Il est accessible dès maintenant, et vous pouvez déjà le modifier.

VOTRE SITE
${siteUrl}

VOTRE ADRESSE DÉFINITIVE ARRIVE
${finalHostname} est en cours de réservation auprès des organismes officiels des noms de
domaine. Leur délai va de quelques minutes à 24 heures. Dès que l'adresse est disponible,
votre site bascule dessus automatiquement et vous recevez un email. Vous n'avez rien à
faire, et votre site reste accessible sans interruption.

MODIFIER VOTRE SITE (lien valable 24 h)
${adminUrl}
Vos modifications sont conservées lors du passage à votre adresse définitive.

RÉCAPITULATIF
Adresse définitive : ${finalHostname} (offerte la 1re année)
Adresse actuelle : ${tempHostname}
Formule : ${planLabel}
Paiement : carte bancaire via Stripe${ref ? `\nRéférence : ${ref}` : ''}

Votre abonnement comprend votre site personnalisé, 3 designs au choix, le nom de domaine
offert la première année, l'hébergement en Allemagne et la maintenance, les mises à jour,
l'installation et la mise en ligne.

Besoin d'une facture ou d'une modification ? Répondez directement à cet email.

MaQuickPage — KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610
CGV : https://maquickpage.fr/legal/cgv.html`;

  return sendRaw({ to, subject, html: renderEmailLayout({ subject, body }), text });
}

/**
 * Email #2 (conditionnel) : la mise en ligne prend du retard.
 *
 * Envoyé automatiquement au bout de OVH_DELAY_NOTICE_MS (8 min par défaut).
 * À ce stade le client a payé, on lui a annoncé quelques minutes, et il a très
 * probablement fermé l'onglet : sans ce message il se retrouve avec un débit et
 * aucun site.
 *
 * Volontairement court et générique : il sert pour n'importe quel retard, sans
 * détailler la cause technique — le client a juste besoin de savoir que sa
 * commande est bien passée et qu'il n'a rien à faire.
 */
export async function sendProvisioningDelayEmail({ to, salonName, hostname, tempHostname }) {
  const subject = 'Votre adresse définitive prend du retard';
  const siteUrl = tempHostname ? `https://${tempHostname}` : null;

  const body = `
          <h1 style="font-size: 24px; margin: 0 0 16px; color: #1a1a1a;">Bonjour ${escapeHtml(salonName)},</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            ${siteUrl
              ? `Votre site fonctionne normalement sur <a href="${siteUrl}" style="color:#1a1a1a;"><strong>${escapeHtml(tempHostname)}</strong></a>, et il n'y a rien à faire de votre côté.`
              : `Votre site fonctionne normalement, et il n'y a rien à faire de votre côté.`}
          </p>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            En revanche, la réservation de <strong style="color:#1a1a1a;">${escapeHtml(hostname)}</strong> dépasse
            le délai annoncé. Le retard vient d'OVHcloud, l'organisme qui attribue les noms de domaine,
            pas de votre commande : elle est bien enregistrée chez eux et nous les relançons.
          </p>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            Dès que l'adresse nous est livrée, la bascule se fait toute seule et vous recevez un email.
          </p>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            Si vous préférez ne pas attendre, répondez à cet email : nous pouvons vous proposer une autre
            adresse disponible immédiatement, ou vous rembourser.
          </p>
          <p style="font-size: 15px; color: #6b7280; line-height: 1.6; margin: 0;">
            Désolé pour ce contretemps.
          </p>`;

  const text = `Bonjour ${salonName},

Votre site fonctionne normalement${tempHostname ? ` sur ${tempHostname}` : ''}, et il n'y a rien à faire de votre côté.

En revanche, la réservation de ${hostname} dépasse le délai annoncé. Le retard vient
d'OVHcloud, l'organisme qui attribue les noms de domaine, pas de votre commande : elle est
bien enregistrée chez eux et nous les relançons.

Dès que l'adresse nous est livrée, la bascule se fait toute seule et vous recevez un email.

Si vous préférez ne pas attendre, répondez à cet email : nous pouvons vous proposer une
autre adresse disponible immédiatement, ou vous rembourser.

Désolé pour ce contretemps.

MaQuickPage — contact@maquickpage.fr`;

  return sendRaw({ to, subject, html: renderEmailLayout({ subject, body }), text });
}

/**
 * Email #2 : le domaine définitif est livré et le site a basculé dessus.
 *
 * Le site n'est plus une nouveauté — il tourne depuis le paiement sur son
 * adresse provisoire. Ce qui change ici, c'est l'adresse : le message doit donc
 * dire quoi en faire (la communiquer, la mettre sur les cartes de visite) et
 * rassurer sur les liens déjà partagés, qui redirigent automatiquement.
 *
 * Modèle Magic Link Only :
 *   - setupToken : token unique single-use valide 24 h, posé en DB par le
 *     worker juste avant l'envoi de l'email (cf. provisioning-worker.js
 *     → generateRecoveryToken(slug, 24*60)).
 *   - À l'ouverture du lien : token consommé → cookie 30 j posé → URL clean.
 *   - Si le coiffeur perd cet email ou attend > 24 h, il va sur l'URL admin
 *     de son site et reçoit un nouveau magic link par email (auto-service).
 *   - Aucune valeur permanente dans l'URL.
 */
export async function sendDomainActiveEmail({ to, salonName, liveHostname, tempHostname, plan, slug, setupToken }) {
  const planLabels = { TWO_YEAR: '9,90 € TTC/mois (engagement 24 mois)', ONE_YEAR: '17,90 € TTC/mois (engagement 12 mois)', FLEX: '29 € TTC/mois (sans engagement)' };
  const planLabel = planLabels[plan] || plan;
  const liveUrl = `https://${liveHostname}`;
  // Admin URL = lien magique single-use valide 24h.
  const adminUrl = setupToken
    ? `https://${liveHostname}/admin/${encodeURIComponent(slug)}?token=${encodeURIComponent(setupToken)}`
    : `https://${liveHostname}/admin/${encodeURIComponent(slug)}`;
  const recoverPageUrl = `https://${liveHostname}/admin/${encodeURIComponent(slug)}`;

  const subject = `C'est fait : votre site est sur ${liveHostname}`;

  // Template HTML avec wrapper <table> = standard email (Stripe, Linear, etc.).
  // Évite que Gmail/Outlook "détachent" la signature logo du contenu.
  const html = `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f5;">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%; background: #ffffff; border-radius: 12px; padding: 30px;">
        <tr><td>

          <h1 style="font-size: 24px; margin: 0 0 16px; color: #1a1a1a;">Bonjour ${escapeHtml(salonName)},</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            Votre adresse définitive est active : votre site est désormais sur
            <strong>${escapeHtml(liveHostname)}</strong>.
          </p>
          <p style="font-size: 16px; line-height: 1.6; color: #4b5563; margin: 0 0 16px;">
            C'est cette adresse qu'il faut donner à vos clientes, mettre sur vos cartes de visite,
            votre vitrine et vos réseaux sociaux.${tempHostname ? `
            L'adresse provisoire que vous aviez reçue continue de fonctionner et renvoie vers celle-ci :
            personne ne se perdra, y compris ceux à qui vous l'auriez déjà transmise.` : ''}
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border: 1px solid #e5e7eb; border-radius: 12px; margin: 24px 0;">
            <tr><td style="padding: 20px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">L'adresse de votre site</p>
              <p style="margin: 0 0 16px; font-size: 18px; font-weight: 600;">
                <a href="${liveUrl}" style="color: #0a0a0a; text-decoration: none;">${escapeHtml(liveHostname)}</a>
              </p>
              <a href="${liveUrl}" style="display: inline-block; background: #0a0a0a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Voir mon site →</a>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FAF6EC; border-left: 4px solid #F4A300; border-radius: 0 8px 8px 0; margin: 24px 0;">
            <tr><td style="padding: 18px 20px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #002FA7; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Modifier votre site</p>
              <p style="margin: 0 0 12px; font-size: 14px; color: #4b5563; line-height: 1.5;">
                Cliquez ci-dessous pour accéder à votre espace de modification (textes, photos, prestations, horaires…). Le lien est <strong>valable 24 heures</strong> et fonctionne sur tous vos appareils. Une fois cliqué, vous restez connecté(e) <strong>30 jours</strong>.
              </p>
              <a href="${adminUrl}" style="display: inline-block; background: #0a0a0a; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Accéder à mon espace →</a>
            </td></tr>
          </table>

          <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 16px;">
            <strong>Récapitulatif :</strong><br>
            Plan : ${escapeHtml(planLabel)}<br>
            Domaine : <a href="${liveUrl}" style="color: #0a0a0a;">${escapeHtml(liveHostname)}</a> (offert pour 1 an)<br>
            Hébergement : Hetzner (Allemagne, UE)
          </p>

          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">

          <p style="font-size: 13px; color: #6b7280; line-height: 1.5; margin: 0 0 16px;">
            <strong>Comment vous connecter plus tard ?</strong><br>
            Allez sur <a href="${recoverPageUrl}" style="color: #0a0a0a;">${escapeHtml(liveHostname)}/admin</a>, entrez votre adresse e-mail, et vous recevrez un nouveau lien de connexion sécurisé (valable 10 minutes). Aucun mot de passe à retenir.
          </p>

          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">

          <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0 0 24px;">
            Une question ? Répondez à cet email ou écrivez à <a href="mailto:contact@maquickpage.fr" style="color: #6b7280;">contact@maquickpage.fr</a>.<br>
            MaQuickPage — KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610 · 61 rue de Lyon, 75012 Paris<br>
            <a href="https://maquickpage.fr/legal/cgv.html" style="color: #9ca3af;">CGV</a> ·
            <a href="https://maquickpage.fr/legal/mentions-legales.html" style="color: #9ca3af;">Mentions légales</a> ·
            <a href="https://maquickpage.fr/legal/privacy.html" style="color: #9ca3af;">Confidentialité</a>
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" style="padding-top: 12px;">
              <a href="https://maquickpage.fr/" style="text-decoration: none; border: 0;">
                <img src="https://maquickpage.fr/_assets/email/logo-signature.png"
                     alt="MaQuickPage"
                     width="100"
                     height="100"
                     style="display: block; width: 100px; height: 100px; border: 0; outline: none; text-decoration: none;">
              </a>
            </td></tr>
          </table>

        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;

  const text = `Bonjour ${salonName},

Votre adresse définitive est active : votre site est désormais sur ${liveHostname}.

C'est cette adresse qu'il faut donner à vos clientes, mettre sur vos cartes de visite,
votre vitrine et vos réseaux sociaux.${tempHostname ? `
L'adresse provisoire que vous aviez reçue continue de fonctionner et renvoie vers celle-ci :
personne ne se perdra, y compris ceux à qui vous l'auriez déjà transmise.` : ''}

ADRESSE DE VOTRE SITE
${liveUrl}

ACCÉDER À VOTRE ESPACE (lien valable 24 h)
${adminUrl}

RÉCAPITULATIF
Plan : ${planLabel}
Domaine : ${liveHostname} (offert pour 1 an)
Hébergement : Hetzner (Allemagne, UE)

COMMENT VOUS CONNECTER PLUS TARD ?
Allez sur ${recoverPageUrl}, entrez votre adresse e-mail, vous recevrez un nouveau lien de connexion sécurisé. Aucun mot de passe à retenir.

Une question ? Répondez à cet email ou écrivez à contact@maquickpage.fr

MaQuickPage — KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610
CGV : https://maquickpage.fr/legal/cgv.html
Mentions légales : https://maquickpage.fr/legal/mentions-legales.html
Confidentialité : https://maquickpage.fr/legal/privacy.html`;

  return sendRaw({ to, subject, html, text });
}

/**
 * Email magic-link de récupération d'accès admin (déclenché par /recover).
 * Le coiffeur entre son email sur maquickpage.fr/recover, on lui envoie un
 * lien valable 10 minutes vers son admin avec son token.
 */
export async function sendRecoveryEmail({ to, salonName, recoverConfirmUrl }) {
  const subject = `Votre lien d'accès à MaQuickPage`;
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 30px; color: #1a1a1a; background: #ffffff;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">Bonjour${salonName ? ' ' + escapeHtml(salonName) : ''},</h1>
  <p style="font-size: 15px; line-height: 1.5; color: #4b5563;">
    Vous avez demandé à récupérer l'accès à l'espace de modification de votre site MaQuickPage.
    Cliquez sur le bouton ci-dessous pour vous y connecter automatiquement&nbsp;:
  </p>
  <p style="margin: 28px 0; text-align: center;">
    <a href="${recoverConfirmUrl}" style="display: inline-block; background: #0a0a0a; color: white; padding: 14px 32px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 15px;">Accéder à mon espace →</a>
  </p>
  <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
    Ce lien est valable <strong>10 minutes</strong> et fonctionne sur tous vos appareils pendant cette fenêtre.
    Si vous n'avez pas demandé cet email, vous pouvez l'ignorer en toute sécurité.
  </p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">
  <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0;">
    MaQuickPage — KAISER CO · contact@maquickpage.fr<br>
    <a href="https://maquickpage.fr/legal/privacy.html" style="color: #9ca3af;">Politique de confidentialité</a>
  </p>
</body></html>`;
  const text = `Bonjour${salonName ? ' ' + salonName : ''},

Vous avez demandé à récupérer l'accès à l'espace de modification de votre site MaQuickPage.
Cliquez sur le lien ci-dessous pour vous y connecter automatiquement :

${recoverConfirmUrl}

Ce lien est valable 10 minutes et fonctionne sur tous vos appareils pendant cette fenêtre.
Si vous n'avez pas demandé cet email, ignorez-le.

MaQuickPage — contact@maquickpage.fr`;
  return sendRaw({ to, subject, html, text });
}

/**
 * Email envoyé si le provisioning échoue (admin alerte).
 */
export async function sendProvisioningErrorEmail({ adminEmail, salonName, slug, hostname, errorMessage, subject: customSubject }) {
  // `subject` surchargeable : le watchdog s'en sert pour signaler un simple
  // retard, qui ne doit pas arriver avec l'objet d'un provisioning échoué.
  const subject = customSubject || `[ALERTE] Provisioning échoué pour ${salonName} (${hostname})`;
  const adminUrl = `https://outil.maquickpage.fr/admin/salons/${slug}`;
  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 30px;">
  <h1 style="color: #b91c1c;">⚠ Provisioning échoué</h1>
  <p><strong>Salon :</strong> ${escapeHtml(salonName)} (slug ${escapeHtml(slug)})</p>
  <p><strong>Domaine cible :</strong> ${escapeHtml(hostname)}</p>
  <p><strong>Erreur :</strong></p>
  <pre style="background: #fef2f2; padding: 12px; border-radius: 6px; color: #991b1b; font-size: 13px;">${escapeHtml(errorMessage)}</pre>
  <p>Action : connectez-vous à l'admin et utilisez "Retry provisioning".</p>
  <p><a href="${adminUrl}">${adminUrl}</a></p>
</body></html>`;
  return sendRaw({ to: adminEmail, subject, html });
}

export default {
  isEnabled,
  sendSiteOnlineEmail,
  sendProvisioningDelayEmail,
  sendDomainActiveEmail,
  sendProvisioningErrorEmail,
  sendRecoveryEmail,
};

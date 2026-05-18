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
 * Email envoyé après que le site est passé LIVE (provisioning OK).
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
export async function sendSignupSuccessEmail({ to, salonName, liveHostname, plan, slug, setupToken }) {
  const planLabels = { TWO_YEAR: '9,90 € TTC/mois (engagement 24 mois)', ONE_YEAR: '17,90 € TTC/mois (engagement 12 mois)', FLEX: '29 € TTC/mois (sans engagement)' };
  const planLabel = planLabels[plan] || plan;
  const liveUrl = `https://${liveHostname}`;
  // Admin URL = lien magique single-use valide 24h.
  const adminUrl = setupToken
    ? `https://${liveHostname}/admin/${encodeURIComponent(slug)}?token=${encodeURIComponent(setupToken)}`
    : `https://${liveHostname}/admin/${encodeURIComponent(slug)}`;
  const recoverPageUrl = `https://${liveHostname}/admin/${encodeURIComponent(slug)}`;

  const subject = `${salonName} — votre site est en ligne sur ${liveHostname}`;

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 30px; color: #1a1a1a; background: #ffffff;">
  <h1 style="font-size: 24px; margin: 0 0 16px;">Bonjour ${escapeHtml(salonName)},</h1>
  <p style="font-size: 16px; line-height: 1.5; color: #4b5563;">
    Votre site est maintenant <strong>en ligne</strong>. Bienvenue sur MaQuickPage.
  </p>

  <div style="background: #fafafa; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin: 24px 0;">
    <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">L'adresse de votre site</p>
    <p style="margin: 0 0 16px; font-size: 18px; font-weight: 600;">
      <a href="${liveUrl}" style="color: #0a0a0a; text-decoration: none;">${escapeHtml(liveHostname)}</a>
    </p>
    <a href="${liveUrl}" style="display: inline-block; background: #0a0a0a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Voir mon site →</a>
  </div>

  <div style="background: #FAF6EC; border-left: 4px solid #F4A300; border-radius: 0 8px 8px 0; padding: 18px 20px; margin: 24px 0;">
    <p style="margin: 0 0 8px; font-size: 13px; color: #002FA7; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Modifier votre site</p>
    <p style="margin: 0 0 12px; font-size: 14px; color: #4b5563; line-height: 1.5;">
      Cliquez ci-dessous pour accéder à votre espace (textes, photos, prestations, horaires…). Le lien est <strong>valable 24 heures</strong>. Passé ce délai, demandez-en un nouveau directement sur votre espace.
    </p>
    <a href="${adminUrl}" style="display: inline-block; background: #0a0a0a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 14px;">Accéder à mon espace →</a>
  </div>

  <p style="font-size: 14px; color: #6b7280; line-height: 1.6;">
    <strong>Récapitulatif :</strong><br>
    Plan : ${escapeHtml(planLabel)}<br>
    Domaine : <a href="${liveUrl}" style="color: #0a0a0a;">${escapeHtml(liveHostname)}</a> (offert pour 1 an)<br>
    Hébergement : Hetzner (Allemagne, UE)
  </p>

  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">

  <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
    <strong>Comment vous connecter plus tard ?</strong><br>
    Allez sur <a href="${recoverPageUrl}" style="color: #0a0a0a;">${escapeHtml(liveHostname)}/admin</a>, entrez votre adresse e-mail, et vous recevrez un nouveau lien de connexion sécurisé (valable 10 minutes). Aucun mot de passe à retenir.
  </p>

  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 28px 0;">

  <p style="font-size: 12px; color: #9ca3af; line-height: 1.5; margin: 0;">
    Une question ? Répondez à cet email ou écrivez à <a href="mailto:contact@maquickpage.fr" style="color: #6b7280;">contact@maquickpage.fr</a>.<br>
    MaQuickPage — KAISER CO · KAISER JOHANN, Entrepreneur individuel · SIREN 791 069 610 · 61 rue de Lyon, 75012 Paris<br>
    <a href="https://maquickpage.fr/legal/cgv.html" style="color: #9ca3af;">CGV</a> ·
    <a href="https://maquickpage.fr/legal/mentions-legales.html" style="color: #9ca3af;">Mentions légales</a> ·
    <a href="https://maquickpage.fr/legal/privacy.html" style="color: #9ca3af;">Confidentialité</a>
  </p>

  <div style="text-align: center; margin: 36px 0 8px;">
    <a href="https://maquickpage.fr/" style="text-decoration: none; border: 0;">
      <img src="https://maquickpage.fr/_assets/email/logo-signature.png"
           alt="MaQuickPage"
           width="120"
           style="display: inline-block; max-width: 120px; height: auto; border: 0; outline: none; text-decoration: none;">
    </a>
  </div>
</body></html>`;

  const text = `Bonjour ${salonName},

Votre site est maintenant en ligne. Bienvenue sur MaQuickPage.

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
    Ce lien est valable <strong>10 minutes</strong> et ne peut être utilisé qu'une seule fois.
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

Ce lien est valable 10 minutes et ne peut être utilisé qu'une seule fois.
Si vous n'avez pas demandé cet email, ignorez-le.

MaQuickPage — contact@maquickpage.fr`;
  return sendRaw({ to, subject, html, text });
}

/**
 * Email envoyé si le provisioning échoue (admin alerte).
 */
export async function sendProvisioningErrorEmail({ adminEmail, salonName, slug, hostname, errorMessage }) {
  const subject = `[ALERTE] Provisioning échoué pour ${salonName} (${hostname})`;
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
  sendSignupSuccessEmail,
  sendProvisioningErrorEmail,
  sendRecoveryEmail,
};

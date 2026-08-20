// email.js — Envoi d'alertes email via l'API REST de Resend (pas de SDK,
// juste fetch). No-op silencieux si RESEND_API_KEY n'est pas configurée,
// pour que l'absence de clé en dev/local ne casse jamais le scan.
const { logEmail, logSourceEvent } = require("./db");

const RESEND_API_URL = "https://api.resend.com/emails";

function formatEuros(n) {
  return `${Number(n).toFixed(2).replace(".", ",")} €`;
}

/**
 * Envoie une alerte pour un produit suivi.
 * @param {"erreur"|"seuil"} motif  "erreur" = anomalie détectée par
 *   l'algorithme ; "seuil" = le prix est passé sous la limite fixée par le
 *   membre. Les deux méritent des mots différents : la première est une
 *   opportunité rare et incertaine (le marchand peut annuler), la seconde est
 *   simplement le prix attendu, enfin atteint.
 */
async function sendPriceErrorAlert(toEmail, { name, price, refPrice, pct, url, motif = "erreur", targetPrice }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true };

  const from = process.env.ALERT_FROM_EMAIL || "RadarPrix <onboarding@resend.dev>";
  const estErreur = motif === "erreur";

  const titre = estErreur ? "🚨 Erreur de prix détectée" : "🎯 Votre prix cible est atteint";
  const sujet = estErreur
    ? `🚨 ${name} à ${formatEuros(price)}${pct ? ` (-${pct}%)` : ""}`
    : `🎯 ${name} est passé à ${formatEuros(price)}`;

  const corps = estErreur
    ? `<p><strong>${name}</strong> est affiché à <strong>${formatEuros(price)}</strong>${
        refPrice ? `, soit <strong>${pct}% de moins</strong> que le prix habituel (${formatEuros(refPrice)})` : ""
      }.</p>
       <p style="color:#b45309; font-size:13px;">Une erreur de prix dure rarement longtemps, et le marchand peut annuler la commande. À vérifier tout de suite.</p>`
    : `<p><strong>${name}</strong> est descendu à <strong>${formatEuros(price)}</strong>,
       sous le seuil de ${formatEuros(targetPrice)} que vous aviez fixé.</p>`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: ${estErreur ? "#dc2626" : "#ea580c"};">${titre}</h2>
      ${corps}
      ${url ? `<p><a href="${url}" style="color:#2563eb;">Voir l'offre →</a></p>` : ""}
      <p style="color:#888; font-size: 12px;">Vous recevez cet email car vous suivez ce produit sur RadarPrix.</p>
    </div>
  `;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: toEmail, subject: sujet, html }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(`[email] envoi Resend échoué (${res.status}) pour ${toEmail}: ${detail}`);
    // Consigné plutôt que seulement affiché dans les journaux : une alerte
    // qui ne part pas ne se voyait nulle part, ni pour le membre ni pour toi.
    logEmail({ to: toEmail, subject: sujet, motif, ok: false, error: `${res.status} ${detail}` });
    logSourceEvent("resend", false, `${res.status} ${detail}`);
    return { skipped: false, ok: false };
  }
  logEmail({ to: toEmail, subject: sujet, motif, ok: true });
  logSourceEvent("resend", true, sujet);
  return { skipped: false, ok: true };
}

/**
 * Prévient l'administrateur qu'un service est tombé. Sans ça, une panne de
 * SerpApi ou du cron ne se découvre qu'en constatant un catalogue vide,
 * parfois plusieurs jours plus tard.
 */
async function sendAdminAlert(sujet, corps) {
  const apiKey = process.env.RESEND_API_KEY;
  const destinataire = process.env.ADMIN_EMAIL;
  if (!apiKey || !destinataire) return { skipped: true };

  const from = process.env.ALERT_FROM_EMAIL || "RadarPrix <onboarding@resend.dev>";
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;line-height:1.6">
    <h2 style="color:#FF345D;margin:0 0 12px">${sujet}</h2>
    <p style="color:#333;white-space:pre-wrap">${corps}</p>
    <p style="color:#888;font-size:12px;margin-top:20px">
      Message automatique de RadarPrix — tableau de bord admin, section « État des sources ».
    </p>
  </div>`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: destinataire, subject: `[RadarPrix] ${sujet}`, html }),
    });
    const ok = res.ok;
    logEmail({ to: destinataire, subject: sujet, motif: "admin", ok, error: ok ? null : await res.text() });
    return { skipped: false, ok };
  } catch (e) {
    logEmail({ to: destinataire, subject: sujet, motif: "admin", ok: false, error: e.message });
    return { skipped: false, ok: false };
  }
}

module.exports = { sendPriceErrorAlert, sendAdminAlert };

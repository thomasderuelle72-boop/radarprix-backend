// email.js — Envoi d'alertes email via l'API REST de Resend (pas de SDK,
// juste fetch). No-op silencieux si RESEND_API_KEY n'est pas configurée,
// pour que l'absence de clé en dev/local ne casse jamais le scan.
const RESEND_API_URL = "https://api.resend.com/emails";

function formatEuros(n) {
  return `${Number(n).toFixed(2).replace(".", ",")} €`;
}

/** Envoie une alerte "erreur de prix détectée" pour un produit suivi. */
async function sendPriceErrorAlert(toEmail, { name, price, refPrice, pct, url }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true };

  const from = process.env.ALERT_FROM_EMAIL || "RadarPrix <onboarding@resend.dev>";
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #dc2626;">🚨 Erreur de prix détectée</h2>
      <p><strong>${name}</strong> est repassé à <strong>${formatEuros(price)}</strong>,
      soit <strong>${pct}% de moins</strong> que le prix habituel (${formatEuros(refPrice)}).</p>
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
    body: JSON.stringify({
      from,
      to: toEmail,
      subject: `🚨 ${name} à ${formatEuros(price)} (-${pct}%)`,
      html,
    }),
  });

  if (!res.ok) {
    console.error(`[email] envoi Resend échoué (${res.status}) pour ${toEmail}: ${await res.text()}`);
    return { skipped: false, ok: false };
  }
  return { skipped: false, ok: true };
}

module.exports = { sendPriceErrorAlert };

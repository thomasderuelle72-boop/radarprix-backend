// email.js — Envoi d'alertes email via l'API REST de Resend (pas de SDK,
// juste fetch). No-op silencieux si RESEND_API_KEY n'est pas configurée,
// pour que l'absence de clé en dev/local ne casse jamais le scan.
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
    console.error(`[email] envoi Resend échoué (${res.status}) pour ${toEmail}: ${await res.text()}`);
    return { skipped: false, ok: false };
  }
  return { skipped: false, ok: true };
}

module.exports = { sendPriceErrorAlert };

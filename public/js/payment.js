// payment.js
document.addEventListener("DOMContentLoaded", () => {
  const payerBtn = document.getElementById("payerBtn");
  const msg = document.getElementById("paymentMsg");

  if (!payerBtn) return;

  payerBtn.addEventListener("click", async () => {
    try {
      payerBtn.disabled = true;
      payerBtn.innerHTML = "Redirection en cours...";

      // 💰 Exemple: Montant fixe (à adapter selon votre logique)
      const amount = 34.0;
      const email = document.querySelector("input[name='email']").value;
      const orderId = "ORDER-" + Date.now();

      if (!email) {
        msg.style.color = "red";
        msg.innerText = "Veuillez saisir votre email avant de payer.";
        payerBtn.disabled = false;
        payerBtn.innerHTML = '<i class="fas fa-credit-card mr-2"></i> Payer maintenant';
        return;
      }

      const res = await fetch("/api/payment/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, email, orderId })
      });

      const data = await res.json();

      if (data.ok && data.redirectUrl) {
        window.location.href = data.redirectUrl; // 🔁 Redirection vers GPG Gateway
      } else {
        msg.style.color = "red";
        msg.innerText = "Erreur: " + (data.message || "Impossible de démarrer le paiement.");
        payerBtn.disabled = false;
        payerBtn.innerHTML = '<i class="fas fa-credit-card mr-2"></i> Payer maintenant';
      }
    } catch (error) {
      console.error("Erreur paiement GPG:", error);
      msg.style.color = "red";
      msg.innerText = "Erreur de connexion au serveur.";
      payerBtn.disabled = false;
      payerBtn.innerHTML = '<i class="fas fa-credit-card mr-2"></i> Payer maintenant';
    }
  });
});


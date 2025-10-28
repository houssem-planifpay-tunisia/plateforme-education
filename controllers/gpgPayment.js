// controllers/gpgPayment.js
const axios = require('axios');
const QRCode = require('qrcode');
require('dotenv').config();
const { Order } = require('../models/order'); // si tu as un fichier séparé, sinon adapte le chemin
const { PendingUser } = require('../models/pendingUser'); // si applicable
const sendConfirmationEmail = require('../utils/sendConfirmationEmail'); // à adapter à ton app

// === 1️⃣ DÉMARRAGE DU PAIEMENT ===
exports.startPayment = async (req, res) => {
  try {
    const { amount, email, orderId } = req.body;

    const payload = {
      merchant_id: process.env.GPG_MERCHANT_ID,
      order_id: orderId,
      amount: amount,
      currency: 'TND',
      success_url: `${process.env.BASE_URL}/api/payment/success`,
      fail_url: `${process.env.BASE_URL}/api/payment/failure`,
      notify_url: `${process.env.BASE_URL}/api/payment/notify`,
      customer_email: email,
      description: 'Paiement BACE'
    };

    const headers = {
      Authorization: `Bearer ${process.env.GPG_API_KEY}`,
      'Content-Type': 'application/json'
    };

    const response = await axios.post(`${process.env.GPG_API_URL}/payment`, payload, { headers });

    if (response.data && response.data.payment_url) {
      res.json({ ok: true, redirectUrl: response.data.payment_url });
    } else {
      res.status(400).json({ ok: false, message: 'Erreur GPG: URL de paiement non reçue' });
    }
  } catch (err) {
    console.error('Erreur GPG startPayment:', err.response?.data || err.message);
    res.status(500).json({ ok: false, message: 'Erreur lors de l’initiation du paiement' });
  }
};

// === 2️⃣ CALLBACK DE NOTIFICATION ===
exports.handleNotification = async (req, res) => {
  try {
    const { order_id, status, transaction_id } = req.body;

    if (status === 'SUCCESS') {
      // Récupérer le subscriber correspondant
      const subscriber = await Subscriber.findById(order_id);
      if (!subscriber) return res.status(404).json({ ok:false, message:'Utilisateur non trouvé' });

      // Marquer comme payé
      subscriber.paid = true;
      await subscriber.save();

      // Générer QR code / identifiants
      const credentials = await generateCredentials(subscriber);

      // Envoyer email avec QR code et identifiants
      await sendSubscriptionCredentials(subscriber);

      console.log(`✅ Paiement confirmé pour ${subscriber.email} (transaction ${transaction_id})`);
      return res.status(200).send('OK');
    } else {
      console.warn(`⚠️ Paiement échoué ou en attente pour order ${order_id}`);
      return res.status(200).send('Payment not successful');
    }
  } catch (err) {
    console.error('Erreur handleNotification:', err.message);
    res.status(500).send('Error');
  }
};
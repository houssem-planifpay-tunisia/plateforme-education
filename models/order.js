/// models/order.js

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'TND' },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  paymentMethod: { type: String, default: 'GPG' },
  createdAt: { type: Date, default: Date.now },
  code4: { type: Number },
  qrCode: { type: String }
});

// Vérifie si le modèle existe déjà avant de le créer
module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);


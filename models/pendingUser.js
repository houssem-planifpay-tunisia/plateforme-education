// models/pendingUser.js
const mongoose = require('mongoose');

const pendingUserSchema = new mongoose.Schema({
  prenom: String,
  nom: String,
  email: String,
  phone: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.PendingUser || mongoose.model('PendingUser', pendingUserSchema);

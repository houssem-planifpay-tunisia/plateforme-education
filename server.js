// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');
const Brevo = require('@getbrevo/brevo');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');

const app = express();

// CORRECTION: Configuration CORS simplifiée
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Config
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads', 'payments');
const QR_DIR = path.join(__dirname, 'public', 'qrcodes');
const JWT_SECRET = process.env.JWT_SECRET || 'bace_super_secret_jwt_key_2025';

// Créer les dossiers nécessaires
[UPLOAD_DIR, QR_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connecté à MongoDB'))
.catch(err => console.error('Erreur MongoDB', err));


// Modèles (garder vos modèles existants)
const SubscriberSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName:  { type: String, required: true },
  email:     { type: String, required: true },
  phone:     { type: String, required: true },
  paid:      { type: Boolean, default: false },
  code4:     { type: String },
  qrCode:    { type: String },
  qrDataURL: { type: String },
  createdAt: { type: Date, default: Date.now }
});  
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);

const OrderSchema = new mongoose.Schema({
  profile: { type: String, required: true },
  prenom: String,
  nom: String,
  telephone: String,
  email: String,
  lycee: String,
  price: Number,
  paymentProofPath: String,
  paymentProofOriginalName: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', OrderSchema);

// --- Multer config (existant)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png','image/jpeg','image/jpg','application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// --- Middleware maintenance (existant)
function basicAuthOk(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return false;
  const creds = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = creds.split(':');
  return user === process.env.DEV_USER && pass === process.env.DEV_PASS;
}

app.use((req, res, next) => {
  const maintenance = process.env.MAINTENANCE === 'true';
  if (!maintenance) return next();

  const allow = [
    '/admin', '/backoffice', '/api', '/uploads',
    '/images', '/css', '/js', '/styles', '/favicon.ico', '/qrcodes', '/secure'
  ];
  if (allow.some(p => req.path.startsWith(p))) return next();

  if (req.query.dev === process.env.DEV_SECRET) return next();
  if (req.headers['x-dev-secret'] === process.env.DEV_SECRET) return next();

  if (basicAuthOk(req)) return next();

  res.set('Retry-After', '3600');
  return res.status(503).sendFile(path.join(__dirname, 'public', 'coming-soon.html'));
});



// --- Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use('/qrcodes', express.static(QR_DIR));
app.use('/uploads/payments', express.static(path.join(__dirname, 'uploads/payments')));


// Importation des contrôleurs GPG
const { startPayment, handleNotification } = require('./controllers/gpgPayment');

// ✅ Routes API
app.post('/api/payment/start', startPayment);
app.post('/api/payment/notify', handleNotification);
// === MIDDLEWARE D'AUTHENTIFICATION JWT ===
const authenticateToken = (req, res, next) => {
  let token = null;
  
  // Vérifier le header Authorization
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  
  // Vérifier le header personnalisé
  if (!token) {
    token = req.headers['x-auth-token'];
  }

  if (!token) {
    return res.status(401).json({ 
      ok: false, 
      message: 'Token d\'authentification manquant' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        ok: false, 
        message: 'Token invalide ou expiré' 
      });
    }
    req.user = user;
    next();
  });
};

// --- Fonctions helper (garder vos fonctions existantes)
async function generateCredentials(subscriber) {
  const code4 = Math.floor(1000 + Math.random() * 9000).toString();
  const qrData = `${subscriber.email}:${code4}`;
  
  const qrFilename = `qrcode-${subscriber._id}-${Date.now()}.png`;
  const qrFilePath = path.join(QR_DIR, qrFilename);
  
  try {
    await QRCode.toFile(qrFilePath, qrData, {
      width: 300,
      height: 300,
      margin: 2,
      color: {
        dark: '#1e40af',
        light: '#ffffff'
      }
    });

    const qrDataURL = await QRCode.toDataURL(qrData, {
      width: 300,
      height: 300,
      margin: 2,
      color: {
        dark: '#1e40af',
        light: '#ffffff'
      }
    });

    subscriber.code4 = code4;
    subscriber.qrCode = `/qrcodes/${qrFilename}`;
    subscriber.qrDataURL = qrDataURL;
    await subscriber.save();

    return {
      code4,
      qrPath: `/qrcodes/${qrFilename}`,
      qrDataURL
    };
    
  } catch (err) {
    console.error('Erreur génération QR code:', err);
    throw err;
  }
}

async function sendSubscriptionCredentials(subscriber) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('BREVO_API_KEY non configurée - skip envoi email');
    return;
  }

  let qrCodeBase64 = '';
  let qrCodeFilename = '';
  try {
    const qrCodePath = path.join(QR_DIR, path.basename(subscriber.qrCode));
    if (fs.existsSync(qrCodePath)) {
      const qrCodeBuffer = fs.readFileSync(qrCodePath);
      qrCodeBase64 = qrCodeBuffer.toString('base64');
      qrCodeFilename = `qrcode-bace-${subscriber.code4}.png`;
    }
  } catch (err) {
    console.error('Erreur lecture QR code:', err);
  }

  const qrDataURL = `data:image/png;base64,${qrCodeBase64}`;

  const payload = {
    sender: { 
      name: 'Bardo Academic Center for Education', 
      email: process.env.FROM_EMAIL 
    },
    to: [
      { 
        email: subscriber.email, 
        name: `${subscriber.firstName} ${subscriber.lastName}` 
      }
    ],
    subject: `🎓 Vos identifiants BACE - Code: ${subscriber.code4}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1e40af; margin-bottom: 10px;">Bienvenue chez BACE !</h1>
          <p style="color: #666; font-size: 16px;">Votre plateforme éducative d'excellence</p>
        </div>
        
        <p>Bonjour <strong>${subscriber.firstName} ${subscriber.lastName}</strong>,</p>
        
        <p>Votre inscription a été confirmée avec succès. Voici vos identifiants personnels :</p>
        
        <div style="background: linear-gradient(135deg, #1e40af, #3b82f6); border-radius: 10px; padding: 25px; text-align: center; margin: 25px 0; color: white;">
          <h3 style="margin: 0 0 15px 0; font-size: 18px;">Votre Code d'Accès Personnel</h3>
          <div style="font-size: 42px; font-weight: bold; letter-spacing: 8px; background: white; color: #1e40af; padding: 15px; border-radius: 8px; display: inline-block; min-width: 200px;">
            ${subscriber.code4}
          </div>
        </div>

        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f8fafc; border-radius: 10px;">
          <h3 style="color: #1e40af; margin-bottom: 20px;">Votre QR Code d'Accès</h3>
          ${qrCodeBase64 ? 
            `<img src="${qrDataURL}" alt="QR Code BACE" style="max-width: 250px; border: 3px solid #1e40af; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />` :
            `<p style="color: #666; font-style: italic;">QR Code généré - voir pièce jointe</p>`
          }
          <p style="color: #666; font-size: 14px; margin-top: 15px;">Scannez ce code pour vous connecter rapidement</p>
        </div>

        <div style="background: #fffbeb; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 25px 0;">
          <h4 style="color: #d97706; margin-top: 0; text-align: center;">📋 Comment utiliser vos identifiants</h4>
          <ul style="color: #92400e; line-height: 1.6;">
            <li><strong>Conservez précieusement</strong> votre code : <code style="background: #fef3c7; padding: 2px 6px; border-radius: 4px;">${subscriber.code4}</code></li>
            <li><strong>Utilisez le QR code</strong> pour une connexion rapide et sécurisée</li>
            <li>Ces identifiants vous seront demandés à chaque connexion à la plateforme</li>
            <li>Ne partagez jamais vos identifiants avec d'autres personnes</li>
          </ul>
        </div>

        <div style="text-align: center; margin: 30px 0; padding: 20px; background: #1e40af; border-radius: 10px; color: white;">
          <h4 style="margin-top: 0;">Besoin d'aide ?</h4>
          <p style="margin-bottom: 0;">
            <strong>Email : bace.dg@gmail.com<br>
            <strong>Téléphone :</strong> +216 97 898 050<br>
            <strong>Adresse :</strong> 20 Avenue du Bardo, Tunis
          </p>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
        
        <footer style="text-align: center; color: #64748b; font-size: 12px;">
          <p>Bardo Academic Centre for Education<br>
          Agréé par le Ministère de l'Éducation<br>
          © ${new Date().getFullYear()} BACE. Tous droits réservés.</p>
        </footer>
      </div>
    `,
    attachment: qrCodeBase64 ? [
      {
        name: qrCodeFilename,
        content: qrCodeBase64
      }
    ] : []
  };

  const headers = {
    'api-key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const url = 'https://api.brevo.com/v3/smtp/email';
  
  try {
    const response = await axios.post(url, payload, { headers });
    console.log('✅ Email d\'identifiants envoyé à:', subscriber.email);
    return response.data;
  } catch (err) {
    console.error('❌ Erreur envoi email identifiants:', err?.response?.data || err.message);
    throw err;
  }
}

async function sendBrevoConfirmation(order, filePath) {
  const apiKey = process.env.BREVO_API_KEY;
  if(!apiKey) return;

  const attachments = [];
  if (filePath && fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    attachments.push({
      name: order.paymentProofOriginalName || path.basename(filePath),
      content: buf.toString('base64')
    });
  }

  const payload = {
    sender: { name: 'Bardo Academic Center for Education', email: process.env.FROM_EMAIL },
    to: [
      { email: order.email, name: `${order.prenom || ''} ${order.nom || ''}` },
      { email: process.env.ADMIN_EMAIL, name: 'Admin' }
    ],
    subject: `Confirmation commande - Réf ${order._id}`,
    htmlContent: `
      <p>Bonjour ${order.prenom || ''} ${order.nom || ''},</p>
      <p>Merci pour votre commande. Bardo Academic Center for Education vous souhaite la Réussite de votre BAC.<br> Détails :</p>
      <ul>
        <li>Profil: ${order.profile}</li>
        <li>Prix: ${order.price} DT</li>
        <li>Réf commande: ${order._id}</li>
      </ul>
      <p>Nous vérifierons la preuve et mettrons à jour le statut. Nous expédions votre livre via la poste à l'adresse indiquée.</p>
    `,
    attachment: attachments
  };

  const headers = {
    'api-key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const url = 'https://api.brevo.com/v3/smtp/email';
  try {
    const r = await axios.post(url, payload, { headers });
    return r.data;
  } catch (err) {
    console.error('Brevo send error:', err?.response?.data || err.message);
    throw err;
  }
}

// --- Routes API

// Route d'inscription
// Route d'inscription (mise à jour pour paiement GPG)
app.post('/api/subscribe', async (req, res) => {
  try {
    let { prenom, nom, email, phone, confirmPhone } = req.body;

    // ✅ Vérifie la présence du champ confirmPhone
    if (!confirmPhone) {
      return res.status(400).json({
        ok: false,
        message: "Le champ de confirmation du téléphone est manquant."
      });
    }

    // ✅ Vérifie la correspondance des numéros
    if (phone !== confirmPhone) {
      return res.status(400).json({
        ok: false,
        message: "❌ Les deux numéros de téléphone ne correspondent pas."
      });
    }

    // ✅ Normalisation des champs
    prenom = prenom.trim();
    nom = nom.trim();
    email = email.trim().toLowerCase();
    phone = phone.replace(/[^0-9+]/g, '');
    if (/^\d{8}$/.test(phone)) phone = '+216' + phone;

    // ✅ Vérifie le format du numéro tunisien
    const phoneRegex = /^(?:\+216|00216)?[2459]\d{7}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        ok: false,
        message: "Numéro de téléphone invalide. Format attendu : 8 chiffres tunisiens valides."
      });
    }

    // ✅ Vérifie si déjà inscrit
    const existing = await Subscriber.findOne({ email });
    if (existing) {
      return res.status(400).json({
        ok: false,
        message: "Cet email est déjà enregistré. Vérifiez votre boîte mail ou contactez le support."
      });
    }

    // ✅ Crée un utilisateur en attente de paiement
    const pendingUser = await Subscriber.create({
      firstName: prenom,
      lastName: nom,
      email,
      phone,
      paid: false // payé seulement après confirmation
    });

    res.json({
      ok: true,
      message: "✅ Inscription enregistrée. Vous pouvez maintenant procéder au paiement.",
      subscriberId: pendingUser._id
    });

  } catch (err) {
    console.error("Erreur inscription:", err);
    res.status(500).json({ ok: false, message: "Erreur serveur lors de l’inscription." });
  }
});



// Route connexion QR - MODIFIÉE
app.post('/api/login-with-qr', async (req, res) => {
  try {
    const { email, code4, qrValue } = req.body;
    
    const normalizedEmail = email.trim().toLowerCase();
    
    const subscriber = await Subscriber.findOne({ 
      email: normalizedEmail, 
      code4 
    });
    
    if (!subscriber) {
      return res.status(400).json({ 
        ok: false,
        message: 'Identifiants invalides' 
      });
    }

    const expectedQR = `${subscriber.email}:${subscriber.code4}`;
    if (qrValue !== expectedQR) {
      return res.status(400).json({ 
        ok: false,
        message: 'QR Code invalide' 
      });
    }

    if (!subscriber.paid) {
      return res.status(403).json({
        ok: false,
        message: 'Votre compte n\'est pas encore activé. Veuillez finaliser votre paiement.'
      });
    }

    // Générer le token JWT
    const token = jwt.sign(
      { 
        id: subscriber._id,
        email: subscriber.email,
        firstName: subscriber.firstName,
        lastName: subscriber.lastName
      }, 
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ 
      ok: true,
      message: 'Connexion réussie!', 
      token: token,
      user: {
        id: subscriber._id,
        email: subscriber.email,
        firstName: subscriber.firstName,
        lastName: subscriber.lastName
      }
    });

  } catch (err) {
    console.error('Erreur connexion:', err);
    res.status(500).json({ 
      ok: false,
      message: 'Erreur lors de la connexion' 
    });
  }
});

// === NOUVELLES ROUTES SÉCURISÉES ===

// Route pour récupérer les documents
app.get('/api/documents', authenticateToken, async (req, res) => {
  try {
    const documents = [
      { 
        id: 1, 
        name: 'Cours Mathématiques - Algèbre', 
        type: 'pdf',
        size: '2.4 MB',
        date: '2024-01-15',
        downloadUrl: '/api/documents/1/download'
      },
      { 
        id: 2, 
        name: 'Exercices Physique - Mécanique', 
        type: 'pdf',
        size: '1.8 MB',
        date: '2024-01-10',
        downloadUrl: '/api/documents/2/download'
      }
    ];
    
    res.json({ 
      ok: true,
      documents 
    });
    
  } catch (err) {
    console.error('Erreur récupération documents:', err);
    res.status(500).json({ 
      ok: false,
      message: 'Erreur lors de la récupération des documents' 
    });
  }
});

// Route pour télécharger un document
app.get('/api/documents/:id/download', authenticateToken, (req, res) => {
  const documentId = req.params.id;
  res.json({
    ok: true,
    message: `Téléchargement du document ${documentId} autorisé`
  });
});

// Route pour vérifier l'authentification
app.get('/api/verify-auth', authenticateToken, (req, res) => {
  res.json({
    ok: true,
    user: req.user,
    message: 'Utilisateur authentifié'
  });
});

// Route de déconnexion
app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({
    ok: true,
    message: 'Déconnexion réussie'
  });
});

// Routes commandes existantes
app.post('/api/orders', upload.single('paymentProof'), async (req, res) => {
  try {
    const { profile, prenom, nom, telephone, email, lycee, price } = req.body;
    if(!profile) return res.status(400).json({ ok:false, message:'profile requis' });
    if(!prenom || !nom || !telephone || !email) return res.status(400).json({ ok:false, message:'champs obligatoires manquants' });
    if(!req.file) return res.status(400).json({ ok:false, message:'preuve de paiement requise' });

    const priceNum = parseInt(price, 10) || (profile === 'eleve' ? 34 : 70);

    const order = await Order.create({
      profile, prenom, nom, telephone, email, lycee,
      price: priceNum,
      paymentProofPath: req.file.path,
      paymentProofOriginalName: req.file.originalname
    });

    try {
      await sendBrevoConfirmation(order, req.file.path);
    } catch (err) {
      console.warn('Erreur envoi email (non bloquant):', err.message || err);
    }

    return res.json({ ok:true, orderId: order._id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, message:'erreur serveur' });
  }
});

// Routes admin existantes
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
function checkAdmin(req, res, next) {
  const t = req.headers['x-admin-token'];
  if(!t || t !== ADMIN_TOKEN) return res.status(401).json({ ok:false, message:'non autorisé' });
  next();
}

app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, orders });
  } catch (err) {
    console.error('Erreur récupération commandes:', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur' });
  }
});

app.get('/api/admin/order/:id/proof', authenticateAdmin, async (req, res) => {
  const o = await Order.findById(req.params.id);
  if(!o) return res.status(404).send('Not found');
  const full = path.resolve(o.paymentProofPath);
  if(!fs.existsSync(full)) return res.status(404).send('Fichier introuvable');
  res.sendFile(full);
});

// === CORRECTION: SERVIR LES PAGES SÉCURISÉES SANS WILDCARD ===

// Route spécifique pour documents.html
app.get('/secure/documents.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'secure', 'documents.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page non trouvée');
  }
});

// Route pour servir d'autres fichiers dans le dossier secure
app.get('/secure/:filename', (req, res) => {
  const filename = req.params.filename;
  // Sécurité: empêcher l'accès à des fichiers sensibles
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(403).send('Accès interdit');
  }
  
  const filePath = path.join(__dirname, 'public', 'secure', filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Fichier non trouvé');
  }
});

// Route catch-all pour le dossier secure - redirige vers documents.html
app.get('/secure', (req, res) => {
  res.redirect('/secure/documents.html');
});




// === SYSTÈME D'AUTHENTIFICATION ADMIN ===
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234567';

// Route de connexion admin
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ 
        ok: false, 
        message: 'Mot de passe administrateur incorrect' 
      });
    }

    // Générer un token admin sécurisé
    const adminToken = jwt.sign(
      { 
        role: 'admin',
        access: 'full',
        timestamp: Date.now()
      }, 
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ 
      ok: true, 
      message: 'Connexion admin réussie',
      token: adminToken
    });

  } catch (err) {
    console.error('Erreur connexion admin:', err);
    res.status(500).json({ 
      ok: false, 
      message: 'Erreur lors de la connexion' 
    });
  }
});

// Middleware admin avec JWT
function authenticateAdmin(req, res, next) {
  let token = null;
  
  // Vérifier le header Authorization
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  
  // Vérifier le header personnalisé
  if (!token) {
    token = req.headers['x-admin-token'];
  }

  if (!token) {
    return res.status(401).json({ 
      ok: false, 
      message: 'Token admin manquant' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        ok: false, 
        message: 'Token admin invalide ou expiré' 
      });
    }
    
    if (decoded.role !== 'admin') {
      return res.status(403).json({ 
        ok: false, 
        message: 'Accès non autorisé' 
      });
    }
    
    req.admin = decoded;
    next();
  });
}


// Routes admin supplémentaires
app.get('/api/admin/subscribers', authenticateAdmin, async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ createdAt: -1 }).lean();
    res.json({ ok: true, subscribers });
  } catch (err) {
    console.error('Erreur récupération subscribers:', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur' });
  }
});

// Route pour mettre à jour le statut d'une commande
app.put('/api/admin/order/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['pending', 'processed', 'shipped', 'delivered'];
    
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ ok: false, message: 'Statut invalide' });
    }
    
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({ ok: false, message: 'Commande non trouvée' });
    }
    
    res.json({ ok: true, order });
  } catch (err) {
    console.error('Erreur mise à jour statut:', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur' });
  }
});

// Route pour obtenir les détails d'une commande spécifique
app.get('/api/admin/order/:id', authenticateAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ ok: false, message: 'Commande non trouvée' });
    }
    res.json({ ok: true, order });
  } catch (err) {
    console.error('Erreur récupération commande:', err);
    res.status(500).json({ ok: false, message: 'Erreur serveur' });
  }
});

// Rediriger /admin vers la page de connexion
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route pour servir la page de connexion admin
app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});;

// Route pour le dashboard admin (alternative)
app.get('/admin/dashboard', authenticateAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/css/admin.css', (req, res) => {
  const cssPath = path.join(__dirname, 'public', 'css', 'admin.css');
  if (fs.existsSync(cssPath)) {
    res.sendFile(cssPath);
  } else {
    // Fallback CSS
    res.type('text/css');
    res.send(`
      .stat-card { background: linear-gradient(135deg, #3b82f6, #1e40af); }
      .stat-card.success { background: linear-gradient(135deg, #10b981, #059669); }
      .stat-card.warning { background: linear-gradient(135deg, #f59e0b, #d97706); }
      .stat-card.danger { background: linear-gradient(135deg, #ef4444, #dc2626); }
      .nav-item.active { background-color: #eff6ff; color: #1e40af; border-right: 3px solid #3b82f6; }
      .nav-item { padding: 12px 16px; display: block; color: #4b5563; border-radius: 4px; margin: 4px 8px; }
      .nav-item:hover { background-color: #f3f4f6; }
      .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
      .status-pending { background: #fef3c7; color: #92400e; }
      .status-processed { background: #dbeafe; color: #1e40af; }
      .status-shipped { background: #f0f9ff; color: #0369a1; }
      .status-delivered { background: #f0fdf4; color: #166534; }
      .table-row:hover { background-color: #f9fafb; }
      .hidden { display: none; }
    `);
  }
});

// --- Démarrage du serveur
app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log(`🔐 JWT Secret: ${JWT_SECRET ? 'Configuré' : 'Utilisation valeur par défaut'}`);
  console.log(`📁 Dossier secure accessible via: http://localhost:${PORT}/secure/documents.html`);
});

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const IntaSend = require('intasend-node');
const cors = require('cors');
const admin = require('firebase-admin');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ============================
// FIXED CORS CONFIGURATION
// ============================
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://backened-lt67.onrender.com',
  'https://my-campus-store-frontend.vercel.app',
  'https://marketmix.site',
  'https://localhost'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);

    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return callback(null, true);
    }

    const msg = `CORS blocked: ${origin}`;
    console.error(msg);
    return callback(new Error(msg), false);
  },
  credentials: true
}));

// ============================
// Middleware
// ============================
app.use(bodyParser.json());

// ============================
// Env Check
// ============================
if (!process.env.INTASEND_PUBLISHABLE_KEY ||
    !process.env.INTASEND_SECRET_KEY ||
    !process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Error: Missing required environment variables.');
  process.exit(1);
}

// ============================
// Firebase Admin Init
// ============================
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase Admin initialized');
} catch (e) {
  console.error('❌ Firebase Admin init failed:', e);
  process.exit(1);
}

const db = admin.firestore();

// ============================
// IntaSend Init
// ============================
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false
);

const BACKEND_HOST = process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com";

// ============================
// Constants
// ============================
const WITHDRAWAL_FEE_RATE = 0.055;

// ============================
// Routes
// ============================

// --- STK Push ---
app.post('/api/stk-push', async (req, res) => {
  try {
    const { amount, phoneNumber, fullName, email, orderId } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }

    const phoneRegex = /^(2547|2541)\d{8}$/;
    if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
    }
    if (!fullName?.trim() || !email?.includes('@')) {
      return res.status(400).json({ success: false, message: 'Invalid name or email.' });
    }

    const [firstName, ...rest] = fullName.trim().split(" ");
    const lastName = rest.join(" ") || "N/A";

    const response = await intasend.collection().mpesaStkPush({
      first_name: firstName,
      last_name: lastName,
      email,
      phone_number: phoneNumber,
      amount,
      host: BACKEND_HOST,
      api_ref: orderId
    });

    await db.collection('orders').doc(orderId).update({
      invoiceId: response.invoice.invoice_id,
      status: 'STK_PUSH_SENT',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, data: response });
  } catch (error) {
    console.error('STK Push Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- IntaSend Callback ---
app.post('/api/intasend-callback', async (req, res) => {
  const { api_ref, state, mpesa_reference } = req.body;
  if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");

  let status = 'pending';
  if (state === 'COMPLETE') status = 'paid';
  if (state === 'FAILED' || state === 'CANCELLED') status = 'failed';

  try {
    await db.collection('orders').doc(api_ref).set({
      paymentStatus: status,
      mpesaReference: mpesa_reference || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error(`Error updating order ${api_ref}:`, err);
  }
  res.send("OK");
});

// --- Transaction Status ---
app.get('/api/transaction/:invoiceId', async (req, res) => {
  try {
    const docs = await db.collection('orders')
      .where('invoiceId', '==', req.params.invoiceId)
      .get();
    if (docs.empty) return res.status(404).json({ success: false, message: 'Transaction not found.' });
    res.json({ success: true, data: docs.docs[0].data() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- Seller Withdrawal ---
app.post('/api/seller/withdraw', async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;

    if (!sellerId || !requestedAmount || isNaN(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid seller ID or amount.' });
    }

    const amount = parseFloat(requestedAmount);
    const phoneRegex = /^(2547|2541)\d{8}$/;
    if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    const netPayoutAmount = +(amount * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2);
    const feeAmount = +(amount * WITHDRAWAL_FEE_RATE).toFixed(2);

    const userRef = db.collection('users').doc(sellerId);
    const withdrawalDocRef = db.collection('withdrawals').doc();

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('Seller not found.');
      const balance = userDoc.data().revenue || 0;
      if (balance < amount) throw new Error('Insufficient balance.');

      t.update(userRef, { revenue: balance - amount, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      t.set(withdrawalDocRef, {
        sellerId,
        requestedAmount: amount,
        feeAmount,
        netPayoutAmount,
        phoneNumber,
        status: 'PENDING_PAYOUT',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const payoutResponse = await intasend.payouts().b2c({
      phone_number: phoneNumber,
      amount: netPayoutAmount,
      api_ref: withdrawalDocRef.id,
      host: BACKEND_HOST,
    });

    await withdrawalDocRef.update({
      trackingId: payoutResponse.tracking_id,
      status: 'PAYOUT_INITIATED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intasendResponse: payoutResponse,
    });

    res.json({
      success: true,
      message: 'Withdrawal initiated',
      data: { requestedAmount: amount, fee: feeAmount, netPayout: netPayoutAmount, trackingId: payoutResponse.tracking_id }
    });
  } catch (error) {
    console.error('Withdrawal Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- Update Stock ---
app.post('/api/update-stock', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    if (!productId || typeof quantity !== 'number' || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid product or quantity.' });
    }

    const productRef = db.collection('products').doc(productId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(productRef);
      if (!doc.exists) throw new Error('Product not found');
      const currentQuantity = doc.data().quantity || 0;
      if (currentQuantity < quantity) throw new Error('Not enough stock');
      t.update(productRef, { quantity: currentQuantity - quantity });
    });

    res.json({ success: true, message: 'Stock updated successfully.' });
  } catch (error) {
    console.error('Stock update failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================
// Start Server
// ============================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

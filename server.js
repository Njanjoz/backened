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
  'http://localhost:5173', // Local dev frontend
  'https://backened-lt67.onrender.com', // Deployed backend
  'https://my-campus-store-frontend.vercel.app', // Vercel frontend
  'https://marketmix.site', // Production frontend
  'https://localhost' // Capacitor apps
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, mobile apps, etc.)
    if (!origin) return callback(null, true);

    // Allow exact matches
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow any localhost / 127.0.0.1 on any port
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return callback(null, true);
    }

    // Otherwise block
    const msg = `CORS blocked: ${origin}`;
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
if (!process.env.INTASEND_PUBLISHABLE_KEY || !process.env.INTASEND_SECRET_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Error: Missing required environment variables.');
  process.exit(1);
}

// ============================
// Firebase Admin Init
// ============================
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (e) {
  console.error('Error initializing Firebase Admin SDK:', e);
  process.exit(1);
}

const db = admin.firestore();

// ============================
// IntaSend Init
// ============================
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false // sandbox = false, live = true
);

// ============================
// Constants
// ============================
const WITHDRAWAL_FEE_RATE = 0.055; // 5.5%

// ============================
// Routes
// ============================

// STK Push initiation
app.post('/api/stk-push', async (req, res) => {
  try {
    const { amount, phoneNumber, fullName, email, orderId } = req.body;

    console.log('Incoming STK Push request:', { amount, phoneNumber, fullName, email, orderId });

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }

    const phoneRegex = /^(2547|2541)\d{8}$/;
    if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
    }

    if (!fullName || fullName.trim() === '') {
      return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    const names = fullName.trim().split(" ");
    const firstName = names[0];
    const lastName = names.slice(1).join(" ") || "N/A";

    const collection = intasend.collection();
    const response = await collection.mpesaStkPush({
      first_name: firstName,
      last_name: lastName,
      email,
      phone_number: phoneNumber,
      amount,
      host: process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com",
      api_ref: orderId
    });

    const docRef = db.collection('orders').doc(orderId);
    await docRef.update({
      invoiceId: response.invoice.invoice_id,
      status: 'STK_PUSH_SENT',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Stored STK push transaction: ${orderId}`);
    res.status(200).json({ success: true, data: response });
  } catch (error) {
    console.error('STK Push Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initiate STK Push.'
    });
  }
});

// IntaSend callback endpoint
app.post('/api/intasend-callback', async (req, res) => {
  console.log("IntaSend callback received:", req.body);

  const { api_ref, state, mpesa_reference } = req.body;

  if (api_ref && state) {
    const docRef = db.collection('orders').doc(api_ref);
    let paymentStatus = 'pending';
    if (state === 'COMPLETE') paymentStatus = 'paid';
    if (state === 'FAILED' || state === 'CANCELLED') paymentStatus = 'failed';

    try {
      await docRef.set({
        paymentStatus,
        mpesaReference: mpesa_reference || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`Order ${api_ref} updated: ${paymentStatus}`);
    } catch (error) {
      console.error(`Error updating order ${api_ref}:`, error);
    }
  }

  res.status(200).send("OK");
});

// Transaction status
app.get('/api/transaction/:invoiceId', async (req, res) => {
  try {
    const docs = await db.collection('orders')
      .where('invoiceId', '==', req.params.invoiceId)
      .get();

    if (docs.empty) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    res.status(200).json({ success: true, data: docs.docs[0].data() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch transaction.', error: error.message });
  }
});

// Seller Withdrawal
app.post('/api/seller/withdraw', async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;

    if (!sellerId || !requestedAmount || isNaN(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid seller ID or amount.' });
    }

    const amount = parseFloat(requestedAmount);
    const phoneRegex = /^(2547|2541)\d{8}$/;
    if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
    }

    const netPayoutAmount = parseFloat((amount * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2));
    const feeAmount = parseFloat((amount * WITHDRAWAL_FEE_RATE).toFixed(2));

    const userRef = db.collection('users').doc(sellerId);
    let withdrawalDocRef;
    let transactionSuccess = false;

    try {
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) throw new Error('Seller account not found.');
        const currentBalance = userDoc.data().revenue || 0;
        if (currentBalance < amount) throw new Error('Insufficient balance.');

        const newBalance = currentBalance - amount;
        transaction.update(userRef, { revenue: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        withdrawalDocRef = db.collection('withdrawals').doc();
        transaction.set(withdrawalDocRef, {
          sellerId,
          requestedAmount: amount,
          feeAmount,
          netPayoutAmount,
          phoneNumber,
          status: 'PENDING_PAYOUT',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        transactionSuccess = true;
      });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    if (!transactionSuccess) {
      return res.status(500).json({ success: false, message: 'Balance deduction failed.' });
    }

    const payouts = intasend.payouts();
    const apiRef = withdrawalDocRef.id;

    const payoutResponse = await payouts.b2c({
      phone_number: phoneNumber,
      amount: netPayoutAmount,
      api_ref: apiRef,
      host: process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com",
    });

    await withdrawalDocRef.update({
      trackingId: payoutResponse.tracking_id,
      status: 'PAYOUT_INITIATED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intasendResponse: payoutResponse,
    });

    res.status(200).json({
      success: true,
      message: 'Withdrawal initiated successfully.',
      data: { requestedAmount: amount, fee: feeAmount, netPayout: netPayoutAmount, trackingId: payoutResponse.tracking_id }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Withdrawal failed.', error: error.message });
  }
});

// Update stock
app.post('/api/update-stock', async (req, res) => {
  try {
    const { productId, quantity } = req.body;

    if (!productId || typeof quantity !== 'number' || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid product ID or quantity.' });
    }

    const productRef = db.collection('products').doc(productId);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(productRef);
      if (!doc.exists) return res.status(404).json({ success: false, message: 'Product not found.' });

      const currentQuantity = doc.data().quantity || 0;
      const newQuantity = currentQuantity - quantity;
      if (newQuantity < 0) return res.status(400).json({ success: false, message: 'Not enough stock.' });

      transaction.update(productRef, { quantity: newQuantity });
    });

    res.status(200).json({ success: true, message: 'Stock updated successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update stock.', error: error.message });
  }
});

// ============================
// Start Server
// ============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

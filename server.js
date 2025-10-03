// server.js
// Rewritten server with improved validation, logging and error handling
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
// CORS CONFIGURATION
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
    if (!origin) return callback(null, true); // allow tools like Postman and server-to-server
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

// Simple request logger (dev)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} → ${req.method} ${req.originalUrl}`);
  next();
});

// ============================
// ENV CHECK (required keys)
// ============================
const requiredEnv = [
  'INTASEND_PUBLISHABLE_KEY',
  'INTASEND_SECRET_KEY',
  'FIREBASE_SERVICE_ACCOUNT_KEY'
];

const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Error: Missing required environment variables:', missing.join(', '));
  // exit early — service can't operate without these
  process.exit(1);
}

// ============================
// Firebase Admin init
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
// IntaSend init
// ============================
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false
);

const BACKEND_HOST = process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com";

// constants
const WITHDRAWAL_FEE_RATE = 0.055;

// ============================
// Helpers
// ============================
function isValidPhone(phone) {
  // Accepts 2547XXXXXXXX or 2541XXXXXXXX
  return typeof phone === 'string' && /^(2547|2541)\d{8}$/.test(phone);
}

function parsePositiveNumber(value) {
  const n = parseFloat(value);
  if (Number.isNaN(n) || !isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function sendServerError(res, err, msg = 'Internal server error') {
  console.error(msg, err);
  return res.status(500).json({ success: false, message: msg });
}

// ============================
// Routes
// ============================

// STK Push
app.post('/api/stk-push', async (req, res) => {
  try {
    const { amount, phoneNumber, fullName, email, orderId } = req.body;

    const amt = parsePositiveNumber(amount);
    if (!amt) return res.status(400).json({ success: false, message: 'Invalid amount.' });
    if (!isValidPhone(phoneNumber)) return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) return res.status(400).json({ success: false, message: 'Invalid full name.' });
    if (!email || typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ success: false, message: 'Invalid email.' });
    if (!orderId) return res.status(400).json({ success: false, message: 'Missing orderId.' });

    const [firstName, ...rest] = fullName.trim().split(" ");
    const lastName = rest.join(" ") || "N/A";

    let response;
    try {
      response = await intasend.collection().mpesaStkPush({
        first_name: firstName,
        last_name: lastName,
        email,
        phone_number: phoneNumber,
        amount: amt,
        host: BACKEND_HOST,
        api_ref: orderId
      });
    } catch (intasendErr) {
      console.error('IntaSend STK Push failed:', intasendErr?.response || intasendErr?.message || intasendErr);
      return res.status(502).json({ success: false, message: 'Payment provider error.' });
    }

    // update order doc with invoice id — tolerant update
    try {
      await db.collection('orders').doc(orderId).update({
        invoiceId: response?.invoice?.invoice_id || null,
        status: 'STK_PUSH_SENT',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (dbErr) {
      console.error('Failed to update order after STK push:', dbErr);
      // don't treat this as fatal — still return success for the payment attempt
    }

    return res.json({ success: true, data: response });
  } catch (error) {
    return sendServerError(res, error, 'STK Push failed');
  }
});

// IntaSend callback
app.post('/api/intasend-callback', async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body;
    if (!api_ref || !state) {
      return res.status(400).send("Missing api_ref or state");
    }

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
      // still return OK to IntaSend so callbacks aren't retried infinitely
    }

    return res.send("OK");
  } catch (error) {
    return sendServerError(res, error, 'IntaSend callback handling failed');
  }
});

// Transaction status (by invoiceId)
app.get('/api/transaction/:invoiceId', async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Missing invoiceId' });

    const docs = await db.collection('orders')
      .where('invoiceId', '==', invoiceId)
      .get();

    if (docs.empty) return res.status(404).json({ success: false, message: 'Transaction not found.' });

    return res.json({ success: true, data: docs.docs[0].data() });
  } catch (error) {
    return sendServerError(res, error, 'Transaction lookup failed');
  }
});

// Seller withdrawal
app.post('/api/seller/withdraw', async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;

    if (!sellerId) return res.status(400).json({ success: false, message: 'Missing sellerId.' });

    const amount = parsePositiveNumber(requestedAmount);
    if (!amount) return res.status(400).json({ success: false, message: 'Invalid amount.' });

    if (!isValidPhone(phoneNumber)) return res.status(400).json({ success: false, message: 'Invalid phone number.' });

    // read user doc first (to give specific 404/400)
    const userRef = db.collection('users').doc(sellerId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'Seller not found.' });

    const currentRevenue = parseFloat(userDoc.data()?.revenue || 0);
    if (currentRevenue < amount) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

    // prepare withdrawal doc
    const withdrawalDocRef = db.collection('withdrawals').doc();
    const feeAmount = +(amount * WITHDRAWAL_FEE_RATE).toFixed(2);
    const netPayoutAmount = +(amount * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2);

    // Run transaction to deduct and create withdrawal record
    try {
      await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw new Error('Seller not found during transaction.'); // defensive
        const balance = parseFloat(snap.data().revenue || 0);
        if (balance < amount) throw new Error('Insufficient balance during transaction.');

        t.update(userRef, {
          revenue: +(balance - amount).toFixed(2),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

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
    } catch (txErr) {
      console.error('Withdrawal transaction failed:', txErr);
      // If this fails, return a 500 because something unexpected happened in DB transaction
      return res.status(500).json({ success: false, message: 'Failed to create withdrawal. Try again.' });
    }

    // Attempt IntaSend payout (B2C)
    let payoutResponse;
    try {
      payoutResponse = await intasend.payouts().b2c({
        phone_number: phoneNumber,
        amount: netPayoutAmount,
        api_ref: withdrawalDocRef.id,
        host: BACKEND_HOST,
      });
    } catch (intasendErr) {
      console.error('IntaSend payout failed:', intasendErr?.response || intasendErr?.message || intasendErr);
      // update withdrawal record to FAILED_INTASEND (best-effort)
      try {
        await withdrawalDocRef.update({
          status: 'PAYOUT_FAILED',
          intasendError: (intasendErr?.response || intasendErr?.message || String(intasendErr)),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (uErr) {
        console.error('Failed to update withdrawal doc after payout error:', uErr);
      }
      return res.status(502).json({ success: false, message: 'Payout provider error. Withdrawal created but payout failed.' });
    }

    // update withdrawal with tracking id and status
    try {
      await withdrawalDocRef.update({
        trackingId: payoutResponse.tracking_id || null,
        status: 'PAYOUT_INITIATED',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        intasendResponse: payoutResponse,
      });
    } catch (updErr) {
      console.error('Failed to update withdrawal after successful payout call:', updErr);
      // still continue to return success since payout was initiated
    }

    return res.json({
      success: true,
      message: 'Withdrawal initiated',
      data: {
        requestedAmount: amount,
        fee: feeAmount,
        netPayout: netPayoutAmount,
        trackingId: payoutResponse.tracking_id || null,
        withdrawalId: withdrawalDocRef.id
      }
    });
  } catch (error) {
    // differentiate known errors vs unknown
    console.error('Withdrawal Error:', error);
    if (error.message && (error.message.includes('Insufficient') || error.message.includes('not found'))) {
      // client error translated earlier should not reach here often
      return res.status(400).json({ success: false, message: error.message });
    }
    return sendServerError(res, error, 'Withdrawal processing failed');
  }
});

// Update stock
app.post('/api/update-stock', async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    if (!productId || typeof quantity !== 'number' || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid product or quantity.' });
    }

    const productRef = db.collection('products').doc(productId);
    try {
      await db.runTransaction(async (t) => {
        const doc = await t.get(productRef);
        if (!doc.exists) throw new Error('Product not found');
        const currentQuantity = doc.data().quantity || 0;
        if (currentQuantity < quantity) throw new Error('Not enough stock');
        t.update(productRef, { quantity: currentQuantity - quantity });
      });
    } catch (txErr) {
      console.error('Stock update failed:', txErr);
      if (txErr.message === 'Product not found') return res.status(404).json({ success: false, message: 'Product not found' });
      if (txErr.message === 'Not enough stock') return res.status(400).json({ success: false, message: 'Not enough stock' });
      return res.status(500).json({ success: false, message: 'Failed to update stock' });
    }

    return res.json({ success: true, message: 'Stock updated successfully.' });
  } catch (error) {
    return sendServerError(res, error, 'Stock update failed');
  }
});

// Health check
app.get('/_health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));

// global fallback
app.use((req, res) => res.status(404).json({ success: false, message: 'Not Found' }));

// ============================
// Start server
// ============================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

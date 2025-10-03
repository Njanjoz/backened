// server.js
// Express backend for Campus Store with STK push, withdrawals, stock updates, and IntaSend payouts

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // for calling IntaSend REST APIs

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ============================
// CORS CONFIGURATION
// ============================
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://localhost",
  "https://backened-lt67.onrender.com",
  "https://my-campus-store-frontend.vercel.app",
  "https://marketmix.site",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) {
        return callback(null, true);
      }
      const msg = `CORS blocked: ${origin}`;
      console.error(msg);
      return callback(new Error(msg), false);
    },
    credentials: true,
  })
);

// ============================
// Middleware
// ============================
app.use(bodyParser.json());

// Simple request logger
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} → ${req.method} ${req.originalUrl}`,
    req.body || {}
  );
  next();
});

// ============================
// ENV CHECK
// ============================
const requiredEnv = [
  "INTASEND_PUBLISHABLE_KEY",
  "INTASEND_SECRET_KEY",
  "FIREBASE_SERVICE_ACCOUNT_KEY",
];

const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

// ============================
// Firebase Admin init
// ============================
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase Admin initialized");
} catch (e) {
  console.error("❌ Firebase Admin init failed:", e);
  process.exit(1);
}

const db = admin.firestore();

const BACKEND_HOST =
  process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com";

// ============================
// Helpers
// ============================
const WITHDRAWAL_FEE_RATE = 0.055;

function isValidPhone(phone) {
  return typeof phone === "string" && /^(2547|2541)\d{8}$/.test(phone);
}

function parsePositiveNumber(value) {
  const n = parseFloat(value);
  return !isNaN(n) && n > 0 ? n : null;
}

function sendServerError(res, err, msg = "Internal server error") {
  console.error(msg, err);
  return res.status(500).json({ success: false, message: msg });
}

// ============================
// Routes
// ============================

// ✅ Seller Withdrawal
app.post("/api/seller/withdraw", async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;

    console.log("📤 Withdrawal Request:", req.body);

    if (!sellerId) return res.status(400).json({ success: false, message: "Missing sellerId" });

    const amount = parsePositiveNumber(requestedAmount);
    if (!amount) return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber))
      return res.status(400).json({ success: false, message: "Invalid phone number" });

    const userRef = db.collection("users").doc(sellerId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "Seller not found" });

    const currentRevenue = parseFloat(userDoc.data()?.revenue || 0);
    console.log(`💰 Seller ${sellerId} available revenue: ${currentRevenue}`);
    if (currentRevenue < amount)
      return res.status(400).json({ success: false, message: "Insufficient balance" });

    const withdrawalDocRef = db.collection("withdrawals").doc();
    const feeAmount = +(amount * WITHDRAWAL_FEE_RATE).toFixed(2);
    const netPayoutAmount = +(amount * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2);

    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const balance = parseFloat(snap.data().revenue || 0);
      if (balance < amount) throw new Error("Insufficient balance in transaction");

      t.update(userRef, {
        revenue: +(balance - amount).toFixed(2),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      t.set(withdrawalDocRef, {
        sellerId,
        requestedAmount: amount,
        feeAmount,
        netPayoutAmount,
        phoneNumber,
        status: "PENDING_PAYOUT",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // ✅ IntaSend Payout API via fetch
    const payoutPayload = {
      currency: "KES",
      transactions: [
        {
          name: userDoc.data()?.name || "Seller",
          account: phoneNumber,
          amount: netPayoutAmount,
        },
      ],
    };

    let payoutResponse;
    try {
      const resp = await fetch("https://payment.intasend.com/api/v1/send-money/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.INTASEND_SECRET_KEY}`,
        },
        body: JSON.stringify(payoutPayload),
      });
      payoutResponse = await resp.json();
      if (!resp.ok) {
        throw new Error(payoutResponse.message || "Payout API error");
      }
    } catch (intasendErr) {
      console.error("❌ IntaSend payout failed:", intasendErr);
      await withdrawalDocRef.update({
        status: "PAYOUT_FAILED",
        intasendError: intasendErr.message || String(intasendErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({ success: false, message: "Payout provider error" });
    }

    await withdrawalDocRef.update({
      trackingId: payoutResponse?.tracking_id || null,
      status: "PAYOUT_INITIATED",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intasendResponse: payoutResponse,
    });

    return res.json({
      success: true,
      message: "Withdrawal initiated",
      data: {
        requestedAmount: amount,
        fee: feeAmount,
        netPayout: netPayoutAmount,
        trackingId: payoutResponse?.tracking_id || null,
        withdrawalId: withdrawalDocRef.id,
      },
    });
  } catch (error) {
    console.error("❌ Withdrawal Error:", error);
    return sendServerError(res, error, "Withdrawal failed");
  }
});

// ============================
// Health check
// ============================
app.get("/_health", (req, res) => res.json({ ok: true, timestamp: Date.now() }));

// 404 fallback
app.use((req, res) => res.status(404).json({ success: false, message: "Not Found" }));

// ============================
// Start server
// ============================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

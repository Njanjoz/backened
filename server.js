// Express backend for Campus Store with live order-based withdrawal check + IntaSend B2C

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const IntaSend = require("intasend-node");
const cors = require("cors");
const admin = require("firebase-admin");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ============================
// CORS CONFIGURATION
// ============================
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://backened-lt67.onrender.com",
  "https://my-campus-store-frontend.vercel.app",
  "https://marketmix.site",
  "https://localhost",
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

// ============================
// IntaSend init
// ============================
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false
);

const BACKEND_HOST =
  process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com";

// ============================
// Fee Constants & Helpers (UPDATED TO MATCH CLIENT: 3.5% + Tiered KSH 10/20)
// ============================
const WITHDRAWAL_THRESHOLD = 100.0; // 100 KSH
const FIXED_FEE_BELOW_THRESHOLD = 10.0; // 10 KSH fixed fee for < 100 KSH
const FIXED_FEE_ABOVE_THRESHOLD = 20.0; // 20 KSH fixed fee for >= 100 KSH
const AGENCY_FEE_RATE = 0.035; // 3.5% agency fee

function getTieredFixedFee(amount) {
  return amount < WITHDRAWAL_THRESHOLD
    ? FIXED_FEE_BELOW_THRESHOLD
    : FIXED_FEE_ABOVE_THRESHOLD;
}

function calculateTotalFee(amount) {
  const percentageFee = amount * AGENCY_FEE_RATE;
  const fixedFee = getTieredFixedFee(amount);
  return +(percentageFee + fixedFee).toFixed(2);
}

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

// ✅ STK Push
app.post("/api/stk-push", async (req, res) => {
  try {
    const { amount, phoneNumber, fullName, email, orderId } = req.body;

    const amt = parsePositiveNumber(amount);
    if (!amt)
      return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber))
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone number format" });
    if (!fullName)
      return res
        .status(400)
        .json({ success: false, message: "Full name required" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ success: false, message: "Invalid email" });
    if (!orderId)
      return res
        .status(400)
        .json({ success: false, message: "Missing orderId" });

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
        api_ref: orderId,
      });
    } catch (intasendErr) {
      console.error(
        "❌ IntaSend STK Push failed:",
        intasendErr?.response || intasendErr
      );
      return res
        .status(502)
        .json({ success: false, message: "Payment provider error" });
    }

    await db.collection("orders").doc(orderId).set(
      {
        invoiceId: response?.invoice?.invoice_id || null,
        status: "STK_PUSH_SENT",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ success: true, data: response });
  } catch (error) {
    return sendServerError(res, error, "STK Push failed");
  }
});

// ✅ IntaSend callback
app.post("/api/intasend-callback", async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body;
    if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");

    let status = "pending";
    if (state === "COMPLETE") status = "paid";
    if (["FAILED", "CANCELLED"].includes(state)) status = "failed";

    await db.collection("orders").doc(api_ref).set(
      {
        paymentStatus: status,
        mpesaReference: mpesa_reference || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.send("OK");
  } catch (error) {
    return sendServerError(res, error, "IntaSend callback failed");
  }
});

// ✅ Transaction lookup
app.get("/api/transaction/:invoiceId", async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    if (!invoiceId)
      return res
        .status(400)
        .json({ success: false, message: "Missing invoiceId" });

    const docs = await db
      .collection("orders")
      .where("invoiceId", "==", invoiceId)
      .get();

    if (docs.empty)
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });

    return res.json({ success: true, data: docs.docs[0].data() });
  } catch (error) {
    return sendServerError(res, error, "Transaction lookup failed");
  }
});

// ✅ Seller Withdrawal (LIVE from orders + IntaSend B2C)
app.post("/api/seller/withdraw", async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;
    console.log("📤 Withdrawal Request:", req.body);

    if (!sellerId)
      return res.status(400).json({ success: false, message: "Missing sellerId" });
    const amount = parsePositiveNumber(requestedAmount);
    if (!amount)
      return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber))
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone number" });

    const minFeeCheck = calculateTotalFee(amount);
    if (amount <= minFeeCheck) {
      return res.status(400).json({
        success: false,
        message: `Requested amount must be greater than the total fee of KSH ${minFeeCheck.toFixed(
          2
        )}.`,
      });
    }

    // 🔎 Calculate seller revenue live from paid orders
    const ordersSnap = await db
      .collection("orders")
      .where("involvedSellerIds", "array-contains", sellerId)
      .where("paymentStatus", "==", "paid")
      .get();

    let totalRevenue = 0;
    ordersSnap.forEach((doc) => {
      const data = doc.data();
      const items = data.items;

      if (!items) return;

      // ✅ Safe handler for array, object, or single item
      if (Array.isArray(items)) {
        items.forEach((item) => {
          if (item?.sellerId === sellerId) {
            const price = Number(item.price) || 0;
            const qty = Number(item.quantity) || 0;
            totalRevenue += price * qty;
          }
        });
      } else if (typeof items === "object") {
        Object.values(items).forEach((item) => {
          if (item?.sellerId === sellerId) {
            const price = Number(item.price) || 0;
            const qty = Number(item.quantity) || 0;
            totalRevenue += price * qty;
          }
        });
      } else {
        const item = items;
        if (item?.sellerId === sellerId) {
          const price = Number(item.price) || 0;
          const qty = Number(item.quantity) || 0;
          totalRevenue += price * qty;
        }
      }
    });

    // 💸 Fetch total previously withdrawn amount from ledger
    let totalPreviouslyWithdrawn = 0;
    const sellerLedgerRef = db.collection("sellerLedgers").doc(sellerId);
    const ledgerSnap = await sellerLedgerRef.get();
    if (ledgerSnap.exists) {
      totalPreviouslyWithdrawn = ledgerSnap.data().totalWithdrawn || 0;
    }

    const netAvailableRevenue = totalRevenue - totalPreviouslyWithdrawn;

    console.log(`💰 Seller ${sellerId} live total revenue: ${totalRevenue.toFixed(2)}`);
    console.log(`💸 Total previously withdrawn: ${totalPreviouslyWithdrawn.toFixed(2)}`);
    console.log(`✅ Net available balance: ${netAvailableRevenue.toFixed(2)}`);

    if (netAvailableRevenue < amount)
      return res
        .status(400)
        .json({ success: false, message: "Insufficient balance" });

    const feeAmount = calculateTotalFee(amount);
    const netPayoutAmount = +(amount - feeAmount).toFixed(2);

    if (netPayoutAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: `Net payout is KSH 0.00 or less after the KSH ${feeAmount.toFixed(
          2
        )} fee. Increase the withdrawal amount.`,
      });
    }

    const withdrawalDocRef = db.collection("withdrawals").doc();
    await withdrawalDocRef.set({
      sellerId,
      amount,
      feeAmount,
      netPayout: netPayoutAmount,
      phoneNumber,
      status: "PENDING_PAYOUT",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    let payoutResponse;
    try {
      payoutResponse = await intasend.payouts().mpesa({
        currency: "KES",
        requires_approval: "NO",
        transactions: [
          {
            name: "Seller Withdrawal",
            account: phoneNumber,
            amount: netPayoutAmount,
            narrative: "Seller Payout",
          },
        ],
      });
    } catch (intasendErr) {
      console.error(
        "❌ IntaSend payout failed:",
        intasendErr?.response || intasendErr
      );
      await withdrawalDocRef.update({
        status: "PAYOUT_FAILED",
        intasendError:
          intasendErr?.response || intasendErr?.message || String(intasendErr),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res
        .status(502)
        .json({ success: false, message: "Payout provider error" });
    }

    await withdrawalDocRef.update({
      trackingId: payoutResponse?.tracking_id || null,
      status: "PAYOUT_INITIATED",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intasendResponse: payoutResponse,
    });

    await db
      .collection("sellerLedgers")
      .doc(sellerId)
      .set(
        {
          totalWithdrawn: admin.firestore.FieldValue.increment(amount),
          lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

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

// ✅ Stock update
app.post("/api/update-stock", async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    if (!productId || typeof quantity !== "number" || quantity <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product or quantity" });
    }

    const productRef = db.collection("products").doc(productId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(productRef);
      if (!doc.exists) throw new Error("Product not found");
      const currentQuantity = doc.data().quantity || 0;
      if (currentQuantity < quantity) throw new Error("Not enough stock");
      t.update(productRef, { quantity: currentQuantity - quantity });
    });

    return res.json({ success: true, message: "Stock updated successfully" });
  } catch (error) {
    console.error("❌ Stock update failed:", error);
    return sendServerError(res, error, "Stock update failed");
  }
});

// ✅ Health check
app.get("/_health", (req, res) => res.json({ ok: true, timestamp: Date.now() }));

// 404 fallback
app.use((req, res) =>
  res.status(404).json({ success: false, message: "Not Found" })
);

// ============================
// Start server
// ============================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

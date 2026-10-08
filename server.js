// server.js — single-file backend for MarketMix (store + wallet + subscriptions + real estate)
// Real-estate flow is isolated by the "PROP_" ref prefix; it does NOT touch store/wallet/subscription logic.

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const IntaSend = require("intasend-node");
const cors = require("cors");
const admin = require("firebase-admin");
const http = require("http");
const Buffer = require('buffer').Buffer;
const fetch = require("node-fetch");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// ============================
// CORS
// ============================
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://backened-lt67.onrender.com",
  "https://my-campus-store-frontend.vercel.app",
  "https://marketmix.site",
  "https://marketmix-realestates.vercel.app",
  "https://localhost",
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
      return callback(null, true);
    }
    console.error(`CORS blocked: ${origin}`);
    return callback(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
}));

// ============================
// Middleware
// ============================
app.use(bodyParser.json());

app.use((req, res, next) => {
  try {
    console.log(`${new Date().toISOString()} → ${req.method} ${req.originalUrl}`, req.body || {});
  } catch (e) {
    console.error("Logging error:", e);
  }
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
// Firebase
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
// IntaSend
// ============================
const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  false
);

const BACKEND_HOST = process.env.RENDER_BACKEND_URL || `http://localhost:${PORT}`;
const REAL_ESTATE_RECEIPT_URL =
  process.env.REAL_ESTATE_RECEIPT_URL ||
  "https://marketmix-realestates.vercel.app/receipt";

// ============================
// Brevo
// ============================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const sendEmail = async (to, subject, html, type = "security") => {
  try {
    console.log("📧 Sending email:", { to, subject, type });

    if (!BREVO_API_KEY) {
      console.log("❌ BREVO_API_KEY not configured");
      return false;
    }

    const sender = type === "sales"
      ? { name: "MarketMixKenya", email: "sales@marketmix.site" }
      : { name: "MarketMixKenya", email: "security@marketmix.site" };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender,
        to: [{ email: to, name: to.split("@")[0] || "User" }],
        subject,
        htmlContent: html,
        tags: [type === "sales" ? "order-confirmation" : "pin-recovery"],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("❌ Brevo API error:", JSON.stringify(data, null, 2));
      throw new Error(data.message || `Brevo API error: ${response.status}`);
    }

    console.log(`✅ Email sent (id=${data.messageId})`);
    return true;
  } catch (error) {
    console.error("❌ Email sending failed:", error.message);
    return false;
  }
};

// Brevo startup check
(async () => {
  if (!BREVO_API_KEY) {
    console.warn("⚠️ BREVO_API_KEY not set — emails will not be sent");
    return;
  }
  try {
    const r = await fetch("https://api.brevo.com/v3/account", {
      headers: { accept: "application/json", "api-key": BREVO_API_KEY },
    });
    if (r.ok) {
      const d = await r.json();
      console.log(`✅ Brevo connected as ${d.email}`);
    } else {
      console.warn("⚠️ Brevo key may be invalid");
    }
  } catch (e) {
    console.warn("⚠️ Brevo startup check failed:", e.message);
  }
})();

// ============================
// Helpers
// ============================
const WITHDRAWAL_THRESHOLD = 100.0;
const FIXED_FEE_BELOW_THRESHOLD = 10.0;
const FIXED_FEE_ABOVE_THRESHOLD = 20.0;
const AGENCY_FEE_RATE = 0.035;

function getTieredFixedFee(amount) {
  return amount < WITHDRAWAL_THRESHOLD ? FIXED_FEE_BELOW_THRESHOLD : FIXED_FEE_ABOVE_THRESHOLD;
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

// Ref-prefix routing (this is the isolation mechanism)
const isWalletRef       = (r) => typeof r === "string" && r.startsWith("WALLET_");
const isSubscriptionRef = (r) => typeof r === "string" && r.startsWith("SUB_");
const isRealEstateRef   = (r) => typeof r === "string" && r.startsWith("PROP_");
const isTestRef         = (r) => typeof r === "string" && r.startsWith("TEST_PAY_");

function isRealEstateOrder(apiRef, orderData) {
  return isRealEstateRef(apiRef)
      || orderData?.orderType === "real_estate"
      || orderData?.isRealEstate === true;
}

// ============================
// Email templates
// ============================
const sendOrderConfirmationEmail = async (orderData, userEmail, orderId) => {
  try {
    console.log("📧 Order confirmation →", userEmail);
    if (!BREVO_API_KEY) return false;

    const itemsTotal = orderData.items?.reduce(
      (s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0) || 0;
    const deliveryTotal = orderData.sellerGroups?.reduce(
      (s, g) => s + (g.deliveryCost || 0), 0) || 0;

    const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
    <h2 style="margin:0 0 6px 0;color:#111827">Thank you for shopping with us</h2>
    <p style="color:#6b7280;margin:0 0 16px 0">Order #${String(orderId).substring(0, 8)}</p>
    <p><strong>Date:</strong> ${new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</p>
    <p><strong>Buyer:</strong> ${orderData.shippingDetails?.fullName || userEmail}</p>
    <ul>
      ${(orderData.items || []).map(i =>
        `<li>${i.name} × ${i.quantity} — Ksh ${((i.price || 0) * (i.quantity || 1)).toFixed(2)}</li>`
      ).join("") || "<li>No items</li>"}
    </ul>
    <p><strong>Items Total:</strong> Ksh ${itemsTotal.toFixed(2)}</p>
    <p><strong>Delivery:</strong> Ksh ${deliveryTotal.toFixed(2)}</p>
    <p style="font-size:18px"><strong>Total Paid:</strong> Ksh ${(orderData.totalAmount || 0).toFixed(2)}</p>
    <p style="color:#6b7280;font-size:12px;margin-top:24px">MarketMix Kenya © ${new Date().getFullYear()}</p>
  </div>
</body></html>`;

    const ok = await sendEmail(
      userEmail,
      `Order Confirmation #${String(orderId).substring(0, 8)} - MarketMix Kenya`,
      html,
      "sales"
    );
    if (ok) {
      await db.collection("orderEmails").add({
        orderId, userEmail, type: "confirmation",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ Order email failed:", e.message);
    return false;
  }
};

const sendRealEstatePaymentEmail = async (data, userEmail, orderId) => {
  try {
    console.log("🏠 Real estate receipt →", userEmail);
    if (!BREVO_API_KEY) return false;

    const paidAt = new Date().toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi", dateStyle: "medium", timeStyle: "short",
    });

    const amount = Number(data.totalAmount || data.amount || 0);
    const mpesaRef = data.mpesaReference || data.mpesaCode || "N/A";

    const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f3f4f6;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:linear-gradient(135deg,#0f766e,#14b8a6);padding:28px 24px;color:#fff;text-align:center">
      <h1 style="margin:0;font-size:22px">MarketMix Real Estates</h1>
      <p style="margin:6px 0 0 0;font-size:14px;opacity:.9">Payment Confirmation Receipt</p>
      <p style="display:inline-block;margin-top:12px;padding:6px 14px;border-radius:999px;background:rgba(255,255,255,.2);font-size:12px;font-weight:600">✅ PAYMENT CONFIRMED</p>
    </div>
    <div style="padding:24px">
      <p>Hello ${data.buyerName || userEmail},</p>
      <p>Your payment has been received and confirmed.</p>
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px;text-align:center;margin:16px 0">
        <p style="margin:0;font-size:12px;color:#047857;letter-spacing:1px">AMOUNT PAID</p>
        <p style="margin:6px 0 0 0;font-size:26px;font-weight:700;color:#065f46">KES ${amount.toLocaleString("en-KE", { minimumFractionDigits: 2 })}</p>
      </div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280">Property</td><td style="text-align:right;font-weight:600">${data.propertyTitle || "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Location</td><td style="text-align:right;font-weight:600">${data.propertyLocation || "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Type</td><td style="text-align:right;font-weight:600">${data.propertyType || "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Reference</td><td style="text-align:right;font-weight:600">${orderId}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">M-Pesa Code</td><td style="text-align:right;font-weight:600">${mpesaRef}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Paid On</td><td style="text-align:right;font-weight:600">${paidAt}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Landlord</td><td style="text-align:right;font-weight:600">${data.landlordName || "—"} (${data.landlordPhone || "—"})</td></tr>
      </table>
      <p style="margin-top:18px;text-align:center">
        <a href="${REAL_ESTATE_RECEIPT_URL}/${orderId}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">View Receipt Online</a>
      </p>
    </div>
    <div style="background:#f9fafb;padding:16px;text-align:center;font-size:12px;color:#6b7280">
      MarketMix Real Estates · MarketMix Kenya © ${new Date().getFullYear()}<br>
      <a href="mailto:sales@marketmix.site" style="color:#0f766e">sales@marketmix.site</a>
    </div>
  </div>
</body></html>`;

    const ok = await sendEmail(
      userEmail,
      `Payment Confirmed - ${data.propertyTitle || "Property"} (${String(orderId).substring(0, 8)})`,
      html,
      "sales"
    );
    if (ok) {
      await db.collection("realEstateEmails").add({
        orderId, userEmail,
        propertyTitle: data.propertyTitle || null,
        amount, mpesaReference: mpesaRef,
        type: "real_estate_confirmation",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ Real estate email failed:", e.message);
    return false;
  }
};

// ============================
// PIN recovery (seller withdrawals)
// ============================
const generateReplacementCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const storeReplacementCode = async (userId, email, code) => {
  try {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db.collection("pinRecoveryCodes").doc(userId).set({
      code, email, userId, expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 0, maxAttempts: 3, used: false, status: "pending",
    });
    return true;
  } catch (e) {
    console.error("Failed to store code:", e);
    return false;
  }
};

const verifyReplacementCode = async (userId, code) => {
  try {
    const doc = await db.collection("pinRecoveryCodes").doc(userId).get();
    if (!doc.exists) return { valid: false, message: "No recovery request found" };
    const d = doc.data();
    if (d.expiresAt.toDate() < new Date()) {
      await db.collection("pinRecoveryCodes").doc(userId).delete();
      return { valid: false, message: "Recovery code has expired" };
    }
    if (d.used) return { valid: false, message: "Code already used" };
    if (d.attempts >= d.maxAttempts) return { valid: false, message: "Too many attempts" };
    if (d.code !== code) {
      await db.collection("pinRecoveryCodes").doc(userId).update({
        attempts: admin.firestore.FieldValue.increment(1),
      });
      return { valid: false, message: `Invalid code. ${d.maxAttempts - (d.attempts + 1)} left` };
    }
    await db.collection("pinRecoveryCodes").doc(userId).update({
      status: "verified",
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { valid: true, data: d };
  } catch (e) {
    console.error("Verify code failed:", e);
    return { valid: false, message: "Verification failed" };
  }
};

const markCodeAsUsed = async (userId) => {
  try {
    await db.collection("pinRecoveryCodes").doc(userId).update({
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "completed",
    });
    return true;
  } catch (e) {
    return false;
  }
};

// ============================
// Subscription helpers
// ============================
const validateSubscriptionPayment = (data) => {
  const { amount, phoneNumber, fullName, email, orderId, planId, sellerId } = data || {};
  if (!amount || !phoneNumber || !fullName || !email || !orderId || !planId || !sellerId) {
    return { valid: false, message: "Missing required fields" };
  }
  const amt = parsePositiveNumber(amount);
  if (!amt) return { valid: false, message: "Invalid amount" };
  if (!isValidPhone(phoneNumber)) return { valid: false, message: "Invalid phone" };
  if (!email.includes("@")) return { valid: false, message: "Invalid email" };
  return { valid: true, data: { ...data, amount: amt } };
};

const createSubscriptionRecord = async (s, invoiceId) => {
  const ref = db.collection("subscriptions").doc(s.orderId);
  await ref.set({
    sellerId: s.sellerId, planId: s.planId, planName: s.planName,
    amount: s.amount, invoiceId, status: "pending",
    paymentMethod: "mpesa", phoneNumber: s.phoneNumber,
    email: s.email, fullName: s.fullName, orderId: s.orderId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: null, paymentStatus: "pending", mpesaReference: null,
  });
  return ref.id;
};

const getSubscriptionPaymentStatus = async (invoiceId) => {
  const snap = await db.collection("subscriptions")
    .where("invoiceId", "==", invoiceId).limit(1).get();
  if (snap.empty) return { success: false, message: "Subscription not found" };
  const s = snap.docs[0].data();
  return { success: true, data: {
    paymentStatus: s.paymentStatus || "pending",
    mpesaReference: s.mpesaReference,
    status: s.status,
  }};
};

const activateSellerSubscription = async (s, mpesaReference) => {
  const { orderId, planId, sellerId, sellerEmail } = s;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await db.collection("subscriptions").doc(orderId).update({
    status: "active", paymentStatus: "paid",
    mpesaReference,
    activatedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("users").doc(sellerId).update({
    subscriptionPlan: planId,
    subscriptionStatus: "active",
    subscriptionActive: true,
    subscriptionExpiresAt: expiresAt,
    subscriptionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSubscriptionPayment: {
      amount: s.amount,
      date: admin.firestore.FieldValue.serverTimestamp(),
      reference: mpesaReference,
      orderId,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("subscriptionPayments").add({
    sellerId, planId, amount: s.amount, mpesaReference, orderId,
    status: "completed", sellerEmail,
    paymentDate: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
  });

  await db.collection("subscriptionLogs").add({
    sellerId, action: "subscription_activated", planId,
    amount: s.amount, orderId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return true;
};

// ============================
// ROUTES
// ============================

// --- Proposal status email ---
app.post("/api/send-proposal-status", async (req, res) => {
  try {
    const { to, subject, html, proposalId, studentName, status, notes, amount, institution } = req.body || {};
    if (!to || !proposalId || !status) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    const emailHtml = html || `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2>Installment Proposal ${status === "approved" ? "Approved ✅" : "Rejected ❌"}</h2>
        <p>Hello ${studentName || "Student"},</p>
        <p>Proposal <strong>${proposalId}</strong> has been <strong>${status}</strong>.</p>
        ${notes ? `<p><em>${notes}</em></p>` : ""}
        <p>Amount: KSH ${Number(amount || 0).toLocaleString()}</p>
        <p>Institution: ${institution || "N/A"}</p>
      </div>`;
    const ok = await sendEmail(to, subject || `Proposal ${status}`, emailHtml, "sales");
    return res.json({ success: ok, message: ok ? "Sent" : "Failed" });
  } catch (e) {
    return sendServerError(res, e, "Proposal email failed");
  }
});

// --- STK push (store, wallet, real estate seed orders — all use this) ---
app.post("/api/stk-push", async (req, res) => {
  try {
    const { amount, phoneNumber, fullName, email, orderId } = req.body || {};
    const amt = parsePositiveNumber(amount);
    if (!amt) return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber)) return res.status(400).json({ success: false, message: "Invalid phone" });
    if (!fullName) return res.status(400).json({ success: false, message: "Full name required" });
    if (!email || !email.includes("@")) return res.status(400).json({ success: false, message: "Invalid email" });
    if (!orderId) return res.status(400).json({ success: false, message: "Missing orderId" });

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
      console.error("❌ IntaSend STK failed:", intasendErr?.response || intasendErr);
      return res.status(502).json({ success: false, message: "Payment provider error" });
    }

    await db.collection("orders").doc(orderId).set({
      invoiceId: response?.invoice?.invoice_id || null,
      status: "STK_PUSH_SENT",
      totalAmount: amt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, data: response });
  } catch (e) {
    return sendServerError(res, e, "STK push failed");
  }
});

// --- Store order seed (items + shipping so store receipt renders) ---
app.post("/api/store/seed", async (req, res) => {
  try {
    const { ref, amount, email, fullName, phoneNumber, cart } = req.body || {};
    if (!ref || !email) return res.status(400).json({ success: false, message: "ref and email required" });

    await db.collection("orders").doc(ref).set({
      orderId: ref,
      orderType: "store",
      totalAmount: Number(amount) || 0,
      userEmail: email,
      buyerEmail: email,
      shippingDetails: { fullName, phoneNumber, email, deliveryPlace: "TBD" },
      items: Array.isArray(cart?.items) ? cart.items : [],
      sellerGroups: Array.isArray(cart?.sellerGroups) ? cart.sellerGroups : [],
      paymentStatus: "pending",
      state: "INITIATED",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, ref });
  } catch (e) {
    return sendServerError(res, e, "Store seed failed");
  }
});

// --- REAL ESTATE SECTION (isolated) -------------------------------------

// Seed a real-estate order before STK push. Ref must start with PROP_.
app.post("/api/real-estate/seed", async (req, res) => {
  try {
    const { ref, amount, email, fullName, phoneNumber, paymentKind, property, landlord } = req.body || {};
    if (!ref || !ref.startsWith("PROP_")) {
      return res.status(400).json({ success: false, message: "ref must start with PROP_" });
    }
    if (!property?.id || !landlord?.phone || !email) {
      return res.status(400).json({ success: false, message: "Missing property/landlord/email" });
    }

    await db.collection("orders").doc(ref).set({
      orderId: ref,
      orderType: "real_estate",
      isRealEstate: true,
      paymentKind: paymentKind || "rent",
      totalAmount: Number(amount) || 0,
      userEmail: email,
      buyerEmail: email,
      buyerName: fullName || "Buyer",
      shippingDetails: { fullName, phoneNumber, email },
      propertyId: property.id,
      propertyTitle: property.title,
      propertyLocation: property.location,
      propertyType: property.type,
      landlordName: landlord.name,
      landlordPhone: landlord.phone,
      paymentStatus: "pending",
      state: "INITIATED",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, message: "Real estate order seeded", ref });
  } catch (e) {
    return sendServerError(res, e, "Real estate seed failed");
  }
});

// --- Subscriptions ---
app.post("/api/subscription-payment", async (req, res) => {
  try {
    const v = validateSubscriptionPayment(req.body);
    if (!v.valid) return res.status(400).json({ success: false, message: v.message });
    const s = v.data;
    const [firstName, ...rest] = s.fullName.trim().split(" ");
    const lastName = rest.join(" ") || "N/A";

    let intasendResponse;
    try {
      intasendResponse = await intasend.collection().mpesaStkPush({
        first_name: firstName, last_name: lastName,
        email: s.email, phone_number: s.phoneNumber,
        amount: s.amount, host: BACKEND_HOST, api_ref: s.orderId,
      });
    } catch (e) {
      return res.status(502).json({ success: false, message: "Payment provider error" });
    }

    await createSubscriptionRecord(s, intasendResponse?.invoice?.invoice_id);
    return res.json({ success: true, data: intasendResponse });
  } catch (e) {
    return sendServerError(res, e, "Subscription payment failed");
  }
});

app.get("/api/subscription-status/:invoiceId", async (req, res) => {
  try {
    const r = await getSubscriptionPaymentStatus(req.params.invoiceId);
    if (!r.success) return res.status(404).json(r);
    return res.json(r);
  } catch (e) {
    return sendServerError(res, e, "Status check failed");
  }
});

app.post("/api/confirm-subscription", async (req, res) => {
  try {
    const { orderId, mpesaReference, planId, sellerId, sellerEmail } = req.body || {};
    if (!orderId || !mpesaReference || !planId || !sellerId || !sellerEmail) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    await activateSellerSubscription({ orderId, planId, sellerId, sellerEmail, amount: req.body.amount }, mpesaReference);
    return res.json({ success: true });
  } catch (e) {
    return sendServerError(res, e, "Confirm subscription failed");
  }
});

// --- IntaSend callback (shared by ALL flows, routes by ref prefix) ---
app.post("/api/intasend-callback", async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body || {};
    if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");

    console.log("📞 Callback:", { api_ref, state, mpesa_reference, value: req.body.value });

    let paymentStatus = "pending";
    if (state === "COMPLETE") paymentStatus = "paid";
    if (["FAILED", "CANCELLED"].includes(state)) paymentStatus = "failed";

    // -- Subscription branch --
    if (isSubscriptionRef(api_ref)) {
      const ref = db.collection("subscriptions").doc(api_ref);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.update({
          paymentStatus,
          mpesaReference: mpesa_reference || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (state === "COMPLETE") {
          const s = snap.data();
          try {
            await activateSellerSubscription({
              orderId: api_ref, planId: s.planId, sellerId: s.sellerId,
              sellerEmail: s.email, amount: s.amount,
            }, mpesa_reference);
          } catch (err) {
            console.error("Activation error:", err);
          }
        }
      }
      return res.send("OK");
    }

    // -- Wallet / Store / Real estate: all live in `orders` keyed by api_ref --
    const orderRef = db.collection("orders").doc(api_ref);
    let orderSnap = await orderRef.get();
    const callbackAmount = parseFloat(req.body.value);

    // Wallet auto-create
    if (!orderSnap.exists && isWalletRef(api_ref)) {
      const sellerId = api_ref.split("_")[1];
      const amount = (callbackAmount > 0 && callbackAmount <= 500000) ? callbackAmount : 1;
      await orderRef.set({
        orderId: api_ref,
        paymentStatus,
        mpesaReference: mpesa_reference || null,
        totalAmount: amount,
        state,
        isWalletDeposit: true,
        sellerId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      orderSnap = await orderRef.get();
    }

    if (!orderSnap.exists) {
      console.error(`❌ Order not found: ${api_ref}`);
      return res.status(404).send("Order not found");
    }

    const orderData = orderSnap.data();

    await orderRef.update({
      paymentStatus,
      mpesaReference: mpesa_reference || null,
      state,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Order ${api_ref} → ${paymentStatus}`);

    // Wallet deposit: update wallet balance + ad transaction
    if (isWalletRef(api_ref) && state === "COMPLETE") {
      const sellerId = api_ref.split("_")[1];
      let amount = callbackAmount;
      if (!amount || amount <= 0 || amount > 500000) amount = orderData.totalAmount;
      if (!amount || amount <= 0 || amount > 500000) {
        await orderRef.update({ paymentStatus: "failed", errorMessage: "Invalid amount" });
        return res.send("OK");
      }

      await db.collection("adTransactions").doc(api_ref).set({
        paymentRef: api_ref, sellerId,
        type: "deposit", amount, status: "completed",
        paymentMethod: "mpesa",
        mpesaCode: mpesa_reference || `MPESA_${Date.now()}`,
        description: `Ad wallet deposit - KSH ${amount.toFixed(2)}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const walletRef = db.collection("sellerAdCredits").doc(sellerId);
      const walletSnap = await walletRef.get();
      if (walletSnap.exists) {
        await walletRef.update({
          balance: admin.firestore.FieldValue.increment(amount),
          totalDeposited: admin.firestore.FieldValue.increment(amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await walletRef.set({
          sellerId, balance: amount, totalDeposited: amount,
          totalSpent: 0, reservedBalance: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      console.log(`💰 Wallet ${sellerId} +KSH ${amount}`);
    }

    // Email branch on COMPLETE for non-wallet orders
    if (state === "COMPLETE" && !isWalletRef(api_ref)) {
      let userEmail =
        orderData.userEmail ||
        orderData.shippingDetails?.email ||
        orderData.buyerEmail ||
        orderData.email;

      if (!userEmail && orderData.userId) {
        try {
          const u = await db.collection("users").doc(orderData.userId).get();
          if (u.exists) userEmail = u.data().email;
        } catch (_) {}
      }
      if (!userEmail && isTestRef(api_ref)) {
        userEmail = orderData.testEmail || process.env.TEST_RECEIPT_EMAIL || null;
      }

      if (!userEmail) {
        console.log(`⚠️ No email on order ${api_ref}, skipping receipt`);
      } else {
        const realEstate = isRealEstateOrder(api_ref, orderData);

        if (realEstate) {
          const payload = {
            ...orderData,
            totalAmount: orderData.totalAmount || callbackAmount || 0,
            mpesaReference: mpesa_reference || orderData.mpesaReference || "N/A",
            propertyTitle: orderData.propertyTitle,
            propertyLocation: orderData.propertyLocation,
            propertyType: orderData.propertyType,
            buyerName: orderData.buyerName || orderData.shippingDetails?.fullName,
            landlordName: orderData.landlordName,
            landlordPhone: orderData.landlordPhone,
          };
          sendRealEstatePaymentEmail(payload, userEmail, api_ref)
            .then((ok) => console.log(ok ? `🏠 RE receipt sent for ${api_ref}` : `❌ RE receipt failed for ${api_ref}`))
            .catch((e) => console.error("RE email error:", e));
        } else {
          sendOrderConfirmationEmail(orderData, userEmail, api_ref)
            .then((ok) => console.log(ok ? `✅ Confirmation sent for ${api_ref}` : `❌ Confirmation failed for ${api_ref}`))
            .catch((e) => console.error("Email error:", e));
        }
      }
    }

    return res.send("OK");
  } catch (e) {
    console.error("❌ Callback error:", e);
    return res.status(500).send("Callback processing failed");
  }
});

// --- Universal transaction lookup (used by all frontends for polling) ---
app.get("/api/ad-transaction/:paymentRef", async (req, res) => {
  const paymentRef = req.params.paymentRef;
  try {
    if (!paymentRef) return res.status(400).json({ success: false, message: "Missing paymentRef" });
    console.log(`🔍 Lookup: ${paymentRef}`);

    // 1. Orders by doc ID (store, wallet, real estate, test)
    const orderDoc = await db.collection("orders").doc(paymentRef).get();
    if (orderDoc.exists) {
      const orderData = orderDoc.data();
      console.log(`✅ Order found: paymentStatus=${orderData.paymentStatus}, isWalletDeposit=${!!orderData.isWalletDeposit}, isRealEstate=${!!orderData.isRealEstate}`);

      // Auto-heal wallet adTransaction
      if (orderData.paymentStatus === "paid" && orderData.isWalletDeposit && orderData.sellerId) {
        const adRef = db.collection("adTransactions").doc(paymentRef);
        const adSnap = await adRef.get();
        if (!adSnap.exists) {
          const amount = orderData.totalAmount || 1;
          await adRef.set({
            paymentRef, sellerId: orderData.sellerId,
            sellerEmail: orderData.sellerEmail || null,
            type: "deposit", amount, status: "completed",
            paymentMethod: "mpesa",
            mpesaCode: orderData.mpesaReference || "SYNCED",
            description: `Ad wallet deposit - KSH ${amount.toFixed(2)}`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`🔄 Auto-healed adTransaction ${paymentRef}`);
        }
      }

      return res.json({
        success: true,
        data: {
          ...orderData,
          status: orderData.paymentStatus === "paid" ? "completed" : orderData.paymentStatus,
          paymentStatus: orderData.paymentStatus,
        },
      });
    }

    // 2. adTransactions by doc ID
    const adTxDoc = await db.collection("adTransactions").doc(paymentRef).get();
    if (adTxDoc.exists) {
      const tx = adTxDoc.data();
      console.log(`✅ adTransaction found: status=${tx.status}`);
      return res.json({ success: true, data: tx });
    }

    console.log(`❌ Not found: ${paymentRef}`);
    return res.status(404).json({ success: false, message: "Transaction not found" });
  } catch (error) {
    console.error(`❌ Lookup failed for ${paymentRef}:`, error?.message || error);
    return res.status(500).json({ success: false, message: "Lookup failed", error: error?.message });
  }
});

// Alias for storefront (by invoiceId)
app.get("/api/transaction/:invoiceId", async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    if (!invoiceId) return res.status(400).json({ success: false, message: "Missing invoiceId" });
    const docs = await db.collection("orders").where("invoiceId", "==", invoiceId).get();
    if (docs.empty) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: docs.docs[0].data() });
  } catch (e) {
    return sendServerError(res, e, "Transaction lookup failed");
  }
});

// --- Seller withdrawal ---
app.post("/api/seller/withdraw", async (req, res) => {
  try {
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body || {};
    if (!sellerId) return res.status(400).json({ success: false, message: "Missing sellerId" });
    const amount = parsePositiveNumber(requestedAmount);
    if (!amount) return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber)) return res.status(400).json({ success: false, message: "Invalid phone" });

    const minFeeCheck = calculateTotalFee(amount);
    if (amount <= minFeeCheck) {
      return res.status(400).json({ success: false, message: `Amount must exceed fee KSH ${minFeeCheck.toFixed(2)}` });
    }

    const ordersSnap = await db.collection("orders")
      .where("involvedSellerIds", "array-contains", sellerId)
      .where("paymentStatus", "==", "paid")
      .get();

    let totalRevenue = 0;
    ordersSnap.forEach((doc) => {
      const items = doc.data().items;
      if (!items) return;
      const list = Array.isArray(items) ? items : Object.values(items);
      list.forEach((item) => {
        if (item?.sellerId === sellerId) {
          totalRevenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
        }
      });
    });

    const ledgerRef = db.collection("sellerLedgers").doc(sellerId);
    const ledgerSnap = await ledgerRef.get();
    const withdrawn = ledgerSnap.exists ? (ledgerSnap.data().totalWithdrawn || 0) : 0;
    const available = totalRevenue - withdrawn;

    if (available < amount) return res.status(400).json({ success: false, message: "Insufficient balance" });

    const feeAmount = calculateTotalFee(amount);
    const netPayout = +(amount - feeAmount).toFixed(2);
    if (netPayout <= 0) return res.status(400).json({ success: false, message: "Net payout is zero" });

    const wRef = db.collection("withdrawals").doc();
    await wRef.set({
      sellerId, amount, feeAmount, netPayout, phoneNumber,
      status: "PENDING_PAYOUT",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    let payout;
    try {
      payout = await intasend.payouts().mpesa({
        currency: "KES", requires_approval: "NO",
        transactions: [{
          name: "Seller Withdrawal", account: phoneNumber,
          amount: netPayout, narrative: "Seller Payout",
        }],
      });
    } catch (e) {
      await wRef.update({
        status: "PAYOUT_FAILED",
        intasendError: e?.response || e?.message || String(e),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({ success: false, message: "Payout provider error" });
    }

    await wRef.update({
      trackingId: payout?.tracking_id || null,
      status: "PAYOUT_INITIATED",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      intasendResponse: payout,
    });

    await ledgerRef.set({
      totalWithdrawn: admin.firestore.FieldValue.increment(amount),
      lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({
      success: true, message: "Withdrawal initiated",
      data: { requestedAmount: amount, fee: feeAmount, netPayout,
              trackingId: payout?.tracking_id || null, withdrawalId: wRef.id },
    });
  } catch (e) {
    console.error("Withdrawal error:", e);
    return sendServerError(res, e, "Withdrawal failed");
  }
});

// --- PIN recovery ---
app.post("/api/seller/recover-pin", async (req, res) => {
  try {
    const { email, userId } = req.body || {};
    if (!email || !userId) return res.status(400).json({ success: false, message: "Email and userId required" });

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found" });

    const u = userDoc.data();
    if (u.email && u.email !== email) return res.status(403).json({ success: false, message: "Email mismatch" });
    if (!u.withdrawalPin) return res.status(400).json({ success: false, message: "No PIN set" });

    const code = generateReplacementCode();
    if (!(await storeReplacementCode(userId, email, code))) {
      return res.status(500).json({ success: false, message: "Failed to generate code" });
    }

    await db.collection("securityLogs").add({
      userId, email, action: "PIN_RECOVERY_REQUESTED",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip, userAgent: req.get("User-Agent"),
    });

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2>Withdrawal PIN Recovery</h2>
        <p>You requested a PIN reset. Use this code:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#667eea;color:#fff;border-radius:12px">${code}</div>
        <p><strong>This code expires in 15 minutes.</strong></p>
        <p style="color:#856404">If you didn't request this, ignore this email.</p>
      </div>`;

    const ok = await sendEmail(email, "Your PIN Reset Code - MarketMix Kenya", html, "security");
    if (!ok) return res.json({ success: false, message: "Failed to send recovery code", emailSent: false });

    return res.json({ success: true, message: "Code sent", emailSent: true });
  } catch (e) {
    console.error("PIN recovery error:", e);
    return res.status(500).json({ success: false, message: "PIN recovery failed" });
  }
});

app.post("/api/seller/verify-recovery-code", async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ success: false, message: "userId and code required" });

    const v = await verifyReplacementCode(userId, code);
    if (!v.valid) return res.status(400).json({ success: false, message: v.message });

    await db.collection("securityLogs").add({
      userId, email: v.data.email, action: "PIN_RECOVERY_VERIFIED",
      timestamp: admin.firestore.FieldValue.serverTimestamp(), ipAddress: req.ip,
    });
    return res.json({ success: true, verified: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Verification failed" });
  }
});

app.post("/api/seller/reset-pin", async (req, res) => {
  try {
    const { userId, code, newPin, confirmPin } = req.body || {};
    if (!userId || !code || !newPin || !confirmPin) return res.status(400).json({ success: false, message: "All fields required" });
    if (newPin !== confirmPin) return res.status(400).json({ success: false, message: "PINs do not match" });
    if (newPin.length < 4 || !/^\d+$/.test(newPin)) return res.status(400).json({ success: false, message: "PIN must be 4+ digits" });

    const v = await verifyReplacementCode(userId, code);
    if (!v.valid) return res.status(400).json({ success: false, message: v.message });

    await db.collection("users").doc(userId).update({
      withdrawalPin: newPin,
      pinSetAt: admin.firestore.FieldValue.serverTimestamp(),
      pinSetMethod: "recovery",
      pinLastChanged: admin.firestore.FieldValue.serverTimestamp(),
    });

    await markCodeAsUsed(userId);
    await db.collection("securityLogs").add({
      userId, email: v.data.email, action: "PIN_RESET_SUCCESS",
      method: "recovery",
      timestamp: admin.firestore.FieldValue.serverTimestamp(), ipAddress: req.ip,
    });
    return res.json({ success: true, reset: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Reset failed" });
  }
});

// --- Stock update ---
app.post("/api/update-stock", async (req, res) => {
  try {
    const { productId, quantity } = req.body || {};
    if (!productId || typeof quantity !== "number" || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Invalid product or quantity" });
    }
    const pRef = db.collection("products").doc(productId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(pRef);
      if (!doc.exists) throw new Error("Product not found");
      const q = doc.data().quantity || 0;
      if (q < quantity) throw new Error("Not enough stock");
      t.update(pRef, { quantity: q - quantity });
    });
    return res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    return sendServerError(res, e, "Stock update failed");
  }
});

// --- Hugging Face image gen ---
app.post("/api/generate-ai-image", async (req, res) => {
  try {
    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt || prompt.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Invalid prompt" });
    }
    if (!process.env.HF_API_KEY) {
      return res.status(500).json({ success: false, message: "HF_API_KEY missing" });
    }
    const r = await fetch(
      "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "image/png",
        },
        body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ success: false, message: "HF provider error", providerStatus: r.status, providerBody: t.slice(0, 200) });
    }
    const ct = r.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await r.arrayBuffer());
    return res.json({ success: true, imageUrl: `data:${ct};base64,${buf.toString("base64")}` });
  } catch (e) {
    return res.status(500).json({ success: false, message: "AI generation failed", detail: e.message });
  }
});

// --- Test endpoints ---
app.get("/api/test-email-auth", async (req, res) => {
  res.json({
    success: !!BREVO_API_KEY,
    message: BREVO_API_KEY ? "Email authentication configured" : "BREVO_API_KEY not configured",
    senders: {
      security: "MarketMixKenya <security@marketmix.site>",
      sales: "MarketMixKenya <sales@marketmix.site>",
    },
  });
});

app.post("/api/test-proposal-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const html = `<p>Test proposal email</p>`;
  const ok = await sendEmail(testEmail, "Test Proposal Email", html, "sales");
  res.json({ success: ok, to: testEmail });
});

app.post("/api/test-real-estate-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const ref = "PROP_TEST_" + Date.now();
  const ok = await sendRealEstatePaymentEmail({
    propertyTitle: "Spacious Bedsitter - Kilimani",
    propertyLocation: "Kilimani, Nairobi",
    propertyType: "For Rent",
    totalAmount: 4000,
    mpesaReference: "TESTREF" + Math.floor(Math.random() * 1e6),
    buyerName: "Test Buyer",
    landlordName: "Test Landlord",
    landlordPhone: "254712345678",
  }, testEmail, ref);
  res.json({ success: ok, to: testEmail });
});

// --- Health ---
app.get("/_health", (req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    services: {
      firebase: true,
      brevo: !!BREVO_API_KEY,
      intasend: true,
      realEstate: "ready",
    },
    endpoints: [
      "/api/stk-push",
      "/api/store/seed",
      "/api/real-estate/seed",
      "/api/subscription-payment",
      "/api/seller/withdraw",
      "/api/seller/recover-pin",
      "/api/ad-transaction/:paymentRef",
      "/_health",
    ],
    uptime: process.uptime(),
  });
});

// 404
app.use((req, res) => res.status(404).json({ success: false, message: "Not Found" }));

// Errors
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));

// ============================
// Keep-alive (11pm–5am EAT pause)
// ============================
(function keepAlive() {
  const disable = process.env.KEEP_ALIVE === "0" || process.env.KEEP_ALIVE === "false";
  const enable = process.env.KEEP_ALIVE === "1" || process.env.KEEP_ALIVE === "true";
  const isProd = process.env.NODE_ENV === "production";
  if (!(enable || (isProd && !disable))) {
    console.log("🛑 Keep-alive disabled");
    return;
  }

  const INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000;
  const JITTER = Number(process.env.KEEP_ALIVE_JITTER_MS) || 30 * 1000;
  const TIMEOUT = Number(process.env.KEEP_ALIVE_REQUEST_TIMEOUT_MS) || 1000;
  let timer = null;
  let paused = false;

  const inPause = () => {
    const h = (new Date().getUTCHours() + 3) % 24;
    return h >= 23 || h < 5;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (inPause()) {
      if (!paused) { paused = true; console.log("🌙 Keep-alive paused until 5am EAT"); }
      timer = setTimeout(schedule, 5 * 60 * 1000);
      timer.unref?.();
      return;
    }
    if (paused) { paused = false; console.log("☀️ Keep-alive resumed"); }
    const j = Math.floor(Math.random() * (JITTER * 2 + 1)) - JITTER;
    timer = setTimeout(() => {
      if (!inPause()) {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: "/_health", method: "GET", timeout: TIMEOUT });
        req.on("timeout", () => req.destroy());
        req.on("error", () => {});
        req.end();
      }
      schedule();
    }, Math.max(1000, INTERVAL + j));
    timer.unref?.();
  };

  schedule();
  console.log("🌀 Smart keep-alive active (pauses 11pm–5am EAT)");
})();

// ============================
// Start
// ============================
const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📧 Brevo: ${BREVO_API_KEY ? "✅" : "❌"}`);
  console.log(`🌐 CORS origins: ${allowedOrigins.join(", ")}`);
  console.log(`🏠 Real estate: enabled (PROP_ prefix)`);
  console.log(`💰 Subscriptions: enabled (SUB_ prefix)`);
  console.log(`🪙 Wallet: enabled (WALLET_ prefix)`);
});

const shutdown = () => {
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

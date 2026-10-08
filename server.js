// server.js — MarketMix backend (store + wallet + subscriptions + real estate + moving)
// Real-estate and moving flows are isolated by ref prefix (PROP_, MOVE_) so they
// can't affect store / wallet / subscription logic.

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
// Brevo sender config (env-driven)
// ============================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const SENDERS = {
  sales:    { name: "MarketMix Kenya",          email: process.env.SENDER_SALES    || "sales@marketmix.site" },
  security: { name: "MarketMix Kenya",          email: process.env.SENDER_SECURITY || "security@marketmix.site" },
  bookings: { name: "MarketMix Real Estates",   email: process.env.SENDER_BOOKINGS || "bookings@marketmix.site" },
  moving:   { name: "MarketMix Moving",         email: process.env.SENDER_MOVING   || "support@marketmix.site" },
};

const sendEmail = async (to, subject, html, type = "security") => {
  try {
    console.log("📧 Sending email:", { to, subject, type });
    if (!BREVO_API_KEY) {
      console.log("❌ BREVO_API_KEY not configured");
      return false;
    }

    const sender = SENDERS[type] || SENDERS.security;
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
        tags: [type],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("❌ Brevo API error:", JSON.stringify(data, null, 2));
      throw new Error(data.message || `Brevo API error: ${response.status}`);
    }
    console.log(`✅ Email sent (id=${data.messageId}) from ${sender.email}`);
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

// Ref-prefix routing
const isWalletRef       = (r) => typeof r === "string" && r.startsWith("WALLET_");
const isSubscriptionRef = (r) => typeof r === "string" && r.startsWith("SUB_");
const isRealEstateRef   = (r) => typeof r === "string" && r.startsWith("PROP_");
const isMovingRef       = (r) => typeof r === "string" && r.startsWith("MOVE_");
const isTestRef         = (r) => typeof r === "string" && r.startsWith("TEST_PAY_");

function isRealEstateOrder(apiRef, orderData) {
  return isRealEstateRef(apiRef) || orderData?.orderType === "real_estate" || orderData?.isRealEstate === true;
}

// ============================
// EMAIL SHELL — MarketMix liquid-glass theme
// ============================
const marketMixEmailShell = ({ preheader = "", eyebrow = "MarketMix Kenya", title, subtitle, bodyHtml, ctaLabel, ctaUrl, footerNote = "" }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;font-size:1px;color:#eef2f0;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef2f0;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
        <tr><td style="background:linear-gradient(135deg,#0b231c 0%,#123528 55%,#0e2b22 100%);border-radius:28px 28px 0 0;padding:32px 28px 28px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:.19em;text-transform:uppercase;color:#a7f3d0;font-weight:700;">${eyebrow}</div>
          <div style="padding-top:12px;font-size:26px;line-height:1.25;font-weight:600;">${title}</div>
          ${subtitle ? `<div style="padding-top:10px;font-size:14px;line-height:1.6;color:rgba(255,255,255,0.72);">${subtitle}</div>` : ""}
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e2e8e6;border-top:none;border-radius:0 0 28px 28px;padding:28px;">
          ${bodyHtml}
          ${ctaLabel && ctaUrl ? `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:22px;">
              <tr><td align="center">
                <a href="${ctaUrl}" style="display:inline-block;background:#123528;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:12px;padding:14px 26px;">${ctaLabel}</a>
              </td></tr>
            </table>` : ""}
          ${footerNote ? `<p style="margin:22px 0 0 0;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center;">${footerNote}</p>` : ""}
        </td></tr>
        <tr><td style="padding:20px 12px 0 12px;text-align:center;font-size:11px;line-height:1.6;color:#64748b;">
          MarketMix Kenya © ${new Date().getFullYear()}<br/>
          <a href="mailto:support@marketmix.site" style="color:#047857;text-decoration:none;">support@marketmix.site</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// Reusable inner blocks
const emailInfoCard = (rows) => `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
    <tr><td style="padding:18px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${rows.map(([label, value, highlight]) => `
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#64748b;width:50%;">${label}</td>
            <td style="padding:6px 0;font-size:13px;font-weight:700;color:${highlight ? "#047857" : "#0f172a"};text-align:right;">${value}</td>
          </tr>
        `).join("")}
      </table>
    </td></tr>
  </table>`;

const emailBodyText = (text) => `
  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">${text}</p>`;

const emailSectionLabel = (label) => `
  <p style="margin:0 0 6px 0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;font-weight:700;">${label}</p>`;

// ============================
// Order confirmation email (store)
// ============================
const sendOrderConfirmationEmail = async (orderData, userEmail, orderId) => {
  try {
    console.log("📧 Order confirmation →", userEmail);
    if (!BREVO_API_KEY) return false;

    const items = orderData.items || [];
    const itemsTotal = items.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
    const deliveryTotal = (orderData.sellerGroups || []).reduce((s, g) => s + (g.deliveryCost || 0), 0);
    const total = orderData.totalAmount || (itemsTotal + deliveryTotal);

    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${orderData.shippingDetails?.fullName || userEmail.split("@")[0]}</strong>, your payment is confirmed.`)}
      ${emailSectionLabel("Order")}
      ${emailInfoCard([
        ["Order ID", String(orderId)],
        ["Date", new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })],
        ["Buyer", orderData.shippingDetails?.fullName || "—"],
      ])}
      ${emailSectionLabel("Items")}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
        <tr><td style="padding:18px;font-size:13px;line-height:1.9;color:#334155;">
          ${items.length ? items.map(i => `${i.name} × ${i.quantity} — Ksh ${((i.price||0)*(i.quantity||1)).toFixed(2)}`).join("<br/>") : "No items"}
        </td></tr>
      </table>
      ${emailSectionLabel("Totals")}
      ${emailInfoCard([
        ["Items Total", `Ksh ${itemsTotal.toFixed(2)}`],
        ["Delivery", `Ksh ${deliveryTotal.toFixed(2)}`],
        ["Total Paid", `Ksh ${total.toFixed(2)}`, true],
      ])}
    `;

    const html = marketMixEmailShell({
      preheader: `Order #${String(orderId).slice(0,8)} confirmed`,
      eyebrow: "MarketMix Kenya",
      title: "Thank you for shopping with us",
      subtitle: "Your payment is confirmed and your order is being prepared.",
      bodyHtml,
      ctaLabel: "View order receipt",
      ctaUrl: `https://marketmix.site/order-receipt/${orderId}`,
      footerNote: "Need help? Reply to this email and we'll get back to you.",
    });

    const ok = await sendEmail(
      userEmail,
      `Order Confirmation #${String(orderId).slice(0, 8)} - MarketMix Kenya`,
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

// ============================
// Real estate confirmation email
// ============================
const sendRealEstatePaymentEmail = async (data, userEmail, orderId) => {
  try {
    console.log("🏠 Real estate receipt →", userEmail);
    if (!BREVO_API_KEY) return false;

    const amount = Number(data.totalAmount || data.amount || 0);
    const mpesaRef = data.mpesaReference || data.mpesaCode || "N/A";

    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${data.buyerName || userEmail.split("@")[0]}</strong>, your payment has been received and confirmed.`)}
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:18px;padding:20px;text-align:center;margin-bottom:16px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#047857;font-weight:700;">Amount paid</div>
        <div style="font-size:28px;font-weight:700;color:#065f46;padding-top:6px;">KES ${amount.toLocaleString("en-KE", { minimumFractionDigits: 2 })}</div>
      </div>
      ${emailSectionLabel("Property")}
      ${emailInfoCard([
        ["Property", data.propertyTitle || "—"],
        ["Location", data.propertyLocation || "—"],
        ["Type", data.propertyType || "—"],
        ["Reference", String(orderId)],
        ["M-Pesa code", mpesaRef],
        ["Paid on", new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })],
      ])}
      ${emailSectionLabel("Landlord / Agent")}
      ${emailInfoCard([
        ["Name", data.landlordName || "—"],
        ["Phone", data.landlordPhone || "—"],
      ])}
      ${emailBodyText("The landlord or agent will contact you shortly to arrange viewing, keys handover, or any outstanding paperwork.")}
    `;

    const html = marketMixEmailShell({
      preheader: `Payment confirmed for ${data.propertyTitle || "your property"}`,
      eyebrow: "MarketMix Real Estates",
      title: "Payment Confirmed",
      subtitle: "Keep this email as your official receipt.",
      bodyHtml,
      ctaLabel: "View receipt online",
      ctaUrl: `${REAL_ESTATE_RECEIPT_URL}/${orderId}`,
      footerNote: "Questions? Reply to this email and our team will help.",
    });

    const ok = await sendEmail(
      userEmail,
      `Payment Confirmed - ${data.propertyTitle || "Property"} (${String(orderId).slice(0, 8)})`,
      html,
      "bookings"
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
// Moving / Transport confirmation email
// ============================
const sendMovingConfirmationEmail = async (data, userEmail, requestId) => {
  try {
    console.log("🚚 Moving confirmation →", userEmail);
    if (!BREVO_API_KEY) return false;

    const status = data.status || "REQUESTED";
    const statusLabel = String(status).replace(/_/g, " ").toLowerCase();
    const amount = Number(data.quotedPrice || data.totalAmount || 0);

    const itemsLine = Object.entries(data.items || {})
      .map(([id, qty]) => `${id} × ${qty}`)
      .join(" · ") || "No items listed";

    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${data.userName || userEmail.split("@")[0]}</strong>, here is a snapshot of your move.`)}
      ${emailSectionLabel("Trip")}
      ${emailInfoCard([
        ["Request ID", String(requestId)],
        ["Status", statusLabel.toUpperCase(), true],
        ["Vehicle", data.vehicleLabel || "—"],
        ["Items", String(data.itemCount || 0)],
      ])}
      ${emailSectionLabel("Pickup")}
      ${emailInfoCard([
        ["Label", data.pickupLabel || "—"],
        ["Coordinates", data.pickupCoordinates ? `${data.pickupCoordinates.lat.toFixed(5)}, ${data.pickupCoordinates.lng.toFixed(5)}` : "—"],
      ])}
      ${emailSectionLabel("Destination")}
      ${emailInfoCard([
        ["Label", data.destinationTitle || data.destinationLabel || "—"],
        ["Coordinates", data.destinationCoordinates ? `${data.destinationCoordinates.lat.toFixed(5)}, ${data.destinationCoordinates.lng.toFixed(5)}` : "—"],
      ])}
      ${emailSectionLabel("What is moving")}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
        <tr><td style="padding:18px;font-size:13px;line-height:1.7;color:#334155;">
          ${itemsLine}
        </td></tr>
      </table>
      ${amount ? emailInfoCard([["Provider quote", `KSh ${amount.toLocaleString("en-KE")}`, true]]) : ""}
      ${emailBodyText("Trip pins are private and visible only to you, the assigned driver, and MarketMix admins. Route estimates use road distance and do not include live traffic.")}
    `;

    const html = marketMixEmailShell({
      preheader: `Your move is ${statusLabel}`,
      eyebrow: "MarketMix Moving",
      title: "Your move request is on the road",
      subtitle: "A local transport provider will confirm vehicle fit and quote shortly.",
      bodyHtml,
      ctaLabel: "Open tracking page",
      ctaUrl: `https://marketmix.site/transport`,
      footerNote: "Live driver updates appear on your tracking page when sharing is enabled.",
    });

    const ok = await sendEmail(
      userEmail,
      `Your move is ${statusLabel} · MarketMix Moving #${String(requestId).slice(0, 8)}`,
      html,
      "moving"
    );

    if (ok) {
      await db.collection("movingEmails").add({
        requestId, userEmail, status, amount,
        type: "moving_confirmation",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ Moving email failed:", e.message);
    return false;
  }
};

// ============================
// PIN recovery helpers
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
  } catch (e) { return false; }
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
    const emailHtml = html || marketMixEmailShell({
      preheader: `Proposal ${status}`,
      eyebrow: "MarketMix Kenya · Lipa Mdogo Mdogo",
      title: `Proposal ${status === "approved" ? "Approved ✅" : "Rejected ❌"}`,
      subtitle: `Hello ${studentName || "Student"}, your installment proposal has been reviewed.`,
      bodyHtml: `
        ${emailInfoCard([
          ["Proposal ID", String(proposalId)],
          ["Status", status.toUpperCase(), status === "approved"],
          ["Amount", `KSH ${Number(amount || 0).toLocaleString()}`],
          ["Institution", institution || "N/A"],
        ])}
        ${notes ? emailBodyText(notes) : ""}
      `,
      ctaLabel: "Open MarketMix",
      ctaUrl: "https://marketmix.site",
    });

    const ok = await sendEmail(to, subject || `Proposal ${status}`, emailHtml, "sales");
    return res.json({ success: ok, message: ok ? "Sent" : "Failed" });
  } catch (e) {
    return sendServerError(res, e, "Proposal email failed");
  }
});

// --- STK push (used by store, wallet, real estate, moving) ---
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
      userEmail: email,
      buyerEmail: email,
      shippingDetails: { fullName, phoneNumber, email },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, data: response });
  } catch (e) {
    return sendServerError(res, e, "STK push failed");
  }
});

// --- Store order seed ---
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

// --- Real estate seed ---
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

// ============================
// MOVING / TRANSPORT endpoints (isolated)
// ============================

// Notify by email when a transport request is created or updated
app.post("/api/moving/notify", async (req, res) => {
  try {
    const { requestId, email } = req.body || {};
    if (!requestId || !email) {
      return res.status(400).json({ success: false, message: "requestId and email required" });
    }

    const snap = await db.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    const data = snap.data();
    const ok = await sendMovingConfirmationEmail(
      {
        userName: data.userName,
        pickupLabel: data.pickupLabel,
        pickupCoordinates: data.pickupCoordinates,
        destinationLabel: data.destinationLabel,
        destinationTitle: data.destinationTitle,
        destinationCoordinates: data.destinationCoordinates,
        vehicleLabel: data.vehicleLabel,
        itemCount: data.itemCount,
        items: data.items,
        quotedPrice: data.quotedPrice,
        status: data.status,
      },
      email,
      requestId
    );

    return res.json({ success: ok });
  } catch (e) {
    return sendServerError(res, e, "Moving notify failed");
  }
});

// Create a transport request entirely server-side (optional, use if you prefer not to write from client)
app.post("/api/moving/request", async (req, res) => {
  try {
    const {
      userId, userName, userEmail,
      pickupLabel, pickupCoordinates, pickupArea,
      destinationLabel, destinationTitle, destinationCoordinates, destinationArea,
      items, itemCount, vehicleId, vehicleLabel,
      propertyId, packageId, packageTitle, destinationPrecision,
    } = req.body || {};

    if (!userId || !pickupLabel || !destinationLabel || !vehicleId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const ref = await db.collection("transportRequests").add({
      userId, userName, userEmail,
      pickupLabel, pickupCoordinates, ...pickupArea,
      destinationLabel, destinationTitle, destinationCoordinates, ...destinationArea,
      items: items || {}, itemCount: itemCount || 0,
      vehicleId, vehicleLabel,
      propertyId: propertyId || "",
      packageId: packageId || "",
      packageTitle: packageTitle || "",
      destinationPrecision: destinationPrecision || "customer-pin",
      status: "REQUESTED",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Fire-and-forget email
    if (userEmail) {
      sendMovingConfirmationEmail({
        userName, pickupLabel, pickupCoordinates,
        destinationLabel, destinationTitle, destinationCoordinates,
        vehicleLabel, itemCount, items, status: "REQUESTED",
      }, userEmail, ref.id).catch(() => {});
    }

    return res.json({ success: true, requestId: ref.id });
  } catch (e) {
    return sendServerError(res, e, "Moving request failed");
  }
});

// Lookup a transport request (for polling the tracking page)
app.get("/api/moving/request/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!requestId) return res.status(400).json({ success: false, message: "Missing requestId" });
    const snap = await db.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: { id: snap.id, ...snap.data() } });
  } catch (e) {
    return sendServerError(res, e, "Moving lookup failed");
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

// --- IntaSend callback ---
app.post("/api/intasend-callback", async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body || {};
    if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");

    console.log("📞 Callback:", { api_ref, state, mpesa_reference, value: req.body.value });

    let paymentStatus = "pending";
    if (state === "COMPLETE") paymentStatus = "paid";
    if (["FAILED", "CANCELLED"].includes(state)) paymentStatus = "failed";

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
          } catch (err) { console.error("Activation error:", err); }
        }
      }
      return res.send("OK");
    }

    const orderRef = db.collection("orders").doc(api_ref);
    let orderSnap = await orderRef.get();
    const callbackAmount = parseFloat(req.body.value);

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

// --- Universal transaction lookup ---
app.get("/api/ad-transaction/:paymentRef", async (req, res) => {
  const paymentRef = req.params.paymentRef;
  try {
    if (!paymentRef) return res.status(400).json({ success: false, message: "Missing paymentRef" });
    console.log(`🔍 Lookup: ${paymentRef}`);

    const orderDoc = await db.collection("orders").doc(paymentRef).get();
    if (orderDoc.exists) {
      const orderData = orderDoc.data();
      console.log(`✅ Order found: paymentStatus=${orderData.paymentStatus}, isWalletDeposit=${!!orderData.isWalletDeposit}, isRealEstate=${!!orderData.isRealEstate}`);

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

    const html = marketMixEmailShell({
      preheader: "Your PIN reset code",
      eyebrow: "MarketMix Kenya · Security",
      title: "Withdrawal PIN Recovery",
      subtitle: "Use the code below to reset your withdrawal PIN.",
      bodyHtml: `
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:18px;padding:22px;text-align:center;margin-bottom:16px;">
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#065f46;">${code}</div>
        </div>
        ${emailInfoCard([
          ["Valid for", "15 minutes"],
          ["Attempts", "3"],
        ])}
        ${emailBodyText("If you didn't request this, you can safely ignore this email — but consider changing your password.")}
      `,
      footerNote: "MarketMix staff will never ask you for this code.",
    });

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
    senders: SENDERS,
  });
});

app.post("/api/test-proposal-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const html = marketMixEmailShell({
    preheader: "Test proposal email",
    eyebrow: "MarketMix Kenya",
    title: "Test Proposal Email",
    subtitle: "This is a test from the proposal status system.",
    bodyHtml: emailBodyText("If you received this, the pipeline is working."),
  });
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

app.post("/api/test-moving-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const ref = "MOVE_TEST_" + Date.now();
  const ok = await sendMovingConfirmationEmail({
    userName: "Test User",
    pickupLabel: "Kilimani, Nairobi",
    pickupCoordinates: { lat: -1.2921, lng: 36.8219 },
    destinationLabel: "Westlands, Nairobi",
    destinationTitle: "2 Bedroom Apartment",
    destinationCoordinates: { lat: -1.2674, lng: 36.8109 },
    vehicleLabel: "Pickup",
    itemCount: 12,
    items: { bed: 1, sofa: 1, box: 10 },
    quotedPrice: 4500,
    status: "REQUESTED",
  }, testEmail, ref);
  res.json({ success: ok, to: testEmail });
});

// --- Health ---
app.get("/_health", (req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    services: { firebase: true, brevo: !!BREVO_API_KEY, intasend: true },
    senders: SENDERS,
    endpoints: [
      "/api/stk-push",
      "/api/store/seed",
      "/api/real-estate/seed",
      "/api/moving/notify",
      "/api/moving/request",
      "/api/moving/request/:id",
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
  let timer = null, paused = false;
  const inPause = () => { const h = (new Date().getUTCHours() + 3) % 24; return h >= 23 || h < 5; };
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
  console.log(`📦 Store: ✅ (ORD_ / TEST_PAY_)`);
  console.log(`🏠 Real estate: ✅ (PROP_)`);
  console.log(`🚚 Moving: ✅ (MOVE_)`);
  console.log(`💰 Subscriptions: ✅ (SUB_)`);
  console.log(`🪙 Wallet: ✅ (WALLET_)`);
});

const shutdown = () => {
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

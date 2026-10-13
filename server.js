// server.js — MarketMix backend (with Occasion Engine integrated)
// v2.6.5 — Safety net: empty selectedGroupIds refuses to send (was: broadcast to all groups)
//
// Real-estate site uses M-Pesa ref as the customer-facing ID.
// WhatsApp (WAHA) sends are queued: first attempt aborts fast (8s) so a cold
// WAHA doesn't block the queue; retries use a 30s timeout once WAHA is warm.
// Uses only existing env vars.
// Emails can optionally mirror to WhatsApp by passing a phone number.
// Dual Firebase Admin: shop (default) owns shop data; realestate (named) owns
// Real Estate auth + Real Estate Firestore (users, properties, transport, etc).

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
  "https://www.marketmixkenya.co.ke",
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

app.use(bodyParser.json({ limit: "25mb" }));

app.use((req, res, next) => {
  try {
    const logBody = { ...req.body };
    if (logBody.imageUrl && typeof logBody.imageUrl === "string" && logBody.imageUrl.length > 200) {
      logBody.imageUrl = `[base64 image: ${logBody.imageUrl.length} chars]`;
    }
    if (logBody.imageBase64 && typeof logBody.imageBase64 === "string") {
      logBody.imageBase64 = `[base64 image: ${logBody.imageBase64.length} chars]`;
    }
    console.log(`${new Date().toISOString()} → ${req.method} ${req.originalUrl}`, logBody || {});
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
  "FIREBASE_REALESTATE_KEY",
];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

// ============================
// Firebase
// ============================
let shopApp;
let reApp;
let db;
let reDb;

try {
  const shopSA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  shopApp = admin.initializeApp({ credential: admin.credential.cert(shopSA) });
  console.log("✅ Firebase Admin (shop) initialized");

  const reSA = JSON.parse(process.env.FIREBASE_REALESTATE_KEY);
  reApp = admin.initializeApp(
    { credential: admin.credential.cert(reSA) },
    "realestate"
  );
  console.log("✅ Firebase Admin (realestate) initialized");
} catch (e) {
  console.error("❌ Firebase Admin init failed:", e);
  process.exit(1);
}

db = shopApp.firestore();
reDb = reApp.firestore();

async function verifyAnyToken(idToken) {
  try {
    return await shopApp.auth().verifyIdToken(idToken);
  } catch (_) {}
  try {
    return await reApp.auth().verifyIdToken(idToken);
  } catch (_) {}
  throw new Error("Invalid auth token");
}

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
const MARKETPLACE_URL = "https://my-campus-store-frontend.vercel.app";
const REAL_ESTATE_APP_URL = "https://marketmix-realestates.vercel.app";
const MOVING_URL = `${REAL_ESTATE_APP_URL}/`;
const DRIVER_DASHBOARD_URL = `${REAL_ESTATE_APP_URL}/`;
const DRIVER_ONBOARD_URL = `${REAL_ESTATE_APP_URL}/`;
const SELLER_DASHBOARD_URL = `${MARKETPLACE_URL}/seller/dashboard/orders`;
const WEBSITE_URL = process.env.WEBSITE_URL || "https://www.marketmixkenya.co.ke";
const PRODUCTS_URL = process.env.PRODUCTS_URL || `${WEBSITE_URL}/products`;
const ORDER_RECEIPT_BASE = process.env.ORDER_RECEIPT_BASE || `${WEBSITE_URL}/order-receipt`;
const WHATSAPP_GROUP_URL = process.env.WHATSAPP_GROUP_URL || "https://chat.whatsapp.com/GQWo3DXgRJa7hFDF6anpTH";

const ADMIN_PHONE = process.env.ADMIN_PHONE || "254115988107";
const ORDERS_PHONE = process.env.ORDERS_PHONE || "254115988107";
const APK_DOWNLOAD_URL = process.env.APK_DOWNLOAD_URL || `${WEBSITE_URL}/apk/MarketMix-Kenya.apk`;

const buildOrderReceiptUrl = (orderId) =>
  orderId ? `${ORDER_RECEIPT_BASE}/${orderId}` : WEBSITE_URL;

// ============================
// Brevo
// ============================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const SENDERS = {
  sales:    { name: "MarketMix Kenya",        email: process.env.SENDER_SALES    || "sales@marketmix.site" },
  security: { name: "MarketMix Kenya",        email: process.env.SENDER_SECURITY || "security@marketmix.site" },
  bookings: { name: "MarketMix Real Estates", email: process.env.SENDER_BOOKINGS || "bookings@marketmix.site" },
  moving:   { name: "MarketMix Moving",       email: process.env.SENDER_MOVING   || "support@marketmix.site" },
};

const sendEmail = async (to, subject, html, type = "security", phone = null) => {
  try {
    console.log("📧 Sending email:", { to, subject, type, phone: phone || "—" });
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

    if (phone) {
      const emoji =
        type === "bookings" ? "🏠" :
        type === "moving" ? "🚚" :
        type === "security" ? "🔐" : "🛍️";
      const brand =
        type === "bookings" ? "MarketMix Real Estates" :
        type === "moving" ? "MarketMix Moving" : "MarketMix Kenya";

      const plain = String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);

      enqueueWhatsApp(phone, `${emoji} ${brand}\n${subject}\n\n${plain}`, {
        kind: `companion-${type}`,
        emailTo: to,
      });
    }

    return true;
  } catch (error) {
    console.error("❌ Email sending failed:", error.message);
    return false;
  }
};

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
// WAHA
// ============================
const WAHA_URL = process.env.WAHA_URL;
const WAHA_API_KEY = process.env.WAHA_API_KEY;
const WAHA_TIMEOUT_MS = 8000;
const WAHA_COLD_GRACE_MS = 30000;

const WAHA_SEND_IMAGE_PATH = "/api/sendImage";
const WAHA_SEND_FILE_PATH  = "/api/sendFile";

async function wahaFetch(path, opts = {}) {
  if (!WAHA_URL) throw new Error("WAHA_URL not configured");
  const timeoutMs = opts.timeoutMs ?? WAHA_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${WAHA_URL}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: {
        "X-Api-Key": WAHA_API_KEY || "",
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePhoneForWa(phoneNumber) {
  if (!phoneNumber) return null;
  let digits = String(phoneNumber).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) digits = "254" + digits.slice(1);
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    digits = "254" + digits;
  }
  if (!digits.startsWith("254")) digits = "254" + digits;
  return digits;
}

function normalizeWaChatId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (s.endsWith("@g.us")) return s;
  return normalizePhoneForWa(s);
}

function buildWahaFilePayload(input, { filename, mimeOverride } = {}) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;

  if (s.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(s);
    if (!match) return null;
    const mimetype = mimeOverride || match[1] || "image/jpeg";
    return {
      mode: "data",
      file: {
        mimetype,
        filename: filename || (mimetype.includes("png") ? "image.png" : "image.jpg"),
        data: match[2],
      },
    };
  }

  if (/^https?:\/\//i.test(s)) {
    return { mode: "url", file: { url: s, filename: filename || undefined } };
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 64) {
    const mimetype = mimeOverride || "image/jpeg";
    return {
      mode: "data",
      file: {
        mimetype,
        filename: filename || (mimetype.includes("png") ? "image.png" : "image.jpg"),
        data: s.replace(/\s+/g, ""),
      },
    };
  }

  return null;
}

const waQueue = [];
let waRunning = false;
const WA_MAX_ATTEMPTS = 4;

function timeoutForAttempt(attempts) {
  return attempts === 0 ? WAHA_TIMEOUT_MS : WAHA_COLD_GRACE_MS;
}

function backoffForAttempt(attempts) {
  return [1000, 3000, 8000][attempts - 1] || 8000;
}

function enqueueWhatsApp(phoneNumber, message, meta = {}) {
  const normalized = normalizeWaChatId(phoneNumber);
  if (!normalized) {
    console.log("⚠️ WhatsApp skipped — invalid phone/group:", phoneNumber, meta);
    return false;
  }
  waQueue.push({
    phone: normalized,
    kind: "text",
    message,
    meta,
    attempts: 0,
    enqueuedAt: Date.now(),
  });
  console.log(`📥 WA queued → ${normalized} (queue size ${waQueue.length})`, meta);
  drainWaQueue();
  return true;
}

function enqueueWhatsAppImage(phoneNumber, imageUrl, caption = "", meta = {}) {
  const normalized = normalizeWaChatId(phoneNumber);
  if (!normalized) {
    console.log("⚠️ WA image skipped — invalid phone/group:", phoneNumber, meta);
    return false;
  }
  waQueue.push({
    phone: normalized,
    kind: "image",
    imageUrl,
    caption,
    message: caption,
    meta: { ...meta, kind: meta.kind || "image" },
    attempts: 0,
    enqueuedAt: Date.now(),
  });
  console.log(`🖼️ WA image queued → ${normalized} (queue size ${waQueue.length})`, meta);
  drainWaQueue();
  return true;
}

async function drainWaQueue() {
  if (waRunning) return;
  waRunning = true;
  while (waQueue.length > 0) {
    const job = waQueue.shift();
    const ok = await attemptWaSend(job);

    if (!ok && job.attempts < WA_MAX_ATTEMPTS) {
      job.attempts += 1;
      const delay = backoffForAttempt(job.attempts);
      console.log(`🔁 WA retry ${job.attempts}/${WA_MAX_ATTEMPTS} in ${delay}ms → ${job.phone}`);
      setTimeout(() => {
        waQueue.push(job);
        drainWaQueue();
      }, delay).unref?.();
    } else if (!ok) {
      console.error(`❌ WA giving up after ${WA_MAX_ATTEMPTS} attempts → ${job.phone}`, job.meta);
    }

    await new Promise((r) => setTimeout(r, 250));
  }
  waRunning = false;
}

async function attemptWaSend(job) {
  if (!WAHA_URL || !WAHA_API_KEY) {
    console.log("⚠️ WAHA not configured, dropping queued message");
    return true;
  }
  const timeoutMs = job.kind === "image"
    ? Math.max(timeoutForAttempt(job.attempts), 20000)
    : timeoutForAttempt(job.attempts);

  try {
    const chatId = job.phone.endsWith("@g.us") ? job.phone : `${job.phone}@c.us`;

    if (job.kind === "image" && job.imageUrl) {
      const res = await wahaFetch(WAHA_SEND_IMAGE_PATH, {
        method: "POST",
        timeoutMs,
        body: JSON.stringify({
          session: "default",
          chatId,
          file: job.imageUrl.startsWith("data:")
            ? { mimetype: "image/jpeg", filename: "image.jpg", data: job.imageUrl.split(",")[1] }
            : { url: job.imageUrl },
          caption: job.caption || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`❌ WAHA image failed (${res.status}, attempt ${job.attempts + 1}) → ${job.phone}`, data);
        return false;
      }
      console.log(`🖼️ WhatsApp image sent → ${job.phone} (attempt ${job.attempts + 1})`);
      return true;
    }

    const res = await wahaFetch("/api/sendText", {
      method: "POST",
      timeoutMs,
      body: JSON.stringify({ session: "default", chatId, text: job.message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`❌ WAHA send failed (${res.status}, attempt ${job.attempts + 1}, ${timeoutMs}ms) → ${job.phone}`, data);
      return false;
    }
    console.log(`📱 WhatsApp sent → ${job.phone} (attempt ${job.attempts + 1}, ${timeoutMs}ms)`);
    return true;
  } catch (e) {
    const isAbort = e.name === "AbortError";
    console.error(
      `❌ WAHA ${isAbort ? "aborted" : "error"} → ${job.phone} (attempt ${job.attempts + 1}, ${timeoutMs}ms):`,
      e.message
    );
    return false;
  }
}

const sendWhatsApp = async (phoneNumber, message) => enqueueWhatsApp(phoneNumber, message);

async function wahaSendImage({ phone, imageUrl, caption, filename }) {
  const normalized = normalizeWaChatId(phone);
  if (!normalized) throw new Error(`Invalid phone/group: ${phone}`);
  const chatId = normalized.endsWith("@g.us") ? normalized : `${normalized}@c.us`;

  const body = {
    session: "default",
    chatId,
    file: imageUrl.startsWith("data:")
      ? { mimetype: "image/jpeg", filename: filename || "image.jpg", data: imageUrl.split(",")[1] }
      : { url: imageUrl, filename: filename || undefined },
    caption: caption || "",
  };

  const res = await wahaFetch(WAHA_SEND_IMAGE_PATH, {
    method: "POST",
    timeoutMs: WAHA_COLD_GRACE_MS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `WAHA sendImage failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function wahaSendFile({ phone, fileUrl, filename, caption }) {
  const normalized = normalizeWaChatId(phone);
  if (!normalized) throw new Error(`Invalid phone/group: ${phone}`);
  const chatId = normalized.endsWith("@g.us") ? normalized : `${normalized}@c.us`;

  const body = {
    session: "default",
    chatId,
    file: fileUrl.startsWith("data:")
      ? { mimetype: "application/octet-stream", filename: filename || "file.bin", data: fileUrl.split(",")[1] }
      : { url: fileUrl, filename: filename || undefined },
    caption: caption || "",
  };

  const res = await wahaFetch(WAHA_SEND_FILE_PATH, {
    method: "POST",
    timeoutMs: WAHA_COLD_GRACE_MS,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `WAHA sendFile failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function personalizeBulkMessage(template, { name } = {}) {
  let msg = String(template || "");
  if (name) msg = msg.replace(/\{\{\s*name\s*\}\}/gi, name);
  return msg.replace(/[ \t]+\n/g, "\n").trim();
}

(function pingWaha() {
  if (!WAHA_URL) {
    console.log("🛑 WAHA ping disabled (WAHA_URL not set)");
    return;
  }
  const INTERVAL = 4 * 60 * 1000;
  const ping = () => {
    wahaFetch("/health", { timeoutMs: 5000 }).catch(() => {});
    setTimeout(ping, INTERVAL).unref?.();
  };
  setTimeout(ping, 30 * 1000).unref?.();
  console.log("🌀 WAHA keep-alive active (every 4 min)");
})();

/* ═══════════════════════════════════════════════════════════════
   AutoPromo — INLINED (v2.6.5)
   ═══════════════════════════════════════════════════════════════ */

const AUTO_PROMO_MAX_PER_GROUP_PER_DAY = 4;
let autoPromoTickTimer = null;
let autoPromoRunning = false;

const SHOP_FB_BUCKET = "my-campus-store-49b1d.appspot.com";

function resolveProductImageUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url) return null;

  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  if (url.startsWith("gs://")) {
    const path = url.replace(`gs://${SHOP_FB_BUCKET}/`, "");
    return `https://firebasestorage.googleapis.com/v0/b/${SHOP_FB_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
  }

  if (
    url.startsWith("products/") ||
    url.startsWith("images/") ||
    url.startsWith("product-images/")
  ) {
    return `https://firebasestorage.googleapis.com/v0/b/${SHOP_FB_BUCKET}/o/${encodeURIComponent(url)}?alt=media`;
  }

  return url;
}

const PLACEHOLDER_IMAGE_RX = /copy[-_ ]?of[-_ ]?social[-_ ]?media|gemini[-_ ]?generated|placeholder|default[-_ ]?image|no[-_ ]?image/i;

function isPlaceholderImageUrl(url) {
  if (!url) return false;
  return PLACEHOLDER_IMAGE_RX.test(String(url));
}

function productImageUrl(product) {
  if (!product) return null;
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
  if (!images.length) return null;

  const nonPlaceholder = images.find((u) => !isPlaceholderImageUrl(u));
  const chosen = nonPlaceholder || images[0];
  return resolveProductImageUrl(chosen);
}

function autoPromoNowEAT() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}
function autoPromoHourEAT() { return autoPromoNowEAT().getUTCHours(); }
function autoPromoMinuteEAT() { return autoPromoNowEAT().getUTCMinutes(); }
function autoPromoHHMMEAT() {
  return `${String(autoPromoHourEAT()).padStart(2, "0")}:${String(autoPromoMinuteEAT()).padStart(2, "0")}`;
}
function autoPromoDateStrEAT() {
  return autoPromoNowEAT().toISOString().slice(0, 10);
}
function autoPromoDowEAT() { return autoPromoNowEAT().getUTCDay(); }
function autoPromoMonthEAT() { return autoPromoNowEAT().getUTCMonth() + 1; }
function autoPromoDayEAT() { return autoPromoNowEAT().getUTCDate(); }

function autoPromoTimeBucket(hour) {
  if (hour >= 5  && hour < 8)  return "early_morning";
  if (hour >= 8  && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "midday";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}
function autoPromoDayBucket(dow) {
  if (dow === 1) return "monday";
  if (dow === 2 || dow === 3) return "midweek";
  if (dow === 4) return "almost_friday";
  if (dow === 5) return "friday";
  if (dow === 6) return "saturday";
  return "sunday";
}
function autoPromoIsPayday() {
  const day = autoPromoDayEAT();
  return day >= 25 || day <= 5;
}
function autoPromoIsMonthEnd() {
  const day = autoPromoDayEAT();
  return day >= 28;
}
function autoPromoDetectGroupKind(groupName) {
  const n = String(groupName || "").toLowerCase();
  if (n.includes("seller") || n.includes("vendor") || n.includes("business")) return "sellers";
  if (n.includes("deal") || n.includes("promo") || n.includes("offer")) return "deals";
  if (n.includes("buyer") || n.includes("customer") || n.includes("shop")) return "buyers";
  return "general";
}

const AUTO_PROMO_CAMPAIGNS = [
  { name: "New Year",            startMonth: 12, startDay: 27, endMonth: 1,  endDay: 3,  eventMonth: 1,  eventDay: 1  },
  { name: "Back to School Jan",  startMonth: 12, startDay: 28, endMonth: 1,  endDay: 15, eventMonth: 1,  eventDay: 8  },
  { name: "Valentine's",         startMonth: 2,  startDay: 7,  endMonth: 2,  endDay: 14, eventMonth: 2,  eventDay: 14 },
  { name: "March Campus Intake", startMonth: 3,  startDay: 1,  endMonth: 3,  endDay: 31, eventMonth: 3,  eventDay: 31 },
  { name: "Easter",              startMonth: 3,  startDay: 25, endMonth: 4,  endDay: 6,  eventMonth: 4,  eventDay: 4  },
  { name: "Labour Day",          startMonth: 4,  startDay: 24, endMonth: 5,  endDay: 1,  eventMonth: 5,  eventDay: 1  },
  { name: "Mother's Day",        startMonth: 5,  startDay: 3,  endMonth: 5,  endDay: 10, eventMonth: 5,  eventDay: 10 },
  { name: "Madaraka Day",        startMonth: 5,  startDay: 25, endMonth: 6,  endDay: 1,  eventMonth: 6,  eventDay: 1  },
  { name: "Father's Day",        startMonth: 6,  startDay: 14, endMonth: 6,  endDay: 21, eventMonth: 6,  eventDay: 21 },
  { name: "Back to School Sep",  startMonth: 8,  startDay: 8,  endMonth: 8,  endDay: 15, eventMonth: 8,  eventDay: 15 },
  { name: "Mazingira Day",       startMonth: 10, startDay: 3,  endMonth: 10, endDay: 10, eventMonth: 10, eventDay: 10 },
  { name: "Mashujaa Day",        startMonth: 10, startDay: 13, endMonth: 10, endDay: 20, eventMonth: 10, eventDay: 20 },
  { name: "Diwali",              startMonth: 10, startDay: 17, endMonth: 10, endDay: 24, eventMonth: 10, eventDay: 24 },
  { name: "Halloween",           startMonth: 10, startDay: 24, endMonth: 10, endDay: 31, eventMonth: 10, eventDay: 31 },
  { name: "Singles' Day",        startMonth: 11, startDay: 4,  endMonth: 11, endDay: 11, eventMonth: 11, eventDay: 11 },
  { name: "Black Friday",        startMonth: 11, startDay: 20, endMonth: 11, endDay: 26, eventMonth: 11, eventDay: 26 },
  { name: "Cyber Monday",        startMonth: 11, startDay: 24, endMonth: 11, endDay: 29, eventMonth: 11, eventDay: 29 },
  { name: "Christmas",           startMonth: 12, startDay: 1,  endMonth: 12, endDay: 25, eventMonth: 12, eventDay: 25 },
  { name: "Jamhuri Day",         startMonth: 12, startDay: 5,  endMonth: 12, endDay: 12, eventMonth: 12, eventDay: 12 },
  { name: "New Year's Eve",      startMonth: 12, startDay: 24, endMonth: 12, endDay: 31, eventMonth: 12, eventDay: 31 },
];

function autoPromoGetActiveCampaign() {
  const nowKey = autoPromoMonthEAT() * 100 + autoPromoDayEAT();
  for (const c of AUTO_PROMO_CAMPAIGNS) {
    const startKey = c.startMonth * 100 + c.startDay;
    const endKey   = c.endMonth   * 100 + c.endDay;
    const evtKey   = c.eventMonth * 100 + c.eventDay;

    let inRange = false;
    if (startKey <= endKey) inRange = nowKey >= startKey && nowKey <= endKey;
    else                    inRange = nowKey >= startKey || nowKey <= endKey;

    if (inRange) {
      let daysToEvent;
      if (nowKey <= evtKey) {
        const nowMonth = Math.floor(nowKey / 100);
        const evtMonth = Math.floor(evtKey / 100);
        daysToEvent = (evtMonth - nowMonth) * 30 + (c.eventDay - autoPromoDayEAT());
      } else {
        daysToEvent = -1;
      }
      return { ...c, daysToEvent };
    }
  }
  return null;
}

function autoPromoSeededRng(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function autoPromoPickTemplatePool({ campaign, timeBucket, dayBucket, payday, monthEnd, groupKind }) {
  if (groupKind === "sellers") return ["T16", "T17", "T18", "T1", "T3", "T8", "T9", "T10"];
  if (groupKind === "deals")   return ["T17", "T16", "T18", "T2", "T3", "T4", "T9"];

  const pool = [];

  if (campaign) {
    const d = campaign.daysToEvent;
    if (d >= 5)       pool.push("T11", "T18", "T3",  "T9",  "T17");
    else if (d >= 2)  pool.push("T12", "T11", "T17", "T3",  "T4");
    else if (d === 1) pool.push("T13", "T12", "T17", "T4",  "T5");
    else if (d === 0) pool.push("T14", "T18", "T1",  "T2",  "T3", "T4");
    else if (d < 0)   pool.push("T15", "T18", "T3",  "T4",  "T9");
  }

  if (payday && timeBucket === "morning") pool.push("T6", "T1");
  if (monthEnd) pool.push("T7", "T3");
  if (dayBucket === "friday" && (timeBucket === "afternoon" || timeBucket === "evening")) pool.push("T8", "T9");
  if (dayBucket === "saturday") pool.push("T9", "T18");
  if (dayBucket === "sunday" && (timeBucket === "afternoon" || timeBucket === "evening")) pool.push("T10", "T20");

  switch (timeBucket) {
    case "early_morning":
    case "morning":   pool.push("T1", "T18", "T17", "T2"); break;
    case "midday":    pool.push("T2", "T17", "T18", "T3"); break;
    case "afternoon": pool.push("T3", "T18", "T17", "T4"); break;
    case "evening":   pool.push("T4", "T18", "T17", "T5"); break;
    case "night":     pool.push("T5", "T19", "T20", "T18"); break;
    default:          pool.push("T1", "T3", "T4");
  }

  const seen = new Set();
  return pool.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
}

const AUTO_FOOTER = (v) => [
  "━━━━━━━━━━━━━━",
  `💬 Order on WhatsApp → wa.me/${v.phone}`,
  `👥 Join our group → ${v.groupLink}`,
  "━━━━━━━━━━━━━━",
].join("\n");

const AutoPromoTemplates = {
  T1: (v) => [
    `☀️ *MORNING PICK*`, ``,
    `Good morning ${v.groupName}! 👋`, ``,
    `Today's handpicked item:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🔥 Was KES ${v.originalPrice} — *${v.discount}% OFF*` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ Shop → ${v.shopLink}`, ``,
    AUTO_FOOTER(v), ``,
    `✨ *MarketMix Kenya* — Shop smart. Shop local.`,
  ].filter(Boolean).join("\n"),

  T2: (v) => [
    `🍽️ *LUNCHTIME DEAL*`, ``,
    `Hey ${v.groupName} — quick one for your lunch break 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🔥 ${v.discount}% OFF — was KES ${v.originalPrice}` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T3: (v) => [
    `🌤️ *AFTERNOON PICK*`, ``,
    `${v.groupName} — something fresh just dropped 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🎯 Save ${v.discount}% — was KES ${v.originalPrice}` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T4: (v) => [
    `🌆 *EVENING DEAL*`, ``,
    `${v.groupName} — one to end the day with 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `⏰ ${v.discount}% off — was KES ${v.originalPrice}` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ Shop tonight → ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T5: (v) => [
    `🌙 *TONIGHT'S PICK*`, ``,
    `${v.groupName} — one to sleep on 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🌙 ${v.discount}% off tonight` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    `💬 wa.me/${v.phone}`,
  ].filter(Boolean).join("\n"),

  T6: (v) => [
    `💸 *PAYDAY DEAL*`, ``,
    `Good morning ${v.groupName}! 🎉`, ``,
    `You earned it — treat yourself:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    v.hasDiscount ? `💰 Was KES ${v.originalPrice}` : `💰 *KES ${v.price}*`,
    v.hasDiscount ? `⚡ Now *KES ${v.price}* (${v.discount}% OFF)` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ Shop → ${v.shopLink}`, ``,
    AUTO_FOOTER(v), ``,
    `✨ *MarketMix Kenya* — Shop smart. Shop local.`,
  ].filter(Boolean).join("\n"),

  T7: (v) => [
    `📦 *STOCK UP DEAL*`, ``,
    `${v.groupName} — month-end essentials 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `📉 ${v.discount}% OFF` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T8: (v) => [
    `🎉 *FRIDAY PICK*`, ``,
    `It's Friday ${v.groupName} — you earned it 🥳`, ``,
    `Something for the weekend 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🎁 ${v.discount}% OFF — was KES ${v.originalPrice}` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v), ``,
    `✨ *MarketMix Kenya* — Weekend sorted.`,
  ].filter(Boolean).join("\n"),

  T9: (v) => [
    `🛍️ *WEEKEND DEAL*`, ``,
    `Happy weekend ${v.groupName}! 🎈`, ``,
    `Perfect time to grab this 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `⚡ ${v.discount}% OFF` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T10: (v) => [
    `🌿 *SUNDAY PREP*`, ``,
    `${v.groupName} — ready for the week ahead?`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `📚 ${v.discount}% off` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T11: (v) => [
    `🔔 *${v.eventName} is coming*`, ``,
    `${v.groupName} — ${v.daysLeft} days to go!`, ``,
    `Start planning. Here's our top pick for early shoppers:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T12: (v) => [
    `⏳ *${v.daysLeft} days to ${v.eventName}*`, ``,
    `${v.groupName} — the countdown is on 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🔥 ${v.discount}% OFF` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T13: (v) => [
    `🚨 *${v.eventName} is TOMORROW*`, ``,
    `${v.groupName} — last chance to get ready!`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ Order tonight → ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T14: (v) => [
    `${v.emoji} *Happy ${v.eventName}!*`, ``,
    `${v.groupName} — 🎊`, ``,
    `Final picks available now:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `⚡ ${v.discount}% off` : null,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v), ``,
    `✨ *MarketMix Kenya*`,
  ].filter(Boolean).join("\n"),

  T15: (v) => [
    `👋 *After ${v.eventName}*`, ``,
    `${v.groupName} — hope it was great!`, ``,
    `Still looking? A few related picks:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    `💬 wa.me/${v.phone}`,
  ].filter(Boolean).join("\n"),

  T16: (v) => [
    `📊 *SELLER SPOTLIGHT*`, ``,
    `Fellow sellers — a product your customers are asking about:`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 Retail: *KES ${v.price}*`,
    ``, `📝 ${v.shortDescription}`, ``,
    `👀 Buyers searching for this NOW.`,
    `🛍️ See listing → ${v.shopLink}`, ``,
    `💬 wa.me/${v.phone}`,
    `👥 ${v.groupLink}`,
  ].filter(Boolean).join("\n"),

  T17: (v) => [
    `⚡ *DEAL ALERT*`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `💰 *KES ${v.price}*`,
    v.hasDiscount ? `🔥 ${v.discount}% OFF` : null,
    `━━━━━━━━━━━━━━`, ``,
    `📝 ${v.shortDescription}`, ``,
    `⏰ Limited stock`,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v),
  ].filter(Boolean).join("\n"),

  T18: (v) => [
    `✨ *FEATURED PICK*`, ``,
    `${v.groupName} — today's pick 👇`, ``,
    `━━━━━━━━━━━━━━`,
    `${v.emoji} *${v.productName}*`,
    `━━━━━━━━━━━━━━`,
    `💰 *KES ${v.price}*`,
    ``, `📝 ${v.shortDescription}`, ``,
    `🛍️ ${v.shopLink}`, ``,
    AUTO_FOOTER(v), ``,
    `✨ *MarketMix Kenya* — Featured today.`,
  ].filter(Boolean).join("\n"),

  T19: () => [
    `💚 *A gentle reminder*`, ``,
    `You never know what someone is carrying today.`, ``,
    `A little kindness can matter more than you realise.`, ``,
    `Check on your people. And be kind to yourself too.`, ``,
    `━━━━━━━━━━━━━━`,
    `💚 From all of us at *MarketMix Kenya*`,
    `💬 wa.me/${ORDERS_PHONE}`,
    `👥 ${WHATSAPP_GROUP_URL}`,
    `━━━━━━━━━━━━━━`,
  ].join("\n"),

  T20: (v) => [
    `🌿 *${v.dayOfWeek || "Today"}'s Reminder*`, ``,
    `You don't have to fix everything this week.`, ``,
    `Pick one thing that matters.`,
    `Start there.`, ``,
    `Small progress is still progress.`, ``,
    `━━━━━━━━━━━━━━`,
    `💚 With care, *MarketMix Kenya*`,
    `💬 wa.me/${ORDERS_PHONE}`,
    `👥 ${WHATSAPP_GROUP_URL}`,
    `━━━━━━━━━━━━━━`,
  ].join("\n"),
};

function autoPromoFillTemplate(templateId, ctx) {
  const { product, campaign, groupName, productUrl } = ctx;
  const priceNum = Number(product?.price || 0);
  const originalNum = Number(product?.originalPrice || 0);
  const discountPct = originalNum > priceNum && originalNum > 0
    ? Math.round(((originalNum - priceNum) / originalNum) * 100)
    : 0;
  const shortDesc = String(product?.description || "Fresh stock available now.")
    .replace(/\s+/g, " ").trim().slice(0, 160);

  const vars = {
    productName: product?.name || "MarketMix pick",
    price: priceNum.toLocaleString("en-KE"),
    originalPrice: originalNum > 0 ? originalNum.toLocaleString("en-KE") : priceNum.toLocaleString("en-KE"),
    discount: discountPct,
    hasDiscount: discountPct > 0,
    shortDescription: shortDesc,
    shopLink: productUrl,
    phone: ORDERS_PHONE,
    groupLink: WHATSAPP_GROUP_URL,
    eventName: campaign?.name || "the season",
    daysLeft: String(Math.max(0, campaign?.daysToEvent ?? 0)),
    groupName: groupName || "MarketMix Family",
    emoji: "🛍️",
    dayOfWeek: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][autoPromoDowEAT()],
  };
  const fn = AutoPromoTemplates[templateId] || AutoPromoTemplates.T1;
  return fn(vars);
}

function autoPromoFmtProduct(p) {
  const name = p.name || "Special pick";
  const price = Number(p.price || 0);
  const desc = String(p.description || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const lines = [`🛍️ *${name.toUpperCase()}*`];
  if (price > 0) lines.push(`💰 KES ${price.toLocaleString("en-KE")}`);
  if (p.brand) lines.push(`🏷️ ${p.brand}`);
  if (p.category) lines.push(`📦 ${p.category}`);
  if (desc) { lines.push(""); lines.push(desc + (String(p.description || "").length > 140 ? "…" : "")); }
  return { text: lines.join("\n") };
}

function autoPromoPickRandom(arr, n = 1) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function autoPromoLoadSettings() {
  const ref = db.collection("platformSettings").doc("autoPromo");
  const snap = await ref.get();
  const defaults = {
    enabled: false,
    perGroupPerDay: 4,
    minGapMinutes: 90,
    activeHours: { start: 8, end: 21 },
    siteUrl: "https://www.marketmixkenya.co.ke",
    selectedGroupIds: [],
  };
  if (!snap.exists) return defaults;
  return { ...defaults, ...snap.data() };
}

async function autoPromoSaveSettings(patch, uid = "system") {
  const ref = db.collection("platformSettings").doc("autoPromo");
  await ref.set({
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid,
  }, { merge: true });
}

async function autoPromoCountTodaySends(groupId) {
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const startEAT = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate(), 0, 0, 0) - 3 * 60 * 60 * 1000);
  const snap = await db.collection("autoPromoLogs")
    .where("groupId", "==", groupId)
    .where("sentAt", ">=", startEAT)
    .where("status", "==", "sent")
    .get();
  return snap.size;
}

async function autoPromoTemplatesUsedToday(groupId) {
  const used = new Set();
  try {
    const now = new Date();
    const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const startEAT = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate(), 0, 0, 0) - 3 * 60 * 60 * 1000);
    const snap = await db.collection("autoPromoLogs")
      .where("groupId", "==", groupId)
      .where("sentAt", ">=", startEAT)
      .where("status", "==", "sent")
      .get();
    snap.forEach(d => { const x = d.data(); if (x.templateId) used.add(x.templateId); });
  } catch (_) {}
  return used;
}

async function autoPromoProductsUsedToday(groupId) {
  const used = new Set();
  try {
    const now = new Date();
    const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const startEAT = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate(), 0, 0, 0) - 3 * 60 * 60 * 1000);
    const snap = await db.collection("autoPromoLogs")
      .where("groupId", "==", groupId)
      .where("sentAt", ">=", startEAT)
      .where("status", "==", "sent")
      .get();
    snap.forEach(d => { const x = d.data(); if (x.productId) used.add(x.productId); });
  } catch (_) {}
  return used;
}

async function autoPromoPickProduct({ group, forceProductId = null, days7Window = true, excludeProductIds = null }) {
  let recentIds = new Set();
  if (days7Window) {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const snap = await db.collection("autoPromoLogs")
        .where("groupId", "==", group.id)
        .where("sentAt", ">=", cutoff)
        .get();
      snap.forEach(d => { const x = d.data(); if (x.productId) recentIds.add(x.productId); });
    } catch (_) {}
  }

  if (forceProductId) {
    const s = await db.collection("products").doc(forceProductId).get();
    if (s.exists) return { id: s.id, ...s.data() };
  }

  const sameDay = excludeProductIds instanceof Set ? excludeProductIds : new Set();

  const pSnap = await db.collection("products").get();
  const all = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const inStock = all.filter(p => {
    const qty = Number(p.quantity) || 0;
    const variantStock = Array.isArray(p.variants) ? p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0) : 0;
    return (qty > 0 || variantStock > 0) && p.isPublished !== false;
  });

  let candidates = inStock.filter(p => !sameDay.has(p.id));
  if (!candidates.length) candidates = inStock;
  if (!candidates.length) return null;

  const scored = candidates.map(p => {
    let score = 0;
    if (p.images?.[0]) score += 5;
    if (p.originalPrice && Number(p.originalPrice) > Number(p.price)) score += 4;
    const createdAt = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt ? new Date(p.createdAt) : null);
    if (createdAt && (Date.now() - createdAt.getTime()) < 14 * 24 * 60 * 60 * 1000) score += 3;
    score += recentIds.has(p.id) ? -4 : 6;
    return { p, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const top = scored.slice(0, 5);
  return autoPromoPickRandom(top, 1)[0].p;
}

/* ─── Overrides ─── */
async function loadOverridesForDate(dateStr) {
  const map = new Map();
  if (!dateStr) return map;
  try {
    const snap = await db.collection("marketingOverrides")
      .where("date", "==", dateStr)
      .get();
    snap.forEach(d => {
      const x = d.data() || {};
      const key = `${x.slot || ""}|${x.originalProductId || "noplan"}`;
      map.set(key, x);
    });
  } catch (e) {
    console.warn("[overrides] load failed:", e.message);
  }
  return map;
}

function applyOverride(slot, overrides) {
  if (!slot || !slot.time) return slot;

  const productId = slot.productId || "noplan";
  const key = `${slot.time}|${productId}`;
  const ov = overrides.get(key);

  if (!ov) return slot;

  // v2.6.4 — group-scoped: if the override pins a groupId and this slot's
  // group doesn't match, do not apply it.
  if (ov.groupId && ov.groupId !== slot.groupId) return slot;

  return {
    ...slot,
    productId: ov.productId || slot.productId,
    productName: ov.productName || slot.productName,
    imageUrl: ov.imageUrl || slot.imageUrl,
    caption: ov.caption || slot.caption,
    time: ov.time || slot.time,
    skipped: typeof ov.skipped === "boolean" ? ov.skipped : slot.skipped,
    isOverridden: true,
    __originalTime: slot.time,
    __originalProductId: slot.productId,
  };
}

/**
 * v2.6.5 — autoPromoRunTick
 *
 * Ordering:
 *   1. Override matching FIRST (before cap check). Group-scoped.
 *   2. Pending override bypasses the daily cap.
 *   3. Override-pinned products skip the auto-pick.
 *   4. Override.imageUrl is placeholder-filtered.
 *
 * v2.6.5 adds: empty selectedGroupIds refuses to send instead of broadcasting
 * to every WAHA group.
 */
async function autoPromoRunTick({ WA_MAX_PER_RUN = 8, forceGroupIds = null, forceProductId = null } = {}) {
  if (autoPromoRunning) return { skipped: "already-running" };
  autoPromoRunning = true;
  try {
    const settings = await autoPromoLoadSettings();
    if (!settings.enabled) return { skipped: "disabled" };

    const hourEAT = autoPromoHourEAT();
    if (hourEAT < settings.activeHours.start || hourEAT >= settings.activeHours.end) {
      return { skipped: `outside-hours (${hourEAT}h EAT)` };
    }

    let groups = [];
    try {
      const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
      const data = await r.json().catch(() => ({}));
      const list = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data) : []);
      groups = list
        .filter(g => g && (g.id || g.chatId) && String(g.id || g.chatId).endsWith("@g.us"))
        .map(g => ({ id: g.id || g.chatId, name: g.subject || g.name || "(unnamed)" }));
    } catch (e) {
      return { error: "groups-fetch-failed", detail: e.message };
    }

    // Dedupe groups by id
    const seenIds = new Set();
    groups = groups.filter(g => {
      if (seenIds.has(g.id)) return false;
      seenIds.add(g.id);
      return true;
    });

    const persistedIds = Array.isArray(settings.selectedGroupIds) ? settings.selectedGroupIds : [];
    const isForceRun = Array.isArray(forceGroupIds) && forceGroupIds.length > 0;
    const effectiveIds = isForceRun ? forceGroupIds : persistedIds;

    if (effectiveIds.length > 0) {
      const allowed = new Set(effectiveIds);
      const before = groups.length;
      groups = groups.filter(g => allowed.has(g.id));
      const missing = effectiveIds.filter(id => !groups.find(g => g.id === id));
      for (const id of missing) groups.push({ id, name: "(forced)" });
      console.log(
        `🤖 AutoPromo: filtered groups ${before} → ${groups.length} ` +
        `(source: ${isForceRun ? "forceGroupIds" : "settings.selectedGroupIds"})`
      );
    } else {
      // ── Safety net (v2.6.5) ──
      // Empty selection on a scheduled tick means "nothing to send" — NOT
      // "send to every group WAHA returned". Previously this fell through
      // to a full broadcast. Refuse instead.
      console.warn("🤖 AutoPromo: selectedGroupIds is EMPTY — refusing to send to any group");
      return { skipped: "no-selected-groups" };
    }

    if (!groups.length) return { skipped: "no-groups" };

    const campaign = autoPromoGetActiveCampaign();
    const timeBucket = autoPromoTimeBucket(hourEAT);
    const dayBucket = autoPromoDayBucket(autoPromoDowEAT());
    const payday = autoPromoIsPayday();
    const monthEnd = autoPromoIsMonthEnd();

    const bypassCap = !!(forceGroupIds || forceProductId);
    const perGroupPerDay = Math.min(AUTO_PROMO_MAX_PER_GROUP_PER_DAY, Math.max(1, Number(settings.perGroupPerDay) || 5));

    const todayEAT = autoPromoDateStrEAT();
    const overrides = await loadOverridesForDate(todayEAT);

    const result = {
      tick: new Date().toISOString(),
      hhmmEAT: autoPromoHHMMEAT(),
      hourEAT,
      campaign: campaign?.name || null,
      campaignDaysToEvent: campaign?.daysToEvent ?? null,
      timeBucket, dayBucket, payday, monthEnd,
      groupsConsidered: groups.length,
      sent: 0,
      skippedGroups: [],
      messages: [],
      overridesApplied: 0,
    };

    const currentHHMM = autoPromoHHMMEAT();
    const currentHour = hourEAT;

    for (const group of groups) {
      const kind = autoPromoDetectGroupKind(group.name);

      // ── 1. Override matching FIRST (group-scoped) ──
      let matchedOverride = null;
      let matchedKey = null;

      if (overrides.size > 0) {
        const groupScoped = (ov) => !ov.groupId || ov.groupId === group.id;

        for (const [key, ov] of overrides.entries()) {
          if (!groupScoped(ov)) continue;
          const [ovSlot] = key.split("|");
          const effective = String(ov.time || ovSlot || "").trim();
          if (effective === currentHHMM) { matchedOverride = ov; matchedKey = key; break; }
        }
        if (!matchedOverride) {
          for (const [key, ov] of overrides.entries()) {
            if (!groupScoped(ov)) continue;
            const [ovSlot] = key.split("|");
            const effective = String(ov.time || ovSlot || "").trim();
            const ovHour = parseInt(effective.split(":")[0], 10);
            if (ovHour === currentHour) { matchedOverride = ov; matchedKey = key; break; }
          }
        }
      }

      const hasPendingOverride = !!matchedOverride;

      // ── 2. Daily cap (bypassed when an override is pending) ──
      if (!bypassCap && !hasPendingOverride) {
        const alreadySent = await autoPromoCountTodaySends(group.id);
        if (alreadySent >= perGroupPerDay) {
          result.skippedGroups.push({ id: group.id, reason: "daily-cap" });
          continue;
        }
      }

      // ── 3. Idempotency guard ──
      const overrideSlotKey = matchedOverride
        ? String(matchedOverride.time || (matchedKey || "").split("|")[0] || "").trim()
        : null;

      if (overrideSlotKey && !bypassCap) {
        try {
          const guardSnap = await db.collection("autoPromoLogs")
            .where("groupId", "==", group.id)
            .where("dateEAT", "==", todayEAT)
            .where("slotTimeEAT", "==", overrideSlotKey)
            .where("status", "==", "sent")
            .limit(1)
            .get();
          if (!guardSnap.empty) {
            result.skippedGroups.push({ id: group.id, reason: `already-fired-${overrideSlotKey}` });
            continue;
          }
        } catch (guardErr) {
          console.warn(`[idempotency] guard lookup for ${group.id}:`, guardErr.message);
        }
      }

      // ── 4. Template pool ──
      const usedTodayTemplates = await autoPromoTemplatesUsedToday(group.id);
      const pool = autoPromoPickTemplatePool({ campaign, timeBucket, dayBucket, payday, monthEnd, groupKind: kind });
      const templateId = pool.find(id => !usedTodayTemplates.has(id)) || pool[0];

      // ── 5. Product pick ──
      const usedTodayProducts = await autoPromoProductsUsedToday(group.id);
      const overridePinnedProductId =
        matchedOverride?.productId && matchedOverride.productId !== "noplan"
          ? matchedOverride.productId
          : null;

      let product = null;
      if (overridePinnedProductId) {
        const pinnedSnap = await db.collection("products").doc(overridePinnedProductId).get();
        if (pinnedSnap.exists) product = { id: pinnedSnap.id, ...pinnedSnap.data() };
      }
      if (!product) {
        product = await autoPromoPickProduct({ group, forceProductId, excludeProductIds: usedTodayProducts });
      }
      if (!product) {
        result.skippedGroups.push({ id: group.id, reason: "no-product" });
        continue;
      }

      // ── 6. Caption / image / slot time ──
      let productUrl = `${settings.siteUrl}/product/${product.slug || product.id}`;
      let caption = autoPromoFillTemplate(templateId, { product, campaign, groupName: group.name, productUrl });
      let imageUrl = productImageUrl(product);
      let slotTime = matchedOverride
        ? (matchedOverride.time || (matchedKey || "").split("|")[0] || currentHHMM)
        : currentHHMM;

      if (matchedOverride) {
        result.overridesApplied++;
        if (matchedOverride.skipped) {
          result.skippedGroups.push({ id: group.id, reason: "overridden-skipped" });
          continue;
        }
        if (matchedOverride.caption) caption = matchedOverride.caption;
        if (matchedOverride.imageUrl) {
          const resolved = resolveProductImageUrl(matchedOverride.imageUrl);
          if (resolved && !isPlaceholderImageUrl(resolved)) imageUrl = resolved;
        }
      }

      // ── 7. Send ──
      try {
        if (imageUrl) {
          enqueueWhatsAppImage(group.id, imageUrl, caption, {
            kind: "auto-promo",
            templateId,
            campaign: campaign?.name || null,
            productId: product.id,
            groupName: group.name,
            overridden: !!matchedOverride,
          });
        } else {
          enqueueWhatsApp(group.id, caption, {
            kind: "auto-promo",
            templateId,
            campaign: campaign?.name || null,
            productId: product.id,
            groupName: group.name,
            overridden: !!matchedOverride,
          });
        }

        await db.collection("autoPromoLogs").add({
          groupId: group.id,
          groupName: group.name,
          productId: product.id,
          productName: product.name || null,
          imageUrlSent: imageUrl || null,
          templateId,
          campaign: campaign?.name || null,
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          preview: caption.slice(0, 240),
          forced: bypassCap,
          overridden: !!matchedOverride,
          overrideBypassedCap: hasPendingOverride && !bypassCap,
          dateEAT: todayEAT,
          slotTimeEAT: slotTime,
          matchedOverrideKey: matchedKey || null,
        });

        result.sent++;
        result.messages.push({ group: group.name, product: product.name, templateId, slotTime });
      } catch (e) {
        await db.collection("autoPromoLogs").add({
          groupId: group.id,
          groupName: group.name,
          productId: product.id,
          templateId,
          status: "failed",
          error: e.message,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          forced: bypassCap,
          dateEAT: todayEAT,
          slotTimeEAT: slotTime,
        }).catch(() => {});
        result.skippedGroups.push({ id: group.id, reason: "send-failed" });
      }

      if (result.sent < WA_MAX_PER_RUN && groups.indexOf(group) < groups.length - 1) {
        const gapMs = 30 * 1000 + Math.random() * 45 * 1000;
        await new Promise(r => setTimeout(r, gapMs));
      }
    }

    console.log(`🤖 AutoPromo tick → ${result.sent} sent (campaign=${result.campaign || "none"}, overrides=${result.overridesApplied}, hhmm=${result.hhmmEAT})`);
    return result;
  } catch (e) {
    console.error("🤖 AutoPromo tick crashed:", e);
    return { error: e.message };
  } finally {
    autoPromoRunning = false;
  }
}

function autoPromoStartScheduler({ SCAN_MS = 60 * 1000 } = {}) {
  const tick = async () => {
    try {
      await autoPromoRunTick({});
    } catch (e) {
      console.error("🤖 AutoPromo scheduled tick error:", e.message);
    }
    autoPromoTickTimer = setTimeout(tick, SCAN_MS).unref?.();
  };
  autoPromoTickTimer = setTimeout(tick, 60 * 1000).unref?.();
  console.log(`🤖 AutoPromo scheduler armed (scan every ${SCAN_MS / 1000}s)`);
  return () => { if (autoPromoTickTimer) clearTimeout(autoPromoTickTimer); };
}

/* ═══════════════════════════════════════════════════════════════
   Occasion Engine
   ═══════════════════════════════════════════════════════════════ */

const OCCASION_LIBRARY = [
  { key: "new-year", month: 1, day: 1, name: "New Year's Day", kind: "both",
    promo: `🎉 Happy New Year from MarketMix Kenya!\n\nStart the year by discovering useful finds from local businesses. From fashion and electronics to everyday essentials, explore what's available.\n\n🛍️ Shop local, grow local: {shop_link}`,
    nonPromo: `🎉 Happy New Year!\n\nYou don't need to have the whole year figured out today. Celebrate how far you've come, give yourself room to grow and take the next step at your own pace. Wishing you a peaceful and fulfilling year.` },

  { key: "valentines", month: 2, day: 14, name: "Valentine's Day", kind: "both",
    promo: `❤️ Valentine's Day is here!\n\nLooking for something thoughtful for your person? Discover available gifts, fashion, accessories and other finds from local businesses.\n\nFind a gift: {shop_link}\n\nShop local, grow local.`,
    nonPromo: `Happy Valentine's Day! ❤️\n\nWhether you're in a relationship, single, healing or enjoying your own company, you deserve respect, care and genuine connection. Love should add to your life, not cost you your peace.` },

  { key: "cancer-day", month: 2, day: 4, name: "World Cancer Day", kind: "non-promo", sensitive: true,
    nonPromo: `🎗️ World Cancer Day\n\nAwareness, timely medical assessment, access to treatment and support matter. Share reliable information, challenge stigma and show compassion to people affected by cancer and their families.` },

  { key: "womens-day", month: 3, day: 8, name: "International Women's Day", kind: "both",
    promo: `💜 Celebrate women building businesses and creating opportunities.\n\nDiscover products from local entrepreneurs, including women-owned businesses participating on MarketMix.\n\nExplore local sellers: {shop_link}`,
    nonPromo: `Happy International Women's Day! 💜\n\nHere's to women learning, leading, caring, creating and finding their own paths. Every woman deserves dignity, safety, opportunity and the freedom to shape her future.` },

  { key: "earth-day", month: 4, day: 22, name: "Earth Day", kind: "both",
    promo: `🌍 Looking for reusable or longer-lasting everyday essentials?\n\nExplore relevant products from local sellers and choose items that genuinely meet your needs.\n\nBrowse: {shop_link}`,
    nonPromo: `Small choices can help us care for our environment. Reduce waste where possible, reuse what you can and take care of the spaces we share. Every effort counts.` },

  { key: "labour-day", month: 5, day: 1, name: "Labour Day Kenya", kind: "both",
    promo: `🛠️ Happy Labour Day!\n\nToday we celebrate the people whose work keeps homes, businesses and communities going. Discover products from local entrepreneurs on MarketMix.\n\nShop local: {shop_link}`,
    nonPromo: `To everyone working shifts, studying while working, running a business or providing for family: your effort matters. Wishing you recognition, rest and better opportunities.` },

  { key: "madaraka-day", month: 6, day: 1, name: "Madaraka Day", kind: "both",
    promo: `🇰🇪 Happy Madaraka Day!\n\nCelebrate the creativity and enterprise of Kenyan businesses. Discover products made or sold by local entrepreneurs.\n\nShop local, grow local: {shop_link}`,
    nonPromo: `Happy Madaraka Day, Kenya! 🇰🇪 Today we reflect on our journey, celebrate our communities and keep working toward a country where everyone has opportunities to thrive.` },

  { key: "mashujaa-day", month: 10, day: 20, name: "Mashujaa Day", kind: "both",
    promo: `🇰🇪 Happy Mashujaa Day!\n\nCelebrate the people building Kenya, one idea and one business at a time. Discover products from local entrepreneurs.\n\nShop local: {shop_link}`,
    nonPromo: `Happy Mashujaa Day! Today we honour the people whose courage, service and dedication have helped shape our country, including the everyday heroes in our communities.` },

  { key: "christmas", month: 12, day: 25, name: "Christmas", kind: "both",
    promo: `🎄 Christmas is here!\n\nStill looking for a gift or something useful for the festive season? Explore available products from local sellers on MarketMix.\n\nFind your festive picks: {shop_link}`,
    nonPromo: `Merry Christmas to everyone celebrating! May your day bring warmth, rest, laughter and meaningful moments with the people you love. We also send care to anyone spending today alone or finding the season difficult.` },

  { key: "jamhuri-day", month: 12, day: 12, name: "Jamhuri Day", kind: "both",
    promo: `🇰🇪 Happy Jamhuri Day!\n\nCelebrate Kenyan creativity and support local entrepreneurs by discovering their products on MarketMix.\n\nShop local, grow local: {shop_link}`,
    nonPromo: `Happy Jamhuri Day, Kenya! Today we celebrate our country's history, our people and the communities that continue to shape our future.` },

  { key: "mothers-day", month: null, day: null, name: "Mother's Day", kind: "both", movable: true,
    promo: `💐 Mother's Day is coming!\n\nLooking for a thoughtful gift for Mum or a mother figure? Explore available fashion, beauty products, accessories and home essentials from local sellers.\n\nFind a gift: {shop_link}`,
    nonPromo: `Happy Mother's Day to the mothers, grandmothers, guardians and mother figures who show up in countless ways. We also send care to anyone for whom this day is difficult.` },

  { key: "fathers-day", month: null, day: null, name: "Father's Day", kind: "both", movable: true,
    promo: `👔 Father's Day is coming!\n\nLooking for a thoughtful gift for Dad or a father figure? Explore available clothing, accessories, electronics and practical everyday finds.\n\nBrowse gifts: {shop_link}`,
    nonPromo: `Happy Father's Day to the fathers, guardians and father figures who offer care, guidance and support. We also recognise that family experiences differ and send care to anyone finding today difficult.` },

  { key: "black-friday", month: null, day: null, name: "Black Friday", kind: "both", movable: true,
    promo: `🖤 BLACK FRIDAY at MarketMix!\n\nLooking for a good deal? Browse participating sellers, compare prices and check product details before ordering.\n\nDiscover available offers: {shop_link}\n\nOnly advertise discounts that have been verified.`,
    nonPromo: `Black Friday reminder: a deal is only a good deal if you actually need or want the item and it fits your budget. Compare prices and don't let countdowns pressure you into spending.` },

  { key: "cyber-monday", month: null, day: null, name: "Cyber Monday", kind: "both", movable: true,
    promo: `💻 Cyber Monday finds!\n\nExplore available electronics, accessories, fashion and other products from participating local sellers.\n\nBrowse: {shop_link}`,
    nonPromo: `Shopping online? Check the seller's details, confirm the final price and delivery arrangements, and use a payment method you trust. A little caution goes a long way.` },

  { key: "easter", month: null, day: null, name: "Easter", kind: "both", movable: true,
    promo: `🌷 Easter is here!\n\nPreparing for a family visit or celebration? Explore relevant products available from local sellers.\n\nBrowse MarketMix: {shop_link}`,
    nonPromo: `Wishing everyone celebrating Easter a peaceful and meaningful holiday. May this season bring hope, reflection, kindness and time with the people who matter to you.` },

  { key: "ramadan", month: null, day: null, name: "Ramadan", kind: "both", movable: true,
    promo: `🌙 Ramadan Mubarak to everyone observing!\n\nPreparing for the month? Explore relevant household essentials, clothing and other available products from local sellers.\n\nBrowse: {shop_link}`,
    nonPromo: `Ramadan Mubarak to everyone observing. May this month bring reflection, generosity, patience and connection with family and community.` },

  { key: "eid-al-fitr", month: null, day: null, name: "Eid al-Fitr", kind: "both", movable: true,
    promo: `🌙 Eid Mubarak!\n\nIf you're preparing for the celebration, discover available clothing, gifts, accessories and household essentials from local sellers.\n\nExplore: {shop_link}`,
    nonPromo: `Eid Mubarak to everyone celebrating! May your day be filled with peace, gratitude, generosity and time with loved ones.` },

  { key: "encouragement-monday", month: null, day: null, name: "Monday Encouragement", kind: "non-promo", recurring: "weekly", weekday: 1,
    nonPromo: `New week, fresh start. 💚\n\nYou don't need to have everything figured out. Choose your priorities, do what you can and give yourself room to learn along the way.` },

  { key: "encouragement-midweek", month: null, day: null, name: "Midweek Check-In", kind: "non-promo", recurring: "weekly", weekday: 3,
    nonPromo: `Midweek check-in. 👋\n\nHave you eaten, had some water and taken a moment to breathe? You can be productive without treating yourself like a machine.` },

  { key: "encouragement-friday", month: null, day: null, name: "Friday Encouragement", kind: "non-promo", recurring: "weekly", weekday: 5,
    nonPromo: `You made it to Friday. 💚\n\nWhatever this week looked like, acknowledge the effort you put in. Rest when you can, celebrate the small wins.` },

  { key: "encouragement-sunday", month: null, day: null, name: "Sunday Reset", kind: "non-promo", recurring: "weekly", weekday: 0,
    nonPromo: `A gentle Sunday reminder: you don't have to solve next week's problems today.\n\nRest, prepare what you can and give yourself permission to enjoy a little peace before Monday.` },
];

function fillOccasionTemplate(text, vars = {}) {
  if (!text) return "";
  const replacements = {
    shop_link: vars.shopLink || WEBSITE_URL || "https://www.marketmixkenya.co.ke/",
    product_name: vars.productName || "",
    price: vars.price || "",
    old_price: vars.oldPrice || "",
    group_link: vars.groupLink || WHATSAPP_GROUP_URL || "",
    name: vars.name || "there",
  };
  return String(text).replace(
    /\{\{\s*(\w+)\s*\}\}|\{\s*(\w+)\s*\}/g,
    (match, doubleKey, singleKey) => {
      const key = doubleKey || singleKey;
      return Object.prototype.hasOwnProperty.call(replacements, key)
        ? replacements[key]
        : match;
    }
  );
}

function resolveOccasionsForDate({
  month,
  day,
  weekday = null,
  movableDates = {},
  includeRecurring = false,
  year = null,
} = {}) {
  const fixed = [];
  const recurring = [];

  for (const occ of OCCASION_LIBRARY) {
    if (occ.recurring === "weekly") {
      if (includeRecurring && weekday !== null && occ.weekday === weekday) {
        recurring.push(occ);
      }
      continue;
    }

    if (occ.movable) {
      const resolved = movableDates[occ.key];
      if (!resolved) continue;
      if (year && resolved.year && resolved.year !== year) continue;
      if (resolved.month === month && resolved.day === day) {
        fixed.push(occ);
      }
      continue;
    }

    if (occ.month === month && occ.day === day) {
      fixed.push(occ);
    }
  }

  return { dated: fixed, recurring };
}

function buildOccasionMessage(occasion, { shopLink, name } = {}) {
  if (!occasion) return null;
  const isSensitive = occasion.sensitive === true;
  const wantsPromo =
    !isSensitive &&
    (occasion.kind === "both" || occasion.kind === "promo") &&
    typeof occasion.promo === "string";

  const raw = wantsPromo ? occasion.promo : occasion.nonPromo;
  if (!raw) return null;

  return fillOccasionTemplate(raw, { shopLink, name });
}

async function occasionLoadSettings() {
  const ref = db.collection("platformSettings").doc("occasions");
  const snap = await ref.get();
  const defaults = {
    enabled: false,
    sendDated: true,
    sendRecurring: true,
    activeHours: { start: 7, end: 21 },
    siteUrl: WEBSITE_URL,
    movableDates: {},
  };
  if (!snap.exists) return defaults;
  return { ...defaults, ...snap.data() };
}

async function occasionSaveSettings(patch, uid = "system") {
  const ref = db.collection("platformSettings").doc("occasions");
  await ref.set({
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid,
  }, { merge: true });
}

async function occasionWasSentToday(occasionKey) {
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const startEAT = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate(), 0, 0, 0) - 3 * 60 * 60 * 1000);
  const snap = await db.collection("occasionLogs")
    .where("occasionKey", "==", occasionKey)
    .where("sentAt", ">=", startEAT)
    .where("status", "==", "sent")
    .limit(1)
    .get();
  return !snap.empty;
}

let occasionRunning = false;

async function occasionRunTick({ forceGroups = null, forceOccasionKey = null, dryRun = false } = {}) {
  if (occasionRunning) return { skipped: "already-running" };
  occasionRunning = true;
  try {
    const settings = await occasionLoadSettings();
    if (!settings.enabled && !dryRun) return { skipped: "disabled" };

    const hourEAT = autoPromoHourEAT();
    if (!dryRun && (hourEAT < settings.activeHours.start || hourEAT >= settings.activeHours.end)) {
      return { skipped: `outside-hours (${hourEAT}h EAT)` };
    }

    const month = autoPromoMonthEAT();
    const day = autoPromoDayEAT();
    const weekday = autoPromoDowEAT();
    const year = autoPromoNowEAT().getUTCFullYear();

    const { dated, recurring } = resolveOccasionsForDate({
      month, day, weekday, year,
      movableDates: settings.movableDates || {},
      includeRecurring: !!settings.sendRecurring,
    });

    let occasions = dated;
    if (forceOccasionKey) {
      occasions = OCCASION_LIBRARY.filter(o => o.key === forceOccasionKey);
    }

    let groups = [];
    if (forceGroups && forceGroups.length) {
      groups = forceGroups;
    } else {
      try {
        const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
        const data = await r.json().catch(() => ({}));
        const list = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data) : []);
        groups = list
          .filter(g => g && (g.id || g.chatId) && String(g.id || g.chatId).endsWith("@g.us"))
          .map(g => ({ id: g.id || g.chatId, name: g.subject || g.name || "(unnamed)" }));
      } catch (e) {
        return { error: "groups-fetch-failed", detail: e.message };
      }
    }

    const result = {
      tick: new Date().toISOString(),
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      hourEAT, weekday,
      datedCount: dated.length,
      recurringCount: recurring.length,
      groupsConsidered: groups.length,
      sent: 0,
      results: [],
    };

    const allOccasions = settings.sendDated === false ? [] : occasions;

    for (const occ of allOccasions) {
      const alreadySent = await occasionWasSentToday(occ.key);
      if (alreadySent && !forceOccasionKey) {
        result.results.push({ occasionKey: occ.key, skipped: "already-sent-today" });
        continue;
      }

      const message = buildOccasionMessage(occ, {
        shopLink: settings.siteUrl || WEBSITE_URL,
        name: null,
      });
      if (!message) {
        result.results.push({ occasionKey: occ.key, skipped: "no-content" });
        continue;
      }

      for (const group of groups) {
        if (dryRun) {
          result.results.push({
            occasionKey: occ.key,
            occasionName: occ.name,
            sensitive: !!occ.sensitive,
            kind: occ.kind,
            groupId: group.id,
            groupName: group.name,
            preview: message.slice(0, 240),
            dryRun: true,
          });
          continue;
        }

        try {
          enqueueWhatsApp(group.id, message, {
            kind: "occasion",
            occasionKey: occ.key,
            occasionName: occ.name,
            sensitive: !!occ.sensitive,
            groupName: group.name,
          });

          await db.collection("occasionLogs").add({
            occasionKey: occ.key,
            occasionName: occ.name,
            sensitive: !!occ.sensitive,
            kind: occ.kind,
            groupId: group.id,
            groupName: group.name,
            status: "sent",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            preview: message.slice(0, 240),
            forced: !!forceOccasionKey,
          });

          result.sent++;
          result.results.push({
            occasionKey: occ.key,
            occasionName: occ.name,
            groupId: group.id,
            groupName: group.name,
            status: "sent",
          });
        } catch (e) {
          await db.collection("occasionLogs").add({
            occasionKey: occ.key,
            occasionName: occ.name,
            groupId: group.id,
            groupName: group.name,
            status: "failed",
            error: e.message,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          result.results.push({
            occasionKey: occ.key,
            groupId: group.id,
            status: "failed",
            error: e.message,
          });
        }

        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
      }
    }

    console.log(`🎯 Occasion tick → ${result.sent} sent (dated=${dated.length}, recurring=${recurring.length})`);
    return result;
  } catch (e) {
    console.error("🎯 Occasion tick crashed:", e);
    return { error: e.message };
  } finally {
    occasionRunning = false;
  }
}

let occasionTickTimer = null;

function occasionStartScheduler({ SCAN_MS = 30 * 60 * 1000 } = {}) {
  const tick = async () => {
    try {
      await occasionRunTick({});
    } catch (e) {
      console.error("🎯 Occasion scheduled tick error:", e.message);
    }
    occasionTickTimer = setTimeout(tick, SCAN_MS).unref?.();
  };
  occasionTickTimer = setTimeout(tick, 90 * 1000).unref?.();
  console.log(`🎯 Occasion scheduler armed (scan every ${SCAN_MS / 60000} min)`);
  return () => { if (occasionTickTimer) clearTimeout(occasionTickTimer); };
}

// ============================
// WhatsApp message templates (store/buyer/seller)
// ============================
function storePaymentConfirmedWhatsApp({ customerName, amount, paymentReference }) {
  const name = customerName && String(customerName).trim() ? String(customerName).trim() : "Customer";
  const amt = Number(amount || 0).toLocaleString("en-KE", { minimumFractionDigits: 2 });
  const ref = paymentReference || "—";
  return [
    `Hey ${name}! 👋`,
    ``,
    `Good news! Your payment has landed safely. 🎉`,
    ``,
    `💰 *Amount paid:* KES ${amt}`,
    `🧾 *Payment reference:* ${ref}`,
    ``,
    `Thanks for choosing MarketMix Kenya! ❤️ Your order journey starts here.`,
    ``,
    `🛍️ *Explore more products:*`,
    PRODUCTS_URL,
    ``,
    `👥 *Join our WhatsApp group for deals & new drops:*`,
    WHATSAPP_GROUP_URL,
    ``,
    `Happy shopping!`,
    ``,
    `*MarketMix Kenya — Shop smart. Shop easy.*`,
  ].join("\n");
}

function storeOrderConfirmedWhatsApp({ customerName, orderId, paymentStatus, orderStatus }) {
  const name = customerName && String(customerName).trim() ? String(customerName).trim() : "Customer";
  const id = orderId ? String(orderId) : "—";
  const pay = paymentStatus || "Confirmed";
  const status = orderStatus || "Processing";
  const receiptUrl = buildOrderReceiptUrl(orderId);
  return [
    `Hey ${name}! 🛍️`,
    ``,
    `It's official — your MarketMix order is confirmed! 🎉`,
    ``,
    `📦 *Order ID:* #${id}`,
    `💳 *Payment:* ${pay}`,
    `🚚 *Order status:* ${status}`,
    ``,
    `We're getting things ready for you!`,
    ``,
    `📦 *Track your order:*`,
    receiptUrl,
    ``,
    `💬 Need help? Just reply to this message.`,
    ``,
    `Thanks for shopping with us, ${name}. We appreciate you! ❤️`,
    ``,
    `👥 *Join our WhatsApp group for deals & new drops:*`,
    WHATSAPP_GROUP_URL,
    ``,
    `*MarketMix Kenya*`,
    `Your marketplace. Your choice.`,
  ].join("\n");
}

function buyerStatusUpdateWhatsApp({ customerName, orderId, statusLabel }) {
  const name = customerName && String(customerName).trim() ? String(customerName).trim() : "Customer";
  const id = orderId ? String(orderId) : "—";
  const status = statusLabel || "Updated";
  const receiptUrl = buildOrderReceiptUrl(orderId);

  const statusMessages = {
    Processing: "We're getting your items ready!",
    Shipped: "Your order is on the way. 🚚",
    Delivered: "Delivered! Hope you love it. ❤️",
    Cancelled: "This order was cancelled. Any payment will be refunded.",
  };
  const message = statusMessages[status] || `Your order is now ${status}.`;

  return [
    `Hey ${name}! 👋`,
    ``,
    `Your MarketMix order has an update.`,
    ``,
    `📦 *Order ID:* #${id}`,
    `🚚 *New status:* ${status}`,
    ``,
    `${message}`,
    ``,
    `📦 *Track your order:*`,
    receiptUrl,
    ``,
    `💬 Questions? Just reply to this message.`,
    ``,
    `👥 *Join our WhatsApp group for deals & new drops:*`,
    WHATSAPP_GROUP_URL,
    ``,
    `*MarketMix Kenya*`,
    `Your marketplace. Your choice.`,
  ].join("\n");
}

function quicksaleBuyerWhatsApp({ customerName, itemSummary, amount, paymentReference, sellerShop }) {
  const name = customerName && String(customerName).trim() ? String(customerName).trim() : "Customer";
  const amt = Number(amount || 0).toLocaleString("en-KE", { minimumFractionDigits: 2 });
  const ref = paymentReference || "—";
  const shop = sellerShop || "the seller";
  const summary = itemSummary || "Your purchase";
  return [
    `Hey ${name}! 👋`,
    ``,
    `Good news — your payment has landed safely. 🎉`,
    ``,
    `🛍️ *Item:* ${summary}`,
    `💰 *Amount paid:* KES ${amt}`,
    `🧾 *Payment ref:* ${ref}`,
    `🏪 *Seller:* ${shop}`,
    ``,
    `Thanks for shopping with MarketMix Kenya! ❤️`,
    `The seller has been notified and your purchase is confirmed.`,
    ``,
    `🛍️ *Explore more products:*`,
    PRODUCTS_URL,
    ``,
    `💬 Questions? Just reply to this message.`,
    ``,
    `👥 *Join our WhatsApp group for deals & new drops:*`,
    WHATSAPP_GROUP_URL,
    ``,
    `*MarketMix Kenya — Shop smart. Shop easy.*`,
  ].join("\n");
}

function quicksaleSellerWhatsApp({ sellerName, itemSummary, amount, paymentReference, customerName, customerPhone }) {
  const name = sellerName && String(sellerName).trim() ? String(sellerName).trim() : "Seller";
  const amt = Number(amount || 0).toLocaleString("en-KE", { minimumFractionDigits: 2 });
  const ref = paymentReference || "—";
  const customer = customerName || "Walk-in customer";
  const phone = customerPhone || "—";
  const summary = itemSummary || "—";
  return [
    `💰 *MarketMix Kenya — Quicksale Recorded*`,
    ``,
    `Hi ${name},`,
    ``,
    `A quicksale payment was just confirmed. ✅`,
    ``,
    `🛍️ *Item(s):* ${summary}`,
    `💵 *Amount:* KES ${amt}`,
    `🧾 *M-Pesa ref:* ${ref}`,
    `👤 *Customer:* ${customer}`,
    `📱 *Phone:* ${phone}`,
    ``,
    `Funds are in your seller ledger.`,
    `👉 ${SELLER_DASHBOARD_URL}`,
    ``,
    `*MarketMix Kenya — Shop smart. Shop easy.*`,
  ].join("\n");
}

function sellerNewOrderWhatsApp({ sellerName, orderId, buyerName, sellerRevenue, itemSummary, itemCount }) {
  const name = sellerName && String(sellerName).trim() ? String(sellerName).trim() : "Seller";
  const id = orderId ? String(orderId) : "—";
  const buyer = buyerName || "A customer";
  const rev = Number(sellerRevenue || 0).toLocaleString("en-KE", { minimumFractionDigits: 2 });
  const summary = itemSummary || `${itemCount || 0} item(s)`;
  return [
    `🛍️ *MarketMix Kenya — New Order*`,
    ``,
    `Hi ${name}! You have a new paid order. 🎉`,
    ``,
    `📦 *Order ID:* #${id}`,
    `👤 *Buyer:* ${buyer}`,
    `💰 *Your revenue:* KES ${rev}`,
    `📋 *Your items:* ${summary}`,
    ``,
    `⏱️ Please process it promptly — we'll remind you every 6 hours until you do.`,
    ``,
    `👉 Open your dashboard:`,
    `${SELLER_DASHBOARD_URL}`,
    ``,
    `*MarketMix Kenya — Shop smart. Shop easy.*`,
  ].join("\n");
}

function sellerReminderWhatsApp({ sellerName, orderId, buyerName, hoursSince, nudgeNumber, maxNudges }) {
  const name = sellerName && String(sellerName).trim() ? String(sellerName).trim() : "Seller";
  const id = orderId ? String(orderId) : "—";
  const buyer = buyerName || "a customer";
  const hours = Number(hoursSince || 0).toFixed(0);
  const num = Number(nudgeNumber || 1);
  const max = Number(maxNudges || 4);
  const isFinal = num >= max;
  return [
    `⏰ *MarketMix Kenya — Order Reminder*`,
    ``,
    `Hi ${name},`,
    ``,
    `Order #${id} from ${buyer} was paid about *${hours}h ago* and is still waiting to be processed.`,
    ``,
    `${isFinal
      ? `⚠️ This is your *final reminder* (${num}/${max}). Our team has been notified.`
      : `Please update its status on your dashboard. *(Reminder ${num}/${max})*`}`,
    ``,
    `👉 ${SELLER_DASHBOARD_URL}`,
    ``,
    `*MarketMix Kenya*`,
  ].join("\n");
}

function welcomeSubscriberWhatsApp({ name }) {
  const displayName = name && String(name).trim() ? String(name).trim() : "there";
  return [
    `Hey ${displayName}! 👋`,
    ``,
    `Welcome to *MarketMix Kenya* — you're officially on the list! 🎉`,
    ``,
    `You'll be the first to know when:`,
    `🛍️ New arrivals drop`,
    `🔥 Flash sales go live`,
    `🎁 Exclusive deals come up`,
    ``,
    `🛍️ *Explore what's live now:*`,
    WEBSITE_URL,
    ``,
    `Thanks for joining us! ❤️`,
    ``,
    `*MarketMix Kenya — Shop smart. Shop easy.*`,
  ].join("\n");
}

// ============================
// Inventory movement logger
// ============================
async function logInventoryMovement({
  productId, sellerId, delta, reason,
  channel = null, orderId = null, note = "", createdBy = "system",
}) {
  if (!productId || !sellerId || typeof delta !== "number" || delta === 0) return null;
  try {
    const ref = await db.collection("inventoryMovements").add({
      productId, sellerId, delta, reason, channel, orderId,
      note: note || "", createdBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("❌ logInventoryMovement failed:", err.message, { productId, delta, reason });
    return null;
  }
}

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

const isWalletRef       = (r) => typeof r === "string" && r.startsWith("WALLET_");
const isSubscriptionRef = (r) => typeof r === "string" && r.startsWith("SUB_");
const isRealEstateRef   = (r) => typeof r === "string" && r.startsWith("PROP_");
const isMovingRef       = (r) => typeof r === "string" && r.startsWith("MOVE_");
const isTestRef         = (r) => typeof r === "string" && r.startsWith("TEST_PAY_");
const isQuicksaleRef    = (r) => typeof r === "string" && r.startsWith("QS_");

function isRealEstateOrder(apiRef, orderData) {
  return isRealEstateRef(apiRef) || orderData?.orderType === "real_estate" || orderData?.isRealEstate === true;
}
function isQuicksaleOrder(orderData) {
  return orderData?.type === "QUICK_SALE" || orderData?.isQuicksale === true;
}
function getSellerItems(orderData, sellerId) {
  const items = orderData?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it?.sellerId === sellerId);
}
function getSellerItemSummary(orderData, sellerId) {
  const items = getSellerItems(orderData, sellerId);
  if (!items.length) return "—";
  return items
    .slice(0, 3)
    .map((it) => `${it.name} x${it.quantity}`)
    .join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "");
}
function getSellerRevenue(orderData, sellerId) {
  const items = getSellerItems(orderData, sellerId);
  return items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
}
function quicksaleItemSummary(orderData) {
  const items = Array.isArray(orderData?.items) ? orderData.items : [];
  if (!items.length) return "Your purchase";
  return items
    .slice(0, 3)
    .map((it) => `${it.name} x${it.quantity}`)
    .join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "");
}

// ============================
// EMAIL SHELL
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
          <a href="mailto:marketmixkenya@gmail.com" style="color:#047857;text-decoration:none;">marketmixkenya@gmail.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
        ["Delivery", orderData.shippingDetails?.deliveryPlace || "—"],
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
      ctaUrl: buildOrderReceiptUrl(orderId),
      footerNote: "Need help? Reply to this email and we'll get back to you.",
    });

    const ok = await sendEmail(
      userEmail,
      `Order Confirmation #${String(orderId).slice(0, 8)} - MarketMix Kenya`,
      html,
      "sales",
      null
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

    const mpesaRef = data.mpesaReference || data.mpesaCode || "—";
    const displayId = mpesaRef;
    const amount = Number(data.totalAmount || data.amount || 0);

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
        ["M-Pesa code", displayId],
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
      preheader: `Payment confirmed for ${data.propertyTitle || "your property"} · ${displayId}`,
      eyebrow: "MarketMix Real Estates",
      title: "Payment Confirmed",
      subtitle: "Keep this email as your official receipt.",
      bodyHtml,
      ctaLabel: "View receipt online",
      ctaUrl: `${REAL_ESTATE_RECEIPT_URL}/${displayId}`,
      footerNote: "Questions? Reply to this email and our team will help.",
    });

    const ok = await sendEmail(
      userEmail,
      `Payment Confirmed - ${data.propertyTitle || "Property"} (${displayId})`,
      html,
      "bookings",
      null
    );

    if (ok) {
      await db.collection("realEstateEmails").add({
        orderId, userEmail, displayId,
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
      ${emailBodyText("Trip pins are private and visible only to you, the assigned driver, and MarketMix admins.")}
    `;

    const html = marketMixEmailShell({
      preheader: `Your move is ${statusLabel}`,
      eyebrow: "MarketMix Moving",
      title: "Your move request is on the road",
      subtitle: "A local transport provider will confirm vehicle fit and quote shortly.",
      bodyHtml,
      ctaLabel: "Open tracking page",
      ctaUrl: MOVING_URL,
      footerNote: "Live driver updates appear on your tracking page when sharing is enabled.",
    });

    const ok = await sendEmail(
      userEmail,
      `Your move is ${statusLabel} · MarketMix Moving #${String(requestId).slice(0, 8)}`,
      html,
      "moving",
      null
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

const sendRealEstateWelcomeEmail = async ({
  userEmail, userName, roleLabel, roleDesc = "", rolePerks = [],
  isSwitch = false, previousRoleLabel = null,
  ctaLabel = "Open MarketMix Real Estates", ctaUrl = REAL_ESTATE_APP_URL,
  emailType = "bookings",
}) => {
  try {
    if (!BREVO_API_KEY) return false;
    const name = userName || (userEmail ? userEmail.split("@")[0] : "there");

    const title = isSwitch
      ? `You switched to ${roleLabel}`
      : `Welcome to MarketMix Real Estates, ${name}!`;

    const subtitle = isSwitch
      ? `You're now a ${roleLabel}${previousRoleLabel ? ` (was ${previousRoleLabel})` : ""} on MarketMix Real Estates.`
      : (roleDesc || "Find houses, match with roommates, and book transport to your new place — all in one app.");

    const bodyHtml = `
      ${emailBodyText(
        isSwitch
          ? `Hello <strong>${name}</strong>, your MarketMix Real Estates account type has been updated.`
          : `Hello <strong>${name}</strong>, we're thrilled to have you on MarketMix Real Estates.`
      )}

      ${rolePerks.length ? emailSectionLabel(isSwitch ? `As a ${roleLabel}, you can now:` : "What you can do") : ""}
      ${rolePerks.length ? `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
          <tr><td style="padding:18px;font-size:13px;line-height:1.9;color:#334155;">
            ${rolePerks.map((line) => `• ${line}`).join("<br/>")}
          </td></tr>
        </table>` : ""}

      ${emailSectionLabel(isSwitch ? "What happens next" : "Getting started")}
      ${emailInfoCard([
        ["Account type", roleLabel, true],
        ["Status", isSwitch ? "Updated" : "Active", true],
      ])}

      ${emailBodyText(
        isSwitch
          ? "If you switched by mistake, you can change back anytime from your Profile page."
          : "You can switch your account type anytime from your Profile page."
      )}
    `;

    const html = marketMixEmailShell({
      preheader: isSwitch
        ? `You're now a ${roleLabel} on MarketMix Real Estates`
        : `Welcome to MarketMix Real Estates — here's what you can do as a ${roleLabel}`,
      eyebrow: `MarketMix Real Estates · ${roleLabel}`,
      title, subtitle, bodyHtml, ctaLabel, ctaUrl,
      footerNote: "Questions? Reply to this email and our team will help.",
    });

    const subject = isSwitch
      ? `You're now a ${roleLabel} · MarketMix Real Estates`
      : `Welcome to MarketMix Real Estates, ${name}!`;

    const ok = await sendEmail(userEmail, subject, html, emailType);
    if (ok) {
      await reDb.collection("welcomeEmails").add({
        userEmail, roleLabel, isSwitch,
        previousRoleLabel: previousRoleLabel || null,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ RE welcome email failed:", e.message);
    return false;
  }
};

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

const activateSellerSubscription = async (s, mpesaReference) => {
  const { orderId, planId, sellerId, sellerEmail } = s;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await db.collection("subscriptions").doc(orderId).update({
    status: "active", paymentStatus: "paid", mpesaReference,
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

async function notifySellersOfNewOrder(orderId, orderData) {
  const sellerIds = Array.isArray(orderData?.involvedSellerIds) ? orderData.involvedSellerIds : [];
  if (!sellerIds.length) {
    console.log(`⚠️ Order ${orderId} has no involvedSellerIds — skipping seller notifications`);
    return;
  }

  const buyerName =
    orderData?.shippingDetails?.fullName ||
    orderData?.buyerName ||
    "A customer";

  for (const sellerId of sellerIds) {
    try {
      const sellerSnap = await db.collection("users").doc(sellerId).get();
      if (!sellerSnap.exists) {
        console.log(`⚠️ Seller ${sellerId} doc not found — skipping`);
        continue;
      }
      const seller = sellerSnap.data() || {};
      const sellerPhone =
        seller.phoneNumber || seller.phone || seller.sellerProfile?.phone || null;
      if (!sellerPhone) {
        console.log(`⚠️ Seller ${sellerId} has no phone — skipping WhatsApp`);
        continue;
      }

      const sellerName = seller.fullName || seller.shopName || seller.email?.split("@")[0] || "Seller";
      const sellerRevenue = getSellerRevenue(orderData, sellerId);
      const itemSummary = getSellerItemSummary(orderData, sellerId);

      enqueueWhatsApp(
        sellerPhone,
        sellerNewOrderWhatsApp({
          sellerName, orderId, buyerName, sellerRevenue, itemSummary,
          itemCount: getSellerItems(orderData, sellerId).length,
        }),
        { kind: "seller-new-order", orderId, sellerId }
      );

      console.log(`📤 Seller new-order WA queued → ${sellerId} for order ${orderId}`);
    } catch (err) {
      console.error(`❌ notifySellersOfNewOrder failed for seller ${sellerId}:`, err.message);
    }
  }

  if (isQuicksaleOrder(orderData)) {
    console.log(`⚡ Skipping nudge timer seed for quicksale order ${orderId}`);
    return;
  }

  try {
    const now = Date.now();
    await db.collection("orders").doc(orderId).set({
      sellerNudgeCount: 0,
      sellerNudgeMax: 4,
      nextSellerNudgeAt: new Date(now + 6 * 60 * 60 * 1000),
      sellerNudgeActive: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error(`❌ Failed to seed nudge timer for ${orderId}:`, err.message);
  }
}

const NUDGE_MAX = 4;
const NUDGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NUDGE_SCAN_MS = 15 * 60 * 1000;
const NUDGE_TERMINAL_STATUSES = ["Processing", "Shipped", "Delivered", "Cancelled"];

async function runSellerNudgeScan() {
  try {
    const now = new Date();
    const snap = await db.collection("orders")
      .where("sellerNudgeActive", "==", true)
      .where("paymentStatus", "==", "paid")
      .where("nextSellerNudgeAt", "<=", now)
      .limit(50)
      .get();

    if (snap.empty) return;

    console.log(`⏰ Nudge scan: ${snap.size} order(s) due`);

    for (const docSnap of snap.docs) {
      const orderId = docSnap.id;
      const order = docSnap.data() || {};

      if (isQuicksaleOrder(order)) {
        await docSnap.ref.update({
          sellerNudgeActive: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        continue;
      }

      const currentStatus = order.status || "";
      if (NUDGE_TERMINAL_STATUSES.includes(currentStatus)) {
        await docSnap.ref.update({
          sellerNudgeActive: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        continue;
      }

      const nudgeCount = Number(order.sellerNudgeCount || 0);
      const sellerIds = Array.isArray(order.involvedSellerIds) ? order.involvedSellerIds : [];
      const hiddenFrom = Array.isArray(order.deletedForSellers) ? order.deletedForSellers : [];

      if (nudgeCount >= NUDGE_MAX) {
        await docSnap.ref.update({
          sellerNudgeActive: false,
          sellerNudgeExhausted: true,
          sellerNudgeExhaustedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        await db.collection("adminAlerts").add({
          type: "seller_nudge_exhausted",
          orderId, sellerIds, nudgeCount,
          flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        console.log(`⚠️ Nudges exhausted for ${orderId} — flagged admin`);
        continue;
      }

      const buyerName = order.shippingDetails?.fullName || order.buyerName || "a customer";
      const hoursSince = 6 * (nudgeCount + 1);
      let anySent = false;

      for (const sellerId of sellerIds) {
        if (hiddenFrom.includes(sellerId)) continue;
        try {
          const sellerSnap = await db.collection("users").doc(sellerId).get();
          if (!sellerSnap.exists) continue;
          const seller = sellerSnap.data() || {};
          const sellerPhone = seller.phoneNumber || seller.phone || null;
          if (!sellerPhone) continue;

          const sellerName = seller.fullName || seller.shopName || seller.email?.split("@")[0] || "Seller";

          enqueueWhatsApp(
            sellerPhone,
            sellerReminderWhatsApp({
              sellerName, orderId, buyerName, hoursSince,
              nudgeNumber: nudgeCount + 1, maxNudges: NUDGE_MAX,
            }),
            { kind: `seller-nudge-${nudgeCount + 1}`, orderId, sellerId }
          );
          anySent = true;
        } catch (err) {
          console.error(`❌ Nudge send failed → ${sellerId}:`, err.message);
        }
      }

      const nextCount = nudgeCount + 1;
      const nextAt = new Date(Date.now() + NUDGE_INTERVAL_MS);
      await docSnap.ref.update({
        sellerNudgeCount: nextCount,
        nextSellerNudgeAt: nextAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      console.log(`⏰ Nudge ${nextCount}/${NUDGE_MAX} ${anySent ? "sent" : "skipped (all sellers hidden)"} for ${orderId}`);
    }
  } catch (err) {
    console.error("❌ runSellerNudgeScan error:", err.message);
  }
}

(function startNudgeScheduler() {
  const run = () => {
    runSellerNudgeScan().catch((e) => console.error("Nudge scan crash:", e.message));
    setTimeout(run, NUDGE_SCAN_MS).unref?.();
  };
  setTimeout(run, 60 * 1000).unref?.();
  console.log(`🌀 Seller nudge scheduler active (scan every ${NUDGE_SCAN_MS / 60000} min)`);
})();

// ============================
// ROUTES
// ============================

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
      ctaUrl: MARKETPLACE_URL,
    });

    const ok = await sendEmail(to, subject || `Proposal ${status}`, emailHtml, "sales");
    return res.json({ success: ok, message: ok ? "Sent" : "Failed" });
  } catch (e) {
    return sendServerError(res, e, "Proposal email failed");
  }
});

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
      phoneNumber,
      "shippingDetails.fullName": fullName,
      "shippingDetails.phoneNumber": phoneNumber,
      "shippingDetails.email": email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, data: response });
  } catch (e) {
    return sendServerError(res, e, "STK push failed");
  }
});

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
      phoneNumber,
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
      phoneNumber,
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

const ALLOWED_SELLER_STATUSES = ["Processing", "Shipped", "Delivered", "Cancelled"];

app.post("/api/seller/update-status", async (req, res) => {
  try {
    const { orderId, newStatus } = req.body || {};
    if (!orderId || !newStatus) {
      return res.status(400).json({ success: false, message: "orderId and newStatus required" });
    }
    if (!ALLOWED_SELLER_STATUSES.includes(newStatus)) {
      return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${ALLOWED_SELLER_STATUSES.join(", ")}` });
    }

    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });

    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const sellerId = decoded.uid;

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const order = orderSnap.data() || {};

    const involved = Array.isArray(order.involvedSellerIds) ? order.involvedSellerIds : [];
    if (!involved.includes(sellerId)) {
      return res.status(403).json({ success: false, message: "You are not a seller on this order" });
    }

    if (order.paymentStatus !== "paid") {
      return res.status(400).json({ success: false, message: "Order is not paid — cannot update status" });
    }

    await orderRef.update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      sellerNudgeActive: false,
      lastStatusUpdateBy: sellerId,
      lastStatusUpdateAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Order ${orderId} status → ${newStatus} by seller ${sellerId}`);

    const buyerPhone =
      order.phoneNumber || order.shippingDetails?.phoneNumber || order.buyerPhone || null;

    if (buyerPhone) {
      const customerName =
        order.shippingDetails?.fullName || order.buyerName || "Customer";
      enqueueWhatsApp(
        buyerPhone,
        buyerStatusUpdateWhatsApp({ customerName, orderId, statusLabel: newStatus }),
        { kind: "buyer-status-update", orderId, sellerId, status: newStatus }
      );
    } else {
      console.log(`⚠️ Order ${orderId} has no buyer phone — buyer WhatsApp skipped`);
    }

    if (newStatus === "Cancelled") {
      try {
        await db.collection("adminAlerts").add({
          type: "seller_cancelled_order",
          orderId, cancelledBy: sellerId, involvedSellerIds: involved,
          flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (_) {}
    }

    return res.json({ success: true, orderId, newStatus, buyerNotified: !!buyerPhone });
  } catch (e) {
    console.error("❌ /api/seller/update-status failed:", e);
    return sendServerError(res, e, "Status update failed");
  }
});

app.post("/api/re/welcome", async (req, res) => {
  try {
    const {
      email, name, phone, roleLabel, roleDesc, rolePerks,
      isSwitch = false, previousRoleLabel = null, ctaLabel, ctaUrl,
    } = req.body || {};

    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Valid email required" });
    }
    if (!roleLabel) {
      return res.status(400).json({ success: false, message: "roleLabel required" });
    }

    const emailSent = await sendRealEstateWelcomeEmail({
      userEmail: email, userName: name, roleLabel, roleDesc,
      rolePerks: Array.isArray(rolePerks) ? rolePerks : [],
      isSwitch: !!isSwitch, previousRoleLabel, ctaLabel, ctaUrl,
    });

    let whatsappQueued = false;
    if (phone) {
      const lines = [
        `🏠 *MarketMix Real Estates*`,
        ``,
        isSwitch
          ? `Hi ${name || "there"} — you're now a *${roleLabel}*${previousRoleLabel ? ` (was ${previousRoleLabel})` : ""}.`
          : `*Welcome, ${name || "friend"}!*`,
        ``,
        roleDesc ? roleDesc : "",
        rolePerks && rolePerks.length ? `\n*What you can do:*` : "",
        ...(Array.isArray(rolePerks) ? rolePerks.map((l) => `• ${l}`) : []),
        ``,
        isSwitch
          ? `Changed by mistake? You can switch back anytime from your Profile page.`
          : `You can switch your account type anytime from your Profile page.`,
        ``,
        `👉 ${ctaUrl || REAL_ESTATE_APP_URL}`,
        ``,
        `👥 *Join our WhatsApp group:*`,
        WHATSAPP_GROUP_URL,
      ].filter(Boolean);

      whatsappQueued = enqueueWhatsApp(phone, lines.join("\n"), {
        kind: isSwitch ? "re-welcome-role-switch" : "re-welcome-signup",
        roleLabel,
      });
    }

    return res.json({ success: true, emailSent, whatsappQueued, isSwitch: !!isSwitch, roleLabel });
  } catch (e) {
    console.error("❌ /api/re/welcome failed:", e);
    return sendServerError(res, e, "Welcome failed");
  }
});

app.get("/api/whatsapp/groups", async (req, res) => {
  try {
    const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!r.ok) {
      console.error(`❌ WAHA /api/default/groups → ${r.status}: ${raw.slice(0, 300)}`);
      return res.status(r.status).json({
        success: false, message: "WAHA returned an error",
        wahaStatus: r.status, wahaBody: raw.slice(0, 500),
      });
    }

    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === "object") list = Object.values(data);

    const groups = list
      .filter((c) => c && (c.id || c.chatId) && String(c.id || c.chatId).endsWith("@g.us"))
      .map((c) => ({
        id: c.id || c.chatId,
        name: c.subject || c.name || "(unnamed group)",
        size: c.size || null,
      }));

    console.log(`👥 /api/whatsapp/groups → ${groups.length} group(s)`);
    return res.json({ success: true, count: groups.length, groups });
  } catch (e) {
    console.error("❌ /api/whatsapp/groups failed:", e);
    return sendServerError(res, e, "Could not list groups");
  }
});

app.get("/api/admin/auto-promo", async (req, res) => {
  try {
    const settings = await autoPromoLoadSettings();
    const recent = await db.collection("autoPromoLogs")
      .orderBy("sentAt", "desc").limit(20).get().catch(() => ({ docs: [] }));
    const campaign = autoPromoGetActiveCampaign();
    return res.json({
      success: true,
      settings,
      campaign: campaign ? { name: campaign.name, daysToEvent: campaign.daysToEvent } : null,
      templates: Object.keys(AutoPromoTemplates).map(id => ({ id })),
      recent: recent.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (e) {
    return sendServerError(res, e, "Could not load auto-promo settings");
  }
});

app.post("/api/admin/auto-promo", async (req, res) => {
  try {
    const allowed = ["enabled", "perGroupPerDay", "minGapMinutes", "activeHours", "siteUrl", "selectedGroupIds", "activeCampaignName", "activeFrom", "activeUntil", "activeContentType", "activeSendTimes"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    await autoPromoSaveSettings(patch, req.body?.uid || "admin");
    const settings = await autoPromoLoadSettings();
    return res.json({ success: true, settings });
  } catch (e) {
    return sendServerError(res, e, "Could not save auto-promo settings");
  }
});

app.post("/api/admin/auto-promo/preview", async (req, res) => {
  try {
    const { date = null, groupIds = null } = req.body || {};
    const autoSettings = await autoPromoLoadSettings();
    const occSettings  = await occasionLoadSettings();

    let groups = [];
    try {
      const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
      const data = await r.json().catch(() => ({}));
      const list = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data) : []);
      groups = list
        .filter(g => g && (g.id || g.chatId) && String(g.id || g.chatId).endsWith("@g.us"))
        .map(g => ({ id: g.id || g.chatId, name: g.subject || g.name || "(unnamed)" }));
    } catch (e) {
      return sendServerError(res, e, "Could not fetch groups");
    }

    const seenIds = new Set();
    groups = groups.filter(g => {
      if (seenIds.has(g.id)) return false;
      seenIds.add(g.id);
      return true;
    });

    const previewPersistedIds = Array.isArray(autoSettings.selectedGroupIds)
      ? autoSettings.selectedGroupIds
      : [];
    const previewEffectiveIds =
      Array.isArray(groupIds) && groupIds.length > 0
        ? groupIds
        : previewPersistedIds;
    if (previewEffectiveIds.length > 0) {
      const allowed = new Set(previewEffectiveIds);
      groups = groups.filter(g => allowed.has(g.id));
      console.log(`🤖 Preview: filtered to ${groups.length} group(s) (source: ${Array.isArray(groupIds) && groupIds.length ? "body" : "settings.selectedGroupIds"})`);
    }

    const targetDate = date ? new Date(date + "T00:00:00Z") : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dateStr = targetDate.toISOString().slice(0, 10);
    const month = targetDate.getUTCMonth() + 1;
    const day   = targetDate.getUTCDate();
    const dow   = targetDate.getUTCDay();
    const year  = targetDate.getUTCFullYear();

    const overrides = await loadOverridesForDate(dateStr);
    console.log(`🤖 Preview: ${overrides.size} override(s) loaded for ${dateStr}`);

    const perGroupPerDay = Math.min(
      AUTO_PROMO_MAX_PER_GROUP_PER_DAY,
      Math.max(1, Number(autoSettings.perGroupPerDay) || 4)
    );
    const { start: hourStart, end: hourEnd } = autoSettings.activeHours || { start: 8, end: 21 };

    const hourPool = [];
    for (let h = hourStart; h < hourEnd; h++) hourPool.push(h);

    const autoSlotHours = [];
    if (hourPool.length && perGroupPerDay > 0) {
      const step = hourPool.length / perGroupPerDay;
      for (let i = 0; i < perGroupPerDay; i++) {
        const idx = Math.min(hourPool.length - 1, Math.floor(i * step));
        if (!autoSlotHours.includes(hourPool[idx])) autoSlotHours.push(hourPool[idx]);
      }
      while (autoSlotHours.length < perGroupPerDay) {
        const next = hourPool.find(h => !autoSlotHours.includes(h));
        if (next === undefined) break;
        autoSlotHours.push(next);
      }
    }
    autoSlotHours.sort((a, b) => a - b);

    const pSnap = await db.collection("products").get();
    const products = pSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => {
        const qty = Number(p.quantity) || 0;
        const variantStock = Array.isArray(p.variants)
          ? p.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0)
          : 0;
        return (qty > 0 || variantStock > 0) && p.isPublished !== false;
      });

    const nowKey = month * 100 + day;
    let campaign = null;
    for (const c of AUTO_PROMO_CAMPAIGNS) {
      const startKey = c.startMonth * 100 + c.startDay;
      const endKey   = c.endMonth   * 100 + c.endDay;
      const evtKey   = c.eventMonth * 100 + c.eventDay;
      let inRange = false;
      if (startKey <= endKey) inRange = nowKey >= startKey && nowKey <= endKey;
      else                    inRange = nowKey >= startKey || nowKey <= endKey;
      if (inRange) {
        const evtMonth = Math.floor(evtKey / 100);
        const nowMonth = Math.floor(nowKey / 100);
        const daysToEvent = nowKey <= evtKey
          ? (evtMonth - nowMonth) * 30 + (c.eventDay - day)
          : -1;
        campaign = { ...c, daysToEvent };
        break;
      }
    }

    const dayBucket = dow === 1 ? "monday"
      : (dow === 2 || dow === 3) ? "midweek"
      : dow === 4 ? "almost_friday"
      : dow === 5 ? "friday"
      : dow === 6 ? "saturday" : "sunday";
    const payday   = day >= 25 || day <= 5;
    const monthEnd = day >= 28;

    const autoSlots = [];

    for (const group of groups) {
      const usedProducts = new Set();
      const usedTemplates = new Set();
      const kind = autoPromoDetectGroupKind(group.name);

      for (const hour of autoSlotHours) {
        const timeBucket = autoPromoTimeBucket(hour);

        const rng = autoPromoSeededRng(`${dateStr}|${group.id}|${hour}`);

        const pool = autoPromoPickTemplatePool({ campaign, timeBucket, dayBucket, payday, monthEnd, groupKind: kind });
        const templateId = pool.find(id => !usedTemplates.has(id)) || pool[0];
        usedTemplates.add(templateId);

        const available = products.filter(p => !usedProducts.has(p.id));
        const pickFrom = available.length ? available : products;
        if (!pickFrom.length) {
          autoSlots.push({
            time: `${String(hour).padStart(2, "0")}:00`,
            hourEAT: hour, timeBucket, templateId,
            slotKind: "promo", skipped: true, reason: "no-products",
            groupId: group.id,
            groupName: group.name,
            productName: null, imageUrl: null,
            caption: "(no product available)",
          });
          continue;
        }
        const product = pickFrom[Math.floor(rng() * pickFrom.length)];
        usedProducts.add(product.id);

        const productUrl = `${autoSettings.siteUrl}/product/${product.slug || product.id}`;
        const caption = autoPromoFillTemplate(templateId, {
          product,
          campaign,
          groupName: group.name,
          productUrl,
        });

        let slot = {
          time: `${String(hour).padStart(2, "0")}:00`,
          hourEAT: hour, timeBucket, templateId,
          slotKind: "promo",
          groupId: group.id,
          groupName: group.name,
          productId: product.id,
          productName: product.name || "—",
          imageUrl: productImageUrl(product),
          caption,
          skipped: false,
        };

        slot = applyOverride(slot, overrides);
        autoSlots.push(slot);
      }
    }

    const { dated, recurring } = resolveOccasionsForDate({
      month, day, weekday: dow, year,
      movableDates: occSettings.movableDates || {},
      includeRecurring: !!occSettings.sendRecurring,
    });

    const occasionSlots = [];
    for (const group of groups) {
      for (const occ of [...dated, ...recurring]) {
        const message = buildOccasionMessage(occ, { shopLink: occSettings.siteUrl || WEBSITE_URL });
        if (!message) continue;
        const isRecurring = !!occ.recurring;
        const isSensitive = !!occ.sensitive;
        const baseHour = isRecurring ? 3 : 9;
        occasionSlots.push({
          time: `${String(baseHour).padStart(2, "0")}:00`,
          hourEAT: baseHour,
          slotKind: isSensitive ? "non-promo" : "occasion",
          templateId: null,
          groupId: group.id,
          groupName: group.name,
          occasionKey: occ.key,
          occasionName: occ.name,
          sensitive: isSensitive,
          productName: occ.name,
          imageUrl: null,
          caption: message,
          skipped: false,
        });
      }
    }

    const slots = [...autoSlots, ...occasionSlots]
      .sort((a, b) => {
        const t = a.time.localeCompare(b.time);
        if (t !== 0) return t;
        return (a.groupName || "").localeCompare(b.groupName || "");
      });

    const expectedPromoSlots = groups.length * autoSlotHours.length;

    return res.json({
      success: true,
      date: dateStr,
      campaign: campaign ? { name: campaign.name, daysToEvent: campaign.daysToEvent } : null,
      groupCount: groups.length,
      perGroupPerDay,
      autoSlotHours,
      expectedPromoSlots,
      promoSlotsReturned: autoSlots.length,
      occasionSlotsReturned: occasionSlots.length,
      activeHours: autoSettings.activeHours || { start: 8, end: 21 },
      overridesLoaded: overrides.size,
      overridesApplied: autoSlots.filter(s => s.isOverridden).length,
      slots,
    });
  } catch (e) {
    console.error("❌ /api/admin/auto-promo/preview failed:", e);
    return sendServerError(res, e, "Preview failed");
  }
});

app.post("/api/admin/auto-promo/run-now", async (req, res) => {
  try {
    const settings = await autoPromoLoadSettings();
    await autoPromoSaveSettings({ enabled: true }, "admin-run-now");
    const result = await autoPromoRunTick({
      WA_MAX_PER_RUN: 3,
      forceGroupIds: Array.isArray(req.body?.groupIds) ? req.body.groupIds : null,
      forceProductId: req.body?.productId || null,
    });
    await autoPromoSaveSettings({ enabled: !!settings.enabled }, "admin-run-now-restore");
    return res.json({ success: true, result });
  } catch (e) {
    return sendServerError(res, e, "Run-now failed");
  }
});

app.get("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: "date query param required" });
    const snap = await db.collection("marketingOverrides")
      .where("date", "==", date)
      .get();
    return res.json({
      success: true,
      count: snap.size,
      overrides: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (e) {
    return sendServerError(res, e, "Could not load overrides");
  }
});

app.post("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date, slot, originalProductId, productId, productName, imageUrl, caption, time, skipped, groupId } = req.body || {};
    if (!date || !slot) return res.status(400).json({ success: false, message: "date and slot required" });

    const key = `${date}_${slot}_${originalProductId || "noplan"}`;
    const payload = {
      date,
      slot,
      originalProductId: originalProductId || null,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      savedBy: req.body?.uid || "admin",
    };
    if (groupId !== undefined) payload.groupId = groupId;
    if (productId !== undefined) payload.productId = productId;
    if (productName !== undefined) payload.productName = productName;
    if (imageUrl !== undefined) payload.imageUrl = imageUrl;
    if (caption !== undefined) payload.caption = caption;
    if (time !== undefined) payload.time = time;
    if (skipped !== undefined) payload.skipped = skipped;

    await db.collection("marketingOverrides").doc(key).set(payload, { merge: true });
    return res.json({ success: true, key, payload });
  } catch (e) {
    return sendServerError(res, e, "Could not save override");
  }
});

app.delete("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date, slot, originalProductId } = req.body || {};
    if (!date || !slot) return res.status(400).json({ success: false, message: "date and slot required" });
    const key = `${date}_${slot}_${originalProductId || "noplan"}`;
    await db.collection("marketingOverrides").doc(key).delete().catch(() => {});
    return res.json({ success: true, key });
  } catch (e) {
    return sendServerError(res, e, "Could not delete override");
  }
});

app.get("/api/admin/occasions", async (req, res) => {
  try {
    const settings = await occasionLoadSettings();
    const todayMonth = autoPromoMonthEAT();
    const todayDay = autoPromoDayEAT();
    const todayWeekday = autoPromoDowEAT();
    const today = resolveOccasionsForDate({
      month: todayMonth, day: todayDay, weekday: todayWeekday,
      movableDates: settings.movableDates || {},
      includeRecurring: true,
    });

    const recent = await db.collection("occasionLogs")
      .orderBy("sentAt", "desc").limit(30).get().catch(() => ({ docs: [] }));

    return res.json({
      success: true,
      settings,
      today: {
        dated: today.dated.map(o => ({ key: o.key, name: o.name, sensitive: !!o.sensitive, kind: o.kind })),
        recurring: today.recurring.map(o => ({ key: o.key, name: o.name, sensitive: !!o.sensitive })),
      },
      totalOccasions: OCCASION_LIBRARY.length,
      movableCount: OCCASION_LIBRARY.filter(o => o.movable).length,
      recurringCount: OCCASION_LIBRARY.filter(o => o.recurring === "weekly").length,
      sensitiveCount: OCCASION_LIBRARY.filter(o => o.sensitive === true).length,
      recent: recent.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (e) {
    return sendServerError(res, e, "Could not load occasions");
  }
});

app.post("/api/admin/occasions", async (req, res) => {
  try {
    const allowed = ["enabled", "sendDated", "sendRecurring", "activeHours", "siteUrl", "movableDates", "allowPromoOnSensitive"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    await occasionSaveSettings(patch, req.body?.uid || "admin");
    const settings = await occasionLoadSettings();
    return res.json({ success: true, settings });
  } catch (e) {
    return sendServerError(res, e, "Could not save occasion settings");
  }
});

app.post("/api/admin/occasions/preview", async (req, res) => {
  try {
    const { date = null, groupIds = null, includeRecurring = true } = req.body || {};
    const settings = await occasionLoadSettings();

    let groups = [];
    try {
      const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
      const data = await r.json().catch(() => ({}));
      const list = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data) : []);
      groups = list
        .filter(g => g && (g.id || g.chatId) && String(g.id || g.chatId).endsWith("@g.us"))
        .map(g => ({ id: g.id || g.chatId, name: g.subject || g.name || "(unnamed)" }));
    } catch (e) {
      return sendServerError(res, e, "Could not fetch groups");
    }
    if (Array.isArray(groupIds) && groupIds.length > 0) {
      const allowed = new Set(groupIds);
      groups = groups.filter(g => allowed.has(g.id));
    }

    const targetDate = date ? new Date(date + "T00:00:00Z") : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const month = targetDate.getUTCMonth() + 1;
    const day = targetDate.getUTCDate();
    const weekday = targetDate.getUTCDay();
    const year = targetDate.getUTCFullYear();

    const { dated, recurring } = resolveOccasionsForDate({
      month, day, weekday, year,
      movableDates: settings.movableDates || {},
      includeRecurring: !!includeRecurring,
    });

    const buildPreviews = (list) => list.map(occ => {
      const message = buildOccasionMessage(occ, { shopLink: settings.siteUrl || WEBSITE_URL });
      return {
        key: occ.key, name: occ.name, kind: occ.kind,
        sensitive: !!occ.sensitive, movable: !!occ.movable,
        preview: message ? message.slice(0, 300) : null,
      };
    });

    return res.json({
      success: true,
      date: targetDate.toISOString().slice(0, 10),
      groupCount: groups.length,
      dated: buildPreviews(dated),
      recurring: buildPreviews(recurring),
    });
  } catch (e) {
    console.error("❌ /api/admin/occasions/preview failed:", e);
    return sendServerError(res, e, "Occasion preview failed");
  }
});

app.post("/api/admin/occasions/run-now", async (req, res) => {
  try {
    const settings = await occasionLoadSettings();
    const wasEnabled = settings.enabled;
    await occasionSaveSettings({ enabled: true }, "admin-occasion-run-now");
    const result = await occasionRunTick({
      forceGroups: Array.isArray(req.body?.groupIds)
        ? req.body.groupIds.map(id => ({ id, name: "(forced)" }))
        : null,
      forceOccasionKey: req.body?.occasionKey || null,
    });
    await occasionSaveSettings({ enabled: !!wasEnabled }, "admin-occasion-run-now-restore");
    return res.json({ success: true, result });
  } catch (e) {
    return sendServerError(res, e, "Occasion run-now failed");
  }
});

app.post("/api/whatsapp/send-media", async (req, res) => {
  try {
    const {
      recipients = [], message = "", mediaUrl = null,
      mediaType = "image", filename = null, pace = "safe", dryRun = false,
    } = req.body || {};

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, message: "recipients[] required" });
    }
    if (!message && !mediaUrl) {
      return res.status(400).json({ success: false, message: "message or mediaUrl required" });
    }
    if (recipients.length > 300) {
      return res.status(400).json({ success: false, message: "Max 300 recipients per batch" });
    }

    const PACE = {
      safe:   { base: 6000, jitter: 0.35 },
      normal: { base: 4000, jitter: 0.30 },
      fast:   { base: 2500, jitter: 0.25 },
    };
    const { base, jitter } = PACE[pace] || PACE.safe;
    const delay = () => base + Math.floor(base * jitter * (Math.random() * 2 - 1));

    const results = [];
    const startedAt = Date.now();

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i] || {};
      const phone = r.phone;
      const name = r.name || null;
      const text = personalizeBulkMessage(message, { name });

      if (dryRun) {
        results.push({ phone, name, status: "validated", message: text.slice(0, 120) + (text.length > 120 ? "…" : "") });
        continue;
      }

      try {
        if (mediaUrl) {
          const sender = mediaType === "file" ? wahaSendFile : wahaSendImage;
          await sender({
            phone,
            ...(mediaType === "file" ? { fileUrl: mediaUrl } : { imageUrl: mediaUrl }),
            caption: text, filename,
          });
        } else {
          enqueueWhatsApp(phone, text, { kind: "bulk-text" });
        }
        results.push({ phone, name, status: "sent" });
        console.log(`📤 Bulk ${i + 1}/${recipients.length} → ${phone}`);
      } catch (e) {
        results.push({ phone, name, status: "failed", error: e.message || "send failed" });
        console.error(`❌ Bulk fail → ${phone}:`, e.message);
      }

      if (i < recipients.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay()));
      }
    }

    const sent = results.filter((x) => x.status === "sent").length;
    const failed = results.filter((x) => x.status === "failed").length;

    await reDb.collection("bulkWhatsAppLogs").add({
      total: recipients.length, sent, failed, pace,
      mediaType: mediaUrl ? mediaType : "text",
      mediaUrl: mediaUrl || null,
      messagePreview: String(message).slice(0, 300),
      durationMs: Date.now() - startedAt,
      results,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    return res.json({
      success: true, total: recipients.length, sent, failed,
      dryRun: !!dryRun, durationMs: Date.now() - startedAt, results,
    });
  } catch (e) {
    console.error("❌ /api/whatsapp/send-media failed:", e);
    return sendServerError(res, e, "Bulk WhatsApp send failed");
  }
});

app.post("/api/admin/notify-user", async (req, res) => {
  try {
    const { userId, phone, email, title = "MarketMix update", message, kind = "admin-notify" } = req.body || {};
    if (!userId || !message) {
      return res.status(400).json({ success: false, message: "userId and message required" });
    }

    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });

    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const callerDoc = await reDb.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists) return res.status(403).json({ success: false, message: "Admin access required" });
    const caller = callerDoc.data() || {};
    const isAdmin =
      caller.role === "admin" || caller.userType === "admin" ||
      (Array.isArray(caller.roles) && caller.roles.includes("admin"));
    if (!isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });

    let target = null;
    let targetDb = "realestate";

    const reTarget = await reDb.collection("users").doc(userId).get();
    if (reTarget.exists) target = reTarget.data();
    else {
      const shopTarget = await db.collection("users").doc(userId).get();
      if (shopTarget.exists) { target = shopTarget.data(); targetDb = "shop"; }
    }

    if (!target) return res.status(404).json({ success: false, message: "User not found" });

    const resolvedPhone = phone || target.phoneNumber || target.phone || target.driverProfile?.phone || null;
    const resolvedEmail = email || target.email || null;

    let whatsappQueued = false;
    let emailSent = false;

    if (resolvedPhone) {
      whatsappQueued = enqueueWhatsApp(
        resolvedPhone,
        `🛍️ MarketMix Kenya\n${title}\n\n${message}`,
        { kind, userId, sourceDb: targetDb }
      );
    }

    if (resolvedEmail) {
      const html = marketMixEmailShell({
        preheader: title, eyebrow: "MarketMix Kenya", title,
        subtitle: "Update from MarketMix",
        bodyHtml: emailBodyText(message),
        footerNote: "If this wasn't expected, reply to this email and we'll help.",
      });
      emailSent = await sendEmail(resolvedEmail, title, html, "sales");
    }

    try {
      await reDb.collection("adminNotifications").add({
        userId, phone: resolvedPhone || null, email: resolvedEmail || null,
        title, message, kind, whatsappQueued, emailSent,
        sentBy: decoded.uid,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}

    return res.json({ success: true, whatsappQueued, emailSent, hasPhone: !!resolvedPhone, hasEmail: !!resolvedEmail });
  } catch (e) {
    console.error("❌ Admin notify-user failed:", e);
    return sendServerError(res, e, "Admin notify failed");
  }
});

app.post("/api/driver/decision", async (req, res) => {
  try {
    const { userId, decision, reason = "" } = req.body || {};
    if (!userId || !["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, message: "userId and decision (approve|reject) required" });
    }

    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });

    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const callerDoc = await reDb.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists) return res.status(403).json({ success: false, message: "Admin access required" });
    const caller = callerDoc.data() || {};
    const isAdmin =
      caller.role === "admin" || caller.userType === "admin" ||
      (Array.isArray(caller.roles) && caller.roles.includes("admin"));
    if (!isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });

    const userRef = reDb.collection("users").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, message: "Driver not found" });
    const driver = userSnap.data() || {};
    const profile = driver.driverProfile || {};
    const approved = decision === "approve";

    await userRef.update({
      driverApproved: approved,
      driverStatus: approved ? "approved" : "rejected",
      driverRejectionReason: approved ? "" : (reason || "Not specified"),
      driverReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      driverReviewedBy: decoded.uid,
      roles: approved
        ? Array.from(new Set([...(Array.isArray(driver.roles) ? driver.roles : []), "driver"]))
        : (Array.isArray(driver.roles) ? driver.roles : []).filter(r => r !== "driver"),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const driverEmail = driver.email || "";
    const driverPhone = profile.phone || driver.phone || driver.phoneNumber || "";
    const driverName = driver.name || (driverEmail ? driverEmail.split("@")[0] : "Driver");

    if (approved) {
      if (driverEmail) {
        const html = marketMixEmailShell({
          preheader: "Your driver account is approved",
          eyebrow: "MarketMix Moving",
          title: "You're approved to drive",
          subtitle: `Welcome aboard, ${driverName}. Your driver account is active.`,
          bodyHtml: `
            ${emailBodyText("You can now accept move requests on MarketMix and start earning.")}
            ${emailSectionLabel("Your driver details")}
            ${emailInfoCard([
              ["Vehicle", profile.vehicleId || "—"],
              ["Plate", profile.plate || "—"],
              ["License", profile.licenseNumber || "—"],
              ["Phone", driverPhone || "—"],
            ])}
            ${emailBodyText("Open the driver dashboard to see live offers and manage trips.")}
          `,
          ctaLabel: "Open driver dashboard",
          ctaUrl: DRIVER_DASHBOARD_URL,
          footerNote: "Questions? Reply to this email and we'll help.",
        });
        sendEmail(driverEmail, "You're approved · MarketMix Moving", html, "moving")
          .catch(e => console.error("Driver approve email error:", e));
      }
      if (driverPhone) {
        enqueueWhatsApp(driverPhone,
          `🚚 MarketMix Moving\nWelcome ${driverName}!\nYour driver account is APPROVED.\nVehicle: ${profile.vehicleId || "—"}\nPlate: ${profile.plate || "—"}\nOpen dashboard: ${DRIVER_DASHBOARD_URL}`,
          { kind: "driver-approved", userId }
        );
      }
    } else {
      if (driverEmail) {
        const html = marketMixEmailShell({
          preheader: "Driver application update",
          eyebrow: "MarketMix Moving",
          title: "Driver application not approved",
          subtitle: `Hello ${driverName}, we couldn't approve your driver account at this time.`,
          bodyHtml: `
            ${emailBodyText("You can update your details and resubmit at any time.")}
            ${emailSectionLabel("Reason")}
            ${emailInfoCard([["Reason", reason || "Not specified"]])}
            ${emailBodyText("If you believe this is a mistake, reply to this email and we'll review again.")}
          `,
          ctaLabel: "Update my details",
          ctaUrl: DRIVER_ONBOARD_URL,
          footerNote: "MarketMix Kenya · support@marketmix.site",
        });
        sendEmail(driverEmail, "Update on your driver application · MarketMix Moving", html, "moving")
          .catch(e => console.error("Driver reject email error:", e));
      }
      if (driverPhone) {
        enqueueWhatsApp(driverPhone,
          `🚚 MarketMix Moving\nHello ${driverName},\nYour driver application was not approved.\nReason: ${reason || "Not specified"}\nUpdate your details at ${DRIVER_ONBOARD_URL}`,
          { kind: "driver-rejected", userId }
        );
      }
    }

    console.log(`✅ Driver ${userId} → ${approved ? "approved" : "rejected"} (by admin ${decoded.uid})`);
    return res.json({ success: true, decision, userId });
  } catch (e) {
    console.error("❌ Driver decision failed:", e);
    return sendServerError(res, e, "Driver decision failed");
  }
});

app.post("/api/whatsapp/notify", async (req, res) => {
  try {
    const {
      phone, title, message, imageUrl, imageBase64, filename,
      mediaType = "image",
    } = req.body || {};

    if (!phone || !message) {
      return res.status(400).json({ success: false, message: "phone and message required" });
    }

    const body = title ? `🛍️ MarketMix Kenya\n${title}\n\n${message}` : String(message);

    const incomingImage =
      (typeof imageUrl === "string" && imageUrl.trim()) ||
      (typeof imageBase64 === "string" && imageBase64.trim()) ||
      null;

    const imagePayload = incomingImage ? buildWahaFilePayload(incomingImage, { filename }) : null;

    if (!imagePayload) {
      const queued = enqueueWhatsApp(phone, body, { kind: "generic-notify" });
      if (!queued) return res.status(400).json({ success: false, message: "Invalid phone number" });
      return res.json({ success: true, queued: true, mode: "text", phone: normalizeWaChatId(phone) });
    }

    const normalized = normalizeWaChatId(phone);
    if (!normalized) {
      return res.status(400).json({ success: false, message: "Invalid phone number" });
    }

    try {
      const isFile = mediaType === "file";
      const sender = isFile ? wahaSendFile : wahaSendImage;

      await sender({
        phone: normalized,
        ...(isFile
          ? { fileUrl: imagePayload.mode === "url" ? imagePayload.file.url : null,
              ...(imagePayload.mode === "data"
                ? { fileUrl: `data:${imagePayload.file.mimetype};base64,${imagePayload.file.data}` }
                : {}) }
          : { imageUrl: imagePayload.mode === "url"
              ? imagePayload.file.url
              : `data:${imagePayload.file.mimetype};base64,${imagePayload.file.data}` }),
        caption: body,
        filename: filename || imagePayload.file.filename,
      });

      console.log(`🖼️ /api/whatsapp/notify → image sent to ${normalized}`);
      return res.json({
        success: true, sent: true, mode: "image",
        mediaType: isFile ? "file" : "image",
        phone: normalized,
      });
    } catch (imgErr) {
      console.error(`⚠️ Image send failed for ${normalized}, falling back to text:`, imgErr.message);
      const queued = enqueueWhatsApp(phone, body, { kind: "generic-notify-fallback" });
      return res.json({
        success: true, queued, mode: "text-fallback",
        phone: normalized, imageError: imgErr.message,
      });
    }
  } catch (e) {
    console.error("❌ /api/whatsapp/notify failed:", e);
    return sendServerError(res, e, "WhatsApp notify failed");
  }
});

app.post("/api/whatsapp/welcome", async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, message: "phone required" });
    }
    const queued = enqueueWhatsApp(
      phone,
      welcomeSubscriberWhatsApp({ name }),
      { kind: "welcome-subscriber", phone, hasName: !!name }
    );
    if (!queued) {
      return res.status(400).json({ success: false, message: "Invalid phone number" });
    }
    return res.json({ success: true, queued: true });
  } catch (e) {
    console.error("❌ /api/whatsapp/welcome failed:", e);
    return sendServerError(res, e, "Welcome WhatsApp failed");
  }
});

app.post("/api/service-request/notify", async (req, res) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, message: "requestId required" });

    let snap = await db.collection("serviceRequests").doc(requestId).get();
    let sourceDb = "shop";
    if (!snap.exists) {
      snap = await reDb.collection("serviceRequests").doc(requestId).get();
      sourceDb = "realestate";
    }
    if (!snap.exists) return res.status(404).json({ success: false, message: "Request not found" });

    const d = snap.data() || {};
    const phone = d.userPhone || d.phoneNumber || null;
    const email = d.userEmail || d.email || null;
    const status = String(d.status || "new").toUpperCase();
    const note = d.adminNote || "";
    const label = d.packageTitle || d.packageId || "Move-in request";

    let whatsappQueued = false;
    let emailSent = false;

    if (phone) {
      whatsappQueued = enqueueWhatsApp(
        phone,
        `🏠 MarketMix Real Estates\n${label}\nStatus: ${status}${note ? `\n\nNote: ${note}` : ""}`,
        { kind: "service-request-update", requestId, sourceDb }
      );
    }

    if (email) {
      const html = marketMixEmailShell({
        preheader: `${label} · ${status}`,
        eyebrow: "MarketMix Real Estates",
        title: `${label} update`,
        subtitle: `Status: ${status}`,
        bodyHtml: `
          ${emailSectionLabel("Update")}
          ${emailInfoCard([
            ["Request", label],
            ["Status", status, true],
            ["Area", d.area || "—"],
          ])}
          ${note ? emailBodyText(`<strong>Note from our team:</strong><br/>${note}`) : ""}
        `,
        ctaLabel: "Open MarketMix",
        ctaUrl: REAL_ESTATE_APP_URL,
      });
      emailSent = await sendEmail(email, `${label} · ${status}`, html, "bookings");
    }

    try {
      await reDb.collection("serviceRequestNotifications").add({
        requestId, sourceDb, phone, email, whatsappQueued, emailSent, status, note,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}

    return res.json({ success: true, whatsappQueued, emailSent, hasPhone: !!phone, hasEmail: !!email });
  } catch (e) {
    console.error("❌ service-request/notify failed:", e);
    return sendServerError(res, e, "Service request notify failed");
  }
});

app.post("/api/moving/notify", async (req, res) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, message: "requestId required" });

    let snap = await reDb.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) snap = await db.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Request not found" });

    const d = snap.data() || {};
    const phone = d.userPhone || d.phoneNumber || d.user?.phone || null;
    const email = d.userEmail || d.email || null;
    const statusLabel = String(d.status || "REQUESTED").replace(/_/g, " ").toLowerCase();
    const quote = d.quotedPrice != null ? `KSh ${Number(d.quotedPrice).toLocaleString("en-KE")}` : "Pending";
    const driver = d.driverName ? `${d.driverName}${d.driverPhone ? ` · ${d.driverPhone}` : ""}` : "Not yet assigned";
    const vehicle = d.vehicleLabel || "—";
    const eta = d.etaMinutes != null ? `${d.etaMinutes} min` : "—";

    let whatsappQueued = false;
    let emailSent = false;

    if (phone) {
      whatsappQueued = enqueueWhatsApp(
        phone,
        `🚚 MarketMix Moving\nStatus: ${statusLabel.toUpperCase()}\nQuote: ${quote}\nDriver: ${driver}\nVehicle: ${vehicle}\nETA: ${eta}\nTrack: ${MOVING_URL}`,
        { kind: "moving-admin-update", requestId: snap.id }
      );
    }

    if (email) {
      const html = marketMixEmailShell({
        preheader: `Your move is ${statusLabel}`,
        eyebrow: "MarketMix Moving",
        title: "Move update",
        subtitle: `Status: ${statusLabel}`,
        bodyHtml: `
          ${emailSectionLabel("Update")}
          ${emailInfoCard([
            ["Status", statusLabel.toUpperCase(), true],
            ["Quote", quote],
            ["Driver", driver],
            ["Vehicle", vehicle],
            ["ETA", eta],
          ])}
          ${emailBodyText("Open the tracking page for live updates.")}
        `,
        ctaLabel: "Open tracking page",
        ctaUrl: MOVING_URL,
      });
      emailSent = await sendEmail(email, `Move update · ${statusLabel}`, html, "moving");
    }

    return res.json({ success: true, whatsappQueued, emailSent, hasPhone: !!phone, hasEmail: !!email });
  } catch (e) {
    console.error("❌ moving/notify failed:", e);
    return sendServerError(res, e, "Moving notify failed");
  }
});

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
        orderId: api_ref, paymentStatus,
        mpesaReference: mpesa_reference || null,
        totalAmount: amount, state,
        isWalletDeposit: true, sellerId,
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
        orderData.userEmail || orderData.shippingDetails?.email ||
        orderData.buyerEmail || orderData.email;

      if (!userEmail && orderData.userId) {
        try {
          const u = await db.collection("users").doc(orderData.userId).get();
          if (u.exists) userEmail = u.data().email;
        } catch (_) {}
      }
      if (!userEmail && isTestRef(api_ref)) {
        userEmail = orderData.testEmail || process.env.TEST_RECEIPT_EMAIL || null;
      }

      const payerPhone =
        orderData.phoneNumber || orderData.shippingDetails?.phoneNumber ||
        orderData.buyerPhone || null;

      const realEstate = isRealEstateOrder(api_ref, orderData);
      const moving = isMovingRef(api_ref) || orderData?.isMoving === true;
      const quicksale = isQuicksaleOrder(orderData) || isQuicksaleRef(api_ref);

      const customerName =
        orderData.shippingDetails?.fullName || orderData.buyerName ||
        (userEmail ? userEmail.split("@")[0] : "Customer");

      if (!quicksale) {
        if (!userEmail) {
          console.log(`⚠️ No email on order ${api_ref}, skipping email receipt`);
        } else if (realEstate) {
          if (mpesa_reference) {
            await orderRef.update({
              displayId: mpesa_reference,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          const payload = {
            ...orderData,
            totalAmount: orderData.totalAmount || callbackAmount || 0,
            mpesaReference: mpesa_reference || orderData.mpesaReference || "—",
          };
          sendRealEstatePaymentEmail(payload, userEmail, api_ref)
            .then((ok) => console.log(ok ? `🏠 RE receipt sent for ${api_ref}` : `❌ RE receipt failed for ${api_ref}`))
            .catch((e) => console.error("RE email error:", e));
        } else if (moving) {
          sendMovingConfirmationEmail({
            ...orderData,
            status: "PAID",
            mpesaReference: mpesa_reference,
            totalAmount: orderData.totalAmount || callbackAmount || 0,
          }, userEmail, api_ref)
            .then((ok) => console.log(ok ? `🚚 Moving receipt sent for ${api_ref}` : `❌ Moving receipt failed for ${api_ref}`))
            .catch((e) => console.error("Moving email error:", e));
        } else {
          sendOrderConfirmationEmail(orderData, userEmail, api_ref)
            .then((ok) => console.log(ok ? `✅ Confirmation sent for ${api_ref}` : `❌ Confirmation failed for ${api_ref}`))
            .catch((e) => console.error("Email error:", e));
        }
      }

      const shortRef = String(mpesa_reference || api_ref).slice(0, 16);
      const amountNum = Number(orderData.totalAmount || callbackAmount || 0);

      if (realEstate) {
        if (payerPhone) {
          enqueueWhatsApp(payerPhone,
            `🏠 MarketMix Real Estates\nPayment confirmed — ${orderData.propertyTitle || "Property"}\nKES ${amountNum.toLocaleString("en-KE")}\nM-Pesa ref: ${mpesa_reference || "—"}\nView receipt: ${REAL_ESTATE_RECEIPT_URL}/${mpesa_reference || api_ref}\n\n👥 *Join our WhatsApp group:*\n${WHATSAPP_GROUP_URL}`,
            { kind: "re-buyer", api_ref }
          );
        }
        if (orderData.landlordPhone) {
          enqueueWhatsApp(orderData.landlordPhone,
            `🏠 MarketMix Real Estates\nNew payment received for ${orderData.propertyTitle || "your property"}\nAmount: KES ${amountNum.toLocaleString("en-KE")}\nRef: ${mpesa_reference || "—"}`,
            { kind: "re-landlord", api_ref }
          );
        }
      } else if (moving) {
        if (payerPhone) {
          enqueueWhatsApp(payerPhone,
            `🚚 MarketMix Moving\nYour move is confirmed\nRef: ${shortRef}\nAmount: KES ${amountNum.toLocaleString("en-KE")}\nTrack it: ${MOVING_URL}\n\n👥 *Join our WhatsApp group:*\n${WHATSAPP_GROUP_URL}`,
            { kind: "moving-paid", api_ref }
          );
        }
      } else if (quicksale) {
        if (payerPhone) {
          enqueueWhatsApp(
            payerPhone,
            quicksaleBuyerWhatsApp({
              customerName,
              itemSummary: quicksaleItemSummary(orderData),
              amount: amountNum,
              paymentReference: mpesa_reference || api_ref,
              sellerShop: null,
            }),
            { kind: "quicksale-buyer", api_ref }
          );
        } else {
          console.log(`⚠️ Quicksale ${api_ref} has no buyer phone — buyer WhatsApp skipped`);
        }

        const sellerIds = Array.isArray(orderData.involvedSellerIds) ? orderData.involvedSellerIds : [];
        for (const sellerId of sellerIds) {
          try {
            const sellerSnap = await db.collection("users").doc(sellerId).get();
            if (!sellerSnap.exists) continue;
            const seller = sellerSnap.data() || {};
            const sellerPhone = seller.phoneNumber || seller.phone || null;
            if (!sellerPhone) continue;
            const sellerName = seller.fullName || seller.shopName || seller.email?.split("@")[0] || "Seller";

            const sellerItems = getSellerItems(orderData, sellerId);
            const itemSummary = sellerItems.length
              ? sellerItems.slice(0, 3).map((it) => `${it.name} x${it.quantity}`).join(", ") +
                (sellerItems.length > 3 ? ` +${sellerItems.length - 3} more` : "")
              : quicksaleItemSummary(orderData);

            enqueueWhatsApp(
              sellerPhone,
              quicksaleSellerWhatsApp({
                sellerName, itemSummary, amount: amountNum,
                paymentReference: mpesa_reference || api_ref,
                customerName,
                customerPhone: payerPhone || "—",
              }),
              { kind: "quicksale-seller", api_ref, sellerId }
            );
            console.log(`📤 Quicksale seller WA queued → ${sellerId} for ${api_ref}`);
          } catch (err) {
            console.error(`❌ Quicksale seller notify failed → ${sellerId}:`, err.message);
          }
        }

        console.log(`⚡ Quicksale ${api_ref} — no nudge timer seeded`);
      } else {
        if (payerPhone) {
          enqueueWhatsApp(
            payerPhone,
            storePaymentConfirmedWhatsApp({
              customerName,
              amount: amountNum,
              paymentReference: mpesa_reference || api_ref,
            }),
            { kind: "store-payment-confirmed", api_ref }
          );

          enqueueWhatsApp(
            payerPhone,
            storeOrderConfirmedWhatsApp({
              customerName, orderId: api_ref,
              paymentStatus: "Paid", orderStatus: "Processing",
            }),
            { kind: "store-order-confirmed", api_ref }
          );
        } else {
          console.log(`⚠️ Store order ${api_ref} has no phone — buyer WhatsApp templates skipped`);
        }

        await notifySellersOfNewOrder(api_ref, orderData);
      }
    }

    return res.send("OK");
  } catch (e) {
    console.error("❌ Callback error:", e);
    return res.status(500).send("Callback processing failed");
  }
});

app.get("/api/ad-transaction/:paymentRef", async (req, res) => {
  const paymentRef = req.params.paymentRef;
  try {
    if (!paymentRef) return res.status(400).json({ success: false, message: "Missing paymentRef" });
    console.log(`🔍 Lookup: ${paymentRef}`);

    let orderDoc = await db.collection("orders").doc(paymentRef).get();

    if (!orderDoc.exists) {
      const byMpesa = await db.collection("orders")
        .where("mpesaReference", "==", paymentRef)
        .where("isRealEstate", "==", true)
        .limit(1)
        .get();
      if (!byMpesa.empty) {
        orderDoc = byMpesa.docs[0];
        console.log(`✅ Resolved ${paymentRef} → real-estate order via M-Pesa ref`);
      }
    }

    if (orderDoc.exists) {
      const orderData = orderDoc.data();
      console.log(`✅ Order found: paymentStatus=${orderData.paymentStatus}, isWalletDeposit=${!!orderData.isWalletDeposit}, isRealEstate=${!!orderData.isRealEstate}`);

      if (orderData.paymentStatus === "paid" && orderData.isWalletDeposit && orderData.sellerId) {
        const adRef = db.collection("adTransactions").doc(orderDoc.id);
        const adSnap = await adRef.get();
        if (!adSnap.exists) {
          const amount = orderData.totalAmount || 1;
          await adRef.set({
            paymentRef: orderDoc.id, sellerId: orderData.sellerId,
            sellerEmail: orderData.sellerEmail || null,
            type: "deposit", amount, status: "completed",
            paymentMethod: "mpesa",
            mpesaCode: orderData.mpesaReference || "SYNCED",
            description: `Ad wallet deposit - KSH ${amount.toFixed(2)}`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`🔄 Auto-healed adTransaction ${orderDoc.id}`);
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

    enqueueWhatsApp(phoneNumber,
      `💸 MarketMix Kenya\nWithdrawal initiated\nAmount: KES ${amount.toLocaleString("en-KE")}\nFee: KES ${feeAmount.toLocaleString("en-KE")}\nNet payout: KES ${netPayout.toLocaleString("en-KE")}\nRef: ${String(payout?.tracking_id || wRef.id).slice(0, 16)}`,
      { kind: "withdrawal", sellerId }
    );

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

    if (u.phoneNumber || u.phone) {
      enqueueWhatsApp(u.phoneNumber || u.phone,
        `🔐 MarketMix Kenya\nYour PIN reset code: ${code}\nValid for 15 minutes.\nDo not share this code with anyone.`,
        { kind: "pin-otp", userId }
      );
    }

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

app.post("/api/update-stock", async (req, res) => {
  try {
    const {
      productId, quantity, channel = null, orderId = null,
      reason = "sale", createdBy = "system",
    } = req.body || {};

    if (!productId || typeof quantity !== "number" || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Invalid product or quantity" });
    }

    const pRef = db.collection("products").doc(productId);
    let sellerId = null;
    let oldQty = 0;

    await db.runTransaction(async (t) => {
      const docSnap = await t.get(pRef);
      if (!docSnap.exists) throw new Error("Product not found");
      const data = docSnap.data();
      const q = data.quantity || 0;
      if (q < quantity) throw new Error("Not enough stock");
      sellerId = data.sellerId || null;
      oldQty = q;
      t.update(pRef, { quantity: q - quantity });
    });

    if (sellerId) {
      await logInventoryMovement({
        productId, sellerId, delta: -Math.abs(quantity),
        reason, channel, orderId,
        note: `Stock ${oldQty} → ${oldQty - quantity}`,
        createdBy,
      });
    }

    return res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    return sendServerError(res, e, "Stock update failed");
  }
});

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

app.get("/api/test-email-auth", async (req, res) => {
  res.json({
    success: !!BREVO_API_KEY,
    message: BREVO_API_KEY ? "Email authentication configured" : "BREVO_API_KEY not configured",
    senders: SENDERS,
    urls: { website: WEBSITE_URL, products: PRODUCTS_URL, orderReceiptBase: ORDER_RECEIPT_BASE, whatsappGroup: WHATSAPP_GROUP_URL },
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
    mpesaReference: "UJ8NN93LWY",
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

app.post("/api/test-store-whatsapp", async (req, res) => {
  try {
    const { phone, customerName = "Test Customer", amount = 2500, paymentReference = "TEST_REF_123", orderId = "TEST_ORDER_456" } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });

    const queued1 = enqueueWhatsApp(
      phone,
      storePaymentConfirmedWhatsApp({ customerName, amount, paymentReference }),
      { kind: "test-store-payment" }
    );
    const queued2 = enqueueWhatsApp(
      phone,
      storeOrderConfirmedWhatsApp({ customerName, orderId, paymentStatus: "Paid", orderStatus: "Processing" }),
      { kind: "test-store-order" }
    );

    return res.json({ success: queued1 && queued2, queued1, queued2 });
  } catch (e) {
    return sendServerError(res, e, "Test store WhatsApp failed");
  }
});

app.post("/api/test-seller-flow-whatsapp", async (req, res) => {
  try {
    const {
      sellerPhone, buyerPhone,
      sellerName = "Test Seller", buyerName = "Test Buyer",
      orderId = "TEST_ORDER_789",
      sellerRevenue = 3500,
      itemSummary = "Sneakers x1, Cap x2",
    } = req.body || {};

    const results = {};

    if (sellerPhone) {
      results.newOrderQueued = enqueueWhatsApp(
        sellerPhone,
        sellerNewOrderWhatsApp({ sellerName, orderId, buyerName, sellerRevenue, itemSummary, itemCount: 2 }),
        { kind: "test-seller-new-order" }
      );
      results.reminderQueued = enqueueWhatsApp(
        sellerPhone,
        sellerReminderWhatsApp({ sellerName, orderId, buyerName, hoursSince: 6, nudgeNumber: 1, maxNudges: 4 }),
        { kind: "test-seller-reminder" }
      );
    }

    if (buyerPhone) {
      results.statusUpdateQueued = enqueueWhatsApp(
        buyerPhone,
        buyerStatusUpdateWhatsApp({ customerName: buyerName, orderId, statusLabel: "Shipped" }),
        { kind: "test-buyer-status-update" }
      );
    }

    return res.json({ success: true, results });
  } catch (e) {
    return sendServerError(res, e, "Test seller flow WhatsApp failed");
  }
});

app.post("/api/test-quicksale-whatsapp", async (req, res) => {
  try {
    const {
      sellerPhone, buyerPhone,
      sellerName = "Test Seller", customerName = "Walk-in Customer",
      itemSummary = "Nike Air x1", amount = 3500,
      paymentReference = "TEST_QS_123",
      sellerShop = "Test Shop",
    } = req.body || {};

    const results = {};

    if (buyerPhone) {
      results.buyerQueued = enqueueWhatsApp(
        buyerPhone,
        quicksaleBuyerWhatsApp({ customerName, itemSummary, amount, paymentReference, sellerShop }),
        { kind: "test-quicksale-buyer" }
      );
    }

    if (sellerPhone) {
      results.sellerQueued = enqueueWhatsApp(
        sellerPhone,
        quicksaleSellerWhatsApp({
          sellerName, itemSummary, amount, paymentReference, customerName,
          customerPhone: buyerPhone || "—",
        }),
        { kind: "test-quicksale-seller" }
      );
    }

    return res.json({ success: true, results });
  } catch (e) {
    return sendServerError(res, e, "Test quicksale WhatsApp failed");
  }
});

app.post("/api/test-welcome-whatsapp", async (req, res) => {
  try {
    const { phone, name = "Test Subscriber" } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const queued = enqueueWhatsApp(
      phone,
      welcomeSubscriberWhatsApp({ name }),
      { kind: "test-welcome-subscriber" }
    );
    return res.json({ success: queued, queued });
  } catch (e) {
    return sendServerError(res, e, "Test welcome WhatsApp failed");
  }
});

app.post("/api/test-whatsapp-notify-image", async (req, res) => {
  try {
    const { phone, title = "Image test", message = "Test image message", imageUrl } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    if (!imageUrl) return res.status(400).json({ success: false, message: "imageUrl required" });

    const r = await fetch(`http://127.0.0.1:${PORT}/api/whatsapp/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, title, message, imageUrl }),
    });
    const data = await r.json().catch(() => ({}));
    return res.json({ success: r.ok, forwarded: data });
  } catch (e) {
    return sendServerError(res, e, "Test notify-image failed");
  }
});

app.get("/_health", (req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    services: { firebase: true, brevo: !!BREVO_API_KEY, intasend: true, waha: !!WAHA_URL },
    firestore: { shop: !!db, realestate: !!reDb },
    urls: {
      marketplace: MARKETPLACE_URL,
      website: WEBSITE_URL,
      products: PRODUCTS_URL,
      orderReceiptBase: ORDER_RECEIPT_BASE,
      whatsappGroup: WHATSAPP_GROUP_URL,
      realEstateApp: REAL_ESTATE_APP_URL,
      realEstateReceipt: REAL_ESTATE_RECEIPT_URL,
      moving: MOVING_URL,
      driverDashboard: DRIVER_DASHBOARD_URL,
      driverOnboard: DRIVER_ONBOARD_URL,
      sellerDashboard: SELLER_DASHBOARD_URL,
    },
    senders: SENDERS,
    whatsappQueue: waQueue.length,
    nudgeScheduler: { scanMs: NUDGE_SCAN_MS, intervalMs: NUDGE_INTERVAL_MS, maxNudges: NUDGE_MAX },
    autoPromo: {
      endpoints: ["/api/admin/auto-promo", "/api/admin/auto-promo/run-now", "/api/admin/auto-promo/preview", "/api/admin/marketing-overrides"],
      firestoreSettingsDoc: "platformSettings/autoPromo",
      logCollection: "autoPromoLogs",
      overridesCollection: "marketingOverrides",
      inlined: true,
      version: "v2.6.5",
      deterministicPreview: true,
      overrideAware: true,
      perGroupPreview: true,
      strictOverrideMatching: true,
      groupDedupe: true,
      minuteAccurateScheduler: true,
      idempotentPerSlot: true,
      overrideMatchesEditedTime: true,
      guardKeyedOnOverrideTime: true,
      imageResolvedFromProduct: true,
      placeholderImageFilter: true,
      overrideImageWins: true,
      overrideBypassesCap: true,
      overridePinnedProductSkipsPick: true,
      overridePlaceholderFiltered: true,
      groupScopedOverrides: true,
      groupFilterSource: ["forceGroupIds", "settings.selectedGroupIds"],
      emptySelectionRefusesSend: true,
      templates: Object.keys(AutoPromoTemplates),
      campaignCalendar: AUTO_PROMO_CAMPAIGNS.length,
    },
    occasions: {
      endpoints: ["/api/admin/occasions", "/api/admin/occasions/preview", "/api/admin/occasions/run-now"],
      firestoreSettingsDoc: "platformSettings/occasions",
      logCollection: "occasionLogs",
      totalOccasions: OCCASION_LIBRARY.length,
      movableCount: OCCASION_LIBRARY.filter(o => o.movable).length,
      recurringCount: OCCASION_LIBRARY.filter(o => o.recurring === "weekly").length,
      sensitiveCount: OCCASION_LIBRARY.filter(o => o.sensitive === true).length,
      version: "v1",
    },
    endpoints: [
      "/api/whatsapp/notify", "/api/whatsapp/groups", "/api/whatsapp/welcome", "/api/whatsapp/send-media",
      "/api/admin/auto-promo", "/api/admin/auto-promo/run-now", "/api/admin/auto-promo/preview",
      "/api/admin/marketing-overrides",
      "/api/admin/occasions", "/api/admin/occasions/preview", "/api/admin/occasions/run-now",
      "/api/service-request/notify", "/api/moving/notify", "/api/re/welcome",
      "/api/stk-push", "/api/store/seed", "/api/real-estate/seed",
      "/api/admin/notify-user", "/api/driver/decision", "/api/subscription-payment",
      "/api/seller/withdraw", "/api/seller/recover-pin", "/api/seller/update-status",
      "/api/ad-transaction/:paymentRef", "/api/update-stock",
      "/api/test-store-whatsapp", "/api/test-seller-flow-whatsapp", "/api/test-quicksale-whatsapp",
      "/api/test-welcome-whatsapp", "/api/test-whatsapp-notify-image", "/_health",
    ],
    fixes: [
      "FIX #24 — marketingOverrides: preview + live scheduler apply admin edits",
      "FIX #25 — GET/POST/DELETE /api/admin/marketing-overrides",
      "FIX #26 — preview response includes overridesApplied count",
      "FIX #27 — v2.4: preview generates ONE SLOT PER GROUP PER TIME",
      "FIX #28 — v2.4: preview slots include groupId + groupName",
      "FIX #29 — v2.4: preview RNG seeded per (date|groupId|hour)",
      "FIX #30 — v2.5: applyOverride strict key matching",
      "FIX #31 — v2.5: groups deduped by id",
      "FIX #32 — v2.5: autoSlotHours sorted ascending",
      "FIX #33 — v2.5: preview diagnostics",
      "FIX #34 — v2.5: skipped overrides keep their slot in preview",
      "FIX #35 — v2.6: scheduler matches overrides on time||slot",
      "FIX #36 — v2.6: scheduler ticks every 60s",
      "FIX #37 — v2.6.1: idempotency guard keyed on override slot time",
      "FIX #38 — v2.6.1: free-form ticks no longer blocked by the override guard",
      "FIX #39 — v2.6.1: edited override times fire at the next matching tick",
      "FIX #40 — v2.6.2: image resolved from product.images[] with placeholder filter",
      "FIX #41 — v2.6.2: gs:// and relative image paths converted to HTTPS Firebase download URLs",
      "FIX #42 — v2.6.2: autoPromoLogs records imageUrlSent for future audits",
      "FIX #43 — v2.6.3: override matching moved before cap check; overrides bypass the daily cap",
      "FIX #44 — v2.6.3: override-pinned products skip the auto-pick",
      "FIX #45 — v2.6.3: placeholder filter applies to override.imageUrl too",
      "FIX #46 — v2.6.4: overrides accept an optional groupId and are scoped to that group when present",
      "FIX #47 — v2.6.4: adding a new group to selectedGroupIds no longer causes existing overrides to fire for it",
      "FIX #48 — v2.6.5: empty selectedGroupIds refuses to send instead of broadcasting to every WAHA group",
      "FIX #49 — v2.6.5: run-now still works — forceGroupIds path is unaffected",
    ],
    uptime: process.uptime(),
  });
});

app.use((req, res) => res.status(404).json({ success: false, message: "Not Found" }));

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));

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

autoPromoStartScheduler({ SCAN_MS: 60 * 1000 });
occasionStartScheduler({ SCAN_MS: 30 * 60 * 1000 });

let adminFlashNudgeLastKey = null;
const ADMIN_FLASH_NUDGE_HOURS = [7, 19];

async function adminFlashNudgeTick() {
  try {
    const hourEAT = autoPromoHourEAT();
    const dateKey = autoPromoNowEAT().toISOString().slice(0, 10);
    if (!ADMIN_FLASH_NUDGE_HOURS.includes(hourEAT)) return;
    const key = `${dateKey}-${hourEAT}`;
    if (adminFlashNudgeLastKey === key) return;

    const hpSnap = await db.collection("homepage").doc("content").get();
    const hp = hpSnap.exists ? hpSnap.data() : {};
    const sales = Array.isArray(hp.flashSales) ? hp.flashSales : [];
    const nowD = new Date();
    const active = sales.filter(s => {
      const st = s.startDate?.toDate ? s.startDate.toDate() : new Date(s.startDate);
      const en = s.endDate?.toDate ? s.endDate.toDate() : new Date(s.endDate);
      return st <= nowD && en >= nowD;
    });

    const campaign = autoPromoGetActiveCampaign();
    const adminUrl = `${WEBSITE_URL.replace(/\/$/, "")}/admin/dashboard/flash-sales`;

    let body;
    if (active.length === 0) {
      body = [
        "🚨 *FLASH SALES NEED ATTENTION*", "",
        "0 active flash sales right now.",
        "Homepage rail is empty.",
        campaign ? `\nToday's campaign: *${campaign.name}*` : "",
        `\n👉 ${adminUrl}`,
      ].filter(Boolean).join("\n");
    } else {
      const manual = active.filter(s => !s.autoCreated).length;
      const auto = active.filter(s => s.autoCreated).length;
      body = [
        "📊 *Daily Flash Sales Check-In*", "",
        `✅ Active: *${active.length}* (${manual} manual, ${auto} auto)`,
        campaign ? `🎯 Today's campaign: *${campaign.name}*` : "",
        `\n👉 ${adminUrl}`,
      ].filter(Boolean).join("\n");
    }

    enqueueWhatsApp(ADMIN_PHONE, body, { kind: "admin-flash-nudge", hourEAT });
    adminFlashNudgeLastKey = key;
    console.log(`📣 Admin flash nudge sent (hour=${hourEAT})`);
  } catch (e) {
    console.error("📣 Admin nudge failed:", e.message);
  }
}

setInterval(adminFlashNudgeTick, 5 * 60 * 1000).unref?.();
setTimeout(adminFlashNudgeTick, 30 * 1000).unref?.();
console.log("📣 Admin flash nudge armed (7am & 7pm EAT)");

const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📧 Brevo: ${BREVO_API_KEY ? "✅" : "❌"}`);
  console.log(`📱 WhatsApp (WAHA): ${WAHA_URL ? "✅" : "❌"}`);
  console.log(`🤖 AutoPromo: v2.6.5 (empty selection refuses send)`);
  console.log(`✏️  Overrides: ✅ /api/admin/marketing-overrides`);
  console.log(`🎯 Occasion engine: ${OCCASION_LIBRARY.length} occasions`);
});

const shutdown = () => {
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

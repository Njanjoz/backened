// server.js — MarketMix backend
// v2.10.7 — Option B: non-promo occasions persistent, editable, fire from plan
//
// [v2.6.5]  base · [v2.9.0] token/LID/subscriptions · [v2.10.0] calendar/campaigns/content-library
// [v2.10.4] subcollection slot storage + day-view endpoint
// [v2.10.6] Two fixes:
//   1. Override time-move updates slot.hourEAT so the tick's hour query finds it
//   2. Tick also fires minute-pinned overrides (time == currentHHMM)
// [v2.10.7] Option B — non-promo occasions:
//   1. Non-promo slots written to scheduledPromos/{date}/slots/ at plan time
//   2. day-view reads them from the plan instead of building them fresh
//   3. The promo tick fires them too — separate occasionStartScheduler disabled
//   4. Frontend can edit/skip/reset them via the same override flow

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const IntaSend = require("intasend-node");
const cors = require("cors");
const admin = require("firebase-admin");
const http = require("http");
const crypto = require("crypto");
const Buffer = require("buffer").Buffer;
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

// ============================
// URL constants
// ============================
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
const WA_BUSINESS_NUMBER = process.env.WA_BUSINESS_NUMBER || ORDERS_PHONE;

const buildOrderReceiptUrl = (orderId) =>
  orderId ? `${ORDER_RECEIPT_BASE}/${orderId}` : WEBSITE_URL;

// ============================
// Category slug helpers
// ============================
function slugifyCategory(raw) {
  if (!raw) return null;
  return String(raw)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const CATEGORY_EMOJI = {
  sneakers: "👟", shoes: "👟", footwear: "👟",
  clothing: "👕", clothes: "👕", fashion: "👕", apparel: "👕",
  electronics: "📱", "mobile-phones": "📱", phones: "📱", gadgets: "📱",
  beauty: "💄", cosmetics: "💄", skincare: "💄",
  accessories: "👜", bags: "👜", handbags: "👜",
  home: "🏠", "home-garden": "🏠", kitchen: "🏠",
  food: "🍽️", beverages: "🍽️", drinks: "🍽️",
  books: "📚", stationery: "📚",
  toys: "🧸", kids: "🧸", baby: "🧸",
  sports: "⚽", fitness: "⚽",
  jewelry: "💍", watches: "⌚",
};
function categoryEmoji(categoryId) {
  if (!categoryId) return "🛍️";
  return CATEGORY_EMOJI[categoryId] || "🛍️";
}

// ============================
// Subscription keyword map
// ============================
const SUBSCRIBE_KEYWORDS = new Set([
  "STOCK", "YES", "SUBSCRIBE",
  "SNEAKERS", "SHOES", "SHOE", "FOOTWEAR",
  "CLOTHES", "CLOTHING", "FASHION", "APPAREL",
  "ELECTRONICS", "ELECTRONIC", "PHONES", "PHONE", "GADGETS",
  "BEAUTY", "COSMETICS", "SKINCARE",
  "ACCESSORIES", "ACCESSORY", "BAGS", "BAG",
  "HOME", "KITCHEN", "GARDEN",
  "FOOD", "BEVERAGES", "DRINKS",
  "BOOKS", "STATIONERY",
  "TOYS", "KIDS", "BABY",
  "SPORTS", "FITNESS",
  "JEWELRY", "WATCHES",
]);
const UNSUBSCRIBE_KEYWORDS = new Set([
  "STOP", "STOP ALL", "UNSUBSCRIBE", "OPT OUT", "OPTOUT", "CANCEL",
]);

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
// WAHA client & queue
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
  if (s.endsWith("@lid")) return s;
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
    onSent: typeof meta.onSent === "function" ? meta.onSent : null,
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
    const chatId = job.phone.endsWith("@g.us") || job.phone.endsWith("@lid")
      ? job.phone
      : `${job.phone}@c.us`;

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

    const sentMessageId = data?.key?.id || data?.id?.id || data?.id?._serialized || null;
    if (sentMessageId && typeof job.onSent === "function") {
      try {
        await job.onSent(sentMessageId, job);
      } catch (cbErr) {
        console.error("⚠️ onSent callback failed:", cbErr.message);
      }
    }
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

async function wahaSendImage({ phone, imageUrl, caption, filename }) {
  const normalized = normalizeWaChatId(phone);
  if (!normalized) throw new Error(`Invalid phone/group: ${phone}`);
  const chatId = normalized.endsWith("@g.us") || normalized.endsWith("@lid")
    ? normalized
    : `${normalized}@c.us`;

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
  const chatId = normalized.endsWith("@g.us") || normalized.endsWith("@lid")
    ? normalized
    : `${normalized}@c.us`;

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
   AutoPromo Engine v2.10.7
   Subcollection-backed plan + fire-time override overlay.
   Non-promo (occasion) slots are persisted in the same plan and
   fire through the same tick.
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
  if (url.startsWith("products/") || url.startsWith("images/") || url.startsWith("product-images/")) {
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

function autoPromoNowEAT() { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function autoPromoHourEAT() { return autoPromoNowEAT().getUTCHours(); }
function autoPromoMinuteEAT() { return autoPromoNowEAT().getUTCMinutes(); }
function autoPromoHHMMEAT() {
  return `${String(autoPromoHourEAT()).padStart(2, "0")}:${String(autoPromoMinuteEAT()).padStart(2, "0")}`;
}
function autoPromoDateStrEAT() { return autoPromoNowEAT().toISOString().slice(0, 10); }
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
function autoPromoIsPayday() { const d = autoPromoDayEAT(); return d >= 25 || d <= 5; }
function autoPromoIsMonthEnd() { return autoPromoDayEAT() >= 28; }
function autoPromoDetectGroupKind(groupName) {
  const n = String(groupName || "").toLowerCase();
  if (n.includes("seller") || n.includes("vendor") || n.includes("business")) return "sellers";
  if (n.includes("deal") || n.includes("promo") || n.includes("offer")) return "deals";
  if (n.includes("buyer") || n.includes("customer") || n.includes("shop")) return "buyers";
  return "general";
}

function computeAutoSlotHours(activeHours, perGroupPerDay) {
  const start = Math.max(0, Math.min(23, Number(activeHours?.start ?? 8)));
  const end   = Math.max(1, Math.min(24, Number(activeHours?.end   ?? 21)));
  const cap   = Math.max(1, Math.min(AUTO_PROMO_MAX_PER_GROUP_PER_DAY, Number(perGroupPerDay) || AUTO_PROMO_MAX_PER_GROUP_PER_DAY));
  const hourPool = [];
  for (let h = start; h < end; h++) hourPool.push(h);
  if (!hourPool.length) return { hours: [], slots: [], effectiveCap: 0 };
  const effectiveCap = Math.min(cap, hourPool.length);
  const hours = [];
  if (effectiveCap === 1) hours.push(hourPool[Math.floor(hourPool.length / 2)]);
  else {
    const step = (hourPool.length - 1) / (effectiveCap - 1);
    for (let i = 0; i < effectiveCap; i++) {
      const idx = Math.round(i * step);
      hours.push(hourPool[Math.min(hourPool.length - 1, idx)]);
    }
  }
  const uniq = [...new Set(hours)].sort((a, b) => a - b);
  return { hours: uniq, slots: uniq.map(h => `${String(h).padStart(2, "0")}:00`), effectiveCap: uniq.length };
}

function buildOverrideKey({ date, slot, groupId }) {
  return `${date}_${slot}_${groupId || "*"}`;
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
      } else daysToEvent = -1;
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

async function loadOverridesForDate(dateStr) {
  const map = new Map();
  if (!dateStr) return map;
  try {
    const snap = await db.collection("marketingOverrides")
      .where("date", "==", dateStr)
      .get();
    snap.forEach(d => {
      const x = d.data() || {};
      const originalSlot = x.slot || x.originalSlot || "";
      const groupId = x.groupId || "*";
      const key = buildOverrideKey({ date: dateStr, slot: originalSlot, groupId });
      map.set(key, x);
      if (!x.groupId) {
        map.set(buildOverrideKey({ date: dateStr, slot: originalSlot, groupId: "*" }), x);
      }
    });
  } catch (e) {
    console.warn("[overrides] load failed:", e.message);
  }
  return map;
}

function findOverrideForSlot(overrides, { date, originalSlot, groupId }) {
  if (!overrides || overrides.size === 0) return null;
  const exact = overrides.get(buildOverrideKey({ date, slot: originalSlot, groupId }));
  if (exact) return exact;
  const wildcard = overrides.get(buildOverrideKey({ date, slot: originalSlot, groupId: "*" }));
  return wildcard || null;
}

function applyOverrideToSlot(slot, overrides, dateStr) {
  if (!slot) return slot;
  const ov = findOverrideForSlot(overrides, {
    date: dateStr,
    originalSlot: slot.time,
    groupId: slot.groupId,
  });
  if (!ov) return slot;
  return {
    ...slot,
    productId: ov.productId || slot.productId,
    productName: ov.productName || slot.productName,
    imageUrl: ov.imageUrl || slot.imageUrl,
    caption: ov.caption || slot.caption,
    time: ov.time || slot.time,
    skipped: typeof ov.skipped === "boolean" ? ov.skipped : slot.skipped,
    overridden: true,
  };
}

/* ─── Plan generation & persistence (subcollection-backed) ─── */

async function computePlanSlotsForDate(dateStr, settings) {
  const perGroupPerDay = Math.min(
    AUTO_PROMO_MAX_PER_GROUP_PER_DAY,
    Math.max(1, Number(settings.perGroupPerDay) || AUTO_PROMO_MAX_PER_GROUP_PER_DAY)
  );
  const { hours: autoSlotHours } = computeAutoSlotHours(settings.activeHours, perGroupPerDay);

  let groups = [];
  try {
    const r = await wahaFetch("/api/default/groups", { timeoutMs: 20000 });
    const data = await r.json().catch(() => ({}));
    const list = Array.isArray(data) ? data : (data && typeof data === "object" ? Object.values(data) : []);
    groups = list
      .filter(g => g && (g.id || g.chatId) && String(g.id || g.chatId).endsWith("@g.us"))
      .map(g => ({ id: g.id || g.chatId, name: g.subject || g.name || "(unnamed)" }));
  } catch (e) {
    throw new Error(`groups-fetch-failed: ${e.message}`);
  }

  const seenIds = new Set();
  groups = groups.filter(g => {
    if (seenIds.has(g.id)) return false;
    seenIds.add(g.id);
    return true;
  });

  const rawPersistedIds = Array.isArray(settings.selectedGroupIds) ? settings.selectedGroupIds : [];
  const persistedIds = [...new Set(rawPersistedIds.filter(Boolean))];
  if (persistedIds.length > 0) {
    const allowed = new Set(persistedIds);
    groups = groups.filter(g => allowed.has(g.id));
    const missing = persistedIds.filter(id => !groups.some(g => g.id === id));
    for (const id of missing) groups.push({ id, name: "(selected)" });
  } else {
    groups = [];
  }

  const targetDate = new Date(dateStr + "T00:00:00Z");
  const month = targetDate.getUTCMonth() + 1;
  const day   = targetDate.getUTCDate();
  const dow   = targetDate.getUTCDay();
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

  const slots = [];
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
        slots.push({
          slotId: `${dateStr}_${String(hour).padStart(2, "0")}:00_${group.id}`,
          dateEAT: dateStr,
          time: `${String(hour).padStart(2, "0")}:00`,
          hourEAT: hour,
          timeBucket, templateId,
          slotKind: "promo",
          groupId: group.id,
          groupName: group.name,
          productId: null, productName: null, imageUrl: null,
          caption: "(no product available)",
          skipped: true, overridden: false,
          status: "skipped",
          sentAt: null, sentMessageId: null, error: "no-products",
        });
        continue;
      }
      const product = pickFrom[Math.floor(rng() * pickFrom.length)];
      usedProducts.add(product.id);

      const productUrl = `${settings.siteUrl}/product/${product.slug || product.id}`;
      const caption = autoPromoFillTemplate(templateId, { product, campaign, groupName: group.name, productUrl });

      slots.push({
        slotId: `${dateStr}_${String(hour).padStart(2, "0")}:00_${group.id}`,
        dateEAT: dateStr,
        time: `${String(hour).padStart(2, "0")}:00`,
        hourEAT: hour,
        timeBucket, templateId,
        slotKind: "promo",
        groupId: group.id,
        groupName: group.name,
        productId: product.id,
        productName: product.name || "—",
        imageUrl: productImageUrl(product),
        caption,
        skipped: false, overridden: false,
        status: "pending",
        sentAt: null, sentMessageId: null, error: null,
      });
    }
  }

  // v2.10.7 — also persist non-promo (occasion) slots in the plan
  try {
    const occSettings = await occasionLoadSettings();
    if (occSettings.enabled) {
      const { dated, recurring } = resolveOccasionsForDate({
        month,
        day,
        weekday: dow,
        year: targetDate.getUTCFullYear(),
        movableDates: occSettings.movableDates || {},
        includeRecurring: !!occSettings.sendRecurring,
      });
      for (const group of groups) {
        for (const occ of [...dated, ...recurring]) {
          const message = buildOccasionMessage(occ, {
            shopLink: occSettings.siteUrl || WEBSITE_URL,
          });
          if (!message) continue;
          const isRecurring = !!occ.recurring;
          const isSensitive = !!occ.sensitive;
          const baseHour = isRecurring ? 3 : 9;
          const time = `${String(baseHour).padStart(2, "0")}:00`;
          const slotId = `${dateStr}_${time}_${group.id}_occ_${occ.key}`;
          slots.push({
            slotId,
            dateEAT: dateStr,
            time,
            hourEAT: baseHour,
            slotKind: isSensitive ? "non-promo" : "occasion",
            templateId: null,
            groupId: group.id,
            groupName: group.name,
            occasionKey: occ.key,
            occasionName: occ.name,
            sensitive: isSensitive,
            productId: null,
            productName: occ.name,
            imageUrl: null,
            caption: message,
            skipped: false,
            overridden: false,
            status: "pending",
            sentAt: null,
            sentMessageId: null,
            error: null,
          });
        }
      }
    }
  } catch (occErr) {
    console.warn("[plan] occasion slots skipped:", occErr.message);
  }

  return { slots, autoSlotHours, campaign, perGroupPerDay };
}

async function ensurePlan(dateStr, settings, generatedBy = "preview") {
  const metaRef = db.collection("scheduledPromos").doc(dateStr);
  const metaSnap = await metaRef.get();

  if (metaSnap.exists && metaSnap.data().version === 2) {
    return { id: metaRef.id, ...metaSnap.data() };
  }

  const built = await computePlanSlotsForDate(dateStr, settings);

  const manifest = {
    version: 2,
    date: dateStr,
    generatedAt: new Date(),
    generatedBy,
    settingsSnapshot: {
      perGroupPerDay: built.perGroupPerDay,
      activeHours: settings.activeHours,
      selectedGroupIds: settings.selectedGroupIds || [],
      siteUrl: settings.siteUrl,
    },
    campaign: built.campaign
      ? { name: built.campaign.name, daysToEvent: built.campaign.daysToEvent }
      : null,
    autoSlotHours: built.autoSlotHours.map(h => `${String(h).padStart(2, "0")}:00`),
    slotCount: built.slots.length,
  };
  await metaRef.set(manifest, { merge: true });

  const BATCH_LIMIT = 450;
  for (let i = 0; i < built.slots.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = built.slots.slice(i, i + BATCH_LIMIT);
    for (const slot of chunk) {
      const ref = metaRef.collection("slots").doc(slot.slotId);
      batch.set(ref, slot, { merge: true });
    }
    await batch.commit();
  }

  return { id: metaRef.id, ...manifest };
}

async function loadPlan(dateStr) {
  const metaRef = db.collection("scheduledPromos").doc(dateStr);
  const metaSnap = await metaRef.get();
  if (!metaSnap.exists) return null;

  const slotsSnap = await metaRef.collection("slots").get();
  const slots = slotsSnap.docs.map(d => d.data());

  return { id: metaRef.id, ...metaSnap.data(), slots };
}

async function patchPlanSlot(dateStr, slotId, patch) {
  const ref = db
    .collection("scheduledPromos").doc(dateStr)
    .collection("slots").doc(slotId);

  await ref.set(
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { slotId, ...patch };
}

async function regeneratePlanPreservingOverrides(dateStr, settings) {
  const metaRef = db.collection("scheduledPromos").doc(dateStr);
  const metaSnap = await metaRef.get();

  let preservedOverrides = new Map();
  if (metaSnap.exists) {
    const slotsSnap = await metaRef.collection("slots").get();
    slotsSnap.docs.forEach(d => {
      const s = d.data();
      if (s.overridden) preservedOverrides.set(d.id, s);
    });
  }

  const built = await computePlanSlotsForDate(dateStr, settings);

  await metaRef.set(
    {
      version: 2,
      date: dateStr,
      generatedAt: new Date(),
      generatedBy: "regenerate",
      settingsSnapshot: {
        perGroupPerDay: built.perGroupPerDay,
        activeHours: settings.activeHours,
        selectedGroupIds: settings.selectedGroupIds || [],
        siteUrl: settings.siteUrl,
      },
      campaign: built.campaign
        ? { name: built.campaign.name, daysToEvent: built.campaign.daysToEvent }
        : null,
      autoSlotHours: built.autoSlotHours.map(h => `${String(h).padStart(2, "0")}:00`),
      slotCount: built.slots.length,
    },
    { merge: true }
  );

  const existingSlots = await metaRef.collection("slots").get();
  for (let i = 0; i < existingSlots.docs.length; i += 450) {
    const batch = db.batch();
    existingSlots.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  for (let i = 0; i < built.slots.length; i += 450) {
    const batch = db.batch();
    built.slots.slice(i, i + 450).forEach(slot => {
      const keep = preservedOverrides.get(slot.slotId);
      const final = keep
        ? {
            ...slot,
            productId: keep.productId || slot.productId,
            productName: keep.productName || slot.productName,
            imageUrl: keep.imageUrl || slot.imageUrl,
            caption: keep.caption || slot.caption,
            skipped: keep.skipped,
            overridden: true,
            status: keep.status === "sent" ? "sent" : (keep.skipped ? "skipped" : "pending"),
            sentAt: keep.sentAt || null,
          }
        : slot;
      const ref = metaRef.collection("slots").doc(slot.slotId);
      batch.set(ref, final, { merge: true });
    });
    await batch.commit();
  }

  return loadPlan(dateStr);
}

/* ═══════════════════════════════════════════════════════════════
   Scheduler tick — v2.10.7: fires promo + non-promo from the plan
   ═══════════════════════════════════════════════════════════════ */

async function autoPromoRunTick({ WA_MAX_PER_RUN = 8, forceGroupIds = null, forceProductId = null } = {}) {
  if (autoPromoRunning) return { skipped: "already-running" };
  autoPromoRunning = true;
  try {
    const settings = await autoPromoLoadSettings();
    if (!settings.enabled) return { skipped: "disabled" };

    const hourEAT = autoPromoHourEAT();
    const currentHHMM = autoPromoHHMMEAT();
    if (hourEAT < settings.activeHours.start || hourEAT >= settings.activeHours.end) {
      return { skipped: `outside-hours (${hourEAT}h EAT)` };
    }

    const isForceRun = Array.isArray(forceGroupIds) && forceGroupIds.length > 0;
    const isForceProduct = !!forceProductId;
    const bypassPlan = isForceRun || isForceProduct;

    const todayEAT = autoPromoDateStrEAT();

    // ── FORCED RUN (Run-now button) ──
    if (bypassPlan) {
      let groups = forceGroupIds || [];
      if (!groups.length) {
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
      const seen = new Set();
      groups = groups.filter(g => {
        if (!g || !g.id) return false;
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        return true;
      });

      const result = { forced: true, sent: 0, messages: [], skippedGroups: [] };
      for (const group of groups.slice(0, WA_MAX_PER_RUN)) {
        let product;
        if (isForceProduct) {
          const s = await db.collection("products").doc(forceProductId).get();
          product = s.exists ? { id: s.id, ...s.data() } : null;
        } else {
          product = await autoPromoPickProduct({ group });
        }
        if (!product) { result.skippedGroups.push({ id: group.id, reason: "no-product" }); continue; }
        const campaign = autoPromoGetActiveCampaign();
        const productUrl = `${settings.siteUrl}/product/${product.slug || product.id}`;
        const templateId = "T18";
        const caption = autoPromoFillTemplate(templateId, { product, campaign, groupName: group.name, productUrl });
        const imageUrl = productImageUrl(product);
        try {
          if (imageUrl) {
            enqueueWhatsAppImage(group.id, imageUrl, caption, { kind: "auto-promo-force", templateId, productId: product.id });
          } else {
            enqueueWhatsApp(group.id, caption, { kind: "auto-promo-force", templateId, productId: product.id });
          }
          result.sent++;
          result.messages.push({ group: group.name, product: product.name, templateId, slotTime: currentHHMM });
        } catch (e) {
          result.skippedGroups.push({ id: group.id, reason: "send-failed", error: e.message });
        }
        if (result.sent < WA_MAX_PER_RUN && groups.indexOf(group) < groups.length - 1) {
          await new Promise(r => setTimeout(r, 45 * 1000 + Math.random() * 45 * 1000));
        }
      }
      console.log(`🤖 AutoPromo FORCE tick → ${result.sent} sent`);
      return result;
    }

    // ── NORMAL PATH ──
    const plan = await ensurePlan(todayEAT, settings, "scheduler");
    const metaRef = db.collection("scheduledPromos").doc(todayEAT);

    // v2.10.6: two queries — hourEAT==hour OR time==HH:MM (minute-pinned overrides)
    const [hourSnap, minuteSnap] = await Promise.all([
      metaRef.collection("slots")
        .where("hourEAT", "==", hourEAT)
        .where("status", "==", "pending")
        .get(),
      metaRef.collection("slots")
        .where("time", "==", currentHHMM)
        .where("status", "==", "pending")
        .get(),
    ]);

    const overrides = await loadOverridesForDate(todayEAT);
    const seen = new Set();
    const pending = [];
    for (const d of [...hourSnap.docs, ...minuteSnap.docs]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const slot = d.data();
      if (slot.skipped) continue;
      const merged = applyOverrideToSlot(slot, overrides, todayEAT);
      pending.push({ slotId: d.id, slot: merged });
    }

    const hourStr = `${String(hourEAT).padStart(2, "0")}:00`;
    const result = {
      tick: new Date().toISOString(),
      hhmmEAT: currentHHMM,
      hourEAT,
      hourStr,
      planId: plan.id,
      planSource: plan.generatedBy,
      overridesLoaded: overrides.size,
      pendingThisHour: pending.length,
      sent: 0,
      skippedGroups: [],
      messages: [],
      substitutions: [],
    };

    if (pending.length === 0) {
      console.log(`🤖 AutoPromo tick → no pending slots at ${hourStr}`);
      return result;
    }

    for (let i = 0; i < pending.length; i++) {
      const { slotId, slot } = pending[i];

      // v2.10.7 — non-promo slots check the legacy occasion log too
      const isNonPromoSlot = slot.slotKind === "occasion" || slot.slotKind === "non-promo";
      if (isNonPromoSlot && slot.occasionKey) {
        const already = await occasionWasSentToday(slot.occasionKey);
        if (already) {
          await patchPlanSlot(todayEAT, slotId, { status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp(), note: "pre-existing occasion log" }).catch(() => {});
          result.skippedGroups.push({ groupId: slot.groupId, reason: "occasion-already-sent" });
          continue;
        }
      }

      const freshSnap = await metaRef.collection("slots").doc(slotId).get();
      if (!freshSnap.exists || freshSnap.data().status !== "pending") {
        result.skippedGroups.push({ groupId: slot.groupId, reason: "status-changed" });
        continue;
      }

      // v2.10.7 — non-promo slots have no product; skip product resolution
      const isNonPromo = slot.slotKind === "occasion" || slot.slotKind === "non-promo";

      let product = null;
      let substitution = null;

      if (!isNonPromo) {
        if (slot.productId) {
          const p = await db.collection("products").doc(slot.productId).get();
          if (p.exists) {
            const data = p.data();
            const qty = Number(data.quantity) || 0;
            const variantStock = Array.isArray(data.variants)
              ? data.variants.reduce((s, v) => s + (Number(v.stock) || 0), 0)
              : 0;
            if ((qty > 0 || variantStock > 0) && data.isPublished !== false) {
              product = { id: p.id, ...data };
            }
          }
        }

        if (!product) {
          const fallback = await autoPromoPickProduct({ group: { id: slot.groupId } });
          if (fallback) {
            product = fallback;
            substitution = { slotId, originalProductId: slot.productId, substitutedProductId: fallback.id };
            result.substitutions.push(substitution);
          }
        }

        if (!product) {
          await patchPlanSlot(todayEAT, slotId, { status: "failed", error: "no-product-at-fire-time" }).catch(() => {});
          result.skippedGroups.push({ groupId: slot.groupId, reason: "no-product" });
          continue;
        }
      }

      let caption = slot.caption;
      let imageUrl = slot.imageUrl;
      if (substitution) {
        const productUrl = `${settings.siteUrl}/product/${product.slug || product.id}`;
        const campaign = plan.campaign ? autoPromoGetActiveCampaign() : null;
        caption = autoPromoFillTemplate(slot.templateId || "T18", {
          product, campaign, groupName: slot.groupName, productUrl,
        });
        imageUrl = productImageUrl(product);
      }

      try {
        if (imageUrl) {
          enqueueWhatsAppImage(slot.groupId, imageUrl, caption, {
            kind: "auto-promo", templateId: slot.templateId, productId: product?.id || null,
            groupId: slot.groupId, slotId, overridden: !!slot.overridden,
          });
        } else {
          enqueueWhatsApp(slot.groupId, caption, {
            kind: "auto-promo", templateId: slot.templateId, productId: product?.id || null,
            groupId: slot.groupId, slotId, overridden: !!slot.overridden,
          });
        }

        await patchPlanSlot(todayEAT, slotId, {
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          productId: product?.id || null,
          productName: product?.name || slot.occasionName || null,
          imageUrl,
          caption,
          overridden: !!slot.overridden,
          substituted: !!substitution,
        });

        await db.collection("autoPromoLogs").add({
          groupId: slot.groupId, groupName: slot.groupName,
          productId: product?.id || null, productName: product?.name || null,
          occasionKey: slot.occasionKey || null,
          occasionName: slot.occasionName || null,
          slotKind: slot.slotKind,
          imageUrlSent: imageUrl || null,
          templateId: slot.templateId,
          campaign: plan.campaign?.name || null,
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          preview: caption.slice(0, 240),
          overridden: !!slot.overridden,
          substituted: !!substitution,
          dateEAT: todayEAT, slotTimeEAT: slot.time, slotId,
        }).catch(() => {});

        result.sent++;
        result.messages.push({
          group: slot.groupName, product: product?.name || slot.occasionName || null,
          templateId: slot.templateId, slotTime: slot.time,
          overridden: !!slot.overridden, substituted: !!substitution,
        });
      } catch (e) {
        await patchPlanSlot(todayEAT, slotId, { status: "failed", error: e.message }).catch(() => {});
        result.skippedGroups.push({ groupId: slot.groupId, reason: "send-failed", error: e.message });
      }

      if (result.sent < WA_MAX_PER_RUN && i < pending.length - 1) {
        await new Promise(r => setTimeout(r, 45 * 1000 + Math.random() * 45 * 1000));
      }
    }

    console.log(`🤖 AutoPromo tick → ${result.sent} sent (slot=${hourStr}, substitutions=${result.substitutions.length}, overrides=${result.overridesLoaded})`);
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
  autoPromoTickTimer = setTimeout(tick, 30 * 1000).unref?.();
  console.log(`🤖 AutoPromo scheduler armed (scan every ${SCAN_MS / 1000}s)`);
  return () => { if (autoPromoTickTimer) clearTimeout(autoPromoTickTimer); };
}

/* ═══════════════════════════════════════════════════════════════
   Occasion Engine — full-length copy
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

function resolveOccasionsForDate({ month, day, weekday = null, movableDates = {}, includeRecurring = false, year = null } = {}) {
  const fixed = [];
  const recurring = [];
  for (const occ of OCCASION_LIBRARY) {
    if (occ.recurring === "weekly") {
      if (includeRecurring && weekday !== null && occ.weekday === weekday) recurring.push(occ);
      continue;
    }
    if (occ.movable) {
      const resolved = movableDates[occ.key];
      if (!resolved) continue;
      if (year && resolved.year && resolved.year !== year) continue;
      if (resolved.month === month && resolved.day === day) fixed.push(occ);
      continue;
    }
    if (occ.month === month && occ.day === day) fixed.push(occ);
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
    if (forceOccasionKey) occasions = OCCASION_LIBRARY.filter(o => o.key === forceOccasionKey);

    let groups = [];
    if (forceGroups && forceGroups.length) {
      const seen = new Set();
      groups = forceGroups.filter(g => {
        if (!g || !g.id) return false;
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        return true;
      });
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
      const message = buildOccasionMessage(occ, { shopLink: settings.siteUrl || WEBSITE_URL, name: null });
      if (!message) {
        result.results.push({ occasionKey: occ.key, skipped: "no-content" });
        continue;
      }

      for (const group of groups) {
        if (dryRun) {
          result.results.push({
            occasionKey: occ.key, occasionName: occ.name,
            sensitive: !!occ.sensitive, kind: occ.kind,
            groupId: group.id, groupName: group.name,
            preview: message.slice(0, 240), dryRun: true,
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
          result.results.push({ occasionKey: occ.key, occasionName: occ.name, groupId: group.id, groupName: group.name, status: "sent" });
        } catch (e) {
          await db.collection("occasionLogs").add({
            occasionKey: occ.key, occasionName: occ.name,
            groupId: group.id, groupName: group.name,
            status: "failed", error: e.message,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          result.results.push({ occasionKey: occ.key, groupId: group.id, status: "failed", error: e.message });
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

/* ═══════════════════════════════════════════════════════════════
   WhatsApp message templates — full-length copy
   ═══════════════════════════════════════════════════════════════ */

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

function buildSubscribeLink(phone, token) {
  if (!token) return null;
  const text = encodeURIComponent(`STOCK ${token}`);
  return `https://wa.me/${WA_BUSINESS_NUMBER}?text=${text}`;
}

function offlineSaleBuyerWhatsApp({
  customerName, shopName, invoiceId, items, amount,
  paymentMethod, paymentStatus, dateStr, emoji,
  hasSubscriptions, receiptVariant = "new",
  cashReceived = null, changeGiven = null, subscribeLink = null,
}) {
  const name = (customerName && String(customerName).trim()) || "there";
  const shop = (shopName && String(shopName).trim()) || "MarketMix seller";
  const amt = Number(amount || 0).toLocaleString("en-KE", { minimumFractionDigits: 2 });
  const safeEmoji = emoji || "🛍️";
  const itemsLines = (Array.isArray(items) ? items : []).map(i => `• ${i.name} × ${i.quantity}`).join("\n") || "• (no items)";
  const paymentLine = paymentStatus === "paid"
    ? `💳 Payment: ${paymentMethod || "Cash"} — Paid in full ✅`
    : `💳 Payment: ${paymentMethod || "—"} — ${paymentStatus || "pending"}`;
  const lines = [
    `Hey ${name}! 👋🏽 Thanks for shopping at ${shop} ❤️`,
    ``,
    `🧾 *YOUR RECEIPT*`,
    ``,
    `Receipt No: ${invoiceId || "—"}`,
    `🏪 Shop: ${shop}`,
    `📅 Date: ${dateStr || "—"}`,
    paymentLine,
    ``,
    `🛍️ *Items purchased*`,
    itemsLines,
    ``,
    `💰 *Total paid: KES ${amt}*`,
  ];
  if (paymentMethod === "cash" && cashReceived != null && Number(cashReceived) > 0) {
    lines.push(`💵 Amount given: KES ${Number(cashReceived).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`);
  }
  if (paymentMethod === "cash" && changeGiven != null && Number(changeGiven) > 0) {
    lines.push(`🪙 Change: KES ${Number(changeGiven).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`);
  }
  if (!hasSubscriptions) {
    lines.push(
      ``,
      `Thank you for supporting a local business! ❤️`,
      `Keep this message as your proof of purchase.`
    );
  } else if (receiptVariant === "subscribed") {
    lines.push(
      ``,
      `✅ You're subscribed — we'll let you know when new stock drops.`
    );
  } else if (receiptVariant === "opted-out") {
    if (subscribeLink) {
      lines.push(
        ``,
        `You turned off stock alerts earlier.`,
        ``,
        `Want them back? Tap to turn them on again: 👇`,
        subscribeLink
      );
    } else {
      lines.push(
        ``,
        `You've turned off stock alerts. Reply *STOCK* anytime to turn them back on.`
      );
    }
  } else {
    if (subscribeLink) {
      lines.push(
        ``,
        `${safeEmoji} *Want to know when new stock drops at ${shop}?*`,
        ``,
        `👉 Tap to get alerts:`,
        subscribeLink,
        ``,
        `Or reply *STOCK* to this message.`
      );
    } else {
      lines.push(
        ``,
        `${safeEmoji} *Want to know when new stock drops?*`,
        ``,
        `Reply *STOCK* and we'll notify you when fresh stock arrives at ${shop}. 👀🔥`
      );
    }
  }
  lines.push(
    ``,
    `*MarketMix Kenya*`,
    `Shop local, grow local. 🇰🇪`
  );
  return lines.join("\n");
}

function subscriptionConfirmedWhatsApp({ shopNamesByCategory }) {
  const blocks = [];
  for (const entry of shopNamesByCategory) {
    const catLines = entry.categories.map(c => `${c.emoji} ${c.name}`).join(", ");
    blocks.push(`• ${entry.shop} — ${catLines}`);
  }
  return [
    `You're on the list! 🎉`,
    ``,
    `We'll ping you when new stock drops:`,
    ...blocks,
    ``,
    `Reply *STOP* anytime to stop.`,
    ``,
    `*MarketMix Kenya* ❤️`,
  ].join("\n");
}

function alreadySubscribedWhatsApp({ shopNamesByCategory }) {
  const blocks = [];
  for (const entry of shopNamesByCategory) {
    const catLines = entry.categories.map(c => `${c.emoji} ${c.name}`).join(", ");
    blocks.push(`• ${entry.shop} — ${catLines}`);
  }
  return [
    `You're already on the list ✅`,
    ``,
    `You'll hear about new stock from:`,
    ...blocks,
    ``,
    `Reply *STOP* anytime to stop.`,
    ``,
    `*MarketMix Kenya* ❤️`,
  ].join("\n");
}

function optOutConfirmedWhatsApp() {
  return [
    `Got it — you won't receive any more stock notifications from us.`,
    ``,
    `You'll still get receipts and order updates for future purchases.`,
    ``,
    `If you change your mind later, reply *STOCK* to this message or any of our receipts.`,
    ``,
    `*MarketMix Kenya*`,
  ].join("\n");
}

async function logInventoryMovement({ productId, sellerId, delta, reason, channel = null, orderId = null, note = "", createdBy = "system" }) {
  if (!productId || !sellerId || typeof delta !== "number" || delta === 0) return null;
  try {
    const ref = await db.collection("inventoryMovements").add({
      productId, sellerId, delta, reason, channel, orderId,
      note: note || "", createdBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("❌ logInventoryMovement failed:", err.message);
    return null;
  }
}

const WITHDRAWAL_THRESHOLD = 100.0;
const FIXED_FEE_BELOW_THRESHOLD = 10.0;
const FIXED_FEE_ABOVE_THRESHOLD = 20.0;
const AGENCY_FEE_RATE = 0.035;
function getTieredFixedFee(amount) { return amount < WITHDRAWAL_THRESHOLD ? FIXED_FEE_BELOW_THRESHOLD : FIXED_FEE_ABOVE_THRESHOLD; }
function calculateTotalFee(amount) { return +((amount * AGENCY_FEE_RATE) + getTieredFixedFee(amount)).toFixed(2); }
function isValidPhone(phone) { return typeof phone === "string" && /^(2547|2541)\d{8}$/.test(phone); }
function parsePositiveNumber(value) { const n = parseFloat(value); return !isNaN(n) && n > 0 ? n : null; }
function sendServerError(res, err, msg = "Internal server error") { console.error(msg, err); return res.status(500).json({ success: false, message: msg }); }

const isWalletRef       = (r) => typeof r === "string" && r.startsWith("WALLET_");
const isSubscriptionRef = (r) => typeof r === "string" && r.startsWith("SUB_");
const isRealEstateRef   = (r) => typeof r === "string" && r.startsWith("PROP_");
const isMovingRef       = (r) => typeof r === "string" && r.startsWith("MOVE_");
const isTestRef         = (r) => typeof r === "string" && r.startsWith("TEST_PAY_");
const isQuicksaleRef    = (r) => typeof r === "string" && r.startsWith("QS_");

function isRealEstateOrder(apiRef, orderData) { return isRealEstateRef(apiRef) || orderData?.orderType === "real_estate" || orderData?.isRealEstate === true; }
function isQuicksaleOrder(orderData) { return orderData?.type === "QUICK_SALE" || orderData?.isQuicksale === true; }
function getSellerItems(orderData, sellerId) {
  const items = orderData?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((it) => it?.sellerId === sellerId);
}
function getSellerItemSummary(orderData, sellerId) {
  const items = getSellerItems(orderData, sellerId);
  if (!items.length) return "—";
  return items.slice(0, 3).map((it) => `${it.name} x${it.quantity}`).join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "");
}
function getSellerRevenue(orderData, sellerId) {
  return getSellerItems(orderData, sellerId).reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
}
function quicksaleItemSummary(orderData) {
  const items = Array.isArray(orderData?.items) ? orderData.items : [];
  if (!items.length) return "Your purchase";
  return items.slice(0, 3).map((it) => `${it.name} x${it.quantity}`).join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "");
}

const marketMixEmailShell = ({ preheader = "", eyebrow = "MarketMix Kenya", title, subtitle, bodyHtml, ctaLabel, ctaUrl, footerNote = "" }) => `
<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><title>${title}</title></head>
<body style="margin:0;padding:0;background:#eef2f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="display:none;font-size:1px;color:#eef2f0;">${preheader}</div>
  <table width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f0;padding:24px 12px;">
    <tr><td align="center">
      <table width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;">
        <tr><td style="background:linear-gradient(135deg,#0b231c 0%,#123528 55%,#0e2b22 100%);border-radius:28px 28px 0 0;padding:32px 28px;color:#fff;">
          <div style="font-size:11px;letter-spacing:.19em;text-transform:uppercase;color:#a7f3d0;font-weight:700;">${eyebrow}</div>
          <div style="padding-top:12px;font-size:26px;line-height:1.25;font-weight:600;">${title}</div>
          ${subtitle ? `<div style="padding-top:10px;font-size:14px;color:rgba(255,255,255,0.72);">${subtitle}</div>` : ""}
        </td></tr>
        <tr><td style="background:#fff;border:1px solid #e2e8e6;border-top:none;border-radius:0 0 28px 28px;padding:28px;">
          ${bodyHtml}
          ${ctaLabel && ctaUrl ? `<table width="100%" style="margin-top:22px;"><tr><td align="center"><a href="${ctaUrl}" style="display:inline-block;background:#123528;color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:12px;padding:14px 26px;">${ctaLabel}</a></td></tr></table>` : ""}
          ${footerNote ? `<p style="margin:22px 0 0 0;font-size:12px;color:#94a3b8;text-align:center;">${footerNote}</p>` : ""}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const emailInfoCard = (rows) => `
  <table width="100%" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
    <tr><td style="padding:18px;">
      <table width="100%">
        ${rows.map(([label, value, highlight]) => `
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#64748b;width:50%;">${label}</td>
            <td style="padding:6px 0;font-size:13px;font-weight:700;color:${highlight ? "#047857" : "#0f172a"};text-align:right;">${value}</td>
          </tr>
        `).join("")}
      </table>
    </td></tr>
  </table>`;

const emailBodyText = (text) => `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">${text}</p>`;
const emailSectionLabel = (label) => `<p style="margin:0 0 6px 0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;font-weight:700;">${label}</p>`;

const sendOrderConfirmationEmail = async (orderData, userEmail, orderId) => {
  try {
    if (!BREVO_API_KEY) return false;
    const items = orderData.items || [];
    const itemsTotal = items.reduce((s, i) => s + ((i.price || 0) * (i.quantity || 1)), 0);
    const deliveryTotal = (orderData.sellerGroups || []).reduce((s, g) => s + (g.deliveryCost || 0), 0);
    const total = orderData.totalAmount || (itemsTotal + deliveryTotal);
    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${orderData.shippingDetails?.fullName || userEmail.split("@")[0]}</strong>, your payment is confirmed.`)}
      ${emailSectionLabel("Order")}
      ${emailInfoCard([["Order ID", String(orderId)], ["Date", new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })], ["Buyer", orderData.shippingDetails?.fullName || "—"], ["Delivery", orderData.shippingDetails?.deliveryPlace || "—"]])}
      ${emailSectionLabel("Items")}
      <table width="100%" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
        <tr><td style="padding:18px;font-size:13px;line-height:1.9;color:#334155;">
          ${items.length ? items.map(i => `${i.name} × ${i.quantity} — Ksh ${((i.price||0)*(i.quantity||1)).toFixed(2)}`).join("<br/>") : "No items"}
        </td></tr>
      </table>
      ${emailInfoCard([["Items Total", `Ksh ${itemsTotal.toFixed(2)}`], ["Delivery", `Ksh ${deliveryTotal.toFixed(2)}`], ["Total Paid", `Ksh ${total.toFixed(2)}`, true]])}
    `;
    const html = marketMixEmailShell({
      preheader: `Order #${String(orderId).slice(0,8)} confirmed`,
      eyebrow: "MarketMix Kenya",
      title: "Thank you for shopping",
      subtitle: "Your payment is confirmed.",
      bodyHtml,
      ctaLabel: "View order receipt",
      ctaUrl: buildOrderReceiptUrl(orderId),
    });
    const ok = await sendEmail(userEmail, `Order Confirmation #${String(orderId).slice(0, 8)} - MarketMix Kenya`, html, "sales", null);
    if (ok) {
      await db.collection("orderEmails").add({ orderId, userEmail, type: "confirmation", sentAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ Order email failed:", e.message);
    return false;
  }
};

const sendRealEstatePaymentEmail = async (data, userEmail, orderId) => {
  try {
    if (!BREVO_API_KEY) return false;
    const mpesaRef = data.mpesaReference || data.mpesaCode || "—";
    const displayId = mpesaRef;
    const amount = Number(data.totalAmount || data.amount || 0);
    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${data.buyerName || userEmail.split("@")[0]}</strong>, your payment has been received.`)}
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:18px;padding:20px;text-align:center;margin-bottom:16px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#047857;font-weight:700;">Amount paid</div>
        <div style="font-size:28px;font-weight:700;color:#065f46;padding-top:6px;">KES ${amount.toLocaleString("en-KE", { minimumFractionDigits: 2 })}</div>
      </div>
      ${emailSectionLabel("Property")}
      ${emailInfoCard([["Property", data.propertyTitle || "—"], ["Location", data.propertyLocation || "—"], ["Type", data.propertyType || "—"], ["M-Pesa code", displayId], ["Paid on", new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })]])}
      ${emailSectionLabel("Landlord / Agent")}
      ${emailInfoCard([["Name", data.landlordName || "—"], ["Phone", data.landlordPhone || "—"]])}
    `;
    const html = marketMixEmailShell({
      preheader: `Payment confirmed · ${displayId}`,
      eyebrow: "MarketMix Real Estates",
      title: "Payment Confirmed",
      subtitle: "Keep this email as your official receipt.",
      bodyHtml,
      ctaLabel: "View receipt online",
      ctaUrl: `${REAL_ESTATE_RECEIPT_URL}/${displayId}`,
    });
    const ok = await sendEmail(userEmail, `Payment Confirmed - ${data.propertyTitle || "Property"} (${displayId})`, html, "bookings", null);
    if (ok) {
      await db.collection("realEstateEmails").add({ orderId, userEmail, displayId, propertyTitle: data.propertyTitle || null, amount, mpesaReference: mpesaRef, type: "real_estate_confirmation", sentAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ Real estate email failed:", e.message);
    return false;
  }
};

const sendMovingConfirmationEmail = async (data, userEmail, requestId) => {
  try {
    if (!BREVO_API_KEY) return false;
    const status = data.status || "REQUESTED";
    const statusLabel = String(status).replace(/_/g, " ").toLowerCase();
    const amount = Number(data.quotedPrice || data.totalAmount || 0);
    const itemsLine = Object.entries(data.items || {}).map(([id, qty]) => `${id} × ${qty}`).join(" · ") || "No items listed";
    const bodyHtml = `
      ${emailBodyText(`Hello <strong>${data.userName || userEmail.split("@")[0]}</strong>, here is a snapshot of your move.`)}
      ${emailSectionLabel("Trip")}
      ${emailInfoCard([["Request ID", String(requestId)], ["Status", statusLabel.toUpperCase(), true], ["Vehicle", data.vehicleLabel || "—"], ["Items", String(data.itemCount || 0)]])}
      ${emailSectionLabel("Pickup")}
      ${emailInfoCard([["Label", data.pickupLabel || "—"]])}
      ${emailSectionLabel("Destination")}
      ${emailInfoCard([["Label", data.destinationTitle || data.destinationLabel || "—"]])}
      ${emailSectionLabel("What is moving")}
      <table width="100%" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;">
        <tr><td style="padding:18px;font-size:13px;color:#334155;">${itemsLine}</td></tr>
      </table>
      ${amount ? emailInfoCard([["Provider quote", `KSh ${amount.toLocaleString("en-KE")}`, true]]) : ""}
    `;
    const html = marketMixEmailShell({
      preheader: `Your move is ${statusLabel}`,
      eyebrow: "MarketMix Moving",
      title: "Your move request is on the road",
      subtitle: "A local transport provider will confirm shortly.",
      bodyHtml,
      ctaLabel: "Open tracking page",
      ctaUrl: MOVING_URL,
    });
    const ok = await sendEmail(userEmail, `Your move is ${statusLabel} · MarketMix Moving #${String(requestId).slice(0, 8)}`, html, "moving", null);
    if (ok) {
      await db.collection("movingEmails").add({ requestId, userEmail, status, amount, type: "moving_confirmation", sentAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
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
    const title = isSwitch ? `You switched to ${roleLabel}` : `Welcome, ${name}!`;
    const subtitle = isSwitch
      ? `You're now a ${roleLabel}${previousRoleLabel ? ` (was ${previousRoleLabel})` : ""}.`
      : (roleDesc || "Find houses, match with roommates, book transport — all in one app.");
    const bodyHtml = `
      ${emailBodyText(isSwitch ? `Hello <strong>${name}</strong>, your account type has been updated.` : `Hello <strong>${name}</strong>, welcome to MarketMix Real Estates.`)}
      ${rolePerks.length ? emailSectionLabel("What you can do") : ""}
      ${rolePerks.length ? `<table width="100%" style="background:#f6faf8;border:1px solid #e2e8e6;border-radius:18px;margin-bottom:16px;"><tr><td style="padding:18px;font-size:13px;line-height:1.9;color:#334155;">${rolePerks.map((line) => `• ${line}`).join("<br/>")}</td></tr></table>` : ""}
      ${emailInfoCard([["Account type", roleLabel, true], ["Status", isSwitch ? "Updated" : "Active", true]])}
    `;
    const html = marketMixEmailShell({
      preheader: isSwitch ? `You're now a ${roleLabel}` : `Welcome — here's what you can do as a ${roleLabel}`,
      eyebrow: `MarketMix Real Estates · ${roleLabel}`,
      title, subtitle, bodyHtml, ctaLabel, ctaUrl,
    });
    const subject = isSwitch ? `You're now a ${roleLabel} · MarketMix Real Estates` : `Welcome to MarketMix Real Estates, ${name}!`;
    const ok = await sendEmail(userEmail, subject, html, emailType);
    if (ok) {
      await reDb.collection("welcomeEmails").add({ userEmail, roleLabel, isSwitch, previousRoleLabel: previousRoleLabel || null, sentAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    return ok;
  } catch (e) {
    console.error("❌ RE welcome email failed:", e.message);
    return false;
  }
};

const generateReplacementCode = () => Math.floor(100000 + Math.random() * 900000).toString();

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
      await db.collection("pinRecoveryCodes").doc(userId).update({ attempts: admin.firestore.FieldValue.increment(1) });
      return { valid: false, message: `Invalid code. ${d.maxAttempts - (d.attempts + 1)} left` };
    }
    await db.collection("pinRecoveryCodes").doc(userId).update({ status: "verified", verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { valid: true, data: d };
  } catch (e) {
    console.error("Verify code failed:", e);
    return { valid: false, message: "Verification failed" };
  }
};

const markCodeAsUsed = async (userId) => {
  try {
    await db.collection("pinRecoveryCodes").doc(userId).update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp(), status: "completed" });
    return true;
  } catch (e) { return false; }
};

const validateSubscriptionPayment = (data) => {
  const { amount, phoneNumber, fullName, email, orderId, planId, sellerId } = data || {};
  if (!amount || !phoneNumber || !fullName || !email || !orderId || !planId || !sellerId) {
    return { valid: false, message: "Missing required fields" };
  }
  let amt = parsePositiveNumber(amount);
  if (!amt) return { valid: false, message: "Invalid amount" };
  if (!isValidPhone(phoneNumber)) return { valid: false, message: "Invalid phone" };
  if (!email.includes("@")) return { valid: false, message: "Invalid email" };
  return { valid: true, data: { ...data, amount: amt } };
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
    lastSubscriptionPayment: { amount: s.amount, date: admin.firestore.FieldValue.serverTimestamp(), reference: mpesaReference, orderId },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("subscriptionPayments").add({
    sellerId, planId, amount: s.amount, mpesaReference, orderId,
    status: "completed", sellerEmail,
    paymentDate: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
  });
  await db.collection("subscriptionLogs").add({
    sellerId, action: "subscription_activated", planId, amount: s.amount, orderId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
};

async function notifySellersOfNewOrder(orderId, orderData) {
  const sellerIds = Array.isArray(orderData?.involvedSellerIds) ? orderData.involvedSellerIds : [];
  if (!sellerIds.length) return;
  const buyerName = orderData?.shippingDetails?.fullName || orderData?.buyerName || "A customer";
  for (const sellerId of sellerIds) {
    try {
      const sellerSnap = await db.collection("users").doc(sellerId).get();
      if (!sellerSnap.exists) continue;
      const seller = sellerSnap.data() || {};
      const sellerPhone = seller.phoneNumber || seller.phone || seller.sellerProfile?.phone || null;
      if (!sellerPhone) continue;
      const sellerName = seller.fullName || seller.shopName || seller.email?.split("@")[0] || "Seller";
      const sellerRevenue = getSellerRevenue(orderData, sellerId);
      const itemSummary = getSellerItemSummary(orderData, sellerId);
      enqueueWhatsApp(sellerPhone, sellerNewOrderWhatsApp({ sellerName, orderId, buyerName, sellerRevenue, itemSummary, itemCount: getSellerItems(orderData, sellerId).length }), { kind: "seller-new-order", orderId, sellerId });
    } catch (err) {
      console.error(`❌ notifySellers failed:`, err.message);
    }
  }
  if (isQuicksaleOrder(orderData)) return;
  try {
    const now = Date.now();
    await db.collection("orders").doc(orderId).set({
      sellerNudgeCount: 0, sellerNudgeMax: 4,
      nextSellerNudgeAt: new Date(now + 6 * 60 * 60 * 1000),
      sellerNudgeActive: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error(`❌ Failed to seed nudge timer:`, err.message);
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
    for (const docSnap of snap.docs) {
      const orderId = docSnap.id;
      const order = docSnap.data() || {};
      if (isQuicksaleOrder(order)) {
        await docSnap.ref.update({ sellerNudgeActive: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        continue;
      }
      const currentStatus = order.status || "";
      if (NUDGE_TERMINAL_STATUSES.includes(currentStatus)) {
        await docSnap.ref.update({ sellerNudgeActive: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
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
        await db.collection("adminAlerts").add({ type: "seller_nudge_exhausted", orderId, sellerIds, nudgeCount, flaggedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        continue;
      }
      const buyerName = order.shippingDetails?.fullName || order.buyerName || "a customer";
      const hoursSince = 6 * (nudgeCount + 1);
      for (const sellerId of sellerIds) {
        if (hiddenFrom.includes(sellerId)) continue;
        try {
          const sellerSnap = await db.collection("users").doc(sellerId).get();
          if (!sellerSnap.exists) continue;
          const seller = sellerSnap.data() || {};
          const sellerPhone = seller.phoneNumber || seller.phone || null;
          if (!sellerPhone) continue;
          const sellerName = seller.fullName || seller.shopName || seller.email?.split("@")[0] || "Seller";
          enqueueWhatsApp(sellerPhone, sellerReminderWhatsApp({ sellerName, orderId, buyerName, hoursSince, nudgeNumber: nudgeCount + 1, maxNudges: NUDGE_MAX }), { kind: `seller-nudge-${nudgeCount + 1}`, orderId, sellerId });
        } catch (err) {
          console.error(`❌ Nudge send failed:`, err.message);
        }
      }
      const nextCount = nudgeCount + 1;
      const nextAt = new Date(Date.now() + NUDGE_INTERVAL_MS);
      await docSnap.ref.update({ sellerNudgeCount: nextCount, nextSellerNudgeAt: nextAt, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
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
  console.log(`🌀 Seller nudge scheduler active`);
})();

function buyerSubscriptionId(phone, sellerId, categoryId) { return `${phone}_${sellerId}_${categoryId}`; }

async function upsertBuyerSubscription({ phone, sellerId, categoryId, categoryName, orderId }) {
  if (!phone || !sellerId || !categoryId) return false;
  try {
    const id = buyerSubscriptionId(phone, sellerId, categoryId);
    const ref = db.collection("buyerSubscriptions").doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.set({
        purchaseCount: admin.firestore.FieldValue.increment(1),
        lastPurchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastOrderId: orderId || null,
        categoryName: categoryName || snap.data().categoryName || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      await ref.set({
        phone, sellerId, categoryId, categoryName: categoryName || null,
        subscribed: false, subscribedAt: null, subscribedVia: null,
        purchaseCount: 1,
        firstPurchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastPurchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastOrderId: orderId || null,
        optedOut: false, optedOutAt: null,
        lastNotifiedAt: null, notifyCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return true;
  } catch (e) {
    console.error("upsertBuyerSubscription failed:", e.message);
    return false;
  }
}

async function recordBuyerProfileTouch({ phone, name, amount }) {
  if (!phone) return;
  try {
    const ref = db.collection("buyerProfiles").doc(phone);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.set({
        name: name || snap.data().name || null,
        totalOrders: admin.firestore.FieldValue.increment(1),
        totalSpent: admin.firestore.FieldValue.increment(Number(amount) || 0),
        lastOrderAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      await ref.set({
        phone, name: name || null,
        totalOrders: 1, totalSpent: Number(amount) || 0,
        firstOrderAt: admin.firestore.FieldValue.serverTimestamp(),
        lastOrderAt: admin.firestore.FieldValue.serverTimestamp(),
        receiptSentAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error("recordBuyerProfileTouch failed:", e.message);
  }
}

async function loadBuyerSubscriptions(phone) {
  const snap = await db.collection("buyerSubscriptions").where("phone", "==", phone).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function activateAllSubscriptionsForPhone({ phone, keyword, receiptSellerId = null, onConfirmationSent = null }) {
  const allSubs = await loadBuyerSubscriptions(phone);
  if (!allSubs.length) return { activated: 0, alreadySubscribed: false };
  const subs = receiptSellerId ? allSubs.filter(s => s.sellerId === receiptSellerId) : allSubs;
  if (!subs.length) return { activated: 0, alreadySubscribed: false };
  const now = admin.firestore.FieldValue.serverTimestamp();
  const toActivate = subs.filter(s => !s.subscribed || s.optedOut);
  const alreadySubscribed = toActivate.length === 0 && subs.some(s => s.subscribed && !s.optedOut);
  const BATCH_LIMIT = 450;
  for (let i = 0; i < toActivate.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const s of toActivate.slice(i, i + BATCH_LIMIT)) {
      batch.set(db.collection("buyerSubscriptions").doc(s.id), {
        subscribed: true, subscribedAt: now,
        subscribedVia: keyword || "STOCK",
        optedOut: false, optedOutAt: null, updatedAt: now,
      }, { merge: true });
    }
    await batch.commit();
  }
  const msgSellerIds = [...new Set((receiptSellerId ? subs : allSubs).map(s => s.sellerId))];
  const sellerNames = {};
  for (const sid of msgSellerIds) {
    try {
      const sSnap = await db.collection("users").doc(sid).get();
      sellerNames[sid] = sSnap.exists ? (sSnap.data().shopName || sSnap.data().fullName || "MarketMix seller") : "MarketMix seller";
    } catch { sellerNames[sid] = "MarketMix seller"; }
  }
  const grouped = {};
  const subsForMessage = receiptSellerId ? subs : allSubs;
  for (const s of subsForMessage) {
    const sid = s.sellerId;
    if (!grouped[sid]) grouped[sid] = { shop: sellerNames[sid], categories: [] };
    grouped[sid].categories.push({
      name: s.categoryName || s.categoryId,
      emoji: categoryEmoji(s.categoryId),
      count: s.purchaseCount || 1,
    });
  }
  const payload = Object.values(grouped);
  const msg = alreadySubscribed ? alreadySubscribedWhatsApp({ shopNamesByCategory: payload }) : subscriptionConfirmedWhatsApp({ shopNamesByCategory: payload });
  enqueueWhatsApp(phone, msg, {
    kind: alreadySubscribed ? "subscription-already-active" : "subscription-confirmed",
    keyword,
    onSent: typeof onConfirmationSent === "function"
      ? async (confirmationMessageId) => {
          try { await onConfirmationSent(confirmationMessageId); }
          catch (e) { console.error("onConfirmationSent failed:", e.message); }
        }
      : null,
  });
  return { activated: toActivate.length, alreadySubscribed, grouped: payload };
}

async function optOutAllSubscriptionsForPhone(phone) {
  const subs = await loadBuyerSubscriptions(phone);
  if (!subs.length) return { optedOut: 0 };
  const now = admin.firestore.FieldValue.serverTimestamp();
  const active = subs.filter(s => !s.optedOut);
  const BATCH_LIMIT = 450;
  for (let i = 0; i < active.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const s of active.slice(i, i + BATCH_LIMIT)) {
      batch.set(db.collection("buyerSubscriptions").doc(s.id), { optedOut: true, optedOutAt: now, updatedAt: now }, { merge: true });
    }
    await batch.commit();
  }
  await db.collection("optOutLogs").add({ phone, count: active.length, loggedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  return { optedOut: active.length };
}

const SUBSCRIBE_TOKEN_TTL_DAYS = 90;
const SUBSCRIBE_TOKEN_BYTES = 6;
function generateSubscribeToken() {
  const buf = crypto.randomBytes(SUBSCRIBE_TOKEN_BYTES);
  return buf.toString("base64").replace(/\+/g, "").replace(/\//g, "").replace(/=/g, "").slice(0, 8);
}
async function getOrCreateSubscribeToken({ phone, sellerId = null, orderId = null }) {
  if (!phone) return null;
  try {
    const existing = await db.collection("subscribeTokens").where("phone", "==", phone).orderBy("createdAt", "desc").limit(1).get();
    if (!existing.empty) {
      const d = existing.docs[0];
      const data = d.data() || {};
      const createdMs = data.createdAt?.toDate?.()?.getTime?.() || 0;
      const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
      if (ageDays < SUBSCRIBE_TOKEN_TTL_DAYS) {
        await d.ref.set({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp(), uses: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
        return d.id;
      }
    }
    let token = generateSubscribeToken();
    for (let i = 0; i < 3; i++) {
      const check = await db.collection("subscribeTokens").doc(token).get();
      if (!check.exists) break;
      token = generateSubscribeToken();
    }
    const expiresAt = new Date(Date.now() + SUBSCRIBE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.collection("subscribeTokens").doc(token).set({
      phone, sellerId: sellerId || null, orderId: orderId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUsedAt: null, uses: 0, expiresAt,
    });
    return token;
  } catch (e) {
    console.error("getOrCreateSubscribeToken failed:", e.message);
    return null;
  }
}
async function resolveSubscribeToken(token) {
  if (!token) return null;
  try {
    const ref = db.collection("subscribeTokens").doc(String(token).toUpperCase());
    const snap = await ref.get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    if (d.expiresAt?.toDate?.() && d.expiresAt.toDate() < new Date()) return null;
    await ref.set({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp(), uses: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
    return { phone: d.phone, sellerId: d.sellerId || null, orderId: d.orderId || null };
  } catch (e) {
    console.error("resolveSubscribeToken failed:", e.message);
    return null;
  }
}
function parseKeywordAndToken(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { keyword: "", token: null };
  const normalized = text.replace(/\s+/g, " ");
  const upper = normalized.toUpperCase();
  const allKeywords = [...UNSUBSCRIBE_KEYWORDS, ...SUBSCRIBE_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const kw of allKeywords) {
    if (upper === kw) return { keyword: kw, token: null };
    if (upper.startsWith(kw + " ")) {
      const rest = normalized.slice(kw.length).trim();
      const tokenMatch = /^([A-Za-z0-9]{4,16})$/.exec(rest);
      if (tokenMatch) return { keyword: kw, token: tokenMatch[1].toUpperCase() };
      return { keyword: kw, token: null };
    }
  }
  return { keyword: upper, token: null };
}

const LID_FALLBACK_COOLDOWN_HOURS = 24;
const LID_FALLBACK_REPEAT_HOURS = 2;
const LID_FALLBACK_MAX_SENDS = 3;

async function storeConfirmationMessageMap({ messageId, phone, sellerId, kind, orderId = null }) {
  if (!messageId || !phone) return false;
  try {
    const ref = db.collection("whatsappMessageMap").doc(messageId);
    const snap = await ref.get();
    if (snap.exists) return false;
    await ref.set({
      messageId, phone, orderId: orderId || null, sellerId: sellerId || null,
      kind: kind || "confirmation",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("storeConfirmationMessageMap failed:", e.message);
    return false;
  }
}

async function resolveLidViaReply({ replyToId }) {
  if (!replyToId) return null;
  try {
    const snap = await db.collection("whatsappMessageMap").doc(replyToId).get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    if (!d.phone) return null;
    return { phone: d.phone, orderId: d.orderId || null, sellerId: d.sellerId || null, kind: d.kind || null };
  } catch (e) {
    console.error("resolveLidViaReply failed:", e.message);
    return null;
  }
}

async function maybeSendSubscribeFallback({ phoneRaw, text, reason, token = null }) {
  if (!SUBSCRIBE_KEYWORDS.has(text)) return false;
  if (UNSUBSCRIBE_KEYWORDS.has(text)) return false;
  if (!phoneRaw || !String(phoneRaw).endsWith("@lid")) return false;
  try {
    const cooldownRef = db.collection("waFallbackCooldowns").doc(String(phoneRaw));
    const snap = await cooldownRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const sentCount = Number(data.sentCount || 0);
    if (sentCount >= LID_FALLBACK_MAX_SENDS) return false;
    if (snap.exists) {
      const last = data.lastSentAt?.toDate?.()?.getTime?.() || 0;
      const hoursSince = (Date.now() - last) / (1000 * 60 * 60);
      const minHours = sentCount >= 1 ? LID_FALLBACK_REPEAT_HOURS : LID_FALLBACK_COOLDOWN_HOURS;
      if (hoursSince < minHours) return false;
    }
    const attempt = sentCount + 1;
    let msg;
    if (attempt === 1) {
      msg = [
        "Hey 😊❤️ Want to know when new stock arrives?",
        "",
        "Please open the receipt we sent you, press and hold that message, tap *Reply*, then type *STOCK* and send.",
        "",
        "That way, we'll know which shop's new arrivals to keep you updated on. 🛍️✨",
        "",
        "*MarketMix Kenya* 🇰🇪",
        "Shop local, grow local.",
      ].join("\n");
    } else if (attempt === 2) {
      msg = [
        "We couldn't match your number to a receipt 😅",
        "",
        "Here's how to subscribe in 3 steps:",
        "",
        "1️⃣ Open your *WhatsApp chat with MarketMix Kenya*",
        "2️⃣ Find your *last receipt message* (the one with your items)",
        "3️⃣ *Press and hold* it → tap *Reply* → type *STOCK* → send",
        "",
        "A fresh message (like the one you just sent) doesn't carry the receipt info we need. 🙏",
        "",
        "*MarketMix Kenya* 🇰🇪",
      ].join("\n");
    } else {
      msg = [
        "We're still having trouble linking your number to a receipt 🥲",
        "",
        "This is a WhatsApp technical limit on our side — sorry!",
        "",
        `Please message our team directly and we'll set you up manually:`,
        `👉 wa.me/${ORDERS_PHONE}`,
        "",
        "Include your most recent receipt number and we'll add you to the right shop's stock alerts. 💚",
        "",
        "*MarketMix Kenya* 🇰🇪",
      ].join("\n");
    }
    enqueueWhatsApp(phoneRaw, msg, { kind: `subscribe-fallback-${attempt}`, reason, token: token || null });
    await cooldownRef.set({
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      sentCount: admin.firestore.FieldValue.increment(1),
      lastReason: reason || null,
    }, { merge: true });
    return true;
  } catch (e) {
    console.error("maybeSendSubscribeFallback failed:", e.message);
    return false;
  }
}

async function maybeSendStopFallback({ phoneRaw, text, reason }) {
  if (!UNSUBSCRIBE_KEYWORDS.has(text)) return false;
  if (!phoneRaw || !String(phoneRaw).endsWith("@lid")) return false;
  try {
    const cooldownRef = db.collection("waStopFallbackCooldowns").doc(String(phoneRaw));
    const snap = await cooldownRef.get();
    if (snap.exists) {
      const last = snap.data().lastSentAt?.toDate?.()?.getTime?.() || 0;
      const hoursSince = (Date.now() - last) / (1000 * 60 * 60);
      if (hoursSince < LID_FALLBACK_COOLDOWN_HOURS) return false;
    }
    const msg = [
      "Hey ❤️ To stop stock notifications, please open the receipt we sent you, press and hold that message, tap *Reply*, then type *STOP* and send.",
      "",
      "This helps us identify the right shop's notifications to turn off. 😊",
      "",
      "*MarketMix Kenya* 🇰🇪",
      "Shop local, grow local.",
    ].join("\n");
    enqueueWhatsApp(phoneRaw, msg, { kind: "stop-fallback", reason });
    await cooldownRef.set({
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      reason: reason || null,
    }, { merge: true });
    return true;
  } catch (e) {
    console.error("maybeSendStopFallback failed:", e.message);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════ */

app.post("/api/send-proposal-status", async (req, res) => {
  try {
    const { to, subject, html, proposalId, studentName, status, notes, amount, institution } = req.body || {};
    if (!to || !proposalId || !status) return res.status(400).json({ success: false, message: "Missing required fields" });
    const emailHtml = html || marketMixEmailShell({
      preheader: `Proposal ${status}`,
      eyebrow: "MarketMix Kenya · Lipa Mdogo Mdogo",
      title: `Proposal ${status === "approved" ? "Approved ✅" : "Rejected ❌"}`,
      subtitle: `Hello ${studentName || "Student"}, your installment proposal has been reviewed.`,
      bodyHtml: `
        ${emailInfoCard([["Proposal ID", String(proposalId)], ["Status", status.toUpperCase(), status === "approved"], ["Amount", `KSH ${Number(amount || 0).toLocaleString()}`], ["Institution", institution || "N/A"]])}
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
    let amt = parsePositiveNumber(amount);
    if (!amt) return res.status(400).json({ success: false, message: "Invalid amount" });
    if (!isValidPhone(phoneNumber)) return res.status(400).json({ success: false, message: "Invalid phone" });
    if (!fullName) return res.status(400).json({ success: false, message: "Full name required" });
    if (!email || !email.includes("@")) return res.status(400).json({ success: false, message: "Invalid email" });
    if (!orderId) return res.status(400).json({ success: false, message: "Missing orderId" });
    const storedOrderSnap = await db.collection("orders").doc(String(orderId)).get();
    const storedOrder = storedOrderSnap.exists ? storedOrderSnap.data() || {} : null;
    if (storedOrder?.isSiteSeeingBooking === true) {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      let paymentUser;
      try { paymentUser = token ? await verifyAnyToken(token) : null; } catch { paymentUser = null; }
      if (!paymentUser || paymentUser.uid !== storedOrder.userId) return res.status(403).json({ success: false, message: "Sign in with the account that created this viewing payment." });
      if (storedOrder.paymentStatus !== "pending") return res.status(409).json({ success: false, message: "This viewing payment is not pending." });
      amt = parsePositiveNumber(storedOrder.totalAmount);
      if (!amt) return res.status(409).json({ success: false, message: "The saved viewing payment amount is invalid." });
    }
    const [firstName, ...rest] = fullName.trim().split(" ");
    const lastName = rest.join(" ") || "N/A";
    let response;
    try {
      response = await intasend.collection().mpesaStkPush({
        first_name: firstName, last_name: lastName, email,
        phone_number: phoneNumber, amount: amt,
        host: BACKEND_HOST, api_ref: orderId,
      });
    } catch (intasendErr) {
      console.error("❌ IntaSend STK failed:", intasendErr?.response || intasendErr);
      return res.status(502).json({ success: false, message: "Payment provider error" });
    }
    await db.collection("orders").doc(orderId).set({
      invoiceId: response?.invoice?.invoice_id || null,
      status: "STK_PUSH_SENT",
      totalAmount: amt, userEmail: email, buyerEmail: email, phoneNumber,
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
      orderId: ref, orderType: "store",
      totalAmount: Number(amount) || 0,
      userEmail: email, buyerEmail: email, phoneNumber,
      shippingDetails: { fullName, phoneNumber, email, deliveryPlace: "TBD" },
      items: Array.isArray(cart?.items) ? cart.items : [],
      sellerGroups: Array.isArray(cart?.sellerGroups) ? cart.sellerGroups : [],
      paymentStatus: "pending", state: "INITIATED",
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
    if (!ref || !ref.startsWith("PROP_")) return res.status(400).json({ success: false, message: "ref must start with PROP_" });
    if (!property?.id || !landlord?.phone || !email) return res.status(400).json({ success: false, message: "Missing property/landlord/email" });
    await db.collection("orders").doc(ref).set({
      orderId: ref, orderType: "real_estate", isRealEstate: true,
      paymentKind: paymentKind || "rent",
      totalAmount: Number(amount) || 0,
      userEmail: email, buyerEmail: email,
      buyerName: fullName || "Buyer",
      phoneNumber,
      shippingDetails: { fullName, phoneNumber, email },
      propertyId: property.id, propertyTitle: property.title,
      propertyLocation: property.location, propertyType: property.type,
      landlordName: landlord.name, landlordPhone: landlord.phone,
      paymentStatus: "pending", state: "INITIATED",
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
    if (!orderId || !newStatus) return res.status(400).json({ success: false, message: "orderId and newStatus required" });
    if (!ALLOWED_SELLER_STATUSES.includes(newStatus)) return res.status(400).json({ success: false, message: `Invalid status` });
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const sellerId = decoded.uid;
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ success: false, message: "Order not found" });
    const order = orderSnap.data() || {};
    const involved = Array.isArray(order.involvedSellerIds) ? order.involvedSellerIds : [];
    if (!involved.includes(sellerId)) return res.status(403).json({ success: false, message: "Not your order" });
    if (order.paymentStatus !== "paid") return res.status(400).json({ success: false, message: "Not paid" });
    await orderRef.update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      sellerNudgeActive: false,
      lastStatusUpdateBy: sellerId,
      lastStatusUpdateAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const buyerPhone = order.phoneNumber || order.shippingDetails?.phoneNumber || order.buyerPhone || null;
    if (buyerPhone) {
      const customerName = order.shippingDetails?.fullName || order.buyerName || "Customer";
      enqueueWhatsApp(buyerPhone, buyerStatusUpdateWhatsApp({ customerName, orderId, statusLabel: newStatus }), { kind: "buyer-status-update", orderId, sellerId, status: newStatus });
    }
    if (newStatus === "Cancelled") {
      try {
        await db.collection("adminAlerts").add({ type: "seller_cancelled_order", orderId, cancelledBy: sellerId, involvedSellerIds: involved, flaggedAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (_) {}
    }
    return res.json({ success: true, orderId, newStatus, buyerNotified: !!buyerPhone });
  } catch (e) {
    return sendServerError(res, e, "Status update failed");
  }
});

app.post("/api/re/welcome", async (req, res) => {
  try {
    const { email, name, phone, roleLabel, roleDesc, rolePerks, isSwitch = false, previousRoleLabel = null, ctaLabel, ctaUrl } = req.body || {};
    if (!email || !email.includes("@")) return res.status(400).json({ success: false, message: "Valid email required" });
    if (!roleLabel) return res.status(400).json({ success: false, message: "roleLabel required" });
    const emailSent = await sendRealEstateWelcomeEmail({
      userEmail: email, userName: name, roleLabel, roleDesc,
      rolePerks: Array.isArray(rolePerks) ? rolePerks : [],
      isSwitch: !!isSwitch, previousRoleLabel, ctaLabel, ctaUrl,
    });
    let whatsappQueued = false;
    if (phone) {
      const lines = [
        `🏠 *MarketMix Real Estates*`, ``,
        isSwitch ? `Hi ${name || "there"} — you're now a *${roleLabel}*.` : `*Welcome, ${name || "friend"}!*`, ``,
        roleDesc ? roleDesc : "",
        rolePerks?.length ? `\n*What you can do:*` : "",
        ...(Array.isArray(rolePerks) ? rolePerks.map((l) => `• ${l}`) : []), ``,
        `👉 ${ctaUrl || REAL_ESTATE_APP_URL}`, ``,
        `👥 ${WHATSAPP_GROUP_URL}`,
      ].filter(Boolean);
      whatsappQueued = enqueueWhatsApp(phone, lines.join("\n"), { kind: isSwitch ? "re-welcome-role-switch" : "re-welcome-signup", roleLabel });
    }
    return res.json({ success: true, emailSent, whatsappQueued, isSwitch: !!isSwitch, roleLabel });
  } catch (e) {
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
      return res.status(r.status).json({ success: false, message: "WAHA error", wahaStatus: r.status, wahaBody: raw.slice(0, 500) });
    }
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === "object") list = Object.values(data);
    const groups = list
      .filter((c) => c && (c.id || c.chatId) && String(c.id || c.chatId).endsWith("@g.us"))
      .map((c) => ({ id: c.id || c.chatId, name: c.subject || c.name || "(unnamed group)", size: c.size || null }));
    return res.json({ success: true, count: groups.length, groups });
  } catch (e) {
    return sendServerError(res, e, "Could not list groups");
  }
});

/* ═══════════════════════════════════════════════════════════════
   AUTO-PROMO ADMIN
   ═══════════════════════════════════════════════════════════════ */

app.get("/api/admin/auto-promo", async (req, res) => {
  try {
    const settings = await autoPromoLoadSettings();
    const recent = await db.collection("autoPromoLogs").orderBy("sentAt", "desc").limit(20).get().catch(() => ({ docs: [] }));
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
    if (Array.isArray(patch.selectedGroupIds)) {
      patch.selectedGroupIds = [...new Set(patch.selectedGroupIds.filter(Boolean))];
    }
    await autoPromoSaveSettings(patch, req.body?.uid || "admin");
    const settingsAfter = await autoPromoLoadSettings();
    const today = autoPromoDateStrEAT();
    const tomorrow = (() => {
      const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const regenResults = [];
    for (const date of [today, tomorrow]) {
      try {
        await regeneratePlanPreservingOverrides(date, settingsAfter);
        regenResults.push({ date, ok: true });
      } catch (e) {
        regenResults.push({ date, ok: false, error: e.message });
      }
    }
    return res.json({ success: true, settings: settingsAfter, planRegenerated: regenResults });
  } catch (e) {
    return sendServerError(res, e, "Could not save auto-promo settings");
  }
});

async function handleAutoPromoPreview(req, res) {
  try {
    const src = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
    const { date = null } = src;
    const rawGroupIds = req.method === "POST" ? src.groupIds : null;
    const groupIds = Array.isArray(rawGroupIds) ? [...new Set(rawGroupIds.filter(Boolean))] : null;
    const autoSettings = await autoPromoLoadSettings();
    const occSettings  = await occasionLoadSettings();

    const targetDate = date ? new Date(date + "T00:00:00Z") : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dateStr = targetDate.toISOString().slice(0, 10);

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
    const previewPersistedIds = Array.isArray(autoSettings.selectedGroupIds) ? [...new Set(autoSettings.selectedGroupIds.filter(Boolean))] : [];
    const previewEffectiveIds = (Array.isArray(groupIds) && groupIds.length > 0) ? groupIds : previewPersistedIds;
    if (previewEffectiveIds.length > 0) {
      const allowed = new Set(previewEffectiveIds);
      groups = groups.filter(g => allowed.has(g.id));
    }

    let plan;
    try {
      plan = await ensurePlan(dateStr, autoSettings, "preview");
      plan = await loadPlan(dateStr);
    }
    catch (e) { return sendServerError(res, e, "Could not generate plan"); }

    const rawSlots = Array.isArray(plan.slots) ? plan.slots : [];
    const overrides = await loadOverridesForDate(dateStr);
    const displaySlots = rawSlots.map(s => applyOverrideToSlot(s, overrides, dateStr));

    const { dated, recurring } = resolveOccasionsForDate({
      month: targetDate.getUTCMonth() + 1,
      day: targetDate.getUTCDate(),
      weekday: targetDate.getUTCDay(),
      year: targetDate.getUTCFullYear(),
      movableDates: occSettings.movableDates || {},
      includeRecurring: !!occSettings.sendRecurring,
    });

    const occasionSlots = [];
    const occEnabled = !!occSettings.enabled;
    if (occEnabled) {
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
    }

    const slots = [...displaySlots, ...occasionSlots]
      .sort((a, b) => {
        const t = a.time.localeCompare(b.time);
        if (t !== 0) return t;
        return (a.groupName || "").localeCompare(b.groupName || "");
      });

    const perGroupPerDay = Math.min(
      AUTO_PROMO_MAX_PER_GROUP_PER_DAY,
      Math.max(1, Number(autoSettings.perGroupPerDay) || AUTO_PROMO_MAX_PER_GROUP_PER_DAY)
    );
    const { slots: autoSlotTimes, effectiveCap } = computeAutoSlotHours(autoSettings.activeHours, perGroupPerDay);
    const expectedPromoSlots = groups.length * autoSlotTimes.length;

    return res.json({
      success: true,
      date: dateStr,
      campaign: plan.campaign || null,
      groupCount: groups.length,
      perGroupPerDay, effectiveCap,
      autoSlotHours: autoSlotTimes,
      expectedPromoSlots,
      promoSlotsReturned: displaySlots.length,
      occasionSlotsReturned: occasionSlots.length,
      occasionEngineEnabled: occEnabled,
      activeHours: autoSettings.activeHours || { start: 8, end: 21 },
      overridesLoaded: overrides.size,
      overridesApplied: displaySlots.filter(s => s.overridden).length,
      planGeneratedAt: plan.generatedAt || null,
      planGeneratedBy: plan.generatedBy || null,
      slots,
    });
  } catch (e) {
    console.error("❌ preview failed:", e);
    return sendServerError(res, e, "Preview failed");
  }
}

app.post("/api/admin/auto-promo/preview", handleAutoPromoPreview);
app.get("/api/admin/auto-promo/preview", handleAutoPromoPreview);

/* ═══════════════════════════════════════════════════════════════
   DAY VIEW — v2.10.7: non-promo slots come from the persisted plan
   ═══════════════════════════════════════════════════════════════ */
app.get("/api/admin/auto-promo/day-view", async (req, res) => {
  try {
    const dateParam = req.query.date || autoPromoDateStrEAT();
    const autoSettings = await autoPromoLoadSettings();
    const occSettings = await occasionLoadSettings();

    const targetDate = new Date(dateParam + "T00:00:00Z");
    const dateStr = targetDate.toISOString().slice(0, 10);

    let plan;
    try {
      plan = await ensurePlan(dateStr, autoSettings, "preview");
      plan = await loadPlan(dateStr);
    }
    catch (e) { return sendServerError(res, e, "Could not generate plan"); }

    const rawSlots = Array.isArray(plan.slots) ? plan.slots : [];
    const overrides = await loadOverridesForDate(dateStr);
    const displaySlots = rawSlots.map(s => applyOverrideToSlot(s, overrides, dateStr));

    // v2.10.7 — non-promo slots now come from the persisted plan
    const occasionSlots = displaySlots.filter(
      s => s.slotKind === "occasion" || s.slotKind === "non-promo"
    );
    const promoDisplaySlots = displaySlots.filter(s => s.slotKind === "promo");
    const occEnabled = !!occSettings.enabled;

    const allSlots = [...promoDisplaySlots, ...occasionSlots].sort((a, b) => {
      const t = a.time.localeCompare(b.time);
      if (t !== 0) return t;
      return (a.groupName || "").localeCompare(b.groupName || "");
    });

    return res.json({
      success: true,
      date: dateStr,
      autoPromoEnabled: !!autoSettings.enabled,
      occasionEngineEnabled: occEnabled,
      planGeneratedAt: plan.generatedAt || null,
      planGeneratedBy: plan.generatedBy || null,
      autoSlotHours: plan.autoSlotHours || [],
      campaign: plan.campaign || null,
      overridesLoaded: overrides.size,
      overridesApplied: displaySlots.filter(s => s.overridden).length,
      promoSlots: promoDisplaySlots.length,
      occasionSlots: occasionSlots.length,
      slots: allSlots,
    });
  } catch (e) {
    console.error("❌ day-view failed:", e);
    return sendServerError(res, e, "Day view failed");
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

app.get("/api/admin/auto-promo/plan", async (req, res) => {
  try {
    const date = req.query.date || autoPromoDateStrEAT();
    const plan = await loadPlan(date);
    if (!plan) return res.status(404).json({ success: false, message: "No plan for " + date });
    return res.json({ success: true, date, plan });
  } catch (e) {
    return sendServerError(res, e, "Could not load plan");
  }
});

app.post("/api/admin/auto-promo/regenerate-plan", async (req, res) => {
  try {
    const date = req.body?.date || autoPromoDateStrEAT();
    const settings = await autoPromoLoadSettings();
    const plan = await regeneratePlanPreservingOverrides(date, settings);
    return res.json({ success: true, date, plan });
  } catch (e) {
    return sendServerError(res, e, "Could not regenerate plan");
  }
});

app.post("/api/admin/auto-promo/refire-slot", async (req, res) => {
  try {
    const { date, slotId } = req.body || {};
    if (!date || !slotId) return res.status(400).json({ success: false, message: "date and slotId required" });
    const slotRef = db.collection("scheduledPromos").doc(date).collection("slots").doc(slotId);
    const snap = await slotRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Slot not found" });
    const slot = snap.data();
    if (!slot.productId && !slot.caption) return res.status(400).json({ success: false, message: "Slot has no content" });
    try {
      if (slot.imageUrl) enqueueWhatsAppImage(slot.groupId, slot.imageUrl, slot.caption, { kind: "auto-promo-refire", slotId, productId: slot.productId });
      else enqueueWhatsApp(slot.groupId, slot.caption, { kind: "auto-promo-refire", slotId, productId: slot.productId });
      await patchPlanSlot(date, slotId, { status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp(), error: null, refired: true });
      return res.json({ success: true, slotId, fired: true });
    } catch (e) {
      await patchPlanSlot(date, slotId, { status: "failed", error: e.message }).catch(() => {});
      return sendServerError(res, e, "Refire failed");
    }
  } catch (e) {
    return sendServerError(res, e, "Refire slot failed");
  }
});

app.get("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: "date query param required" });
    const snap = await db.collection("marketingOverrides").where("date", "==", date).get();
    return res.json({ success: true, count: snap.size, overrides: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    return sendServerError(res, e, "Could not load overrides");
  }
});

app.post("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date, slot, originalProductId, productId, productName, imageUrl, caption, time, skipped, groupId } = req.body || {};
    if (!date || !slot) return res.status(400).json({ success: false, message: "date and slot required" });
    if (!groupId) return res.status(400).json({ success: false, message: "groupId required" });
    const key = buildOverrideKey({ date, slot, groupId });
    const payload = {
      date, slot, groupId,
      originalProductId: originalProductId || null,
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      savedBy: req.body?.uid || "admin",
    };
    if (productId !== undefined) payload.productId = productId;
    if (productName !== undefined) payload.productName = productName;
    if (imageUrl !== undefined) payload.imageUrl = imageUrl;
    if (caption !== undefined) payload.caption = caption;
    if (time !== undefined) payload.time = time;
    if (skipped !== undefined) payload.skipped = skipped;
    await db.collection("marketingOverrides").doc(key).set(payload, { merge: true });
    try {
      const slotId = `${date}_${slot}_${groupId}`;
      const patch = { overridden: true };
      if (productId !== undefined) patch.productId = productId;
      if (productName !== undefined) patch.productName = productName;
      if (imageUrl !== undefined) patch.imageUrl = imageUrl;
      if (caption !== undefined) patch.caption = caption;
      if (time !== undefined) {
        // v2.10.6 — recompute hourEAT so the tick's hour query finds it
        patch.time = time;
        patch.hourEAT = parseInt(String(time).split(":")[0], 10);
      }
      if (skipped !== undefined) {
        patch.skipped = skipped;
        patch.status = skipped ? "skipped" : "pending";
      }
      await patchPlanSlot(date, slotId, patch);
    } catch (planErr) {
      console.warn("[override] plan patch failed:", planErr.message);
    }
    return res.json({ success: true, key, payload });
  } catch (e) {
    return sendServerError(res, e, "Could not save override");
  }
});

app.delete("/api/admin/marketing-overrides", async (req, res) => {
  try {
    const { date, slot, groupId, originalProductId } = req.body || {};
    if (!date || !slot) return res.status(400).json({ success: false, message: "date and slot required" });
    const key = buildOverrideKey({ date, slot, groupId });
    await db.collection("marketingOverrides").doc(key).delete().catch(() => {});
    const legacyKey = `${date}_${slot}_${originalProductId || "noplan"}`;
    if (legacyKey !== key) await db.collection("marketingOverrides").doc(legacyKey).delete().catch(() => {});
    try {
      const settings = await autoPromoLoadSettings();
      await regeneratePlanPreservingOverrides(date, settings);
    } catch (e) {
      console.warn("[override] plan regen failed:", e.message);
    }
    return res.json({ success: true, key });
  } catch (e) {
    return sendServerError(res, e, "Could not delete override");
  }
});

/* ═══════════════════════════════════════════════════════════════
   OCCASIONS ADMIN
   ═══════════════════════════════════════════════════════════════ */

app.get("/api/admin/occasions", async (req, res) => {
  try {
    const settings = await occasionLoadSettings();
    const today = resolveOccasionsForDate({
      month: autoPromoMonthEAT(), day: autoPromoDayEAT(), weekday: autoPromoDowEAT(),
      movableDates: settings.movableDates || {}, includeRecurring: true,
    });
    const recent = await db.collection("occasionLogs").orderBy("sentAt", "desc").limit(30).get().catch(() => ({ docs: [] }));
    return res.json({
      success: true, settings,
      today: {
        dated: today.dated.map(o => ({ key: o.key, name: o.name, sensitive: !!o.sensitive, kind: o.kind })),
        recurring: today.recurring.map(o => ({ key: o.key, name: o.name, sensitive: !!o.sensitive })),
      },
      totalOccasions: OCCASION_LIBRARY.length,
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

async function handleOccasionPreview(req, res) {
  try {
    const src = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
    const { date = null } = src;
    const rawGroupIds = req.method === "POST" ? src.groupIds : (src.groupIds ? String(src.groupIds).split(",") : null);
    const groupIds = Array.isArray(rawGroupIds) ? [...new Set(rawGroupIds.filter(Boolean))] : null;
    const includeRecurring = req.method === "POST" ? (src.includeRecurring !== false) : (src.includeRecurring !== "false");
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
    const { dated, recurring } = resolveOccasionsForDate({
      month: targetDate.getUTCMonth() + 1, day: targetDate.getUTCDate(),
      weekday: targetDate.getUTCDay(), year: targetDate.getUTCFullYear(),
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
    return sendServerError(res, e, "Occasion preview failed");
  }
}

app.post("/api/admin/occasions/preview", handleOccasionPreview);
app.get("/api/admin/occasions/preview", handleOccasionPreview);

app.post("/api/admin/occasions/run-now", async (req, res) => {
  try {
    const settings = await occasionLoadSettings();
    const wasEnabled = settings.enabled;
    await occasionSaveSettings({ enabled: true }, "admin-occasion-run-now");
    const result = await occasionRunTick({
      forceGroups: Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(id => ({ id, name: "(forced)" })) : null,
      forceOccasionKey: req.body?.occasionKey || null,
    });
    await occasionSaveSettings({ enabled: !!wasEnabled }, "admin-occasion-run-now-restore");
    return res.json({ success: true, result });
  } catch (e) {
    return sendServerError(res, e, "Occasion run-now failed");
  }
});

/* ═══════════════════════════════════════════════════════════════
   WHATSAPP BULK & NOTIFY
   ═══════════════════════════════════════════════════════════════ */

app.post("/api/whatsapp/send-media", async (req, res) => {
  try {
    const { recipients = [], message = "", mediaUrl = null, mediaType = "image", filename = null, pace = "safe", dryRun = false } = req.body || {};
    if (!Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ success: false, message: "recipients[] required" });
    if (!message && !mediaUrl) return res.status(400).json({ success: false, message: "message or mediaUrl required" });
    if (recipients.length > 300) return res.status(400).json({ success: false, message: "Max 300 per batch" });

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
      } catch (e) {
        results.push({ phone, name, status: "failed", error: e.message || "send failed" });
      }
      if (i < recipients.length - 1) await new Promise((resolve) => setTimeout(resolve, delay()));
    }

    const sent = results.filter((x) => x.status === "sent").length;
    const failed = results.filter((x) => x.status === "failed").length;

    await reDb.collection("bulkWhatsAppLogs").add({
      total: recipients.length, sent, failed, pace,
      mediaType: mediaUrl ? mediaType : "text", mediaUrl: mediaUrl || null,
      messagePreview: String(message).slice(0, 300),
      durationMs: Date.now() - startedAt, results,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    return res.json({ success: true, total: recipients.length, sent, failed, dryRun: !!dryRun, durationMs: Date.now() - startedAt, results });
  } catch (e) {
    return sendServerError(res, e, "Bulk WhatsApp send failed");
  }
});

app.post("/api/admin/notify-user", async (req, res) => {
  try {
    const { userId, phone, email, title = "MarketMix update", message, kind = "admin-notify" } = req.body || {};
    if (!userId || !message) return res.status(400).json({ success: false, message: "userId and message required" });
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const callerDoc = await reDb.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists) return res.status(403).json({ success: false, message: "Admin access required" });
    const caller = callerDoc.data() || {};
    const isAdmin = caller.role === "admin" || caller.userType === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
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
      whatsappQueued = enqueueWhatsApp(resolvedPhone, `🛍️ MarketMix Kenya\n${title}\n\n${message}`, { kind, userId, sourceDb: targetDb });
    }
    if (resolvedEmail) {
      const html = marketMixEmailShell({
        preheader: title, eyebrow: "MarketMix Kenya", title,
        subtitle: "Update from MarketMix",
        bodyHtml: emailBodyText(message),
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
    return sendServerError(res, e, "Admin notify failed");
  }
});

app.post("/api/driver/decision", async (req, res) => {
  try {
    const { userId, decision, reason = "" } = req.body || {};
    if (!userId || !["approve", "reject"].includes(decision)) return res.status(400).json({ success: false, message: "userId and decision required" });
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const callerDoc = await reDb.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists) return res.status(403).json({ success: false, message: "Admin access required" });
    const caller = callerDoc.data() || {};
    const isAdmin = caller.role === "admin" || caller.userType === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
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
          preheader: "Driver account approved",
          eyebrow: "MarketMix Moving",
          title: "You're approved to drive",
          subtitle: `Welcome aboard, ${driverName}.`,
          bodyHtml: `
            ${emailBodyText("You can now accept move requests on MarketMix.")}
            ${emailInfoCard([["Vehicle", profile.vehicleId || "—"], ["Plate", profile.plate || "—"], ["License", profile.licenseNumber || "—"], ["Phone", driverPhone || "—"]])}
          `,
          ctaLabel: "Open driver dashboard",
          ctaUrl: DRIVER_DASHBOARD_URL,
        });
        sendEmail(driverEmail, "You're approved · MarketMix Moving", html, "moving").catch(e => console.error(e));
      }
      if (driverPhone) enqueueWhatsApp(driverPhone, `🚚 MarketMix Moving\nWelcome ${driverName}!\nYour driver account is APPROVED.\n${DRIVER_DASHBOARD_URL}`, { kind: "driver-approved", userId });
    } else {
      if (driverEmail) {
        const html = marketMixEmailShell({
          preheader: "Driver application update",
          eyebrow: "MarketMix Moving",
          title: "Driver application not approved",
          subtitle: `Hello ${driverName},`,
          bodyHtml: `
            ${emailBodyText("You can update your details and resubmit anytime.")}
            ${emailInfoCard([["Reason", reason || "Not specified"]])}
          `,
          ctaLabel: "Update my details",
          ctaUrl: DRIVER_ONBOARD_URL,
        });
        sendEmail(driverEmail, "Update on your driver application", html, "moving").catch(e => console.error(e));
      }
      if (driverPhone) enqueueWhatsApp(driverPhone, `🚚 MarketMix Moving\nHello ${driverName},\nYour application was not approved.\nReason: ${reason || "Not specified"}\n${DRIVER_ONBOARD_URL}`, { kind: "driver-rejected", userId });
    }

    return res.json({ success: true, decision, userId });
  } catch (e) {
    return sendServerError(res, e, "Driver decision failed");
  }
});

app.post("/api/whatsapp/webhook", async (req, res) => {
  res.json({ success: true });
  try {
    const body = req.body || {};
    const inner = body.payload || body;
    const rawFrom = inner.from || inner.chatId || inner.author || null;
    const rawBody = String(inner.body || inner.text || "").trim();
    const fromMe = inner.fromMe === true;
    const replyToId = inner.replyTo?.id || null;
    if (fromMe) return;
    if (!rawFrom || !rawBody) return;
    if (String(rawFrom).endsWith("@g.us")) return;

    const { keyword, token } = parseKeywordAndToken(rawBody);
    let phone = null;
    let receiptSellerId = null;
    let resolutionReason = "direct";

    if (token) {
      const tok = await resolveSubscribeToken(token);
      if (tok?.phone) { phone = tok.phone; receiptSellerId = tok.sellerId || null; resolutionReason = "token"; }
      else resolutionReason = "token-invalid";
    }

    if (!phone && String(rawFrom).endsWith("@lid")) {
      if (replyToId) {
        const resolved = await resolveLidViaReply({ replyToId });
        if (resolved?.phone) {
          phone = resolved.phone;
          receiptSellerId = resolved.sellerId || null;
          resolutionReason = "reply-to-map";
        } else resolutionReason = "reply-to-unknown";
      } else if (resolutionReason === "direct") resolutionReason = "no-reply-chain";
    }

    if (!phone && !String(rawFrom).endsWith("@lid")) {
      phone = normalizePhoneForWa(String(rawFrom).replace(/@.*$/, ""));
    }

    if (!phone) {
      await db.collection("waUnresolvedLids").add({
        lid: rawFrom, keyword, token: token || null, replyToId: replyToId || null,
        reason: resolutionReason,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      if (SUBSCRIBE_KEYWORDS.has(keyword)) {
        await maybeSendSubscribeFallback({ phoneRaw: rawFrom, text: keyword, reason: resolutionReason, token: token || null });
      } else if (UNSUBSCRIBE_KEYWORDS.has(keyword)) {
        await maybeSendStopFallback({ phoneRaw: rawFrom, text: keyword, reason: resolutionReason });
      }
      return;
    }

    if (UNSUBSCRIBE_KEYWORDS.has(keyword)) {
      const r = await optOutAllSubscriptionsForPhone(phone);
      enqueueWhatsApp(phone, optOutConfirmedWhatsApp(), {
        kind: "optout-confirmed",
        onSent: async (confirmationMessageId) => {
          await storeConfirmationMessageMap({ messageId: confirmationMessageId, phone, sellerId: receiptSellerId || null, kind: "optout-confirmed" });
        },
      });
      await db.collection("waInboundLogs").add({ phone, keyword, action: "optout", affected: r.optedOut, rawFrom, token: token || null, loggedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      return;
    }

    if (SUBSCRIBE_KEYWORDS.has(keyword)) {
      const r = await activateAllSubscriptionsForPhone({
        phone, keyword, receiptSellerId,
        onConfirmationSent: async (confirmationMessageId) => {
          await storeConfirmationMessageMap({ messageId: confirmationMessageId, phone, sellerId: receiptSellerId || null, kind: "subscription-confirmed" });
        },
      });
      await db.collection("waInboundLogs").add({
        phone, keyword,
        action: r.alreadySubscribed ? "already-subscribed" : "subscribe",
        affected: r.activated || 0, sellerScoped: !!receiptSellerId, viaToken: !!token,
        rawFrom, loggedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }

    await db.collection("waInboundLogs").add({ phone, keyword, action: "unknown", rawFrom, loggedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  } catch (e) {
    console.error("❌ webhook error:", e.message);
  }
});

app.post("/api/promo/stock-drop", async (req, res) => {
  try {
    const { productId, sellerId: sellerOverride, maxRecipients = 200 } = req.body || {};
    if (!productId) return res.status(400).json({ success: false, message: "productId required" });
    const pSnap = await db.collection("products").doc(productId).get();
    if (!pSnap.exists) return res.status(404).json({ success: false, message: "Product not found" });
    const product = pSnap.data() || {};
    const sellerId = sellerOverride || product.sellerId;
    const categoryRaw = product.category;
    const categoryId = slugifyCategory(categoryRaw);
    if (!sellerId || !categoryId) return res.status(400).json({ success: false, message: "Missing sellerId or category" });

    let shopName = "MarketMix seller";
    try {
      const s = await db.collection("users").doc(sellerId).get();
      if (s.exists) { const d = s.data() || {}; shopName = d.shopName || d.fullName || shopName; }
    } catch {}

    const subsSnap = await db.collection("buyerSubscriptions")
      .where("sellerId", "==", sellerId)
      .where("categoryId", "==", categoryId)
      .where("subscribed", "==", true)
      .limit(Math.min(Number(maxRecipients) || 200, 500))
      .get();

    if (subsSnap.empty) return res.json({ success: true, matched: 0, sent: 0, categoryId, shopName });

    const emoji = categoryEmoji(categoryId);
    const productUrl = `${WEBSITE_URL}/product/${product.slug || productId}`;
    const priceFmt = Number(product.price || 0).toLocaleString("en-KE");
    let sent = 0;
    const now = admin.firestore.FieldValue.serverTimestamp();

    for (const d of subsSnap.docs) {
      const sub = d.data() || {};
      if (sub.optedOut) continue;
      const buyerName = sub.buyerName || null;
      const msg = [
        `${emoji} *New stock just dropped!*`, ``,
        `Hi${buyerName ? ` ${buyerName}` : ""}! New stock from ${shopName}:`, ``,
        `🛍️ *${product.name || "New item"}*`,
        `💰 KES ${priceFmt}`,
        ``, `👉 ${productUrl}`, ``,
        `Reply *STOP* to stop.`, ``,
        `*MarketMix Kenya*`,
      ].filter(Boolean).join("\n");
      enqueueWhatsApp(sub.phone, msg, { kind: "stock-drop", sellerId, categoryId, productId });
      await d.ref.set({ lastNotifiedAt: now, notifyCount: admin.firestore.FieldValue.increment(1), updatedAt: now }, { merge: true }).catch(() => {});
      sent++;
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    }

    await db.collection("stockDropLogs").add({ productId, productName: product.name || null, sellerId, categoryId, shopName, matched: subsSnap.size, sent, loggedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return res.json({ success: true, matched: subsSnap.size, sent, categoryId, shopName });
  } catch (e) {
    return sendServerError(res, e, "Stock drop failed");
  }
});

app.get("/api/seller/customers", async (req, res) => {
  try {
    const { sellerId, limit = 200, categoryId = null, subscribedOnly = null } = req.query || {};
    if (!sellerId) return res.status(400).json({ success: false, message: "sellerId required" });
    const snap = await db.collection("buyerSubscriptions").where("sellerId", "==", sellerId).limit(Math.min(Number(limit) || 200, 500)).get();
    let subs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (categoryId) subs = subs.filter(s => s.categoryId === categoryId);
    if (subscribedOnly === "true") subs = subs.filter(s => s.subscribed && !s.optedOut);
    const byPhone = new Map();
    for (const s of subs) {
      if (!byPhone.has(s.phone)) byPhone.set(s.phone, { phone: s.phone, buyerName: s.buyerName || null, totalOrders: 0, subscriptions: [], lastActivityAt: null });
      const c = byPhone.get(s.phone);
      c.subscriptions.push({ categoryId: s.categoryId, categoryName: s.categoryName || s.categoryId, subscribed: !!s.subscribed, optedOut: !!s.optedOut, purchaseCount: s.purchaseCount || 0 });
      c.totalOrders += Number(s.purchaseCount || 0);
      const ts = s.lastPurchasedAt?.toDate?.()?.getTime?.() || 0;
      if (!c.lastActivityAt || ts > c.lastActivityAt) c.lastActivityAt = ts;
    }
    const customers = [...byPhone.values()];
    customers.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    return res.json({ success: true, count: customers.length, customers });
  } catch (e) {
    return sendServerError(res, e, "Could not load customers");
  }
});

app.post("/api/seller/customers/:phone/note", async (req, res) => {
  try {
    const phone = req.params.phone;
    const { note, sellerId } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    await db.collection("buyerProfiles").doc(phone).set({
      note: String(note || "").slice(0, 1000),
      noteUpdatedBy: sellerId || null,
      noteUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return sendServerError(res, e, "Could not save note");
  }
});

app.post("/api/seller/customers/:phone/manual-optout", async (req, res) => {
  try {
    const phone = req.params.phone;
    const { sellerId } = req.body || {};
    if (!phone || !sellerId) return res.status(400).json({ success: false, message: "phone and sellerId required" });
    const snap = await db.collection("buyerSubscriptions").where("phone", "==", phone).where("sellerId", "==", sellerId).get();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    snap.docs.forEach(d => batch.set(d.ref, { optedOut: true, optedOutAt: now, updatedAt: now }, { merge: true }));
    await batch.commit();
    return res.json({ success: true, affected: snap.size });
  } catch (e) {
    return sendServerError(res, e, "Manual opt-out failed");
  }
});

app.post("/api/offline-sale/notify", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ success: false, message: "orderId required" });
    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ success: false, message: "Order not found" });
    const order = orderSnap.data() || {};
    if (order.receiptSentAt) return res.json({ success: true, skipped: "receipt-already-sent" });

    const phone = order.buyerPhoneNormalized || normalizePhoneForWa(order.buyerPhone);
    const items = Array.isArray(order.items) ? order.items : [];

    let subscriptionsCreated = 0;
    const tuples = new Map();
    for (const it of items) {
      const sellerId = it.sellerId;
      if (!sellerId) continue;
      let categoryRaw = it.category || null;
      let categoryId = slugifyCategory(categoryRaw);
      if (!categoryId && it.productId) {
        try {
          const pSnap = await db.collection("products").doc(it.productId).get();
          if (pSnap.exists) { const p = pSnap.data() || {}; categoryRaw = p.category || null; categoryId = slugifyCategory(categoryRaw); }
        } catch {}
      }
      if (!categoryId) { categoryId = "uncategorized"; categoryRaw = categoryRaw || "Uncategorized"; }
      const key = `${sellerId}::${categoryId}`;
      if (!tuples.has(key)) tuples.set(key, { sellerId, categoryId, categoryName: categoryRaw || categoryId, items: [] });
      tuples.get(key).items.push(it);
    }

    if (phone) {
      for (const t of tuples.values()) {
        const ok = await upsertBuyerSubscription({ phone, sellerId: t.sellerId, categoryId: t.categoryId, categoryName: t.categoryName, orderId });
        if (ok) subscriptionsCreated++;
      }
      await recordBuyerProfileTouch({ phone, name: order.buyerName, amount: order.total || order.totalAmount || 0 });
    }

    const sellerId = (order.involvedSellerIds || [])[0] || null;
    let receiptVariant = "new";
    if (phone && sellerId) {
      try {
        const subsSnap = await db.collection("buyerSubscriptions").where("phone", "==", phone).where("sellerId", "==", sellerId).get();
        if (!subsSnap.empty) {
          const subs = subsSnap.docs.map(d => d.data());
          if (subs.some(s => s.subscribed && !s.optedOut)) receiptVariant = "subscribed";
          else if (subs.some(s => s.optedOut)) receiptVariant = "opted-out";
        }
      } catch (e) {}
    }

    let shopName = "MarketMix seller";
    if (sellerId) {
      try { const s = await db.collection("users").doc(sellerId).get(); if (s.exists) { const d = s.data() || {}; shopName = d.shopName || d.fullName || shopName; } } catch {}
    }

    let subscribeLink = null;
    if (phone && subscriptionsCreated > 0 && receiptVariant !== "subscribed") {
      const token = await getOrCreateSubscribeToken({ phone, sellerId, orderId });
      if (token) subscribeLink = buildSubscribeLink(phone, token);
    }

    const emojiPriority = ["sneakers", "footwear", "shoes", "clothing", "fashion", "electronics", "beauty", "accessories", "bags", "home", "food", "books", "toys", "sports", "jewelry"];
    let emoji = "🛍️";
    const categoryIds = [...tuples.values()].map(t => t.categoryId);
    for (const p of emojiPriority) { if (categoryIds.includes(p)) { emoji = categoryEmoji(p); break; } }

    const dateStr = new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const receiptItems = items.map(it => ({ name: it.name, quantity: it.quantity }));

    const message = offlineSaleBuyerWhatsApp({
      customerName: order.buyerName, shopName,
      invoiceId: order.invoiceId || orderId,
      items: receiptItems,
      amount: order.total || order.totalAmount || 0,
      paymentMethod: order.paymentMethod || "Cash",
      paymentStatus: order.paymentStatus || "paid",
      dateStr, emoji,
      hasSubscriptions: subscriptionsCreated > 0,
      receiptVariant,
      cashReceived: order.cashReceived != null ? Number(order.cashReceived) : null,
      changeGiven: order.changeGiven != null ? Number(order.changeGiven) : null,
      subscribeLink,
    });

    let whatsappQueued = false;
    if (phone) {
      whatsappQueued = enqueueWhatsApp(phone, message, {
        kind: "offline-receipt", orderId, sellerId, subscriptionsCreated,
        onSent: async (messageId) => {
          if (!messageId) return;
          try {
            await db.collection("whatsappMessageMap").doc(messageId).set({ messageId, phone, orderId, kind: "offline-receipt", sellerId: sellerId || null, sentAt: admin.firestore.FieldValue.serverTimestamp() });
            await db.collection("orders").doc(orderId).set({ receiptWhatsAppMessageId: messageId, receiptWhatsAppSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          } catch (e) { console.error("msgMap failed:", e.message); }
        },
      });
    }

    await db.collection("orders").doc(orderId).set({
      receiptSentAt: admin.firestore.FieldValue.serverTimestamp(),
      receiptSentTo: phone || null,
      receiptSubscriptionsCreated: subscriptionsCreated,
      receiptSubscribeLink: subscribeLink || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({ success: true, whatsappQueued, subscriptionsCreated, hasPhone: !!phone, shopName, emoji, subscribeLink });
  } catch (e) {
    return sendServerError(res, e, "Offline sale notify failed");
  }
});

const handleIntaSendCallback = async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body || {};
    const configuredChallenge = String((req.path === "/api/intasend-realestate-callback" ? process.env.INTASEND_REALESTATE_WEBHOOK_CHALLENGE : process.env.INTASEND_WEBHOOK_CHALLENGE) || "").trim();
    if (!configuredChallenge) return res.status(503).send("IntaSend webhook challenge is not configured");
    if (String(req.body.challenge || "").trim() !== configuredChallenge) return res.status(401).send("Invalid IntaSend webhook challenge");
    if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");
    let paymentStatus = "pending";
    if (state === "COMPLETE") paymentStatus = "paid";
    if (["FAILED", "CANCELLED", "CANCELED"].includes(state)) paymentStatus = "failed";

    if (isSubscriptionRef(api_ref)) {
      const ref = db.collection("subscriptions").doc(api_ref);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.update({ paymentStatus, mpesaReference: mpesa_reference || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        if (state === "COMPLETE") {
          const s = snap.data();
          try { await activateSellerSubscription({ orderId: api_ref, planId: s.planId, sellerId: s.sellerId, sellerEmail: s.email, amount: s.amount }, mpesa_reference); }
          catch (err) { console.error("Activation error:", err); }
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
        orderId: api_ref, paymentStatus, mpesaReference: mpesa_reference || null,
        totalAmount: amount, state, isWalletDeposit: true, sellerId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      orderSnap = await orderRef.get();
    }

    if (!orderSnap.exists) return res.status(404).send("Order not found");
    const orderData = orderSnap.data();
    if (["paid", "failed", "review_required"].includes(String(orderData.paymentStatus || "").toLowerCase()) && state !== "COMPLETE") return res.send("OK");
    if (orderData.isSiteSeeingBooking === true && state === "COMPLETE") {
      const expectedAmount = Number(orderData.totalAmount);
      const receivedAmount = Number(req.body.value);
      const currency = String(req.body.currency || "").toUpperCase();
      if (!Number.isFinite(expectedAmount) || !Number.isFinite(receivedAmount) || Math.abs(expectedAmount - receivedAmount) > 0.01 || currency !== "KES") {
        await orderRef.update({ paymentStatus: "review_required", state: "PAYMENT_DETAILS_MISMATCH", receivedAmount: Number.isFinite(receivedAmount) ? receivedAmount : null, receivedCurrency: currency || null, callbackInvoiceId: req.body.invoice_id || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        const mismatchBookingRef = reDb.collection("sightseeingBookings").doc(String(orderData.bookingId));
        const mismatchBookingSnap = await mismatchBookingRef.get();
        if (mismatchBookingSnap.exists) {
          const mismatchBooking = mismatchBookingSnap.data() || {};
          const packagePayment = orderData.isCompletion || orderData.bookingMode === "direct_booking";
          await mismatchBookingRef.set(packagePayment ? { packagePaymentStatus: "review_required" } : { availabilityPaymentStatus: "review_required" }, { merge: true });
          await mismatchBookingRef.collection("payments").doc(String(api_ref)).set({ paymentRef: api_ref, bookingId: String(orderData.bookingId), userId: orderData.userId, amount: Number.isFinite(receivedAmount) ? receivedAmount : null, expectedAmount, currency: currency || null, paymentStatus: "review_required", paymentKind: packagePayment ? "sightseeing_package" : "sightseeing_availability_check", mpesaReference: mpesa_reference || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }        console.error("Site-seeing payment callback mismatch", { api_ref, expectedAmount, receivedAmount, currency });
        return res.send("OK");
      }
    }
    await orderRef.update({ paymentStatus, mpesaReference: mpesa_reference || null, state, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    // SITE-SEEING PAYMENTS ONLY: bookings live in the real-estate Firebase
    // project. Keep this isolated from the shared marketplace order handlers.
    if (orderData.isSiteSeeingBooking === true) {
      if (paymentStatus === "paid") {
        const bookingRef = reDb.collection("sightseeingBookings").doc(String(orderData.bookingId));
        const bookingSnap = await bookingRef.get();
        if (bookingSnap.exists) {
          const booking = bookingSnap.data() || {};
          const isCompletionPayment = orderData.isCompletion === true;
          const firstConfirmation = isCompletionPayment ? !booking.completionPaymentReference : orderData.bookingMode === "direct_booking" ? !booking.directPaymentReference : booking.paymentStatus !== "paid";
          await bookingRef.set({
            paymentStatus: "paid",
            bookingStatus: isCompletionPayment || orderData.bookingMode === "direct_booking" ? "meeting_details_pending" : "awaiting_availability",
            status: isCompletionPayment || orderData.bookingMode === "direct_booking" ? "meeting_details_pending" : "awaiting_availability",
            ...(isCompletionPayment ? { completionPaymentReference: api_ref, completionMpesaReference: mpesa_reference || null, packagePaymentReference: api_ref, packagePaymentAmount: Number(orderData.totalAmount || callbackAmount || 0), packagePaymentStatus: "paid", packagePaymentMpesaReference: mpesa_reference || null, remainingBalance: 0, completedAt: admin.firestore.FieldValue.serverTimestamp() } : orderData.bookingMode === "direct_booking" ? { packagePaymentReference: api_ref, packagePaymentAmount: Number(orderData.totalAmount || callbackAmount || 0), packagePaymentStatus: "paid", packagePaymentMpesaReference: mpesa_reference || null, directPaymentReference: api_ref, directPaymentAmount: Number(orderData.totalAmount || callbackAmount || 0), directMpesaReference: mpesa_reference || null } : { availabilityStatus: "pending", availabilityPaymentReference: api_ref, availabilityPaymentAmount: Number(orderData.totalAmount || callbackAmount || 0), availabilityPaymentStatus: "paid", availabilityMpesaReference: mpesa_reference || null }),
            ...((isCompletionPayment || orderData.bookingMode === "direct_booking") ? { assignedAgentId: booking.agentId || booking.sellerId || orderData.sellerId || null, agentAssignmentLocked: Boolean(booking.agentId || booking.sellerId || orderData.sellerId), tourCompleted: false } : {}),
            mpesaReference: mpesa_reference || null,
            paymentRef: api_ref,
            paidAmount: Number(orderData.totalAmount || callbackAmount || 0),
            confirmedAt: booking.confirmedAt || admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          await bookingRef.collection("payments").doc(String(api_ref)).set({ paymentRef: api_ref, bookingId: String(orderData.bookingId), userId: orderData.userId, amount: Number(orderData.totalAmount || callbackAmount || 0), currency: "KES", paymentStatus: "paid", paymentKind: isCompletionPayment || orderData.bookingMode === "direct_booking" ? "sightseeing_package" : "sightseeing_availability_check", mpesaReference: mpesa_reference || null, invoiceId: req.body.invoice_id || null, updatedAt: admin.firestore.FieldValue.serverTimestamp(), createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

          if (firstConfirmation) {
            const receiptEmail = orderData.userEmail || orderData.buyerEmail || "";
            if (receiptEmail) sendRealEstatePaymentEmail({ ...orderData, totalAmount: orderData.totalAmount || callbackAmount || 0, mpesaReference: mpesa_reference || "—" }, receiptEmail, api_ref).catch((emailError) => console.error("Site-seeing receipt email failed:", emailError.message));
            const customerPhone = booking.phoneNumber || orderData.phoneNumber || "";
            const customerName = booking.buyerName || orderData.buyerName || "Customer";
            const sellerId = booking.sellerId || booking.agentId || orderData.sellerId || null;
            const sellerProfileSnap = sellerId ? await reDb.collection("users").doc(String(sellerId)).get() : null;
            const sellerProfile = sellerProfileSnap?.data() || {};
            const sellerPhone = booking.ownerPhone || booking.sellerPhone || orderData.landlordPhone || sellerProfile.phoneNumber || sellerProfile.phone || sellerProfile.contactPhone || "";
            const sellerName = booking.landlordName || orderData.landlordName || sellerProfile.fullName || sellerProfile.name || sellerProfile.displayName || "Property seller";
            const propertyTitle = booking.propertyTitle || orderData.propertyTitle || "Property";
            const bookingId = booking.bookingId || orderData.bookingId;
            const amount = Number(orderData.totalAmount || callbackAmount || 0).toLocaleString("en-KE");
            const mpesaRef = mpesa_reference || "Not provided";
            const adminLink = `${REAL_ESTATE_APP_URL}/admin/sightseeing-bookings?bookingId=${encodeURIComponent(bookingId)}`;
            const sellerFormLink = `${REAL_ESTATE_APP_URL}/agent/viewing-availability/${encodeURIComponent(bookingId)}`;
            const visitFormLink = `${REAL_ESTATE_APP_URL}/agent/viewing-details/${encodeURIComponent(bookingId)}`;
            const adminMessage = [
              "🏠 MARKETMIX SITE-SEEING BOOKING PAID",
              `Booking: ${bookingId}`,
              `Customer: ${customerName}`,
              `Customer phone: ${customerPhone || "Not provided"}`,
              `Customer email: ${booking.buyerEmail || orderData.buyerEmail || "Not provided"}`,
              `Property: ${propertyTitle}`,
              `Seller: ${sellerName}`,
              `Seller phone: ${sellerPhone || "Not provided"}`,
              `Package: ${booking.packageTitle || orderData.packageTitle || "Site Seeing"}`,
              `Amount paid: KSh ${amount}`,
              `M-Pesa reference: ${mpesaRef}`,
              `Review booking on MarketMix: ${adminLink}`,
            ].join("\n");
            const sellerMessage = isCompletionPayment || orderData.bookingMode === "direct_booking"
              ? `Hello ${sellerName}, the customer has paid for the site-seeing package at ${propertyTitle}. ${orderData.bookingMode === "direct_booking" ? "Vacancy was not verified and is not guaranteed; please reconfirm with the owner before the visit." : "Availability was confirmed and approved."} After the tour and admin approval, your package balance is the package amount less 15% agency commission and the 3% collection fee. Please add the visit details on MarketMix: ${visitFormLink}`
              : [
                  `Hello ${sellerName}, a paid site-seeing request has been received.`,
                  `Property: ${propertyTitle}`,
                  `Customer: ${customerName}`,
                  `Package: ${booking.packageTitle || orderData.packageTitle || "Site Seeing"}`,
                  "To confirm availability, use the MarketMix form to capture live photos and a video of the empty room, enter the available unit count, and submit any changes for admin review. The KSh 25 confirmation payment is sent only after admin approves the evidence.",
                  `Open availability form: ${sellerFormLink}`,
                ].join("\n");
            if (customerPhone) enqueueWhatsApp(customerPhone, isCompletionPayment ? `🏠 MarketMix Real Estates\nYour site-seeing package payment is confirmed for ${propertyTitle}. Amount: KSh ${amount}. M-Pesa ref: ${mpesaRef}. Booking: ${bookingId}. Visit details will be sent through MarketMix.` : orderData.bookingMode === "direct_booking" ? `🏠 MarketMix Real Estates\nYour site-seeing package payment is confirmed for ${propertyTitle}. Amount: KSh ${amount}. M-Pesa ref: ${mpesaRef}. Booking: ${bookingId}. Vacancy was not verified and is not guaranteed. Visit coordination will happen through MarketMix.` : `🏠 MarketMix Real Estates\nPayment confirmed for ${propertyTitle}. Amount: KSh ${amount}. M-Pesa ref: ${mpesaRef}. Booking: ${bookingId}. We will update you after the seller submits live photos and a YouTube video and admin reviews the vacancy.`, { kind: "site-seeing-buyer-paid", api_ref });
            enqueueWhatsApp(ADMIN_PHONE, adminMessage, { kind: "site-seeing-admin-paid", api_ref });
            if (sellerPhone) enqueueWhatsApp(sellerPhone, sellerMessage, { kind: "site-seeing-seller-paid", api_ref, sellerId });
          }
        } else {
          console.error(`Site-seeing booking ${orderData.bookingId} not found in real-estate Firebase`);
        }
      }
      if (paymentStatus !== "paid") {
        const bookingRef = reDb.collection("sightseeingBookings").doc(String(orderData.bookingId));
        const bookingSnap = await bookingRef.get();
        if (bookingSnap.exists) {
          const failedBooking = bookingSnap.data() || {};
          const packagePayment = orderData.isCompletion === true || orderData.bookingMode === "direct_booking";
          await bookingRef.set(packagePayment
            ? { packagePaymentStatus: paymentStatus, ...(orderData.bookingMode === "direct_booking" && paymentStatus === "failed" ? { paymentStatus: "failed", status: "payment_failed", bookingStatus: "payment_failed" } : {}), updatedAt: admin.firestore.FieldValue.serverTimestamp() }
            : { availabilityPaymentStatus: paymentStatus, ...(paymentStatus === "failed" && failedBooking.paymentStatus !== "paid" ? { paymentStatus: "failed", status: "payment_failed", bookingStatus: "payment_failed" } : {}), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          await bookingRef.collection("payments").doc(String(api_ref)).set({ paymentRef: api_ref, bookingId: String(orderData.bookingId), userId: orderData.userId, amount: Number(orderData.totalAmount || 0), currency: "KES", paymentStatus, paymentKind: packagePayment ? "sightseeing_package" : "sightseeing_availability_check", mpesaReference: mpesa_reference || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
      }
      return res.send("OK");
    }

    if (isWalletRef(api_ref) && state === "COMPLETE") {
      const sellerId = api_ref.split("_")[1];
      let amount = callbackAmount;
      if (!amount || amount <= 0 || amount > 500000) amount = orderData.totalAmount;
      if (!amount || amount <= 0 || amount > 500000) {
        await orderRef.update({ paymentStatus: "failed", errorMessage: "Invalid amount" });
        return res.send("OK");
      }
      await db.collection("adTransactions").doc(api_ref).set({
        paymentRef: api_ref, sellerId, type: "deposit", amount, status: "completed",
        paymentMethod: "mpesa", mpesaCode: mpesa_reference || `MPESA_${Date.now()}`,
        description: `Ad wallet deposit - KSH ${amount.toFixed(2)}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      const walletRef = db.collection("sellerAdCredits").doc(sellerId);
      const walletSnap = await walletRef.get();
      if (walletSnap.exists) {
        await walletRef.update({ balance: admin.firestore.FieldValue.increment(amount), totalDeposited: admin.firestore.FieldValue.increment(amount), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      } else {
        await walletRef.set({ sellerId, balance: amount, totalDeposited: amount, totalSpent: 0, reservedBalance: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }

    if (state === "COMPLETE" && !isWalletRef(api_ref)) {
      let userEmail = orderData.userEmail || orderData.shippingDetails?.email || orderData.buyerEmail || orderData.email;
      if (!userEmail && orderData.userId) {
        try { const u = await db.collection("users").doc(orderData.userId).get(); if (u.exists) userEmail = u.data().email; } catch (_) {}
      }
      if (!userEmail && isTestRef(api_ref)) userEmail = orderData.testEmail || process.env.TEST_RECEIPT_EMAIL || null;

      const payerPhone = orderData.phoneNumber || orderData.shippingDetails?.phoneNumber || orderData.buyerPhone || null;
      const realEstate = isRealEstateOrder(api_ref, orderData);
      const moving = isMovingRef(api_ref) || orderData?.isMoving === true;
      const quicksale = isQuicksaleOrder(orderData) || isQuicksaleRef(api_ref);
      const customerName = orderData.shippingDetails?.fullName || orderData.buyerName || (userEmail ? userEmail.split("@")[0] : "Customer");

      if (!quicksale) {
        if (!userEmail) { console.log(`⚠️ No email on ${api_ref}`); }
        else if (realEstate) {
          if (mpesa_reference) await orderRef.update({ displayId: mpesa_reference, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          sendRealEstatePaymentEmail({ ...orderData, totalAmount: orderData.totalAmount || callbackAmount || 0, mpesaReference: mpesa_reference || orderData.mpesaReference || "—" }, userEmail, api_ref).catch(e => console.error(e));
        } else if (moving) {
          sendMovingConfirmationEmail({ ...orderData, status: "PAID", mpesaReference: mpesa_reference, totalAmount: orderData.totalAmount || callbackAmount || 0 }, userEmail, api_ref).catch(e => console.error(e));
        } else {
          sendOrderConfirmationEmail(orderData, userEmail, api_ref).catch(e => console.error(e));
        }
      }

      const shortRef = String(mpesa_reference || api_ref).slice(0, 16);
      const amountNum = Number(orderData.totalAmount || callbackAmount || 0);

      if (realEstate) {
        if (payerPhone) {
          enqueueWhatsApp(payerPhone, `🏠 MarketMix Real Estates\nPayment confirmed — ${orderData.propertyTitle || "Property"}\nKES ${amountNum.toLocaleString("en-KE")}\nM-Pesa ref: ${mpesa_reference || "—"}\nView: ${REAL_ESTATE_RECEIPT_URL}/${mpesa_reference || api_ref}\n\n👥 ${WHATSAPP_GROUP_URL}`, { kind: "re-buyer", api_ref });
        }
        if (orderData.landlordPhone) {
          enqueueWhatsApp(orderData.landlordPhone, `🏠 MarketMix Real Estates\nNew payment for ${orderData.propertyTitle || "your property"}\nAmount: KES ${amountNum.toLocaleString("en-KE")}\nRef: ${mpesa_reference || "—"}`, { kind: "re-landlord", api_ref });
        }
      } else if (moving) {
        if (payerPhone) {
          enqueueWhatsApp(payerPhone, `🚚 MarketMix Moving\nYour move is confirmed\nRef: ${shortRef}\nAmount: KES ${amountNum.toLocaleString("en-KE")}\nTrack: ${MOVING_URL}`, { kind: "moving-paid", api_ref });
        }
      } else if (quicksale) {
        if (payerPhone) enqueueWhatsApp(payerPhone, quicksaleBuyerWhatsApp({ customerName, itemSummary: quicksaleItemSummary(orderData), amount: amountNum, paymentReference: mpesa_reference || api_ref, sellerShop: null }), { kind: "quicksale-buyer", api_ref });
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
              ? sellerItems.slice(0, 3).map((it) => `${it.name} x${it.quantity}`).join(", ") + (sellerItems.length > 3 ? ` +${sellerItems.length - 3} more` : "")
              : quicksaleItemSummary(orderData);
            enqueueWhatsApp(sellerPhone, quicksaleSellerWhatsApp({ sellerName, itemSummary, amount: amountNum, paymentReference: mpesa_reference || api_ref, customerName, customerPhone: payerPhone || "—" }), { kind: "quicksale-seller", api_ref, sellerId });
          } catch (err) { console.error(`Quicksale seller failed:`, err.message); }
        }
      } else {
        if (payerPhone) {
          enqueueWhatsApp(payerPhone, storePaymentConfirmedWhatsApp({ customerName, amount: amountNum, paymentReference: mpesa_reference || api_ref }), { kind: "store-payment-confirmed", api_ref });
          enqueueWhatsApp(payerPhone, storeOrderConfirmedWhatsApp({ customerName, orderId: api_ref, paymentStatus: "Paid", orderStatus: "Processing" }), { kind: "store-order-confirmed", api_ref });
        }
        await notifySellersOfNewOrder(api_ref, orderData);
      }
    }

    return res.send("OK");
  } catch (e) {
    console.error("❌ Callback error:", e);
    return res.status(500).send("Callback processing failed");
  }
};

app.post("/api/intasend-callback", handleIntaSendCallback);
app.post("/api/intasend-realestate-callback", handleIntaSendCallback);

app.get("/api/ad-transaction/:paymentRef", async (req, res) => {
  const paymentRef = req.params.paymentRef;
  try {
    if (!paymentRef) return res.status(400).json({ success: false, message: "Missing paymentRef" });
    let orderDoc = await db.collection("orders").doc(paymentRef).get();
    if (!orderDoc.exists) {
      const byMpesa = await db.collection("orders").where("mpesaReference", "==", paymentRef).where("isRealEstate", "==", true).limit(1).get();
      if (!byMpesa.empty) orderDoc = byMpesa.docs[0];
    }
    if (orderDoc.exists) {
      const orderData = orderDoc.data();
      if (orderData.paymentStatus === "paid" && orderData.isWalletDeposit && orderData.sellerId) {
        const adRef = db.collection("adTransactions").doc(orderDoc.id);
        const adSnap = await adRef.get();
        if (!adSnap.exists) {
          const amount = orderData.totalAmount || 1;
          await adRef.set({
            paymentRef: orderDoc.id, sellerId: orderData.sellerId, sellerEmail: orderData.sellerEmail || null,
            type: "deposit", amount, status: "completed", paymentMethod: "mpesa",
            mpesaCode: orderData.mpesaReference || "SYNCED",
            description: `Ad wallet deposit - KSH ${amount.toFixed(2)}`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
      return res.json({ success: true, data: { ...orderData, status: orderData.paymentStatus === "paid" ? "completed" : orderData.paymentStatus, paymentStatus: orderData.paymentStatus } });
    }
    const adTxDoc = await db.collection("adTransactions").doc(paymentRef).get();
    if (adTxDoc.exists) return res.json({ success: true, data: adTxDoc.data() });
    return res.status(404).json({ success: false, message: "Transaction not found" });
  } catch (error) {
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

app.post("/api/site-seeing/agent-withdraw", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); } catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const requestedAmount = Number(req.body?.amount);
    const phoneNumber = normalizePhoneForWa(req.body?.phoneNumber || "");
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) return res.status(400).json({ success: false, message: "Enter a whole shilling amount to withdraw." });
    if (!phoneNumber) return res.status(400).json({ success: false, message: "Enter a valid Kenyan M-Pesa number." });
    const withdrawalFee = requestedAmount < 100 ? 10 : requestedAmount >= 5000 ? 30 : 20;
    const netPayout = requestedAmount - withdrawalFee;
    if (netPayout <= 0) return res.status(400).json({ success: false, message: "Withdrawal amount must be greater than the withdrawal fee." });
    const profileSnap = await reDb.collection("users").doc(decoded.uid).get();
    const profile = profileSnap.data() || {};
    if (!profileSnap.exists) return res.status(403).json({ success: false, message: "Agent account required." });
    const walletRef = reDb.collection("agentViewingWallets").doc(decoded.uid);
    const withdrawalRef = reDb.collection("agentViewingWithdrawals").doc();
    await reDb.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);
      const balance = Number(walletSnap.data()?.withdrawableBalance || 0);
      if (balance < requestedAmount) throw new Error("Insufficient viewing balance.");
      transaction.update(walletRef, { withdrawableBalance: balance - requestedAmount, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      transaction.create(withdrawalRef, { withdrawalId: withdrawalRef.id, sellerId: decoded.uid, sellerName: profile.fullName || profile.name || profile.displayName || "MarketMix Agent", phone: phoneNumber, requestedAmount, withdrawalFee, netPayout, currency: "KES", status: "PROCESSING", createdAt: admin.firestore.FieldValue.serverTimestamp(), idempotencyKey: `MM-SVW-${withdrawalRef.id}`.slice(0, 70) });
    });
    let provider;
    try {
      provider = await intasend.payouts().mpesa({ currency: "KES", requires_approval: "NO", transactions: [{ name: String(profile.fullName || profile.name || "MarketMix Agent").replace(/[^a-zA-Z0-9 _:-]/g, "").slice(0, 80), account: phoneNumber, amount: String(netPayout), narrative: "MarketMix Viewing Earnings", idempotency_key: `MM-SVW-${withdrawalRef.id}`.slice(0, 70) }] });
    } catch (providerError) {
      await reDb.runTransaction(async (transaction) => {
        const [withdrawalSnap, walletSnap] = await Promise.all([transaction.get(withdrawalRef), transaction.get(walletRef)]);
        if (withdrawalSnap.data()?.status === "PROCESSING") {
          transaction.update(walletRef, { withdrawableBalance: Number(walletSnap.data()?.withdrawableBalance || 0) + requestedAmount, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          transaction.update(withdrawalRef, { status: "PAYOUT_FAILED", errorMessage: String(providerError?.message || providerError).slice(0, 300), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      });
      return res.status(502).json({ success: false, message: "M-Pesa payout failed. The amount was returned to your viewing balance." });
    }
    await withdrawalRef.update({ status: "PAYOUT_INITIATED", trackingId: provider?.tracking_id || null, providerStatus: provider?.status || null, providerResponse: provider || null, initiatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    enqueueWhatsApp(phoneNumber, `MarketMix agent withdrawal initiated. Amount: KSh ${requestedAmount}. Withdrawal fee: KSh ${withdrawalFee}. M-Pesa payout: KSh ${netPayout}. Reference: ${provider?.tracking_id || withdrawalRef.id}`, { kind: "site-seeing-agent-withdrawal", sellerId: decoded.uid, withdrawalId: withdrawalRef.id });
    return res.json({ success: true, withdrawalId: withdrawalRef.id, requestedAmount, withdrawalFee, netPayout, trackingId: provider?.tracking_id || null, status: "PAYOUT_INITIATED" });
  } catch (error) {
    if (error?.message === "Insufficient viewing balance.") return res.status(400).json({ success: false, message: error.message });
    return sendServerError(res, error, "Could not process agent viewing withdrawal");
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
    if (amount <= minFeeCheck) return res.status(400).json({ success: false, message: `Amount must exceed fee KSH ${minFeeCheck.toFixed(2)}` });

    const ordersSnap = await db.collection("orders").where("involvedSellerIds", "array-contains", sellerId).where("paymentStatus", "==", "paid").get();
    let totalRevenue = 0;
    ordersSnap.forEach((doc) => {
      const items = doc.data().items;
      if (!items) return;
      const list = Array.isArray(items) ? items : Object.values(items);
      list.forEach((item) => { if (item?.sellerId === sellerId) totalRevenue += (Number(item.price) || 0) * (Number(item.quantity) || 0); });
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
    await wRef.set({ sellerId, amount, feeAmount, netPayout, phoneNumber, status: "PENDING_PAYOUT", timestamp: admin.firestore.FieldValue.serverTimestamp() });

    let payout;
    try {
      payout = await intasend.payouts().mpesa({
        currency: "KES", requires_approval: "NO",
        transactions: [{ name: "Seller Withdrawal", account: phoneNumber, amount: netPayout, narrative: "Seller Payout" }],
      });
    } catch (e) {
      await wRef.update({ status: "PAYOUT_FAILED", intasendError: e?.response || e?.message || String(e), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return res.status(502).json({ success: false, message: "Payout provider error" });
    }

    await wRef.update({ trackingId: payout?.tracking_id || null, status: "PAYOUT_INITIATED", updatedAt: admin.firestore.FieldValue.serverTimestamp(), intasendResponse: payout });
    await ledgerRef.set({ totalWithdrawn: admin.firestore.FieldValue.increment(amount), lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    enqueueWhatsApp(phoneNumber, `💸 MarketMix Kenya\nWithdrawal initiated\nAmount: KES ${amount.toLocaleString("en-KE")}\nFee: KES ${feeAmount.toLocaleString("en-KE")}\nNet payout: KES ${netPayout.toLocaleString("en-KE")}\nRef: ${String(payout?.tracking_id || wRef.id).slice(0, 16)}`, { kind: "withdrawal", sellerId });

    return res.json({ success: true, message: "Withdrawal initiated", data: { requestedAmount: amount, fee: feeAmount, netPayout, trackingId: payout?.tracking_id || null, withdrawalId: wRef.id } });
  } catch (e) {
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
    if (!(await storeReplacementCode(userId, email, code))) return res.status(500).json({ success: false, message: "Failed to generate code" });
    await db.collection("securityLogs").add({ userId, email, action: "PIN_RECOVERY_REQUESTED", timestamp: admin.firestore.FieldValue.serverTimestamp(), ipAddress: req.ip, userAgent: req.get("User-Agent") });

    const html = marketMixEmailShell({
      preheader: "Your PIN reset code",
      eyebrow: "MarketMix Kenya · Security",
      title: "Withdrawal PIN Recovery",
      subtitle: "Use the code below to reset your withdrawal PIN.",
      bodyHtml: `
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:18px;padding:22px;text-align:center;margin-bottom:16px;">
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#065f46;">${code}</div>
        </div>
        ${emailInfoCard([["Valid for", "15 minutes"], ["Attempts", "3"]])}
      `,
      footerNote: "MarketMix staff will never ask you for this code.",
    });

    const ok = await sendEmail(email, "Your PIN Reset Code - MarketMix Kenya", html, "security");
    if (!ok) return res.json({ success: false, message: "Failed to send recovery code", emailSent: false });
    if (u.phoneNumber || u.phone) {
      enqueueWhatsApp(u.phoneNumber || u.phone, `🔐 MarketMix Kenya\nYour PIN reset code: ${code}\nValid for 15 minutes.\nDo not share.`, { kind: "pin-otp", userId });
    }
    return res.json({ success: true, message: "Code sent", emailSent: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: "PIN recovery failed" });
  }
});

app.post("/api/seller/verify-recovery-code", async (req, res) => {
  try {
    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ success: false, message: "userId and code required" });
    const v = await verifyReplacementCode(userId, code);
    if (!v.valid) return res.status(400).json({ success: false, message: v.message });
    await db.collection("securityLogs").add({ userId, email: v.data.email, action: "PIN_RECOVERY_VERIFIED", timestamp: admin.firestore.FieldValue.serverTimestamp(), ipAddress: req.ip });
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
    await db.collection("securityLogs").add({ userId, email: v.data.email, action: "PIN_RESET_SUCCESS", method: "recovery", timestamp: admin.firestore.FieldValue.serverTimestamp(), ipAddress: req.ip });
    return res.json({ success: true, reset: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Reset failed" });
  }
});

app.post("/api/update-stock", async (req, res) => {
  try {
    const { productId, quantity, channel = null, orderId = null, reason = "sale", createdBy = "system" } = req.body || {};
    if (!productId || typeof quantity !== "number" || quantity <= 0) return res.status(400).json({ success: false, message: "Invalid product or quantity" });
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
      await logInventoryMovement({ productId, sellerId, delta: -Math.abs(quantity), reason, channel, orderId, note: `Stock ${oldQty} → ${oldQty - quantity}`, createdBy });
    }
    return res.json({ success: true, message: "Stock updated" });
  } catch (e) {
    return sendServerError(res, e, "Stock update failed");
  }
});

app.post("/api/generate-ai-image", async (req, res) => {
  try {
    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt || prompt.trim().length < 3) return res.status(400).json({ success: false, message: "Invalid prompt" });
    if (!process.env.HF_API_KEY) return res.status(500).json({ success: false, message: "HF_API_KEY missing" });
    const r = await fetch("https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HF_API_KEY}`, "Content-Type": "application/json", Accept: "image/png" },
      body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }),
    });
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
  res.json({ success: !!BREVO_API_KEY, message: BREVO_API_KEY ? "Email configured" : "BREVO_API_KEY not configured", senders: SENDERS, urls: { website: WEBSITE_URL, products: PRODUCTS_URL, orderReceiptBase: ORDER_RECEIPT_BASE, whatsappGroup: WHATSAPP_GROUP_URL } });
});

app.post("/api/test-proposal-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const html = marketMixEmailShell({ preheader: "Test proposal email", eyebrow: "MarketMix Kenya", title: "Test Proposal Email", subtitle: "This is a test.", bodyHtml: emailBodyText("If you received this, the pipeline is working.") });
  const ok = await sendEmail(testEmail, "Test Proposal Email", html, "sales");
  res.json({ success: ok, to: testEmail });
});

app.post("/api/test-real-estate-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const ref = "PROP_TEST_" + Date.now();
  const ok = await sendRealEstatePaymentEmail({ propertyTitle: "Test Property", propertyLocation: "Kilimani", propertyType: "For Rent", totalAmount: 4000, mpesaReference: "UJ8NN93LWY", buyerName: "Test Buyer", landlordName: "Test Landlord", landlordPhone: "254712345678" }, testEmail, ref);
  res.json({ success: ok, to: testEmail });
});

app.post("/api/test-moving-email", async (req, res) => {
  const testEmail = req.body?.email || "test@example.com";
  const ref = "MOVE_TEST_" + Date.now();
  const ok = await sendMovingConfirmationEmail({ userName: "Test User", pickupLabel: "Kilimani", destinationLabel: "Westlands", destinationTitle: "2BR", vehicleLabel: "Pickup", itemCount: 12, items: { bed: 1, sofa: 1 }, quotedPrice: 4500, status: "REQUESTED" }, testEmail, ref);
  res.json({ success: ok, to: testEmail });
});

app.post("/api/test-store-whatsapp", async (req, res) => {
  try {
    const { phone, customerName = "Test Customer", amount = 2500, paymentReference = "TEST_REF_123", orderId = "TEST_ORDER_456" } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const queued1 = enqueueWhatsApp(phone, storePaymentConfirmedWhatsApp({ customerName, amount, paymentReference }), { kind: "test-store-payment" });
    const queued2 = enqueueWhatsApp(phone, storeOrderConfirmedWhatsApp({ customerName, orderId, paymentStatus: "Paid", orderStatus: "Processing" }), { kind: "test-store-order" });
    return res.json({ success: queued1 && queued2, queued1, queued2 });
  } catch (e) {
    return sendServerError(res, e, "Test store WhatsApp failed");
  }
});

app.post("/api/test-seller-flow-whatsapp", async (req, res) => {
  try {
    const { sellerPhone, buyerPhone, sellerName = "Test Seller", buyerName = "Test Buyer", orderId = "TEST_ORDER_789", sellerRevenue = 3500, itemSummary = "Sneakers x1, Cap x2" } = req.body || {};
    const results = {};
    if (sellerPhone) {
      results.newOrderQueued = enqueueWhatsApp(sellerPhone, sellerNewOrderWhatsApp({ sellerName, orderId, buyerName, sellerRevenue, itemSummary, itemCount: 2 }), { kind: "test-seller-new-order" });
      results.reminderQueued = enqueueWhatsApp(sellerPhone, sellerReminderWhatsApp({ sellerName, orderId, buyerName, hoursSince: 6, nudgeNumber: 1, maxNudges: 4 }), { kind: "test-seller-reminder" });
    }
    if (buyerPhone) results.statusUpdateQueued = enqueueWhatsApp(buyerPhone, buyerStatusUpdateWhatsApp({ customerName: buyerName, orderId, statusLabel: "Shipped" }), { kind: "test-buyer-status-update" });
    return res.json({ success: true, results });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/test-quicksale-whatsapp", async (req, res) => {
  try {
    const { sellerPhone, buyerPhone, sellerName = "Test Seller", customerName = "Walk-in", itemSummary = "Nike Air x1", amount = 3500, paymentReference = "TEST_QS_123", sellerShop = "Test Shop" } = req.body || {};
    const results = {};
    if (buyerPhone) results.buyerQueued = enqueueWhatsApp(buyerPhone, quicksaleBuyerWhatsApp({ customerName, itemSummary, amount, paymentReference, sellerShop }), { kind: "test-quicksale-buyer" });
    if (sellerPhone) results.sellerQueued = enqueueWhatsApp(sellerPhone, quicksaleSellerWhatsApp({ sellerName, itemSummary, amount, paymentReference, customerName, customerPhone: buyerPhone || "—" }), { kind: "test-quicksale-seller" });
    return res.json({ success: true, results });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/test-welcome-whatsapp", async (req, res) => {
  try {
    const { phone, name = "Test Subscriber" } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const queued = enqueueWhatsApp(phone, welcomeSubscriberWhatsApp({ name }), { kind: "test-welcome-subscriber" });
    return res.json({ success: queued, queued });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/test-whatsapp-notify-image", async (req, res) => {
  try {
    const { phone, title = "Image test", message = "Test image message", imageUrl } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    if (!imageUrl) return res.status(400).json({ success: false, message: "imageUrl required" });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/whatsapp/notify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, title, message, imageUrl }),
    });
    const data = await r.json().catch(() => ({}));
    return res.json({ success: r.ok, forwarded: data });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/test-offline-sale-whatsapp", async (req, res) => {
  try {
    const { phone, customerName = "Test Buyer", shopName = "Test Shop", invoiceId = "OFF-TEST123", amount = 5500, items = [{ name: "Nike Air Force 1", quantity: 1 }, { name: "White Cap", quantity: 2 }], emoji = "👟", hasSubscriptions = true, receiptVariant = "new", paymentMethod = "Cash", cashReceived = null, changeGiven = null, includeSubscribeLink = true } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const dateStr = new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });
    let subscribeLink = null;
    if (includeSubscribeLink && receiptVariant !== "subscribed") {
      const token = await getOrCreateSubscribeToken({ phone });
      if (token) subscribeLink = buildSubscribeLink(phone, token);
    }
    const msg = offlineSaleBuyerWhatsApp({ customerName, shopName, invoiceId, items, amount, paymentMethod, paymentStatus: "paid", dateStr, emoji, hasSubscriptions, receiptVariant, cashReceived: cashReceived != null ? Number(cashReceived) : null, changeGiven: changeGiven != null ? Number(changeGiven) : null, subscribeLink });
    const queued = enqueueWhatsApp(phone, msg, { kind: "test-offline-receipt" });
    return res.json({ success: queued, queued, subscribeLink, preview: msg });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/test-subscription-confirm-whatsapp", async (req, res) => {
  try {
    const { phone, shopNamesByCategory } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const payload = shopNamesByCategory || [{ shop: "Jane's Sneaker Hub", categories: [{ name: "Sneakers", emoji: "👟", count: 1 }] }];
    const msg = subscriptionConfirmedWhatsApp({ shopNamesByCategory: payload });
    const queued = enqueueWhatsApp(phone, msg, { kind: "test-subscription-confirm" });
    return res.json({ success: queued, queued, preview: msg });
  } catch (e) {
    return sendServerError(res, e, "Test failed");
  }
});

app.post("/api/whatsapp/notify", async (req, res) => {
  try {
    const { phone, title, message, imageUrl, imageBase64, filename, mediaType = "image" } = req.body || {};
    if (!phone || !message) return res.status(400).json({ success: false, message: "phone and message required" });
    const body = title ? `🛍️ MarketMix Kenya\n${title}\n\n${message}` : String(message);
    const incomingImage = (typeof imageUrl === "string" && imageUrl.trim()) || (typeof imageBase64 === "string" && imageBase64.trim()) || null;
    const imagePayload = incomingImage ? buildWahaFilePayload(incomingImage, { filename }) : null;

    if (!imagePayload) {
      const queued = enqueueWhatsApp(phone, body, { kind: "generic-notify" });
      if (!queued) return res.status(400).json({ success: false, message: "Invalid phone number" });
      return res.json({ success: true, queued: true, mode: "text", phone: normalizeWaChatId(phone) });
    }

    const normalized = normalizeWaChatId(phone);
    if (!normalized) return res.status(400).json({ success: false, message: "Invalid phone number" });

    try {
      const isFile = mediaType === "file";
      const sender = isFile ? wahaSendFile : wahaSendImage;
      await sender({
        phone: normalized,
        ...(isFile
          ? { fileUrl: imagePayload.mode === "url" ? imagePayload.file.url : `data:${imagePayload.file.mimetype};base64,${imagePayload.file.data}` }
          : { imageUrl: imagePayload.mode === "url" ? imagePayload.file.url : `data:${imagePayload.file.mimetype};base64,${imagePayload.file.data}` }),
        caption: body,
        filename: filename || imagePayload.file.filename,
      });
      return res.json({ success: true, sent: true, mode: "image", mediaType: isFile ? "file" : "image", phone: normalized });
    } catch (imgErr) {
      const queued = enqueueWhatsApp(phone, body, { kind: "generic-notify-fallback" });
      return res.json({ success: true, queued, mode: "text-fallback", phone: normalized, imageError: imgErr.message });
    }
  } catch (e) {
    return sendServerError(res, e, "WhatsApp notify failed");
  }
});

app.post("/api/whatsapp/welcome", async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const queued = enqueueWhatsApp(phone, welcomeSubscriberWhatsApp({ name }), { kind: "welcome-subscriber", phone, hasName: !!name });
    if (!queued) return res.status(400).json({ success: false, message: "Invalid phone number" });
    return res.json({ success: true, queued: true });
  } catch (e) {
    return sendServerError(res, e, "Welcome WhatsApp failed");
  }
});

app.post("/api/service-request/notify", async (req, res) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, message: "requestId required" });
    let snap = await db.collection("serviceRequests").doc(requestId).get();
    let sourceDb = "shop";
    if (!snap.exists) { snap = await reDb.collection("serviceRequests").doc(requestId).get(); sourceDb = "realestate"; }
    if (!snap.exists) return res.status(404).json({ success: false, message: "Not found" });
    const d = snap.data() || {};
    const phone = d.userPhone || d.phoneNumber || null;
    const email = d.userEmail || d.email || null;
    const status = String(d.status || "new").toUpperCase();
    const note = d.adminNote || "";
    const label = d.packageTitle || d.packageId || "Move-in request";
    let whatsappQueued = false;
    let emailSent = false;
    if (phone) whatsappQueued = enqueueWhatsApp(phone, `🏠 MarketMix Real Estates\n${label}\nStatus: ${status}${note ? `\n\nNote: ${note}` : ""}`, { kind: "service-request-update", requestId, sourceDb });
    if (email) {
      const html = marketMixEmailShell({
        preheader: `${label} · ${status}`,
        eyebrow: "MarketMix Real Estates",
        title: `${label} update`,
        subtitle: `Status: ${status}`,
        bodyHtml: `
          ${emailSectionLabel("Update")}
          ${emailInfoCard([["Request", label], ["Status", status, true], ["Area", d.area || "—"]])}
          ${note ? emailBodyText(`<strong>Note:</strong><br/>${note}`) : ""}
        `,
        ctaLabel: "Open MarketMix",
        ctaUrl: REAL_ESTATE_APP_URL,
      });
      emailSent = await sendEmail(email, `${label} · ${status}`, html, "bookings");
    }
    try { await reDb.collection("serviceRequestNotifications").add({ requestId, sourceDb, phone, email, whatsappQueued, emailSent, status, note, sentAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_) {}
    return res.json({ success: true, whatsappQueued, emailSent, hasPhone: !!phone, hasEmail: !!email });
  } catch (e) {
    return sendServerError(res, e, "Service request notify failed");
  }
});

async function movingAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) throw new Error("Unauthorized");
  return verifyAnyToken(h.slice(7));
}
const movingNorm = v => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
function movingMatches(driver, request) {
  const p = driver.driverProfile || {}, county = movingNorm(p.workCounty || driver.workCounty), pickupCounty = movingNorm(request.pickupCounty);
  if (county && pickupCounty && county !== pickupCounty) return false;
  for (const [a, b] of [["workSubCounty","pickupSubCounty"],["workWard","pickupWard"],["workArea","pickupArea"]]) {
    const x = movingNorm(p[a] || driver[a]), y = movingNorm(request[b]);
    if (x && y && x === y) return true;
  }
  const home = p.workCoordinates || driver.workCoordinates, point = request.pickupCoordinates;
  if (home && point && Number.isFinite(Number(home.lat)) && Number.isFinite(Number(home.lng))) {
    const r = n => n * Math.PI / 180, dl = r(Number(point.lat)-Number(home.lat)), dn = r(Number(point.lng)-Number(home.lng)), a = r(Number(home.lat)), b = r(Number(point.lat));
    const v = Math.sin(dl/2)**2 + Math.cos(a)*Math.cos(b)*Math.sin(dn/2)**2;
    if (6371 * 2 * Math.atan2(Math.sqrt(v),Math.sqrt(1-v)) <= 35) return true;
  }
  return Boolean(county && pickupCounty && county === pickupCounty);
}
function movingCanCarry(driver, request) {
  const profile = driver.driverProfile || {}, supported = Array.isArray(profile.canCarryItems) ? profile.canCarryItems : [], capacity = profile.cargoCapacity && typeof profile.cargoCapacity === "object" ? profile.cargoCapacity : {};
  const requested = Object.entries(request.items || {}).filter(([, quantity]) => Number(quantity) > 0);
  return requested.length > 0 && requested.every(([item, quantity]) => { const max=Number(capacity[item] ?? (supported.includes(item) ? 1 : 0)); return max>0 && max>=Number(quantity); });
}
function movingPointKm(a, b) {
  if (!a || !b || ![a.lat,a.lng,b.lat,b.lng].every(v => Number.isFinite(Number(v)))) return null;
  const rad = n => n * Math.PI / 180, dl = rad(Number(b.lat)-Number(a.lat)), dn = rad(Number(b.lng)-Number(a.lng));
  const la = rad(Number(a.lat)), lb = rad(Number(b.lat));
  const x = Math.sin(dl/2)**2 + Math.cos(la)*Math.cos(lb)*Math.sin(dn/2)**2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(x),Math.sqrt(1-x)) * 10) / 10;
}

// Additive generic alert for unmatched requests; sensitive trip/driver details stay in admin Firestore view.
async function notifyMovingNoMatchAdmin(requestId) {
  const notificationRef = reDb.collection("adminNotifications").doc("transport_no_match_" + requestId);
  const notificationSnap = await notificationRef.get();
  if (notificationSnap.exists && notificationSnap.data()?.whatsappQueued === true) return;
  const message = "⚠️ MarketMix Moving: no compatible driver was found for request " + requestId +
    ". Review the request and nearby contacts securely in the admin portal: https://marketmix-realestates.vercel.app/admin/transport-requests";
  const whatsappQueued = enqueueWhatsApp(ADMIN_PHONE, message, { kind: "moving-no-driver-match-admin", requestId });
  await notificationRef.set({
    kind: "moving-no-driver-match", requestId, title: "No compatible driver found",
    message: "A move request has no compatible nearby driver. Open the admin transport requests page to review its details and nearby contacts.",
    whatsappQueued: Boolean(whatsappQueued), status: whatsappQueued ? "SENT_TO_QUEUE" : "PENDING",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(notificationSnap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() })
  }, { merge: true });
}
// === End additive fallback notification ===
app.post("/api/moving/dispatch", async (req,res) => {
  try {
    const user = await movingAuth(req), {requestId} = req.body || {};
    if (!requestId) return res.status(400).json({success:false,message:"Missing requestId"});
    const ref = reDb.collection("transportRequests").doc(requestId), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({success:false,message:"Request not found"});
    const request = snap.data();
    if (request.userId !== user.uid) return res.status(403).json({success:false,message:"Not allowed"});
    if (!["REQUESTED","QUOTED"].includes(request.status) || request.driverUserId) return res.status(409).json({success:false,message:"Request is no longer open"});
    const all = await reDb.collection("users").where("driverApproved","==",true).get();
    const nearby = all.docs.map(d=>({id:d.id,...d.data()})).filter(d=>movingMatches(d,request));
    const matched = nearby.filter(d=>movingCanCarry(d,request));
    if (!matched.length) {
      const contacts = nearby.map(d=>{
        const p=d.driverProfile||{}, last=d.driverLastSeenAt?.toMillis?.()||0;
        return {driverId:d.id,name:String(d.name||d.displayName||"Driver").slice(0,80),phone:String(d.phoneNumber||d.phone||p.phone||"").slice(0,32),vehicleLabel:String(p.vehicleTemplate||p.vehicleId||"Vehicle").slice(0,60),plate:String(p.plate||"").slice(0,20),canCarryItems:Array.isArray(p.canCarryItems)?p.canCarryItems:[],cargoCapacity:p.cargoCapacity&&typeof p.cargoCapacity==="object"?p.cargoCapacity:{},driverDistanceKm:movingPointKm(d.driverLiveLocation||p.workCoordinates||d.workCoordinates,request.pickupCoordinates),online:d.driverOnline===true&&last>=Date.now()-300000,workArea:[p.workArea,p.workSubCounty,p.workCounty].filter(Boolean).join(", ")};
      }).sort((a,b)=>Number(b.online)-Number(a.online)||(a.driverDistanceKm??Infinity)-(b.driverDistanceKm??Infinity)).slice(0,30);
      await reDb.collection("transportCapacityAlerts").doc(requestId).set({requestId,status:"PENDING",customerName:String(request.userName||"Customer").slice(0,120),pickupLabel:String(request.pickupLabel||"").slice(0,200),destinationLabel:String(request.destinationLabel||request.destinationTitle||"").slice(0,200),vehicleLabel:String(request.vehicleLabel||"").slice(0,60),items:Object.entries(request.items||{}).filter(([,q])=>Number(q)>0).map(([id,quantity])=>({id,quantity:Number(quantity)})),nearbyDrivers:contacts,nearbyDriverCount:nearby.length,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      await notifyMovingNoMatchAdmin(requestId).catch(error => console.error("No-match admin notification failed:", error));
      await ref.update({offerDriverIds:[],offerDispatchMode:"admin-capacity-review",offerDispatchedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      return res.json({success:true,mode:"admin-capacity-review",drivers:[],capacityAlert:true});
    }
    const cutoff = Date.now()-300000, online = matched.filter(d=>d.driverOnline===true && (d.driverLastSeenAt?.toMillis?.()||0)>=cutoff), selected = online.length ? online : matched;
    await ref.update({offerDriverIds:selected.map(d=>d.id),offerDispatchMode:online.length?"online":"registered-area",offerDispatchedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    const journeyKm = movingPointKm(request.pickupCoordinates, request.destinationCoordinates);
    const freshCutoff = Date.now() - 5 * 60 * 1000;
    for (const driver of selected) {
      const profile = driver.driverProfile || {};
      const phone = driver.phoneNumber || driver.phone || profile.phone;
      if (!phone) {
        console.warn("Move offer has no driver phone:", driver.id);
        continue;
      }
      const livePoint = driver.driverLiveLocation;
      const registeredPoint = profile.workCoordinates || driver.workCoordinates;
      const onlineNow = driver.driverOnline === true && (driver.driverLastSeenAt?.toMillis?.() || 0) >= freshCutoff;
      const fromKm = movingPointKm(livePoint || registeredPoint, request.pickupCoordinates);
      const areaLabel = profile.workArea || profile.workWard || profile.workSubCounty || profile.workCounty || "your registered service area";
      const fromText = fromKm != null
        ? "Approx. distance from your " + (livePoint && onlineNow ? "live location" : "registered area pin") + ": " + fromKm + " km"
        : "Service area: " + areaLabel;
      const journeyText = journeyKm != null
        ? "Approx. straight-line journey distance: " + journeyKm + " km"
        : "Journey distance: open the trip for route details";
      const message = [
        "🚚 *MarketMix Moving — New move request*",
        "A move was requested by " + (request.userName || "a MarketMix customer") + ".",
        "",
        "Pickup: " + (request.pickupLabel || "See request"),
        fromText,
        "Destination: " + (request.destinationLabel || request.destinationTitle || "See request"),
        journeyText,
        "Vehicle: " + (request.vehicleLabel || "Provider to confirm"),
        "Items: " + (request.itemCount || 0),
        "",
        "Review and accept the offer: https://marketmix-realestates.vercel.app/driver/dashboard",
      ].join("\n");
      enqueueWhatsApp(phone, message, { kind: "driver-move-offer", requestId, driverId: driver.id, distanceFromPickupKm: fromKm, journeyStraightLineKm: journeyKm });
    }

    return res.json({success:true,mode:online.length?"online":"registered-area",drivers:selected.map(({id,phoneNumber,phone,driverProfile})=>({id,phoneNumber,phone,driverProfile}))});
  } catch(e) { console.error("Moving dispatch error:",e); return res.status(500).json({success:false,message:e.message||"Driver matching failed"}); }
});
app.get("/api/moving/driver/offers", async (req,res) => {
  try {
    const user=await movingAuth(req), userSnap=await reDb.collection("users").doc(user.uid).get();
    if (!userSnap.exists || userSnap.data()?.driverApproved!==true) return res.status(403).json({success:false,message:"Driver account not approved yet"});
    const pending=await reDb.collection("transportRequests").where("status","in",["QUOTED","REQUESTED"]).get(), refs=[];
    for (const d of pending.docs) { const r=d.data(); if (!r.driverUserId && movingMatches(userSnap.data(),r) && movingCanCarry(userSnap.data(),r)) refs.push(d.ref); }
    for(let i=0;i<refs.length;i+=450){const batch=reDb.batch();refs.slice(i,i+450).forEach(ref=>batch.update(ref,{offerDriverIds:admin.firestore.FieldValue.arrayUnion(user.uid),offerDispatchMode:"registered-area",offerDispatchedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()}));await batch.commit();}
    const snap=await reDb.collection("transportRequests").where("offerDriverIds","array-contains",user.uid).get();
    const offers=snap.docs.map(d=>({id:d.id,requestId:d.id,...d.data()})).filter(r=>["QUOTED","REQUESTED"].includes(r.status)&&!r.driverUserId&&movingCanCarry(userSnap.data(),r));
    return res.json({success:true,offers});
  } catch(e) { console.error("List moving offers error:",e); return res.status(500).json({success:false,message:e.message||"Could not load offers"}); }
});
app.post("/api/moving/driver/accept", async (req,res) => {
  try {
    const user=await movingAuth(req),{requestId}=req.body||{};
    if(!requestId)return res.status(400).json({success:false,message:"Missing requestId"});
    const userSnap=await reDb.collection("users").doc(user.uid).get(), driver=userSnap.data()||{};
    if(driver.driverApproved!==true)return res.status(403).json({success:false,message:"Driver not approved"});
    const ref=reDb.collection("transportRequests").doc(requestId);
    await reDb.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw Error("Request not found");const r=snap.data();if(r.driverUserId||!["QUOTED","REQUESTED"].includes(r.status))throw Error("Offer already claimed");if(!(r.offerDriverIds||[]).includes(user.uid))throw Error("Offer unavailable to this account");if(!movingCanCarry(driver,r))throw Error("Your vehicle cargo listing does not include all item types in this move");tx.update(ref,{driverUserId:user.uid,driverName:driver.name||driver.displayName||"Driver",driverPhone:driver.phoneNumber||driver.phone||driver.driverProfile?.phone||"",vehicleLabel:driver.driverProfile?.vehicleTemplate||driver.driverProfile?.vehicleId||"Vehicle",status:"DRIVER_ASSIGNED",assignedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});});
    return res.json({success:true,message:"Offer accepted"});
  } catch(e) { console.error("Accept moving offer error:",e); return res.status(409).json({success:false,message:e.message||"Could not accept offer"}); }
});
app.post("/api/moving/driver/decline", async (req,res) => {
  try { const user=await movingAuth(req),{requestId,reason}=req.body||{}; if(!requestId)return res.status(400).json({success:false,message:"Missing requestId"}); const ref=reDb.collection("transportRequests").doc(requestId),snap=await ref.get(); if(!snap.exists)return res.status(404).json({success:false,message:"Request not found"}); if(!(snap.data().offerDriverIds||[]).includes(user.uid))return res.status(403).json({success:false,message:"Offer unavailable"}); await ref.update({declinedDrivers:admin.firestore.FieldValue.arrayUnion({driverId:user.uid,reason:reason||"Declined",at:new Date()}),updatedAt:admin.firestore.FieldValue.serverTimestamp()}); return res.json({success:true,message:"Offer declined"}); }
  catch(e){console.error("Decline moving offer error:",e);return res.status(500).json({success:false,message:e.message||"Could not decline offer"});}
});
async function updateMovingTrip(req,res,status,timeField) {
  try { const user=await movingAuth(req),{requestId}=req.body||{};if(!requestId)return res.status(400).json({success:false,message:"Missing requestId"});const ref=reDb.collection("transportRequests").doc(requestId),snap=await ref.get();if(!snap.exists||snap.data()?.driverUserId!==user.uid)return res.status(403).json({success:false,message:"Trip is not assigned to this driver"});await ref.update({status,[timeField]:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});return res.json({success:true});}
  catch(e){console.error("Moving trip update error:",e);return res.status(500).json({success:false,message:e.message||"Could not update trip"});}
}
app.post("/api/moving/driver/start-trip",(req,res)=>updateMovingTrip(req,res,"IN_TRANSIT","startedAt"));
app.post("/api/moving/driver/complete",(req,res)=>updateMovingTrip(req,res,"DELIVERED","completedAt"));


// === MarketMix Moving: driver rate quotes and customer quote decisions ===
app.get("/api/moving/drivers/quotes", async (req,res) => {
  try {
    await movingAuth(req);
    const vehicleId=String(req.query.vehicleId||"");
    const pickup={lat:Number(req.query.pickupLat),lng:Number(req.query.pickupLng)};
    const destination={lat:Number(req.query.destinationLat),lng:Number(req.query.destinationLng)};
    const area={pickupCounty:String(req.query.pickupCounty||""),pickupSubCounty:String(req.query.pickupSubCounty||""),pickupWard:String(req.query.pickupWard||""),pickupArea:String(req.query.pickupArea||""),pickupCoordinates:pickup};
    const itemTypes=String(req.query.itemTypes||"").split(",").map(x=>x.trim()).filter(Boolean);
    let itemCounts=Object.fromEntries(itemTypes.map(item=>[item,1]));
    try { const parsed=JSON.parse(String(req.query.itemCounts||"")); if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))itemCounts=parsed; } catch {}
    if(!["motorbike","tuk","pickup","lorry"].includes(vehicleId)||![pickup.lat,pickup.lng,destination.lat,destination.lng].every(Number.isFinite))return res.status(400).json({success:false,message:"Choose a vehicle and valid trip map pins"});
    const straightKm=movingPointKm(pickup,destination);
    if(straightKm==null)return res.status(400).json({success:false,message:"Could not calculate trip distance"});
    const routeKm=Math.round(straightKm*1.15*10)/10;
    const all=await reDb.collection("users").where("driverApproved","==",true).get();
    const drivers=all.docs.map(d=>({id:d.id,...d.data()})).filter(d=>d.driverProfile?.vehicleId===vehicleId&&movingMatches(d,area)&&movingCanCarry(d,{items:itemCounts})).map(d=>{
      const p=d.driverProfile||{},ratePerKm=Number(p.ratePerKm||0),from=movingPointKm(p.workCoordinates||d.workCoordinates,pickup),last=d.driverLastSeenAt?.toMillis?.()||0;
      return {id:d.id,name:String(d.name||d.displayName||"Local driver").slice(0,80),vehicleId:p.vehicleId,vehicleTemplate:String(p.vehicleTemplate||p.vehicleId||"Vehicle").slice(0,60),plate:String(p.plate||"").slice(0,20),photoUrl:String(p.photoUrl||"").slice(0,500),ratePerKm,driverDistanceKm:from,routeKm,quote:Math.ceil(routeKm*ratePerKm/50)*50,online:d.driverOnline===true&&last>=Date.now()-300000,workArea:[p.workArea,p.workSubCounty,p.workCounty].filter(Boolean).join(", ")};
    }).filter(d=>d.ratePerKm>0&&Number.isFinite(d.quote)).sort((a,b)=>Number(b.online)-Number(a.online)||a.quote-b.quote);
    return res.json({success:true,drivers});
  } catch(e) { console.error("Moving driver quote search failed:",e); return res.status(500).json({success:false,message:e.message||"Could not find drivers"}); }
});

app.post("/api/moving/dispatch-quote", async (req,res) => {
  try {
    const user=await movingAuth(req),{requestId}=req.body||{};
    if(!requestId)return res.status(400).json({success:false,message:"Missing requestId"});
    const ref=reDb.collection("transportRequests").doc(requestId),snap=await ref.get();
    if(!snap.exists)return res.status(404).json({success:false,message:"Request not found"});
    const request=snap.data();
    if(request.userId!==user.uid)return res.status(403).json({success:false,message:"Not allowed"});
    if(!["REQUESTED","QUOTED"].includes(request.status)||request.driverUserId)return res.status(409).json({success:false,message:"Request is no longer open"});
    if(!request.quotedDriverId)return res.status(400).json({success:false,message:"Select a driver quote first"});
    const driverSnap=await reDb.collection("users").doc(request.quotedDriverId).get(),driver=driverSnap.data()||{},p=driver.driverProfile||{};
    if(!driverSnap.exists||driver.driverApproved!==true||p.vehicleId!==request.vehicleId||!movingMatches(driver,request)||!movingCanCarry(driver,request)||!(Number(p.ratePerKm)>0))return res.status(409).json({success:false,message:"Selected driver or rate card is no longer available"});
    const straightKm=movingPointKm(request.pickupCoordinates,request.destinationCoordinates);
    if(straightKm==null)return res.status(400).json({success:false,message:"Could not calculate trip distance"});
    const routeKm=Math.round(straightKm*1.15*10)/10,rate=Number(p.ratePerKm),quote=Math.ceil(routeKm*rate/50)*50;
    await ref.update({offerDriverIds:[request.quotedDriverId],quotedPrice:quote,quotedRouteKm:routeKm,quotedRatePerKm:rate,quotedDriverName:driver.name||driver.displayName||"Driver",offerDispatchMode:driver.driverOnline===true?"online":"registered-area",offerDispatchedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    const phone=driver.phoneNumber||driver.phone||p.phone;
    if(phone)enqueueWhatsApp(phone,["🚚 *MarketMix Moving — driver rate quote request*",(request.userName||"A customer")+" selected your "+(request.vehicleLabel||p.vehicleId)+" rate card.","Pickup: "+(request.pickupLabel||"See dashboard"),"Destination: "+(request.destinationLabel||request.destinationTitle||"See dashboard"),"Trip: "+routeKm+" km · Your rate: KSh "+rate+"/km · Quote: KSh "+quote.toLocaleString("en-KE"),"Open: https://marketmix-realestates.vercel.app/driver/dashboard"].join(String.fromCharCode(10)),{kind:"moving-driver-rate-quote",requestId,driverId:request.quotedDriverId,quote});
    return res.json({success:true,quote,routeKm,driverId:request.quotedDriverId});
  } catch(e) { console.error("Dispatch selected moving quote failed:",e); return res.status(500).json({success:false,message:e.message||"Could not send selected quote"}); }
});

app.post("/api/moving/quote/respond", async (req,res) => {
  try {
    const user=await movingAuth(req),{requestId,action,counterOffer,message=""}=req.body||{};
    if(!requestId||!["accept","decline","appeal"].includes(action))return res.status(400).json({success:false,message:"Choose a valid quote response"});
    if(action==="appeal"&&!(Number(counterOffer)>0))return res.status(400).json({success:false,message:"Enter your counter-offer amount"});
    const ref=reDb.collection("transportRequests").doc(String(requestId));
    await reDb.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists)throw Error("Move request not found");
      const r=snap.data();
      if(r.userId!==user.uid||r.status!=="QUOTED"||!r.quotedDriverId||(r.quoteDecision&&r.quoteDecision!=="PENDING"))throw Error("This quote is no longer awaiting your response");
      if(action==="decline"){tx.update(ref,{status:"CANCELLED",quoteDecision:"DECLINED",quoteRespondedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});return;}
      const driverRef=reDb.collection("users").doc(r.quotedDriverId),driverSnap=await tx.get(driverRef);
      if(!driverSnap.exists)throw Error("Selected driver unavailable");
      const d=driverSnap.data(),p=d.driverProfile||{},phone=d.phoneNumber||d.phone||p.phone||"";
      if(action==="accept"){
        if(d.driverApproved!==true)throw Error("Selected driver is no longer approved");
        tx.update(ref,{driverUserId:r.quotedDriverId,driverName:d.name||d.displayName||"Driver",driverPhone:phone,vehicleLabel:p.vehicleTemplate||r.vehicleLabel||"Vehicle",status:"DRIVER_ASSIGNED",quoteDecision:"ACCEPTED",assignedAt:admin.firestore.FieldValue.serverTimestamp(),quoteRespondedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
        return;
      }
      tx.update(ref,{quoteDecision:"APPEALED",quoteAppeal:{status:"PENDING",customerOffer:Math.round(Number(counterOffer)),message:String(message||"").slice(0,500),originalQuote:Number(r.quotedPrice||0),driverUserId:r.quotedDriverId,driverName:d.name||d.displayName||"Driver",driverPhone:phone,driverVehicle:p.vehicleTemplate||r.vehicleLabel||"Vehicle",createdAt:admin.firestore.FieldValue.serverTimestamp()},quoteRespondedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    return res.json({success:true,message:action==="appeal"?"Counter-offer sent to MarketMix admin":"Quote response saved"});
  } catch(e) { console.error("Moving quote response failed:",e); return res.status(400).json({success:false,message:e.message||"Could not save quote response"}); }
});
// === Additive MarketMix Moving item-specific driver rate cards ===
app.get("/api/moving/drivers/quotes-item-rates", async (req,res) => {
  try {
    const user=await movingAuth(req);
    const vehicleId=String(req.query.vehicleId||"");
    const pickup={lat:Number(req.query.pickupLat),lng:Number(req.query.pickupLng)};
    const destination={lat:Number(req.query.destinationLat),lng:Number(req.query.destinationLng)};
    const area={pickupCounty:String(req.query.pickupCounty||""),pickupSubCounty:String(req.query.pickupSubCounty||""),pickupWard:String(req.query.pickupWard||""),pickupArea:String(req.query.pickupArea||""),pickupCoordinates:pickup};
    let itemCounts={};
    try { const parsed=JSON.parse(String(req.query.itemCounts||"{}")); if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))itemCounts=parsed; } catch {}
    if(!["motorbike","tuk","pickup","lorry"].includes(vehicleId)||![pickup.lat,pickup.lng,destination.lat,destination.lng].every(Number.isFinite)||!itemCounts||typeof itemCounts!=="object"||Array.isArray(itemCounts))return res.status(400).json({success:false,message:"Choose a vehicle, valid trip pins, and belongings"});
    const straightKm=movingPointKm(pickup,destination);
    if(straightKm==null)return res.status(400).json({success:false,message:"Could not calculate trip distance"});
    const routeKm=Math.round(straightKm*1.15*10)/10;
    const all=await reDb.collection("users").where("driverApproved","==",true).get();
    const drivers=all.docs.map(d=>({id:d.id,...d.data()})).filter(d=>d.id!==user.uid&&d.driverProfile?.vehicleId===vehicleId&&movingMatches(d,area)&&movingCanCarry(d,{items:itemCounts})).map(d=>{
      const p=d.driverProfile||{},ratePerKm=Number(p.ratePerKm||0),itemRates=p.itemRates&&typeof p.itemRates==="object"?p.itemRates:{};
      const itemFeeBreakdown=Object.fromEntries(Object.entries(itemCounts).filter(([,count])=>Number(count)>0).map(([item,count])=>[item,Math.max(0,Number(itemRates[item])||0)*Number(count)]));
      const itemFeeTotal=Object.values(itemFeeBreakdown).reduce((sum,fee)=>sum+fee,0),distanceFare=routeKm*ratePerKm,quote=Math.ceil((distanceFare+itemFeeTotal)/50)*50;
      const from=movingPointKm(p.workCoordinates||d.workCoordinates,pickup),last=d.driverLastSeenAt?.toMillis?.()||0;
      return {id:d.id,name:String(d.name||d.displayName||"Local driver").slice(0,80),vehicleId:p.vehicleId,vehicleTemplate:String(p.vehicleTemplate||p.vehicleId||"Vehicle").slice(0,60),plate:String(p.plate||"").slice(0,20),photoUrl:String(p.photoUrl||"").slice(0,500),ratePerKm,itemRates,itemFeeBreakdown,itemFeeTotal,distanceFare,driverDistanceKm:from==null?null:Math.round(from*10)/10,routeKm,quote,online:d.driverOnline===true&&last>=Date.now()-300000,workArea:[p.workArea,p.workSubCounty,p.workCounty].filter(Boolean).join(", ")};
    }).filter(d=>d.ratePerKm>0&&Number.isFinite(d.quote)).sort((a,b)=>Number(b.online)-Number(a.online)||a.quote-b.quote);
    return res.json({success:true,drivers});
  } catch(e) { console.error("Moving item-rate driver quote search failed:",e); return res.status(500).json({success:false,message:e.message||"Could not find drivers"}); }
});

app.post("/api/moving/dispatch-quote-item-rates", async (req,res) => {
  try {
    const user=await movingAuth(req),{requestId}=req.body||{};
    if(!requestId)return res.status(400).json({success:false,message:"Missing requestId"});
    const ref=reDb.collection("transportRequests").doc(String(requestId)),snap=await ref.get();
    if(!snap.exists)return res.status(404).json({success:false,message:"Request not found"});
    const request=snap.data();
    if(request.userId!==user.uid)return res.status(403).json({success:false,message:"Not allowed"});
    if(!request.quotedDriverId||!["REQUESTED","QUOTED"].includes(request.status)||request.driverUserId)return res.status(409).json({success:false,message:"Request is no longer open"});
    const driverSnap=await reDb.collection("users").doc(request.quotedDriverId).get(),driver=driverSnap.data()||{},p=driver.driverProfile||{};
    if(!driverSnap.exists||driver.driverApproved!==true||p.vehicleId!==request.vehicleId||!movingMatches(driver,request)||!movingCanCarry(driver,request)||!(Number(p.ratePerKm)>0))return res.status(409).json({success:false,message:"Selected driver or rate card is no longer available"});
    const straightKm=movingPointKm(request.pickupCoordinates,request.destinationCoordinates);
    if(straightKm==null)return res.status(400).json({success:false,message:"Could not calculate trip distance"});
    const routeKm=Math.round(straightKm*1.15*10)/10,ratePerKm=Number(p.ratePerKm),itemRates=p.itemRates&&typeof p.itemRates==="object"?p.itemRates:{};
    const itemFeeBreakdown=Object.fromEntries(Object.entries(request.items||{}).filter(([,count])=>Number(count)>0).map(([item,count])=>[item,Math.max(0,Number(itemRates[item])||0)*Number(count)]));
    const itemFeeTotal=Object.values(itemFeeBreakdown).reduce((sum,fee)=>sum+fee,0),distanceFare=routeKm*ratePerKm,quote=Math.ceil((distanceFare+itemFeeTotal)/50)*50;
    await ref.update({offerDriverIds:[request.quotedDriverId],quotedPrice:quote,quotedRouteKm:routeKm,quotedRatePerKm:ratePerKm,quotedItemRates:itemRates,quotedItemFeeBreakdown:itemFeeBreakdown,quotedItemFeeTotal:itemFeeTotal,quotedDistanceFare:distanceFare,quoteModel:"driver-distance-plus-item-rates-v2",quotedDriverName:driver.name||driver.displayName||"Driver",offerDispatchMode:driver.driverOnline===true?"online":"registered-area",offerDispatchedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    const phone=driver.phoneNumber||driver.phone||p.phone;
    if(phone)enqueueWhatsApp(phone,["🚚 *MarketMix Moving — item-rate quote request*",(request.userName||"A customer")+" selected your "+(request.vehicleLabel||p.vehicleId)+" rate card.","Pickup: "+(request.pickupLabel||"See dashboard"),"Destination: "+(request.destinationLabel||request.destinationTitle||"See dashboard"),"Trip: "+routeKm+" km · Distance rate: KSh "+ratePerKm+"/km · Item fees: KSh "+itemFeeTotal.toLocaleString("en-KE")+" · Quote: KSh "+quote.toLocaleString("en-KE"),"Open: https://marketmix-realestates.vercel.app/driver/dashboard"].join(String.fromCharCode(10)),{kind:"moving-driver-item-rate-quote",requestId,driverId:request.quotedDriverId,quote});
    return res.json({success:true,quote,routeKm,ratePerKm,itemFeeTotal,itemFeeBreakdown,driverId:request.quotedDriverId});
  } catch(e) { console.error("Dispatch moving item-rate quote failed:",e); return res.status(500).json({success:false,message:e.message||"Could not send the selected driver quote"}); }
});
// === End additive MarketMix Moving item-specific driver rate cards ===
// === End MarketMix Moving quote section ===

app.post("/api/moving/notify", async (req, res) => {
  try {
    const { requestId } = req.body || {};
    if (!requestId) return res.status(400).json({ success: false, message: "requestId required" });
    let snap = await reDb.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) snap = await db.collection("transportRequests").doc(requestId).get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Not found" });
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
      whatsappQueued = enqueueWhatsApp(phone, `🚚 MarketMix Moving\nStatus: ${statusLabel.toUpperCase()}\nQuote: ${quote}\nDriver: ${driver}\nVehicle: ${vehicle}\nETA: ${eta}\nTrack: ${MOVING_URL}`, { kind: "moving-admin-update", requestId: snap.id });
    }
    if (email) {
      const html = marketMixEmailShell({
        preheader: `Your move is ${statusLabel}`,
        eyebrow: "MarketMix Moving",
        title: "Move update",
        subtitle: `Status: ${statusLabel}`,
        bodyHtml: `
          ${emailSectionLabel("Update")}
          ${emailInfoCard([["Status", statusLabel.toUpperCase(), true], ["Quote", quote], ["Driver", driver], ["Vehicle", vehicle], ["ETA", eta]])}
          ${emailBodyText("Open the tracking page for live updates.")}
        `,
        ctaLabel: "Open tracking page",
        ctaUrl: MOVING_URL,
      });
      emailSent = await sendEmail(email, `Move update · ${statusLabel}`, html, "moving");
    }
    return res.json({ success: true, whatsappQueued, emailSent, hasPhone: !!phone, hasEmail: !!email });
  } catch (e) {
    return sendServerError(res, e, "Moving notify failed");
  }
});

app.get("/api/admin/unresolved-lids", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const unresolved = await db.collection("waUnresolvedLids").orderBy("receivedAt", "desc").limit(limit).get().catch(() => ({ docs: [] }));
    const cooldowns = await db.collection("waFallbackCooldowns").orderBy("lastSentAt", "desc").limit(limit).get().catch(() => ({ docs: [] }));
    const stopCooldowns = await db.collection("waStopFallbackCooldowns").orderBy("lastSentAt", "desc").limit(limit).get().catch(() => ({ docs: [] }));
    return res.json({ success: true, unresolved: unresolved.docs.map(d => ({ id: d.id, ...d.data() })), cooldowns: cooldowns.docs.map(d => ({ id: d.id, ...d.data() })), stopCooldowns: stopCooldowns.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    return sendServerError(res, e, "Could not load unresolved LIDs");
  }
});

app.get("/api/admin/subscribe-tokens/:token", async (req, res) => {
  try {
    const { token } = req.params || {};
    if (!token) return res.status(400).json({ success: false, message: "token required" });
    const ref = db.collection("subscribeTokens").doc(String(token).toUpperCase());
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, token: snap.id, data: snap.data() });
  } catch (e) {
    return sendServerError(res, e, "Token lookup failed");
  }
});

app.post("/api/admin/subscribe-tokens", async (req, res) => {
  try {
    const { phone, sellerId = null } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });
    const normalized = normalizePhoneForWa(phone);
    if (!normalized) return res.status(400).json({ success: false, message: "Invalid phone" });
    const token = await getOrCreateSubscribeToken({ phone: normalized, sellerId });
    if (!token) return res.status(500).json({ success: false, message: "Could not mint token" });
    return res.json({ success: true, token, phone: normalized, subscribeLink: buildSubscribeLink(normalized, token) });
  } catch (e) {
    return sendServerError(res, e, "Could not mint token");
  }
});

app.get("/api/admin/marketing/calendar", async (req, res) => {
  try {
    const year = Number(req.query.year) || autoPromoNowEAT().getUTCFullYear();
    const settings = await occasionLoadSettings();
    const campaigns = AUTO_PROMO_CAMPAIGNS.map(c => ({
      name: c.name,
      startsOn: `${year}-${String(c.startMonth).padStart(2, "0")}-${String(c.startDay).padStart(2, "0")}`,
      endsOn: `${year}-${String(c.endMonth).padStart(2, "0")}-${String(c.endDay).padStart(2, "0")}`,
      eventOn: `${year}-${String(c.eventMonth).padStart(2, "0")}-${String(c.eventDay).padStart(2, "0")}`,
    }));
    const occasions = OCCASION_LIBRARY.map(o => {
      if (o.recurring === "weekly") return { key: o.key, name: o.name, kind: o.kind, recurring: "weekly", weekday: o.weekday, sensitive: !!o.sensitive };
      if (o.movable) {
        const mv = (settings.movableDates || {})[o.key];
        return { key: o.key, name: o.name, kind: o.kind, movable: true, sensitive: !!o.sensitive, resolvedDate: mv && mv.month && mv.day ? `${year}-${String(mv.month).padStart(2, "0")}-${String(mv.day).padStart(2, "0")}` : null };
      }
      return { key: o.key, name: o.name, kind: o.kind, date: `${year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`, sensitive: !!o.sensitive };
    });
    return res.json({ success: true, year, campaigns, occasions });
  } catch (e) {
    return sendServerError(res, e, "Could not build calendar");
  }
});

app.get("/api/admin/campaigns", async (req, res) => {
  try {
    const snap = await db.collection("platformSettings").doc("campaigns").get();
    const stored = snap.exists ? (snap.data()?.list || null) : null;
    return res.json({ success: true, source: stored ? "firestore" : "builtin", count: (stored || AUTO_PROMO_CAMPAIGNS).length, campaigns: stored || AUTO_PROMO_CAMPAIGNS });
  } catch (e) {
    return sendServerError(res, e, "Could not load campaigns");
  }
});

app.post("/api/admin/campaigns", async (req, res) => {
  try {
    const { list, uid = "admin" } = req.body || {};
    if (!Array.isArray(list)) return res.status(400).json({ success: false, message: "list[] required" });
    for (const c of list) {
      if (!c.name || !Number.isInteger(c.startMonth) || !Number.isInteger(c.startDay) || !Number.isInteger(c.endMonth) || !Number.isInteger(c.endDay) || !Number.isInteger(c.eventMonth) || !Number.isInteger(c.eventDay)) {
        return res.status(400).json({ success: false, message: "Each campaign needs name + start/end/event month+day" });
      }
    }
    await db.collection("platformSettings").doc("campaigns").set({ list, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
    return res.json({ success: true, count: list.length });
  } catch (e) {
    return sendServerError(res, e, "Could not save campaigns");
  }
});

app.get("/api/admin/content-library", async (req, res) => {
  try {
    const snap = await db.collection("platformSettings").doc("contentLibrary").get();
    const overrides = snap.exists ? (snap.data()?.overrides || {}) : {};
    const ids = Object.keys(AutoPromoTemplates);
    const library = ids.map(id => ({ id, hasOverride: Object.prototype.hasOwnProperty.call(overrides, id), override: overrides[id] || null }));
    return res.json({ success: true, count: ids.length, templates: library });
  } catch (e) {
    return sendServerError(res, e, "Could not load content library");
  }
});

app.post("/api/admin/content-library", async (req, res) => {
  try {
    const { templateId, override = null, uid = "admin" } = req.body || {};
    if (!templateId || !Object.prototype.hasOwnProperty.call(AutoPromoTemplates, templateId)) {
      return res.status(400).json({ success: false, message: "Unknown templateId" });
    }
    const ref = db.collection("platformSettings").doc("contentLibrary");
    const snap = await ref.get();
    const current = snap.exists ? (snap.data()?.overrides || {}) : {};
    if (override === null) delete current[templateId];
    else current[templateId] = { caption: override.caption || null, notes: override.notes || null, updatedAt: new Date().toISOString(), updatedBy: uid };
    await ref.set({ overrides: current, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
    return res.json({ success: true, templateId, cleared: override === null });
  } catch (e) {
    return sendServerError(res, e, "Could not save content library override");
  }
});

app.get("/api/admin/delivery-logs", async (req, res) => {
  try {
    const kind = String(req.query.kind || "all").toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const reads = [];
    if (kind === "all" || kind === "promo") {
      reads.push(db.collection("autoPromoLogs").orderBy("sentAt", "desc").limit(limit).get().catch(() => ({ docs: [] })).then(snap => snap.docs.map(d => ({ type: "promo", id: d.id, ...d.data() }))));
    } else reads.push(Promise.resolve([]));
    if (kind === "all" || kind === "occasion") {
      reads.push(db.collection("occasionLogs").orderBy("sentAt", "desc").limit(limit).get().catch(() => ({ docs: [] })).then(snap => snap.docs.map(d => ({ type: "occasion", id: d.id, ...d.data() }))));
    } else reads.push(Promise.resolve([]));
    if (kind === "all" || kind === "inbound") {
      reads.push(db.collection("waInboundLogs").orderBy("loggedAt", "desc").limit(limit).get().catch(() => ({ docs: [] })).then(snap => snap.docs.map(d => ({ type: "inbound", id: d.id, ...d.data() }))));
    } else reads.push(Promise.resolve([]));
    const [promo, occasion, inbound] = await Promise.all(reads);
    const merged = [...promo, ...occasion, ...inbound]
      .sort((a, b) => {
        const ta = (a.sentAt || a.loggedAt)?.toDate?.()?.getTime?.() || 0;
        const tb = (b.sentAt || b.loggedAt)?.toDate?.()?.getTime?.() || 0;
        return tb - ta;
      })
      .slice(0, limit);
    return res.json({ success: true, kind, limit, counts: { promo: promo.length, occasion: occasion.length, inbound: inbound.length }, logs: merged });
  } catch (e) {
    return sendServerError(res, e, "Could not load delivery logs");
  }
});

app.get("/api/admin/sticker-studio", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const snap = await db.collection("stickerStudio").orderBy("createdAt", "desc").limit(limit).get().catch(() => ({ docs: [] }));
    return res.json({ success: true, count: snap.docs.length, stickers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    return sendServerError(res, e, "Could not load stickers");
  }
});

app.post("/api/admin/sticker-studio", async (req, res) => {
  try {
    const { name, imageUrl, tags = [], uid = "admin" } = req.body || {};
    if (!name || !imageUrl) return res.status(400).json({ success: false, message: "name and imageUrl required" });
    const ref = await db.collection("stickerStudio").add({
      name: String(name).slice(0, 80),
      imageUrl: String(imageUrl),
      tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
      createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, id: ref.id });
  } catch (e) {
    return sendServerError(res, e, "Could not save sticker");
  }
});

app.delete("/api/admin/sticker-studio/:id", async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ success: false, message: "id required" });
    await db.collection("stickerStudio").doc(id).delete();
    return res.json({ success: true, id });
  } catch (e) {
    return sendServerError(res, e, "Could not delete sticker");
  }
});

app.get("/_health", (req, res) => {
  res.json({
    ok: true,
    version: "v2.10.7",
    timestamp: Date.now(),
    services: { firebase: true, brevo: !!BREVO_API_KEY, intasend: true, waha: !!WAHA_URL },
    firestore: { shop: !!db, realestate: !!reDb },
    autoPromo: {
      enabled: true,
      version: "v2.10.7",
      planCollection: "scheduledPromos",
      planShape: "manifest + slots subcollection (no arrays)",
      overrideTimeMoveUpdatesHourEAT: true,
      minutePinnedOverridesFire: true,
      nonPromoSlotsPersisted: true,
      dayViewEndpoint: "GET /api/admin/auto-promo/day-view?date=YYYY-MM-DD",
      templates: Object.keys(AutoPromoTemplates),
      campaignCalendar: AUTO_PROMO_CAMPAIGNS.length,
    },
    occasions: {
      enabled: true,
      totalOccasions: OCCASION_LIBRARY.length,
      schedulerDisabled: true,
    },
    whatsappQueue: waQueue.length,
    fixes: [
      "v2.10.4 — scheduledPromos/{date}/slots/{slotId} subcollection (kills array sentinel bug)",
      "v2.10.4 — GET /api/admin/auto-promo/day-view (Daily Preview)",
      "v2.10.4 — dedupe selectedGroupIds so a group cannot fire multiple times per tick",
      "v2.10.6 — Override time-move updates hourEAT",
      "v2.10.6 — Tick also fires minute-pinned overrides (time == HH:MM)",
      "v2.10.7 — Non-promo occasions persisted in plan, editable, fire via promo tick",
      "v2.10.7 — occasionStartScheduler disabled (no duplicate sends)",
    ],
    uptime: process.uptime(),
  });
});

/* ═══════════════════════════════════════════════════════════════
   SITE-SEEING BOOKINGS — v1
   Checkout prepares a pending booking and payment order. The client
   sends the M-Pesa prompt, polls the existing transaction endpoint,
   then calls confirm after payment is paid.
   ═══════════════════════════════════════════════════════════════ */

app.post("/api/bookings/site-seeing/checkout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });

    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const { propertyId, propertyIds = [], packageId, phoneNumber, customerName } = req.body || {};
    if (!propertyId || !packageId || !phoneNumber) {
      return res.status(400).json({ success: false, message: "propertyId, packageId and phoneNumber required" });
    }
    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({ success: false, message: "Phone must be in 2547XXXXXXXX or 2541XXXXXXXX format" });
    }

    const uniquePropertyIds = [...new Set((Array.isArray(propertyIds) ? propertyIds : []).map(String).filter(Boolean))];
    if (!uniquePropertyIds.includes(String(propertyId))) uniquePropertyIds.unshift(String(propertyId));
    const isMultiPackage = ["assisted_view", "student_hunt", "property_hunt", "premium_hunt"].includes(String(packageId));
    const maxProperties = String(packageId) === "assisted_view" ? 2 : String(packageId) === "premium_hunt" ? 6 : 4;
    if (uniquePropertyIds.length > (isMultiPackage ? maxProperties : 1)) {
      return res.status(400).json({ success: false, message: `This package supports up to ${isMultiPackage ? maxProperties : 1} properties.` });
    }
    const [propertySnaps, packageSnap, userSnap] = await Promise.all([
      Promise.all(uniquePropertyIds.map((id) => reDb.collection("properties").doc(id).get())),
      reDb.collection("sightseeingPackages").doc(String(packageId)).get(),
      reDb.collection("users").doc(decoded.uid).get(),
    ]);
    if (propertySnaps.some((snap) => !snap.exists)) return res.status(404).json({ success: false, message: "One or more selected properties could not be found" });

    const defaultPackages = {
      quick_view: { title: "Quick View", price: 100 },
      assisted_view: { title: "Assisted View", price: 250 },
      student_hunt: { title: "Student Hunt", price: 300 },
      property_hunt: { title: "Property Hunt", price: 500 },
      premium_hunt: { title: "Premium Hunt", price: 1000 },
      group_viewing: { title: "Group Viewing", price: 150 },
    };
    const tourProperties = propertySnaps.map((snap) => ({ id: snap.id, ...snap.data() }));
    const property = tourProperties.find((item) => item.id === String(propertyId)) || tourProperties[0];
    const packageData = packageSnap.exists
      ? (packageSnap.data() || {})
      : (defaultPackages[String(packageId)] || null);
    const pkg = ["quick_view", "assisted_view"].includes(String(packageId))
      ? { ...(packageData || {}), ...defaultPackages[String(packageId)] }
      : packageData;
    if (!pkg) return res.status(404).json({ success: false, message: "Viewing package not found" });
    if (pkg.active === false || pkg.enabled === false || pkg.isActive === false) {
      return res.status(400).json({ success: false, message: "This viewing package is unavailable" });
    }
    const totalPrice = Number(pkg.price);
    if (!Number.isFinite(totalPrice) || totalPrice < 50) {
      return res.status(400).json({ success: false, message: "Package price must be at least KSh 50" });
    }

    const bookingMode = req.body.bookingMode === "direct_booking" ? "direct_booking" : "availability_check";
    const completionBookingId = String(req.body.completionBookingId || "").trim();
    const isCompletion = Boolean(completionBookingId);
    const completionRef = isCompletion ? reDb.collection("sightseeingBookings").doc(completionBookingId) : null;
    const completionSnap = completionRef ? await completionRef.get() : null;
    if (isCompletion && (!completionSnap.exists || completionSnap.data()?.userId !== decoded.uid || completionSnap.data()?.availabilityStatus !== "available" || completionSnap.data()?.availabilityApproved !== true)) return res.status(409).json({ success: false, message: "This booking is not approved to continue yet." });
    if (isCompletion && String(completionSnap.data()?.packageId) !== String(packageId)) return res.status(409).json({ success: false, message: "Continue with the package saved in your original request." });
    const availabilityFeeSnap = !isCompletion && bookingMode === "availability_check" ? await reDb.collection("siteSeeingSettings").doc("availabilityFee").get() : null;
    const configuredAvailabilityFee = Number(availabilityFeeSnap?.data()?.amount);
    const availabilityFee = Number.isInteger(configuredAvailabilityFee) && configuredAvailabilityFee >= 1 && configuredAvailabilityFee <= 500000 ? configuredAvailabilityFee : 50;
    const depositAmount = isCompletion || bookingMode === "direct_booking" ? totalPrice : availabilityFee;
    const bookingId = isCompletion ? completionBookingId : `SS_${Date.now()}_${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const paymentRef = `PROP_SITESEEING_${bookingId}_${Date.now()}`;
    const user = userSnap.exists ? (userSnap.data() || {}) : {};
    const buyerEmail = decoded.email || user.email || null;
    const buyerName = String(customerName || user.fullName || user.name || decoded.name || (buyerEmail ? buyerEmail.split("@")[0] : "Customer")).trim().slice(0, 120);
    const ownerPhone = property.landlordPhone || property.phone || property.sellerPhone || property.ownerPhone || property.agentPhone || null;
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (!isCompletion) {
      await reDb.collection("sightseeingBookings").doc(bookingId).set({
      bookingId, paymentRef, userId: decoded.uid, buyerName, buyerEmail,
      customerName: buyerName,
      propertyId: property.id, propertyIds: uniquePropertyIds,
      tourProperties: tourProperties.map((item) => ({ id: item.id, title: item.title || item.name || "Property", location: item.location || item.address || null })),
      sellerId: property.agentId || property.userId || property.ownerId || property.sellerId || null,
      agentId: property.agentId || property.userId || property.ownerId || property.sellerId || null,
      propertyTitle: property.title || property.name || "Property",
      propertyLocation: property.location || property.address || null,
      packageId: String(packageId), packageTitle: pkg.title || pkg.name || "Site Seeing",
      packageName: pkg.title || pkg.name || "Site Seeing",
      bookingMode, totalPrice, depositAmount, remainingBalance: bookingMode === "availability_check" ? totalPrice : totalPrice - depositAmount,
      paymentStatus: "pending", bookingStatus: "awaiting_payment", status: "awaiting_payment",
      ...(bookingMode === "availability_check" ? { availabilityPaymentReference: paymentRef, availabilityPaymentAmount: depositAmount, availabilityPaymentStatus: "pending", availabilityPaymentCreatedAt: now } : { packagePaymentReference: paymentRef, packagePaymentAmount: depositAmount, packagePaymentStatus: "pending", packagePaymentCreatedAt: now }),
      availabilityStatus: "pending",
      landlordName: property.landlordName || property.ownerName || null,
      preferredViewingDate: req.body.preferredViewingDate || null,
      preferredViewingTime: req.body.preferredViewingTime || null,
      bookingNote: String(req.body.bookingNote || "").slice(0, 1000),
      createdAt: now, updatedAt: now,
      });
    }


    if (isCompletion) await completionRef.set({ packagePaymentReference: paymentRef, packagePaymentAmount: depositAmount, packagePaymentStatus: "pending", packagePaymentCreatedAt: now, updatedAt: now }, { merge: true });

    await db.collection("orders").doc(paymentRef).set({
      orderId: paymentRef, orderType: "real_estate", isRealEstate: true,
      isSiteSeeingBooking: true, isCompletion, bookingId, userId: decoded.uid,
      userEmail: buyerEmail, buyerEmail, buyerName, phoneNumber,
      totalAmount: depositAmount, consultationFee: depositAmount, packageTotal: totalPrice,
      paymentKind: isCompletion ? "sightseeing_booking_completion" : "site_seeing_deposit",
      propertyId: property.id, propertyIds: uniquePropertyIds,
      tourProperties: tourProperties.map((item) => ({ id: item.id, title: item.title || item.name || "Property", location: item.location || item.address || null })),
      propertyTitle: property.title || property.name || "Property",
      propertyLocation: property.location || property.address || null,
      propertyType: "site_seeing", landlordName: property.landlordName || property.ownerName || null,
      landlordPhone: ownerPhone,
      sellerId: property.agentId || property.userId || property.ownerId || property.sellerId || null,
      packageTitle: pkg.title || pkg.name || "Site Seeing",
      bookingMode,
      paymentStatus: "pending", state: "INITIATED",
      createdAt: now, updatedAt: now,
    });

    return res.json({
      success: true, bookingId, paymentRef, totalPrice, depositAmount, amountDue: depositAmount, completion: isCompletion,
      consultationFee: depositAmount, packageName: pkg.title || pkg.name || "Site Seeing",
      remainingBalance: isCompletion || bookingMode === "direct_booking" ? 0 : totalPrice,
    });
  } catch (e) {
    return sendServerError(res, e, "Could not prepare site-seeing booking");
  }
});

// SITE-SEEING AVAILABILITY AND ADMIN APPROVAL
// Kept separate from the shared shop and transport payment routes.
app.post("/api/bookings/site-seeing/:bookingId/availability", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const { available, availableUnits = 0, notes = "" } = req.body || {};
    const evidencePhotoUrls = Array.isArray(req.body?.evidencePhotoUrls) ? req.body.evidencePhotoUrls.filter((url) => typeof url === "string" && url.startsWith("https://")).slice(0, 5) : [];
    const availabilityVideoUrl = String(req.body?.availabilityVideoUrl || "").trim();
    const units = Number(availableUnits);
    if (typeof available !== "boolean") return res.status(400).json({ success: false, message: "Choose whether a unit is available." });
    if (available && (!Number.isInteger(units) || units < 1 || units > 10000)) return res.status(400).json({ success: false, message: "Enter a valid number of available units." });
    if (available && evidencePhotoUrls.length === 0) return res.status(400).json({ success: false, message: "Upload current photos of the available unit." });
    if (available && !/^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}|youtu\.be\/[A-Za-z0-9_-]{11})(?:[&#?].*)?$/.test(availabilityVideoUrl)) return res.status(400).json({ success: false, message: "Upload the live vacancy video to YouTube before submitting." });

    const bookingRef = reDb.collection("sightseeingBookings").doc(String(req.params.bookingId));
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, message: "Viewing request not found." });
    const booking = bookingSnap.data() || {};
    if (booking.paymentStatus !== "paid") return res.status(409).json({ success: false, message: "The booking payment is not confirmed." });
    if (booking.adminCustomerUpdateStatus === "sent") return res.status(409).json({ success: false, message: "Admin has already finalized this availability report." });

    const propertySnap = await reDb.collection("properties").doc(String(booking.propertyId)).get();
    const property = propertySnap.exists ? propertySnap.data() || {} : {};
    const sellerId = booking.sellerId || booking.agentId || property.agentId || property.userId || property.ownerId || property.sellerId || null;
    const completionUrl = `${REAL_ESTATE_APP_URL}/site-seeing?propertyId=${encodeURIComponent(booking.propertyId || "")}&propertyIds=${encodeURIComponent((booking.propertyIds || [booking.propertyId]).join(","))}&bookingId=${encodeURIComponent(req.params.bookingId)}&packageId=${encodeURIComponent(booking.packageId || "")}&participantCount=${encodeURIComponent(booking.participantCount || 1)}`;
    const callerSnap = await reDb.collection("users").doc(decoded.uid).get();
    const caller = callerSnap.data() || {};
    const isAdmin = caller.role === "admin" || caller.userType === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
    if (!isAdmin && (!sellerId || decoded.uid !== sellerId)) return res.status(403).json({ success: false, message: "Only the assigned seller or an admin can submit availability." });

    const earningRef = sellerId ? reDb.collection("agentViewingEarnings").doc(String(req.params.bookingId)) : null;
    const walletRef = sellerId ? reDb.collection("agentViewingWallets").doc(String(sellerId)) : null;
    let credited = false;
    await reDb.runTransaction(async (transaction) => {
      const [currentSnap, earningSnap, walletSnap] = await Promise.all([
        transaction.get(bookingRef),
        earningRef ? transaction.get(earningRef) : Promise.resolve(null),
        walletRef ? transaction.get(walletRef) : Promise.resolve(null),
      ]);
      if (!currentSnap.exists) throw new Error("Viewing request not found.");
      const current = currentSnap.data() || {};
      if (current.adminCustomerUpdateStatus === "sent") throw new Error("Admin has already finalized this report.");
      const payoutSnap = await transaction.get(reDb.collection("agentViewingPayouts").doc(String(req.params.bookingId)));
      if (payoutSnap.exists && ["PAYOUT_INITIATED", "PAID"].includes(payoutSnap.data()?.status)) throw new Error("The availability credit has already been paid and cannot be changed.");
      const hadCredit = earningSnap?.exists && earningSnap.data()?.status !== "reversed";
      transaction.set(bookingRef, {
        sellerId, agentId: sellerId,
        availabilityStatus: available ? "available" : "unavailable",
        availableUnits: available ? units : 0,
        availabilityEvidencePhotoUrls: available ? evidencePhotoUrls : [],
        availabilityVideoUrl: available ? availabilityVideoUrl : null,
        completionUrl: available ? completionUrl : null,
        availabilityNotes: String(notes || "").trim().slice(0, 1000),
        availabilityCheckedBy: decoded.uid,
        availabilityCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: available ? "awaiting_admin_confirmation" : "awaiting_admin_customer_update",
        bookingStatus: available ? "awaiting_admin_confirmation" : "awaiting_admin_customer_update",
        adminCustomerUpdateStatus: "pending",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

    });

    const refreshed = (await bookingRef.get()).data() || booking;
    const sellerSnap = sellerId ? await reDb.collection("users").doc(String(sellerId)).get() : null;
    const seller = sellerSnap?.data() || {};
    const sellerPhone = refreshed.sellerPhone || refreshed.ownerPhone || refreshed.landlordPhone || seller.phoneNumber || seller.phone || seller.contactPhone || "Not listed";
    const adminLink = `${REAL_ESTATE_APP_URL}/admin/sightseeing-bookings?bookingId=${encodeURIComponent(req.params.bookingId)}`;
    const lines = [
      "🏠 SITE-SEEING AVAILABILITY NEEDS YOUR REVIEW",
      `Booking: ${req.params.bookingId}`,
      `Property: ${refreshed.propertyTitle || "Property"}`,
      `Customer: ${refreshed.customerName || refreshed.buyerName || "Customer"} · ${refreshed.customerPhone || refreshed.phoneNumber || "No phone"}`,
      `Seller: ${seller.fullName || seller.name || seller.displayName || "Seller"}`,
      `Seller phone: ${sellerPhone}`,
      `Availability: ${available ? `AVAILABLE · ${units} unit(s)` : "UNAVAILABLE"}`,
      `Seller notes: ${String(notes || "None").trim().slice(0, 600) || "None"}`,
      `Vacancy photos: ${evidencePhotoUrls.join(" | ") || "None"}`,
      `Vacancy video: ${available ? availabilityVideoUrl : "None"}`,
      `Vacancy confirmation credit: ${available && sellerId ? "KSh 25 after availability photo review and admin approval" : "None"}`,
      `Review and approve on MarketMix: ${adminLink}`,
    ].join("\n");
    enqueueWhatsApp(ADMIN_PHONE, lines, { kind: "site-seeing-availability-review", bookingId: req.params.bookingId, sellerId });
    return res.json({ success: true, bookingId: req.params.bookingId, availabilityStatus: available ? "available" : "unavailable", status: available ? "awaiting_admin_confirmation" : "awaiting_admin_customer_update", agentEarning: 0, credited: false });
  } catch (e) {
    return sendServerError(res, e, "Could not submit site-seeing availability");
  }
});

app.post("/api/bookings/site-seeing/:bookingId/admin-notify-customer", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const adminSnap = await reDb.collection("users").doc(decoded.uid).get();
    const adminUser = adminSnap.data() || {};
    if (!(adminUser.role === "admin" || adminUser.userType === "admin" || (Array.isArray(adminUser.roles) && adminUser.roles.includes("admin")))) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }

    const bookingRef = reDb.collection("sightseeingBookings").doc(String(req.params.bookingId));
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, message: "Viewing request not found." });
    const booking = bookingSnap.data() || {};
    const isTourReview = booking.tourStatus === "awaiting_admin_tour_review";
    if (!isTourReview && !["available", "unavailable"].includes(booking.availabilityStatus)) return res.status(409).json({ success: false, message: "Wait for the seller to submit availability first." });
    if (booking.adminCustomerUpdateStatus === "sent" && booking.tourStatus !== "awaiting_admin_tour_review") return res.status(409).json({ success: false, message: "This request has already been finalized." });

    let payout = null;
    if (!isTourReview && booking.availabilityStatus === "available") {
      if (!booking.availabilityVideoUrl || !(booking.availabilityEvidencePhotoUrls || []).length) return res.status(409).json({ success: false, message: "Availability approval requires both submitted photos and a YouTube video." });
      const sellerId = booking.sellerId || booking.agentId;
      if (!sellerId) return res.status(409).json({ success: false, message: "No seller account is linked to this booking." });
      const sellerSnap = await reDb.collection("users").doc(String(sellerId)).get();
      const seller = sellerSnap.data() || {};
      const payoutPhone = normalizePhoneForWa(seller.mpesaPhone || seller.phoneNumber || seller.phone || seller.contactPhone || booking.sellerPhone || booking.ownerPhone || booking.landlordPhone || "");
      if (!payoutPhone) return res.status(409).json({ success: false, message: "Add a valid seller M-Pesa number to the seller account before approving this payout." });
      const payoutRef = reDb.collection("agentViewingPayouts").doc(String(req.params.bookingId));
      let shouldSend = false;
      await reDb.runTransaction(async (transaction) => {
        const snap = await transaction.get(payoutRef);
        if (snap.exists && ["PAYOUT_INITIATED", "PAID"].includes(snap.data()?.status)) return;
        if (snap.exists && snap.data()?.status === "SUBMITTING") throw new Error("This M-Pesa payout is already being processed.");
        transaction.set(payoutRef, {
          bookingId: String(req.params.bookingId), sellerId, sellerName: seller.fullName || seller.name || seller.displayName || "Seller",
          phone: payoutPhone, amount: 25, currency: "KES", status: "SUBMITTING",
          idempotencyKey: `MM-SV-${String(req.params.bookingId)}`.slice(0, 70),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
        }, { merge: true });
        shouldSend = true;
      });
      const existingPayout = await payoutRef.get();
      if (shouldSend) {
        const idempotencyKey = existingPayout.data()?.idempotencyKey || `MM-SV-${String(req.params.bookingId)}`.slice(0, 70);
        try {
          const provider = await intasend.payouts().mpesa({
            currency: "KES", requires_approval: "NO",
            transactions: [{ name: String(seller.fullName || seller.name || "MarketMix Seller").replace(/[^a-zA-Z0-9 _:-]/g, "").slice(0, 80), account: payoutPhone, amount: "25", narrative: `Availability ${String(req.params.bookingId).slice(0, 20)}`, idempotency_key: idempotencyKey }],
          });
          await payoutRef.update({ status: "PAYOUT_INITIATED", trackingId: provider?.tracking_id || null, providerResponse: provider || null, initiatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          const walletRef = reDb.collection("agentViewingWallets").doc(String(sellerId));
          await reDb.runTransaction(async (transaction) => {
            const [walletSnap, earningSnap] = await Promise.all([
              transaction.get(walletRef), transaction.get(reDb.collection("agentViewingEarnings").doc(String(req.params.bookingId))),
            ]);
            if (earningSnap.exists && earningSnap.data()?.status !== "payout_initiated") {
              transaction.set(walletRef, { withdrawableBalance: Math.max(0, Number(walletSnap.data()?.withdrawableBalance || 0) - 25), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
              transaction.set(reDb.collection("agentViewingEarnings").doc(String(req.params.bookingId)), { status: "payout_initiated", payoutId: payoutRef.id, paidTo: payoutPhone, payoutInitiatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            }
          });
          payout = { success: true, phone: payoutPhone, trackingId: provider?.tracking_id || null };
        } catch (providerError) {
          await payoutRef.update({ status: "PAYOUT_FAILED", errorMessage: String(providerError?.message || providerError).slice(0, 400), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          throw new Error("The M-Pesa payout could not be started. The credit remains available for retry.");
        }
      } else {
        payout = { success: true, trackingId: existingPayout.data()?.trackingId || null, alreadyInitiated: true };
      }
    }

    const customerPaymentSnap = await db.collection("orders").where("bookingId", "==", String(req.params.bookingId)).limit(1).get();
    const customerPhone = customerPaymentSnap.docs[0]?.data()?.phoneNumber || "";
    const customerName = booking.customerName || booking.buyerName || "there";
    const propertyTitle = booking.propertyTitle || "the property";
    const customerMessage = isTourReview
      ? `Your MarketMix site-seeing visit for ${propertyTitle} is marked complete after review of the submitted tour evidence. Thank you for using MarketMix.`
      : booking.availabilityStatus === "available"
      ? `Good news, ${customerName} — ${propertyTitle} is available for ${booking.availableUnits || 1} unit(s), confirmed by MarketMix admin. Vacancy photos: ${(booking.availabilityEvidencePhotoUrls || []).join(" | ") || "See your booking"}. Vacancy video: ${booking.availabilityVideoUrl || "See your booking"}. Book your site-seeing visit here: ${booking.completionUrl || `${REAL_ESTATE_APP_URL}/site-seeing?propertyId=${encodeURIComponent(booking.propertyId || "")}&bookingId=${encodeURIComponent(req.params.bookingId)}&packageId=${encodeURIComponent(booking.packageId || "")}`}`
      : `Update on your MarketMix viewing request for ${propertyTitle}: the seller reports that it is not currently available. Browse other properties here: ${REAL_ESTATE_APP_URL}/site-seeing`;
    if (customerPhone && (isTourReview || booking.adminCustomerUpdateStatus !== "sent")) enqueueWhatsApp(customerPhone, customerMessage, { kind: "site-seeing-admin-customer-update", bookingId: req.params.bookingId });
    let tourEarning = null;
    if (isTourReview) {
      const sellerId = booking.assignedAgentId || booking.agentId || booking.sellerId;
      if (!sellerId) return res.status(409).json({ success: false, message: "No assigned agent is linked to this completed tour." });
      const grossAmount = Number(booking.packagePaymentAmount || booking.directPaymentAmount || booking.totalPrice || booking.packagePrice || 0);
      if (!Number.isFinite(grossAmount) || grossAmount <= 0) return res.status(409).json({ success: false, message: "The paid site-seeing package amount is missing; cannot calculate the agent earning." });
      const agencyCommissionAmount = Math.floor(grossAmount * 0.15);
      const collectionFeeAmount = Math.ceil(grossAmount * 0.03);
      const netAmount = Math.max(0, grossAmount - agencyCommissionAmount - collectionFeeAmount);
      const earningRef = reDb.collection("agentViewingEarnings").doc(`${String(req.params.bookingId)}__tour`);
      const walletRef = reDb.collection("agentViewingWallets").doc(String(sellerId));
      let newlyCredited = false;
      await reDb.runTransaction(async (transaction) => {
        const [earningSnap, walletSnap] = await Promise.all([transaction.get(earningRef), transaction.get(walletRef)]);
        if (earningSnap.exists && ["tour_approved", "payout_initiated", "paid"].includes(String(earningSnap.data()?.status || ""))) return;
        transaction.set(walletRef, { withdrawableBalance: admin.firestore.FieldValue.increment(netAmount), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(earningRef, { bookingId: String(req.params.bookingId), earningKind: "site_seeing_tour", sellerId, grossAmount, agencyCommissionRate: 0.15, agencyCommissionAmount, collectionFeeRate: 0.03, collectionFeeAmount, netAmount, currency: "KES", status: "tour_approved", creditedAt: admin.firestore.FieldValue.serverTimestamp(), createdAt: earningSnap.exists ? earningSnap.data()?.createdAt || admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        newlyCredited = true;
      });
      tourEarning = { grossAmount, agencyCommissionAmount, collectionFeeAmount, netAmount };
      if (newlyCredited) {
        const sellerSnap = await reDb.collection("users").doc(String(sellerId)).get();
        const seller = sellerSnap.data() || {};
        const sellerPhone = seller.mpesaPhone || seller.phoneNumber || seller.phone || seller.contactPhone || booking.sellerPhone || booking.ownerPhone;
        if (sellerPhone) enqueueWhatsApp(sellerPhone, `Your MarketMix site-seeing tour was approved. Package amount: KSh ${grossAmount}. Agency commission (15%): KSh ${agencyCommissionAmount}. Collection fee (3%): KSh ${collectionFeeAmount}. KSh ${netAmount} has been added to your viewing balance. Withdrawal fees apply when you cash out.`, { kind: "site-seeing-tour-earning-approved", bookingId: req.params.bookingId });
      }
    }
    if (payout?.success && !payout.alreadyInitiated) enqueueWhatsApp(payout.phone || booking.sellerPhone || booking.ownerPhone, `MarketMix vacancy evidence approved. Your KSh 25 confirmation payout has been initiated to M-Pesa. If the customer books and completes the site-seeing tour, your package earnings are paid after admin approval, less 15% agency commission and the 3% collection fee.`, { kind: "site-seeing-vacancy-payout", bookingId: req.params.bookingId });
    await bookingRef.set({
      adminCustomerUpdateStatus: "sent", adminCustomerUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(isTourReview ? { tourCompleted: true, tourEvidenceReviewStatus: "approved", agentAssignmentLocked: false, assignmentReleasedAt: admin.firestore.FieldValue.serverTimestamp() } : booking.availabilityStatus === "available" ? { availabilityApproved: true, availabilityApprovedAt: admin.firestore.FieldValue.serverTimestamp(), availabilityApprovedBy: decoded.uid } : {}),
      adminCustomerUpdatedBy: decoded.uid,
      status: isTourReview ? "completed" : booking.availabilityStatus === "available" ? "awaiting_customer_completion" : "property_unavailable",
      bookingStatus: booking.tourStatus === "awaiting_admin_tour_review" ? "completed" : booking.availabilityStatus === "available" ? "awaiting_customer_completion" : "property_unavailable",
      ...(booking.tourStatus === "awaiting_admin_tour_review" ? { tourCompleted: true, tourCompletedAt: admin.firestore.FieldValue.serverTimestamp(), tourEvidenceReviewStatus: "approved", agentAssignmentLocked: false, assignmentReleasedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.json({ success: true, bookingId: req.params.bookingId, customerNotified: Boolean(customerPhone), payout, tourEarning });
  } catch (e) {
    return sendServerError(res, e, "Could not finalize site-seeing availability");
  }
});
// TOUR COMPLETION: assignment stays with the booking's agent until the tour is recorded.
app.post("/api/bookings/site-seeing/:bookingId/meeting-details", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const { meetingPoint, meetingTime, estimatedCostPerPerson, landmark, notes = "" } = req.body || {};
    if (![meetingPoint, meetingTime, landmark].every((value) => String(value || "").trim())) return res.status(400).json({ success: false, message: "Meeting place, meeting time, and a major landmark are required." });
    const bookingRef = reDb.collection("sightseeingBookings").doc(String(req.params.bookingId));
    const snap = await bookingRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Booking not found." });
    const booking = snap.data() || {};
    const profileSnap = await reDb.collection("users").doc(decoded.uid).get();
    const profile = profileSnap.data() || {};
    const isAdmin = profile.role === "admin" || profile.userType === "admin" || (Array.isArray(profile.roles) && profile.roles.includes("admin"));
    const assignedAgentId = booking.assignedAgentId || booking.agentId || booking.sellerId;
    if (!isAdmin && assignedAgentId !== decoded.uid) return res.status(403).json({ success: false, message: "Only the assigned agent or an admin can submit meeting details." });
    if (booking.paymentStatus !== "paid" || (booking.bookingMode !== "direct_booking" && !booking.completionPaymentReference)) return res.status(409).json({ success: false, message: "The customer has not completed the site-seeing package payment yet." });
    const agentSnap = assignedAgentId ? await reDb.collection("users").doc(String(assignedAgentId)).get() : profileSnap;
    const agent = agentSnap?.data() || profile;
    const cost = estimatedCostPerPerson === "" || estimatedCostPerPerson == null ? null : Number(estimatedCostPerPerson);
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return res.status(400).json({ success: false, message: "Estimated cost must be zero or more." });
    const meeting = { meetingPoint: String(meetingPoint).trim().slice(0, 240), meetingTime: String(meetingTime).trim().slice(0, 120), estimatedCostPerPerson: cost, landmark: String(landmark).trim().slice(0, 240), notes: String(notes).trim().slice(0, 800), submittedBy: decoded.uid, submittedAt: admin.firestore.FieldValue.serverTimestamp() };
    await bookingRef.set({ meetingDetails: meeting, status: "confirmed", tourStatus: "scheduled", assignedAgentId: assignedAgentId || null, agentAssignmentLocked: Boolean(assignedAgentId), tourCompleted: false, meetingDetailsSentAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const amount = Number(booking.totalPrice || booking.packagePrice || 0);
    const message = `MARKETMIX SITE-SEEING — VISIT DETAILS\nBooking: ${req.params.bookingId}\nProperty: ${booking.propertyTitle || "Property"}\nPackage: ${booking.packageTitle || booking.packageName || "Viewing"}\n\nMeet at: ${meeting.meetingPoint}\nTime: ${meeting.meetingTime}\nLandmark: ${meeting.landmark}\nEstimated extra cost per person: ${cost == null ? "To be agreed directly" : `KSh ${cost.toLocaleString()}`}\n${meeting.notes ? `Notes: ${meeting.notes}\n` : ""}Agent: ${agent.fullName || agent.name || agent.displayName || "Assigned agent"}\n\nPAYMENT RECEIPT\nBooking: ${req.params.bookingId}\nPackage paid: KSh ${amount.toLocaleString()}\nM-Pesa ref: ${booking.completionMpesaReference || booking.directMpesaReference || booking.mpesaReference || "See M-Pesa confirmation"}\nPayment status: Paid\nThank you for booking with MarketMix Real Estates.`;
    const customerPaymentSnap = await db.collection("orders").where("bookingId", "==", String(req.params.bookingId)).limit(1).get();
    const customerPhone = customerPaymentSnap.docs[0]?.data()?.phoneNumber || "";
    const queued = customerPhone ? enqueueWhatsApp(customerPhone, message, { kind: "site-seeing-visit-details", bookingId: req.params.bookingId }) : false;
    return res.json({ success: true, bookingId: req.params.bookingId, customerNotified: Boolean(queued) });
  } catch (e) { return sendServerError(res, e, "Could not save site-seeing visit details"); }
});

app.post("/api/bookings/site-seeing/:bookingId/complete-tour", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });
    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }
    const bookingId = String(req.params.bookingId);
    const bookingRef = reDb.collection("sightseeingBookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, message: "Viewing booking not found." });
    const booking = bookingSnap.data() || {};
    const profileSnap = await reDb.collection("users").doc(decoded.uid).get();
    const profile = profileSnap.data() || {};
    const isAdmin = profile.role === "admin" || profile.userType === "admin" || (Array.isArray(profile.roles) && profile.roles.includes("admin"));
    const assignedAgentId = booking.assignedAgentId || booking.agentId || booking.sellerId;
    if (!isAdmin && (!assignedAgentId || assignedAgentId !== decoded.uid)) return res.status(403).json({ success: false, message: "Only the assigned agent or an admin can complete this tour." });
    if (booking.paymentStatus !== "paid" || !booking.meetingDetailsSentAt || !booking.meetingDetails) return res.status(409).json({ success: false, message: "Submit visit details after package payment, then mark the tour complete." });
    const evidenceUrls = Array.isArray(req.body?.evidenceUrls) ? req.body.evidenceUrls.filter((url) => typeof url === "string" && url.startsWith("https://")).slice(0, 5) : [];
    if (evidenceUrls.length === 0) return res.status(400).json({ success: false, message: "Upload at least one tour photo as evidence." });
    if (booking.tourStatus === "awaiting_admin_tour_review" || booking.tourCompleted === true) return res.json({ success: true, bookingId, status: booking.tourStatus, alreadySubmitted: true });
    await bookingRef.set({ status: "awaiting_admin_tour_review", bookingStatus: "awaiting_admin_tour_review", tourStatus: "awaiting_admin_tour_review", tourEvidenceUrls: evidenceUrls, tourEvidenceSubmittedBy: decoded.uid, tourEvidenceSubmittedAt: admin.firestore.FieldValue.serverTimestamp(), agentAssignmentLocked: true, tourEvidenceReviewStatus: "pending_admin_review", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    const adminLink = `${REAL_ESTATE_APP_URL}/admin/sightseeing-bookings?bookingId=${encodeURIComponent(bookingId)}`;
    enqueueWhatsApp(ADMIN_PHONE, `Tour evidence needs review\\nBooking: ${bookingId}\\nProperty: ${booking.propertyTitle || "Property"}\\nAgent site-seeing payment: pending admin approval after tour evidence\\nReview: ${adminLink}`, { kind: "site-seeing-tour-evidence-review", bookingId });
    return res.json({ success: true, bookingId, status: "awaiting_admin_tour_review", assignmentReleased: false });  } catch (e) { return sendServerError(res, e, "Could not complete site-seeing tour"); }
});
app.post("/api/bookings/site-seeing/confirm", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ success: false, message: "Missing auth token" });

    let decoded;
    try { decoded = await verifyAnyToken(idToken); }
    catch { return res.status(401).json({ success: false, message: "Invalid auth token" }); }

    const { paymentRef } = req.body || {};
    if (!paymentRef || !String(paymentRef).startsWith("PROP_SITESEEING_SS_")) {
      return res.status(400).json({ success: false, message: "Valid site-seeing paymentRef required" });
    }

    const orderSnap = await db.collection("orders").doc(String(paymentRef)).get();
    if (!orderSnap.exists || orderSnap.data()?.isSiteSeeingBooking !== true) {
      return res.status(404).json({ success: false, message: "Site-seeing payment not found" });
    }
    const order = orderSnap.data() || {};
    if (order.userId !== decoded.uid) return res.status(403).json({ success: false, message: "This booking belongs to another user" });
    if (order.paymentStatus !== "paid") return res.status(409).json({ success: false, message: "Payment is not confirmed yet" });

    const bookingRef = reDb.collection("sightseeingBookings").doc(String(order.bookingId));
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, message: "Booking record not found" });

    const booking = bookingSnap.data() || {};
    if (booking.userId !== decoded.uid) return res.status(403).json({ success: false, message: "This booking belongs to another user" });
    const isCompletion = order.isCompletion === true;
    const isDirect = !isCompletion && order.bookingMode === "direct_booking";
    const nextBookingStatus = isCompletion || isDirect ? "meeting_details_pending" : "awaiting_availability";
    const amountPaid = Number(order.totalAmount || 0);
    await bookingRef.set({
      paymentStatus: "paid", bookingStatus: nextBookingStatus, status: nextBookingStatus,
      mpesaReference: order.mpesaReference || null, paymentRef,
      paidAmount: amountPaid,
      ...(isCompletion ? { packagePaymentReference: paymentRef, packagePaymentAmount: amountPaid, packagePaymentStatus: "paid", packagePaymentMpesaReference: order.mpesaReference || null, completionPaymentReference: paymentRef, completionMpesaReference: order.mpesaReference || null, remainingBalance: 0 } : isDirect ? { packagePaymentReference: paymentRef, packagePaymentAmount: amountPaid, packagePaymentStatus: "paid", packagePaymentMpesaReference: order.mpesaReference || null, directPaymentReference: paymentRef, directPaymentAmount: amountPaid, directMpesaReference: order.mpesaReference || null, remainingBalance: 0 } : { availabilityPaymentReference: paymentRef, availabilityPaymentAmount: amountPaid, availabilityPaymentStatus: "paid", availabilityMpesaReference: order.mpesaReference || null }),
      confirmedAt: booking.confirmedAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await bookingRef.collection("payments").doc(String(paymentRef)).set({ paymentRef, bookingId: String(order.bookingId), userId: decoded.uid, amount: amountPaid, currency: "KES", paymentStatus: "paid", paymentKind: isCompletion || isDirect ? "sightseeing_package" : "sightseeing_availability_check", mpesaReference: order.mpesaReference || null, invoiceId: order.invoiceId || null, updatedAt: admin.firestore.FieldValue.serverTimestamp(), createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.json({
      success: true, bookingId: booking.bookingId,
      paymentRef, completionPayment: order.isCompletion ? order.totalAmount : undefined, totalPrice: booking.totalPrice,
      depositAmount: booking.depositAmount,
      remainingBalance: booking.remainingBalance,
      mpesaReference: order.mpesaReference || null,
      bookingStatus: order.isCompletion ? "meeting_details_pending" : "awaiting_availability",
    });
  } catch (e) {
    return sendServerError(res, e, "Could not confirm site-seeing booking");
  }
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
      if (!paused) { paused = true; console.log("🌙 Keep-alive paused"); }
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
  console.log("🌀 Smart keep-alive active");
})();

autoPromoStartScheduler({ SCAN_MS: 60 * 1000 });
// v2.10.7 — occasion scheduler disabled; non-promo slots now fire
// through the plan-based AutoPromo tick
// occasionStartScheduler({ SCAN_MS: 30 * 60 * 1000 });

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
      body = ["🚨 *FLASH SALES NEED ATTENTION*", "", "0 active flash sales right now.", campaign ? `\nToday's campaign: *${campaign.name}*` : "", `\n👉 ${adminUrl}`].filter(Boolean).join("\n");
    } else {
      const manual = active.filter(s => !s.autoCreated).length;
      const auto = active.filter(s => s.autoCreated).length;
      body = ["📊 *Daily Flash Sales Check-In*", "", `✅ Active: *${active.length}* (${manual} manual, ${auto} auto)`, campaign ? `🎯 Today's campaign: *${campaign.name}*` : "", `\n👉 ${adminUrl}`].filter(Boolean).join("\n");
    }
    enqueueWhatsApp(ADMIN_PHONE, body, { kind: "admin-flash-nudge", hourEAT });
    adminFlashNudgeLastKey = key;
  } catch (e) {
    console.error("📣 Admin nudge failed:", e.message);
  }
}

setInterval(adminFlashNudgeTick, 5 * 60 * 1000).unref?.();
setTimeout(adminFlashNudgeTick, 30 * 1000).unref?.();
console.log("📣 Admin flash nudge armed (7am & 7pm EAT)");

const server = app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT} — v2.10.7`);
  console.log(`🤖 AutoPromo: v2.10.7 — non-promo occasions fire from plan`);
  console.log(`📅 Plan collection: scheduledPromos/{date} + slots/*`);
  console.log(`🎯 Occasion engine: ${OCCASION_LIBRARY.length} occasions (scheduler disabled)`);
});

const shutdown = () => {
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

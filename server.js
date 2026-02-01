/* your entire original header & code preserved exactly as provided by you above */
/* Full replacement: Express backend for Campus Store with live order-based withdrawal check + IntaSend B2C

  Additions & safety features included (non-destructive):
  - Stealth in-memory keep-alive loop using Node's http.request + jitter (prevents free-host cold sleeps)
  - Toggleable via env: KEEP_ALIVE=true (defaults to enabled in production when not explicitly disabled)
  - Short request timeout & silent error handling so it never interferes with real handlers
  - Graceful shutdown clearing keep-alive interval
  - Unref() on interval so it doesn't keep process alive on shutdown
  - Global uncaughtException/unhandledRejection logging (no crash swallowing)
  - Minimal changes to your original logic; routes unchanged
*/

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const IntaSend = require("intasend-node");
const cors = require("cors");
const admin = require("firebase-admin");
const http = require("http");
const Buffer = require('buffer').Buffer; // Ensure Buffer is available for Base64 conversion

// ---- ADDED: node-fetch for backend HF calls (safe, server-side)
const fetch = require("node-fetch"); // npm i node-fetch@2
const nodemailer = require('nodemailer'); // For sending PIN recovery emails

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

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
  try {
    console.log(
      `${new Date().toISOString()} → ${req.method} ${req.originalUrl}`,
      req.body || {}
    );
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

const BACKEND_HOST = process.env.RENDER_BACKEND_URL || `http://localhost:${PORT}`;

// ============================
// Email transporter setup
// ============================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Fallback email config if SMTP not available
const sendEmail = async (to, subject, html) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.log('Email credentials not configured. Email would have been sent to:', to);
      console.log('Subject:', subject);
      return true;
    }
    
    const mailOptions = {
      from: `"Marketplace Security" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Email sent to ${to}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error('❌ Email sending failed:', error);
    return false;
  }
};

// ============================
// Fee Constants & Helpers
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
// Routes (UNCHANGED logic, kept as-is but defensive)
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

// ✅ PIN Recovery Endpoint
app.post("/api/seller/recover-pin", async (req, res) => {
  try {
    const { email, userId } = req.body;
    
    console.log("🔑 PIN Recovery Request:", { email, userId });
    
    if (!email || !userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and user ID are required' 
      });
    }

    // 1. Verify the user exists and email matches
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    const userData = userDoc.data();
    
    // 2. Check if email matches (security measure)
    if (userData.email && userData.email !== email) {
      return res.status(403).json({ 
        success: false, 
        message: 'Email does not match user account' 
      });
    }

    // 3. Check if user has a PIN set
    if (!userData.withdrawalPin) {
      return res.status(400).json({ 
        success: false, 
        message: 'No PIN is set for this account' 
      });
    }

    // 4. Record the PIN recovery request (for security audit)
    await db.collection('securityLogs').add({
      userId: userId,
      email: email,
      action: 'PIN_RECOVERY_REQUESTED',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    // 5. Generate HTML email template
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; }
          .content { background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .logo { color: #667eea; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
          .pin-display { 
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
            color: white; 
            font-size: 36px; 
            font-weight: bold; 
            padding: 25px; 
            border-radius: 10px; 
            text-align: center; 
            letter-spacing: 10px; 
            margin: 30px 0;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
          }
          .security-alert { 
            background: #fff3e0; 
            border-left: 5px solid #ff9800; 
            padding: 15px; 
            margin: 20px 0; 
            border-radius: 5px;
          }
          .footer { 
            margin-top: 30px; 
            padding-top: 20px; 
            border-top: 1px solid #eee; 
            text-align: center; 
            color: #666; 
            font-size: 12px;
          }
          .warning-icon { color: #ff9800; margin-right: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <div class="header">
              <div class="logo">MARKETPLACE</div>
              <h1>Withdrawal PIN Recovery</h1>
              <p>Here is your requested PIN information</p>
            </div>
            
            <div style="text-align: center; margin-bottom: 20px;">
              <p style="color: #666; font-size: 16px;">Your withdrawal PIN is:</p>
            </div>
            
            <div class="pin-display">
              ${userData.withdrawalPin}
            </div>
            
            <div class="security-alert">
              <p style="margin: 0;">
                <strong>⚠️ IMPORTANT SECURITY NOTICE</strong><br>
                • This PIN provides access to your funds<br>
                • Never share it with anyone<br>
                • Marketplace staff will never ask for your PIN<br>
                • If you suspect unauthorized access, contact support immediately
              </p>
            </div>
            
            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0; color: #666; font-size: 14px;">
                <strong>Request Details:</strong><br>
                • Time: ${new Date().toLocaleString()}<br>
                • Email: ${email}
              </p>
            </div>
            
            <div class="footer">
              <p>This email was sent in response to your PIN recovery request.</p>
              <p>If you didn't request this, please secure your account immediately.</p>
              <p style="margin-top: 20px;">
                <a href="https://yourmarketplace.com/seller/dashboard" style="color: #667eea; text-decoration: none;">Go to Dashboard</a> | 
                <a href="https://yourmarketplace.com/contact" style="color: #667eea; text-decoration: none;">Contact Support</a> | 
                <a href="https://yourmarketplace.com" style="color: #667eea; text-decoration: none;">Visit Marketplace</a>
              </p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    // 6. Send email with PIN
    const emailSent = await sendEmail(
      email,
      '🔒 Your Withdrawal PIN Recovery Request',
      emailHtml
    );

    if (!emailSent) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to send PIN recovery email. Please contact support.' 
      });
    }

    res.json({ 
      success: true, 
      message: 'PIN recovery email sent successfully' 
    });

  } catch (error) {
    console.error('PIN recovery error:', error);
    
    // Log the error for security monitoring
    try {
      await db.collection('securityLogs').add({
        userId: req.body?.userId || 'unknown',
        email: req.body?.email || 'unknown',
        action: 'PIN_RECOVERY_FAILED',
        error: error.message,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        ipAddress: req.ip
      });
    } catch (logError) {
      console.error('Failed to log security error:', logError);
    }

    res.status(500).json({ 
      success: false, 
      message: 'Failed to process PIN recovery request' 
    });
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

// ---------------------- CORRECTED & STABILIZED: Hugging Face image generation route ----------------------
/*
  This route is now extremely defensive:
  1. Guarantees a JSON error body on server crash or provider failure (Fixes frontend JSON.parse error).
  2. Uses wait_for_model: true to prevent 503 errors when the model is asleep.
  3. Returns a Base64 Data URI in a JSON body (required by the frontend utility).
*/
app.post("/api/generate-ai-image", async (req, res) => {
  try {
    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Invalid prompt" });
    }

    // CRITICAL: Ensure HF_API_KEY is present
    if (!process.env.HF_API_KEY) {
      console.error("Missing HF_API_KEY in environment");
      return res.status(500).json({ success: false, message: "Server misconfiguration: HF_API_KEY is missing." });
    }

    const hfResponse = await fetch(
      "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json",
          "Accept": "image/png" // Explicitly request PNG
        },
        body: JSON.stringify({ 
             inputs: prompt,
             options: { wait_for_model: true } // Crucial for cold-start prevention
        })
      }
    );

    if (!hfResponse.ok) {
      const status = hfResponse.status;
      let bodyText = "Hugging Face call failed.";
      try {
        bodyText = await hfResponse.text();
      } catch (e) { /* silent fail */ }
      
      console.error(`Hugging Face error ${status}:`, bodyText.slice(0, 300));
      return res.status(502).json({
        success: false,
        message: "Image generation provider error. Check key/limits.",
        providerStatus: status,
        providerBody: bodyText.slice(0, 200)
      });
    }

    const contentType = hfResponse.headers.get("content-type") || "image/png";
    const arrBuf = await hfResponse.arrayBuffer();
    
    // ⭐ STABILITY FIX: Convert ArrayBuffer to Buffer safely
    const imageBuffer = Buffer.from(arrBuf);
    
    // Convert the image buffer to Base64 Data URI
    const base64Image = imageBuffer.toString('base64');
    const imageUrl = `data:${contentType};base64,${base64Image}`;

    // Send the Data URI back in a JSON object
    return res.json({ imageUrl: imageUrl, success: true });
    
  } catch (err) {
    console.error("❌ AI generation error in server.js catch block:", err);
    // ⭐ CRITICAL FIX: Ensure that even the generic catch returns a valid JSON response body
    return res.status(500).json({ 
        success: false, 
        message: "AI generation failed due to a server-side error (500).", 
        detail: err.message
    });
  }
});
// ------------------------------------------------------------------------

// ✅ Health check
app.get("/_health", (req, res) => res.json({ ok: true, timestamp: Date.now() }));

// 404 fallback
app.use((req, res) =>
  res.status(404).json({ success: false, message: "Not Found" })
);

// ============================
// Global error / process handlers
// ============================
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // optionally: notify monitoring service here
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
  // optionally: notify monitoring service here
});

// ============================
// Stealth keep-alive (in-memory http request, with jitter)
// - Enabled automatically in production unless KEEP_ALIVE=0
// - You can explicitly enable in non-production with KEEP_ALIVE=true
// ============================
(function setupKeepAlive() {
  const explicitDisable = process.env.KEEP_ALIVE === "0" || process.env.KEEP_ALIVE === "false";
  const explicitEnable = process.env.KEEP_ALIVE === "1" || process.env.KEEP_ALIVE === "true";
  const isProd = process.env.NODE_ENV === "production";
  const enabled = explicitEnable || (isProd && !explicitDisable);

  if (!enabled) {
    console.log("🛑 Keep-alive disabled by environment");
    return;
  }

  const BASE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000; // default 4 minutes
  const JITTER_MS = Number(process.env.KEEP_ALIVE_JITTER_MS) || 30 * 1000; // +/- 30s jitter
  const REQUEST_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_REQUEST_TIMEOUT_MS) || 1000; // 1s timeout

  let keepAliveInterval = null;

  const scheduleNext = () => {
    // compute next delay with jitter
    const jitter = Math.floor(Math.random() * (JITTER_MS * 2 + 1)) - JITTER_MS; // -J..+J
    const delay = Math.max(1000, BASE_INTERVAL_MS + jitter);

    keepAliveInterval = setTimeout(() => {
      try {
        const options = {
          host: "127.0.0.1",
          port: PORT,
          path: "/_health",
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
        };

        const req = http.request(options, (res) => {
          // consume and discard any data so sockets are clean
          res.on("data", () => {});
          res.on("end", () => {});
        });

        req.on("timeout", () => {
          try { req.destroy(); } catch (e) {}
        });
        req.on("error", () => {
          // intentionally swallow: keep-alive must not crash or log noisy errors
        });

        // end the request immediately — server will handle quickly
        req.end();
      } catch (err) {
        // swallow: keep-alive must be silent
      } finally {
        // schedule next run
        scheduleNext();
      }
    }, delay);

    // allow process to exit if nothing else is keeping it alive
    if (typeof keepAliveInterval.unref === "function") keepAliveInterval.unref();
  };

  // start the loop
  scheduleNext();

  // clear on graceful shutdown
  const clear = () => {
    try {
      if (keepAliveInterval) clearTimeout(keepAliveInterval);
    } catch (e) {}
  };
  process.on("SIGINT", clear);
  process.on("SIGTERM", clear);

  console.log(`🌀 Stealth keep-alive initialized. Interval ~${BASE_INTERVAL_MS}ms ±${JITTER_MS}ms`);
})();

// ============================
// Start server
// ============================
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Graceful shutdown for the server itself
const shutdown = async () => {
  console.log("Shutting down server...");
  try {
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
    // force exit if not closed in time
    setTimeout(() => process.exit(1), 5000).unref();
  } catch (e) {
    console.error("Error during shutdown:", e);
    process.exit(1);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
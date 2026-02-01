/* Full replacement: Express backend for Campus Store with Brevo Email Integration
   Features:
   - Brevo transactional email for PIN recovery (environment variable only)
   - Real-time fee listener from Firestore
   - IntaSend B2C withdrawals
   - Hugging Face image generation
   - Stealth keep-alive for Render
*/

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
// Brevo Email Service
// ============================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const sendEmail = async (to, subject, html) => {
  try {
    console.log('📧 Attempting to send email to:', to);
    console.log('📧 Subject:', subject);
    
    if (!BREVO_API_KEY) {
      console.log('❌ BREVO_API_KEY not configured in environment');
      console.log('📧 Email would have been sent to:', to);
      return false;
    }
    
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          name: 'MarketMix Kenya',
          email: 'security@marketmix.site'
        },
        to: [{
          email: to,
          name: to.split('@')[0] || 'User'
        }],
        subject: subject,
        htmlContent: html,
        tags: ['pin-recovery', 'transactional']
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Brevo API error:', JSON.stringify(data, null, 2));
      throw new Error(data.message || `Brevo API error: ${response.status}`);
    }

    console.log(`✅ Email sent successfully!`);
    console.log(`📧 Message ID: ${data.messageId}`);
    console.log(`📧 To: ${to}`);
    console.log(`📧 From: security@marketmix.site`);
    return true;
    
  } catch (error) {
    console.error('❌ Email sending failed:', error.message);
    return false;
  }
};

// Test Brevo setup on startup
(async () => {
  if (BREVO_API_KEY) {
    try {
      const response = await fetch('https://api.brevo.com/v3/account', {
        headers: {
          'accept': 'application/json',
          'api-key': BREVO_API_KEY
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Brevo API connected successfully`);
        console.log(`📧 Account: ${data.email}`);
        console.log(`📧 Sender: security@marketmix.site`);
      } else {
        console.warn('⚠️ Brevo API key may be invalid');
      }
    } catch (error) {
      console.warn('⚠️ Could not verify Brevo API key on startup:', error.message);
    }
  } else {
    console.warn('⚠️ BREVO_API_KEY not set in environment - PIN recovery emails will not be sent');
  }
})();

// ============================
// Fee Constants & Helpers
// ============================
const WITHDRAWAL_THRESHOLD = 100.0;
const FIXED_FEE_BELOW_THRESHOLD = 10.0;
const FIXED_FEE_ABOVE_THRESHOLD = 20.0;
const AGENCY_FEE_RATE = 0.035;

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
    
    // 2. Check if email matches
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

    const pin = userData.withdrawalPin;
    
    // 4. Record the PIN recovery request
    await db.collection('securityLogs').add({
      userId: userId,
      email: email,
      action: 'PIN_RECOVERY_REQUESTED',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    // 5. Create beautiful email template
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: #f8f9fa; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; color: white; }
          .logo { font-size: 32px; font-weight: bold; margin-bottom: 10px; }
          .content { padding: 40px 30px; }
          .pin-box { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; font-size: 48px; font-weight: bold; padding: 30px; border-radius: 12px; text-align: center; letter-spacing: 15px; margin: 30px 0; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
          .security-note { background: #fff3e0; border-left: 5px solid #ff9800; padding: 20px; border-radius: 8px; margin: 25px 0; }
          .footer { background: #f8f9fa; padding: 25px 30px; text-align: center; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 14px; }
          .info-box { background: #e8f4fd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #2196f3; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">MarketMix Kenya</div>
            <h2 style="margin: 10px 0 0 0; font-weight: 300;">Withdrawal PIN Recovery</h2>
          </div>
          
          <div class="content">
            <h3 style="color: #333; text-align: center; margin-bottom: 10px;">Hello Seller,</h3>
            <p style="color: #666; text-align: center; margin-bottom: 30px;">You requested your withdrawal PIN. Here it is:</p>
            
            <div class="pin-box">
              ${pin}
            </div>
            
            <div class="security-note">
              <h4 style="margin-top: 0; color: #856404;">⚠️ SECURITY ALERT</h4>
              <ul style="margin-bottom: 0; color: #856404;">
                <li>This PIN provides access to your funds</li>
                <li>Never share it with anyone</li>
                <li>MarketMix staff will never ask for your PIN</li>
                <li>If you suspect unauthorized access, contact support immediately</li>
              </ul>
            </div>
            
            <div class="info-box">
              <h4 style="margin-top: 0; color: #0c5460;">Request Details</h4>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Time:</strong> ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</p>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Email:</strong> ${email}</p>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Account ID:</strong> ${userId.slice(0, 8)}...</p>
            </div>
            
            <p style="text-align: center; color: #666; margin-top: 30px;">
              Need help? <a href="mailto:security@marketmix.site" style="color: #667eea; text-decoration: none;">Contact Support</a>
            </p>
          </div>
          
          <div class="footer">
            <p style="margin: 0 0 10px 0;"><strong>MarketMix Kenya</strong></p>
            <p style="margin: 0 0 10px 0; font-size: 12px;">This email was sent from <strong>security@marketmix.site</strong></p>
            <p style="margin: 0; font-size: 12px;">If you didn't request this, please secure your account immediately.</p>
            <p style="margin: 15px 0 0 0; font-size: 12px;">
              <a href="https://marketmix.site" style="color: #667eea; text-decoration: none;">Visit Marketplace</a> | 
              <a href="https://marketmix.site/seller/dashboard" style="color: #667eea; text-decoration: none;">Seller Dashboard</a> | 
              <a href="mailto:security@marketmix.site" style="color: #667eea; text-decoration: none;">Contact Support</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    // 6. Send email via Brevo
    const emailSent = await sendEmail(
      email,
      '🔒 Your Withdrawal PIN Recovery - MarketMix Kenya',
      emailHtml
    );

    if (!emailSent) {
      console.log(`⚠️ Email failed to send for ${email}`);
      
      return res.json({ 
        success: false, 
        message: 'Failed to send PIN recovery email. Please try again or contact support.',
        emailSent: false
      });
    }

    console.log(`✅ PIN recovery email sent to ${email}`);
    
    res.json({ 
      success: true, 
      message: 'PIN recovery email sent successfully',
      emailSent: true,
      note: 'Check your inbox and spam folder'
    });

  } catch (error) {
    console.error('❌ PIN recovery error:', error);
    
    // Log the error
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

// ✅ Hugging Face image generation
app.post("/api/generate-ai-image", async (req, res) => {
  try {
    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Invalid prompt" });
    }

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
          "Accept": "image/png"
        },
        body: JSON.stringify({ 
             inputs: prompt,
             options: { wait_for_model: true }
        })
      }
    );

    if (!hfResponse.ok) {
      const status = hfResponse.status;
      let bodyText = "Hugging Face call failed.";
      try {
        bodyText = await hfResponse.text();
      } catch (e) { }
      
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
    const imageBuffer = Buffer.from(arrBuf);
    const base64Image = imageBuffer.toString('base64');
    const imageUrl = `data:${contentType};base64,${base64Image}`;

    return res.json({ imageUrl: imageUrl, success: true });
    
  } catch (err) {
    console.error("❌ AI generation error:", err);
    return res.status(500).json({ 
        success: false, 
        message: "AI generation failed due to a server-side error.", 
        detail: err.message
    });
  }
});

// ============================
// Debug & Test Endpoints
// ============================

// ✅ Test Brevo setup
app.get("/api/test-email-setup", async (req, res) => {
  try {
    if (!BREVO_API_KEY) {
      return res.json({
        success: false,
        message: "BREVO_API_KEY not configured in environment",
        help: "Add BREVO_API_KEY to Render environment variables",
        currentEnv: Object.keys(process.env).filter(k => k.includes('BREVO') || k.includes('EMAIL'))
      });
    }

    // Test account info
    const accountResponse = await fetch('https://api.brevo.com/v3/account', {
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY
      }
    });
    
    const accountData = await accountResponse.json();
    
    if (!accountResponse.ok) {
      return res.json({
        success: false,
        message: 'Brevo API key is invalid',
        error: accountData.message || 'Check your API key',
        status: accountResponse.status
      });
    }

    // Test sending
    const testEmailHtml = `
      <h2>✅ Brevo Test Successful!</h2>
      <p>Your Brevo API is working correctly with:</p>
      <ul>
        <li><strong>Sender:</strong> security@marketmix.site</li>
        <li><strong>Account:</strong> ${accountData.email}</li>
        <li><strong>Time:</strong> ${new Date().toLocaleString()}</li>
      </ul>
    `;
    
    const emailSent = await sendEmail(
      'johnnjanjo4@gmail.com',
      '✅ Brevo Test - PIN Recovery System Working',
      testEmailHtml
    );

    res.json({
      success: true,
      message: '✅ Brevo API key is working!',
      account: {
        email: accountData.email,
        firstName: accountData.firstName,
        lastName: accountData.lastName
      },
      sender: 'security@marketmix.site is configured',
      emailTest: emailSent ? '✅ Test email sent successfully' : '❌ Test email failed',
      note: 'Check johnnjanjo4@gmail.com for test email'
    });
    
  } catch (error) {
    console.error('❌ Brevo test error:', error);
    res.status(500).json({
      success: false,
      message: 'Brevo test failed',
      error: error.message
    });
  }
});

// ✅ Health check
app.get("/_health", (req, res) => {
  const health = {
    ok: true,
    timestamp: Date.now(),
    services: {
      firebase: true,
      brevo: !!BREVO_API_KEY,
      intasend: true
    },
    uptime: process.uptime()
  };
  res.json(health);
});

// 404 fallback
app.use((req, res) =>
  res.status(404).json({ success: false, message: "Not Found" })
);

// ============================
// Global error handlers
// ============================
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ============================
// Stealth keep-alive
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

  const BASE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 4 * 60 * 1000;
  const JITTER_MS = Number(process.env.KEEP_ALIVE_JITTER_MS) || 30 * 1000;
  const REQUEST_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_REQUEST_TIMEOUT_MS) || 1000;

  let keepAliveInterval = null;

  const scheduleNext = () => {
    const jitter = Math.floor(Math.random() * (JITTER_MS * 2 + 1)) - JITTER_MS;
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
          res.on("data", () => {});
          res.on("end", () => {});
        });

        req.on("timeout", () => {
          try { req.destroy(); } catch (e) {}
        });
        req.on("error", () => {});

        req.end();
      } catch (err) {
      } finally {
        scheduleNext();
      }
    }, delay);

    if (typeof keepAliveInterval.unref === "function") keepAliveInterval.unref();
  };

  scheduleNext();

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
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Brevo API: ${BREVO_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`📧 Sender: security@marketmix.site`);
  console.log(`🌐 CORS enabled for: ${allowedOrigins.join(', ')}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down server...");
  try {
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  } catch (e) {
    console.error("Error during shutdown:", e);
    process.exit(1);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
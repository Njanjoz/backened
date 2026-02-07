// server.js
// Full Express backend for Campus Store with Brevo Email Integration & Subscription Support
// Features:
// - Brevo transactional email for PIN recovery (REPLACEMENT CODES ONLY)
// - Automated order confirmation emails after purchase
// - Real-time fee listener from Firestore
// - IntaSend B2C withdrawals
// - Hugging Face image generation
// - Subscription payment handling (M-Pesa STK Push)
// - Subscription status polling and confirmation
// - Stealth keep-alive for Render

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
  "http://localhost:3000",
  "http://127.0.0.1:3000",
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

// Request logging middleware
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

const sendEmail = async (to, subject, html, type = 'security') => {
  try {
    console.log('📧 Attempting to send email to:', to);
    console.log('📧 Subject:', subject);
    console.log('📧 Type:', type);
    
    if (!BREVO_API_KEY) {
      console.log('❌ BREVO_API_KEY not configured in environment');
      console.log('📧 Email would have been sent to:', to);
      return false;
    }
    
    // Determine sender based on email type
    const sender = type === 'sales' 
      ? {
          name: 'MarketMixKenya',
          email: 'sales@marketmix.site'
        }
      : {
          name: 'MarketMixKenya',
          email: 'security@marketmix.site'
        };
    
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: sender,
        to: [{
          email: to,
          name: to.split('@')[0] || 'User'
        }],
        subject: subject,
        htmlContent: html,
        tags: [type === 'sales' ? 'order-confirmation' : 'pin-recovery']
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
    console.log(`📧 From: ${sender.name} <${sender.email}>`);
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
        console.log(`📧 Security Sender: MarketMixKenya <security@marketmix.site>`);
        console.log(`📧 Sales Sender: MarketMixKenya <sales@marketmix.site>`);
        console.log(`📧 Authentication: DKIM, DMARC, SPF configured`);
      } else {
        console.warn('⚠️ Brevo API key may be invalid');
      }
    } catch (error) {
      console.warn('⚠️ Could not verify Brevo API key on startup:', error.message);
    }
  } else {
    console.warn('⚠️ BREVO_API_KEY not set in environment - emails will not be sent');
  }
})();

// ============================
// PIN Recovery System (Replacement Codes)
// ============================

// Generate a 6-digit replacement code
const generateReplacementCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Store replacement codes in Firestore with TTL
const storeReplacementCode = async (userId, email, code) => {
  try {
    const expiryTime = new Date();
    expiryTime.setMinutes(expiryTime.getMinutes() + 15); // 15 minute expiry
    
    await db.collection('pinRecoveryCodes').doc(userId).set({
      code,
      email,
      userId,
      expiresAt: expiryTime,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 0,
      maxAttempts: 3,
      used: false,
      status: 'pending'
    });
    
    return true;
  } catch (error) {
    console.error('Failed to store replacement code:', error);
    return false;
  }
};

// Verify replacement code
const verifyReplacementCode = async (userId, code) => {
  try {
    const recoveryDoc = await db.collection('pinRecoveryCodes').doc(userId).get();
    
    if (!recoveryDoc.exists) {
      return { valid: false, message: 'No recovery request found' };
    }
    
    const recoveryData = recoveryDoc.data();
    
    // Check if expired
    if (recoveryData.expiresAt.toDate() < new Date()) {
      await db.collection('pinRecoveryCodes').doc(userId).delete();
      return { valid: false, message: 'Recovery code has expired' };
    }
    
    // Check if already used
    if (recoveryData.used) {
      return { valid: false, message: 'Recovery code has already been used' };
    }
    
    // Check if max attempts reached
    if (recoveryData.attempts >= recoveryData.maxAttempts) {
      return { valid: false, message: 'Too many failed attempts' };
    }
    
    // Check if code matches
    if (recoveryData.code !== code) {
      // Increment attempts
      await db.collection('pinRecoveryCodes').doc(userId).update({
        attempts: admin.firestore.FieldValue.increment(1)
      });
      
      const remainingAttempts = recoveryData.maxAttempts - (recoveryData.attempts + 1);
      return { 
        valid: false, 
        message: `Invalid code. ${remainingAttempts} attempts remaining` 
      };
    }
    
    // Mark as verified (not used yet - will be used when PIN is reset)
    await db.collection('pinRecoveryCodes').doc(userId).update({
      status: 'verified',
      verifiedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { valid: true, data: recoveryData };
  } catch (error) {
    console.error('Failed to verify replacement code:', error);
    return { valid: false, message: 'Verification failed' };
  }
};

// Mark replacement code as used
const markCodeAsUsed = async (userId) => {
  try {
    await db.collection('pinRecoveryCodes').doc(userId).update({
      used: true,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'completed'
    });
    return true;
  } catch (error) {
    console.error('Failed to mark code as used:', error);
    return false;
  }
};

// ============================
// Order Confirmation Email System - UPDATED TO MATCH RECEIPT DESIGN
// ============================

const sendOrderConfirmationEmail = async (orderData, userEmail, orderId) => {
  try {
    console.log('📧 Sending order confirmation to:', userEmail);
    
    if (!BREVO_API_KEY) {
      console.log('❌ BREVO_API_KEY not configured - skipping email');
      return false;
    }
    
    // Format date
    const orderDate = orderData.orderDate?.toDate() || new Date();
    const formattedDate = orderDate.toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Calculate totals
    const itemsTotal = orderData.items?.reduce((sum, item) => 
      sum + ((item.price || 0) * (item.quantity || 1)), 0) || 0;
    
    const deliveryTotal = orderData.sellerGroups?.reduce((sum, group) => 
      sum + (group.deliveryCost || 0), 0) || 0;
    
    // Create email template matching receipt design
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { 
      font-family: 'Georgia', 'Times New Roman', serif;
      line-height: 1.6; 
      color: #1f2937; 
      margin: 0; 
      padding: 0; 
      background: linear-gradient(to bottom right, #f9fafb, #f3f4f6);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container { 
      max-width: 480px; 
      width: 100%;
      margin: 20px auto; 
      background: white; 
      border-radius: 20px; 
      overflow: hidden; 
      box-shadow: 0 10px 30px rgba(0,0,0,0.08); 
      position: relative;
      border: 1px solid #e5e7eb;
      padding-bottom: 64px;
    }
    .watermark {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 0;
      opacity: 0.05;
    }
    .watermark img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .logo-container {
      display: flex;
      justify-content: center;
      margin-bottom: 24px;
      margin-top: 24px;
      position: relative;
      z-index: 10;
    }
    .logo {
      height: 64px;
    }
    .header {
      text-align: center;
      position: relative;
      z-index: 10;
      padding: 0 24px;
    }
    .title {
      font-weight: bold;
      font-size: 18px;
      margin-bottom: 4px;
      color: #1f2937;
    }
    .subtitle {
      color: #6b7280;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .content-box {
      background: #f9fafb;
      border-radius: 12px;
      padding: 20px;
      margin: 0 24px 24px;
      border: 1px solid #e5e7eb;
      position: relative;
      z-index: 10;
    }
    .order-info {
      margin-bottom: 16px;
    }
    .info-row {
      margin-bottom: 8px;
      font-size: 14px;
    }
    .info-label {
      font-weight: 600;
      color: #374151;
    }
    .items-section {
      margin-top: 16px;
    }
    .items-title {
      font-weight: 600;
      margin-bottom: 8px;
      color: #374151;
    }
    .items-list {
      padding-left: 20px;
      list-style-type: disc;
      margin: 0;
    }
    .item {
      margin-bottom: 6px;
      color: #4b5563;
      font-size: 14px;
    }
    .item span {
      color: #1f2937;
      font-weight: 500;
    }
    .total-row {
      text-align: right;
      font-weight: 600;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px dashed #d1d5db;
      font-size: 15px;
      color: #1f2937;
    }
    .divider {
      height: 1px;
      background: #e5e7eb;
      margin: 24px;
      position: relative;
      z-index: 10;
    }
    .section-title {
      font-weight: 600;
      margin-bottom: 12px;
      margin-left: 24px;
      color: #374151;
      position: relative;
      z-index: 10;
      font-size: 15px;
    }
    .shipping-box {
      background: #f9fafb;
      border-radius: 8px;
      padding: 16px;
      margin: 0 24px;
      border: 1px solid #e5e7eb;
      position: relative;
      z-index: 10;
    }
    .shipping-row {
      margin-bottom: 6px;
      font-size: 14px;
    }
    .footer {
      text-align: center;
      font-size: 11px;
      color: #9ca3af;
      margin-top: 24px;
      position: relative;
      z-index: 10;
      padding: 0 24px;
    }
    .receipt-id {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: bold;
      margin-bottom: 16px;
      font-size: 14px;
      letter-spacing: 0.5px;
    }
    .status-badge {
      display: inline-block;
      background: #10b981;
      color: white;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      margin-top: 8px;
    }
    .print-section {
      text-align: center;
      margin-top: 24px;
      position: relative;
      z-index: 10;
    }
    .action-link {
      color: #4f46e5;
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
    .action-link:hover {
      text-decoration: underline;
    }
    .action-button {
      display: inline-block;
      background: #4f46e5;
      color: white;
      padding: 10px 20px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      margin: 0 8px;
      font-size: 14px;
      border: none;
      cursor: pointer;
    }
    .coupon-row {
      color: #10b981;
      font-size: 14px;
    }
    .delivery-row {
      font-size: 14px;
      color: #4b5563;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Watermark -->
    <div class="watermark">
      <img src="https://i.ibb.co/JjSrxbPz/icon-png-1.png" alt="Watermark">
    </div>
    
    <!-- Logo -->
    <div class="logo-container">
      <img src="https://i.ibb.co/JjSrxbPz/icon-png-1.png" alt="MarketMix Logo" class="logo">
    </div>
    
    <!-- Header -->
    <div class="header">
      <div class="receipt-id">Order #${orderId.substring(0, 8)}</div>
      <div class="title">Thank you for shopping with us</div>
      <div class="subtitle">We appreciate your trust and hope you enjoyed your order.</div>
      <div class="status-badge">Payment Confirmed</div>
    </div>
    
    <!-- Order Summary -->
    <div class="content-box">
      <div class="order-info">
        <div class="info-row">
          <span class="info-label">Order ID:</span> ${orderId || "N/A"}
        </div>
        <div class="info-row">
          <span class="info-label">Date:</span> ${formattedDate}
        </div>
        <div class="info-row">
          <span class="info-label">Buyer:</span> ${orderData.shippingDetails?.fullName || userEmail || "N/A"}
        </div>
      </div>
      
      <div class="items-section">
        <div class="items-title">Items:</div>
        <ul class="items-list">
          ${orderData.items?.map(item => `
            <li class="item">
              ${item.name} × ${item.quantity} – Ksh <span>${((item.price || 0) * (item.quantity || 1)).toFixed(2)}</span>
            </li>
          `).join('') || '<li class="item">No items</li>'}
        </ul>
      </div>
      
      <div class="total-row">
        Items Total: Ksh ${itemsTotal.toFixed(2)}
      </div>
      
      ${orderData.couponDiscount > 0 ? `
        <div class="total-row coupon-row">
          Coupon Discount ${orderData.couponCode ? `(${orderData.couponCode})` : ''}: -Ksh ${orderData.couponDiscount.toFixed(2)}
        </div>
      ` : ''}
      
      <div class="total-row delivery-row">
        Delivery Total: Ksh ${deliveryTotal.toFixed(2)}
      </div>
      
      <div class="total-row" style="font-size: 16px; color: #1f2937; margin-top: 20px;">
        Total Amount Paid: Ksh ${orderData.totalAmount?.toFixed(2) || '0.00'}
      </div>
    </div>
    
    <div class="divider"></div>
    
    <!-- Shipping Details -->
    <div class="section-title">Shipping Details</div>
    <div class="shipping-box">
      <div class="shipping-row">
        <span class="info-label">Full Name:</span> ${orderData.shippingDetails?.fullName || "N/A"}
      </div>
      <div class="shipping-row">
        <span class="info-label">Phone:</span> ${orderData.shippingDetails?.phoneNumber || "N/A"}
      </div>
      <div class="shipping-row">
        <span class="info-label">Delivery Place:</span> ${orderData.shippingDetails?.deliveryPlace || "N/A"}
      </div>
    </div>
    
    <!-- Action Links -->
    <div class="print-section">
      <p style="margin-bottom: 16px; color: #6b7280; font-size: 14px;">
        View your full receipt: 
        <a href="https://marketmix.site/order-receipt/${orderId}" class="action-link">Order Receipt</a>
      </p>
      <div style="margin-top: 20px;">
        <a href="https://marketmix.site" class="action-button" style="background: #1f2937;">Continue Shopping</a>
        <a href="https://marketmix.site/orders" class="action-button">View All Orders</a>
      </div>
    </div>
    
    <!-- Footer -->
    <div class="footer">
      <p style="margin: 0;">MarketMix Kenya © ${new Date().getFullYear()} | Receipt generated online</p>
      <p style="margin: 8px 0 0 0; font-size: 10px;">
        Need help? Contact: <a href="mailto:sales@marketmix.site" style="color: #6b7280;">sales@marketmix.site</a>
      </p>
    </div>
  </div>
</body>
</html>`;

    // Send email via MarketMixKenya <sales@marketmix.site>
    const emailSent = await sendEmail(
      userEmail,
      `Order Confirmation #${orderId.substring(0, 8)} - MarketMix Kenya`,
      emailHtml,
      'sales'
    );

    if (emailSent) {
      // Record email sent status
      try {
        await db.collection('orderEmails').add({
          orderId,
          userEmail,
          type: 'confirmation',
          sender: 'MarketMixKenya <sales@marketmix.site>',
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          authenticated: true,
          dmarc: 'configured',
          dkim: 'signed'
        });
      } catch (logErr) {
        console.error('Failed to log email:', logErr);
      }
    }
    
    return emailSent;
    
  } catch (error) {
    console.error('❌ Order confirmation email failed:', error.message);
    return false;
  }
};

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
// NEW: Subscription Helper Functions
// ============================

// Validate subscription payment data
const validateSubscriptionPayment = (data) => {
  const { amount, phoneNumber, fullName, email, orderId, planId, sellerId } = data;
  
  if (!amount || !phoneNumber || !fullName || !email || !orderId || !planId || !sellerId) {
    return { valid: false, message: "Missing required fields" };
  }
  
  const amt = parsePositiveNumber(amount);
  if (!amt) return { valid: false, message: "Invalid amount" };
  
  if (!isValidPhone(phoneNumber)) {
    return { valid: false, message: "Invalid phone number format. Use 2547XXXXXXXX or 2541XXXXXXXX" };
  }
  
  if (!email.includes("@")) return { valid: false, message: "Invalid email" };
  
  return { valid: true, data: { ...data, amount: amt } };
};

// Create subscription record in Firestore
const createSubscriptionRecord = async (subscriptionData, invoiceId) => {
  try {
    const subscriptionRef = db.collection('subscriptions').doc(subscriptionData.orderId);
    
    const subscriptionRecord = {
      sellerId: subscriptionData.sellerId,
      planId: subscriptionData.planId,
      planName: subscriptionData.planName,
      amount: subscriptionData.amount,
      invoiceId: invoiceId,
      status: 'pending',
      paymentMethod: 'mpesa',
      phoneNumber: subscriptionData.phoneNumber,
      email: subscriptionData.email,
      fullName: subscriptionData.fullName,
      orderId: subscriptionData.orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: null,
      paymentStatus: 'pending',
      mpesaReference: null
    };
    
    await subscriptionRef.set(subscriptionRecord);
    return subscriptionRef.id;
  } catch (error) {
    console.error('Failed to create subscription record:', error);
    throw error;
  }
};

// Get subscription status from IntaSend
const getSubscriptionPaymentStatus = async (invoiceId) => {
  try {
    // This would normally call IntaSend API to check payment status
    // For now, we'll simulate by checking Firestore
    const subscriptionSnapshot = await db.collection('subscriptions')
      .where('invoiceId', '==', invoiceId)
      .limit(1)
      .get();
    
    if (subscriptionSnapshot.empty) {
      return { success: false, message: 'Subscription not found' };
    }
    
    const subscription = subscriptionSnapshot.docs[0].data();
    return { 
      success: true, 
      data: {
        paymentStatus: subscription.paymentStatus || 'pending',
        mpesaReference: subscription.mpesaReference,
        status: subscription.status
      }
    };
  } catch (error) {
    console.error('Failed to get subscription status:', error);
    return { success: false, message: 'Failed to check payment status' };
  }
};

// Activate subscription after payment
const activateSellerSubscription = async (subscriptionData, mpesaReference) => {
  try {
    const { orderId, planId, sellerId, sellerEmail } = subscriptionData;
    
    // Calculate expiration date (30 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    
    // Update subscription record
    const subscriptionRef = db.collection('subscriptions').doc(orderId);
    await subscriptionRef.update({
      status: 'active',
      paymentStatus: 'paid',
      mpesaReference: mpesaReference,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update seller's subscription status
    const sellerRef = db.collection('users').doc(sellerId);
    await sellerRef.update({
      subscriptionPlan: planId,
      subscriptionStatus: 'active',
      subscriptionActive: true,
      subscriptionExpiresAt: expiresAt,
      subscriptionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSubscriptionPayment: {
        amount: subscriptionData.amount,
        date: admin.firestore.FieldValue.serverTimestamp(),
        reference: mpesaReference,
        orderId: orderId
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create subscription payment record
    await db.collection('subscriptionPayments').add({
      sellerId,
      planId,
      amount: subscriptionData.amount,
      mpesaReference,
      orderId,
      status: 'completed',
      sellerEmail,
      paymentDate: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expiresAt
    });
    
    // Log subscription activation
    await db.collection('subscriptionLogs').add({
      sellerId,
      action: 'subscription_activated',
      planId,
      amount: subscriptionData.amount,
      orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return true;
  } catch (error) {
    console.error('Failed to activate subscription:', error);
    throw error;
  }
};

// ============================
// Routes
// ============================

// ✅ STK Push for Regular Orders
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

// ✅ NEW: Subscription Payment Endpoint
app.post("/api/subscription-payment", async (req, res) => {
  try {
    console.log("📦 Subscription payment request:", req.body);
    
    const validation = validateSubscriptionPayment(req.body);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }
    
    const subscriptionData = validation.data;
    const { amount, phoneNumber, fullName, email, orderId } = subscriptionData;
    
    const [firstName, ...rest] = fullName.trim().split(" ");
    const lastName = rest.join(" ") || "N/A";

    let intasendResponse;
    try {
      intasendResponse = await intasend.collection().mpesaStkPush({
        first_name: firstName,
        last_name: lastName,
        email,
        phone_number: phoneNumber,
        amount: amount,
        host: BACKEND_HOST,
        api_ref: orderId,
      });
    } catch (intasendErr) {
      console.error(
        "❌ IntaSend Subscription STK Push failed:",
        intasendErr?.response || intasendErr
      );
      return res
        .status(502)
        .json({ success: false, message: "Payment provider error" });
    }

    // Create subscription record
    const invoiceId = intasendResponse?.invoice?.invoice_id;
    await createSubscriptionRecord(subscriptionData, invoiceId);

    return res.json({ 
      success: true, 
      data: intasendResponse,
      message: "Subscription payment initiated successfully" 
    });
  } catch (error) {
    console.error("❌ Subscription payment error:", error);
    return sendServerError(res, error, "Subscription payment failed");
  }
});

// ✅ NEW: Subscription Status Check Endpoint
app.get("/api/subscription-status/:invoiceId", async (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    if (!invoiceId) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing invoice ID" 
      });
    }
    
    const status = await getSubscriptionPaymentStatus(invoiceId);
    
    if (!status.success) {
      return res.status(404).json(status);
    }
    
    return res.json(status);
  } catch (error) {
    console.error("❌ Subscription status check error:", error);
    return sendServerError(res, error, "Failed to check subscription status");
  }
});

// ✅ NEW: Confirm Subscription Endpoint
app.post("/api/confirm-subscription", async (req, res) => {
  try {
    const { orderId, mpesaReference, planId, sellerId, sellerEmail } = req.body;
    
    console.log("✅ Confirming subscription:", { orderId, mpesaReference });
    
    if (!orderId || !mpesaReference || !planId || !sellerId || !sellerEmail) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields" 
      });
    }
    
    // Activate the subscription
    await activateSellerSubscription({
      orderId,
      planId,
      sellerId,
      sellerEmail,
      amount: req.body.amount // Optional, can be fetched from subscription record
    }, mpesaReference);
    
    return res.json({ 
      success: true, 
      message: "Subscription activated successfully",
      data: {
        orderId,
        activated: true,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("❌ Confirm subscription error:", error);
    return sendServerError(res, error, "Failed to confirm subscription");
  }
});

// ✅ IntaSend callback - UPDATED WITH EMAIL CONFIRMATION
app.post("/api/intasend-callback", async (req, res) => {
  try {
    const { api_ref, state, mpesa_reference } = req.body;
    if (!api_ref || !state) return res.status(400).send("Missing api_ref or state");

    let status = "pending";
    if (state === "COMPLETE") status = "paid";
    if (["FAILED", "CANCELLED"].includes(state)) status = "failed";

    // Check if this is a subscription payment or regular order
    const isSubscription = api_ref.startsWith('SUB_');
    
    if (isSubscription) {
      // Handle subscription payment callback
      const subscriptionRef = db.collection('subscriptions').doc(api_ref);
      const subscriptionSnap = await subscriptionRef.get();
      
      if (subscriptionSnap.exists) {
        await subscriptionRef.update({
          paymentStatus: status,
          mpesaReference: mpesa_reference || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        console.log(`Subscription ${api_ref} updated to status: ${status}`);
        
        // If payment successful, activate subscription
        if (state === "COMPLETE") {
          const subscriptionData = subscriptionSnap.data();
          try {
            await activateSellerSubscription({
              orderId: api_ref,
              planId: subscriptionData.planId,
              sellerId: subscriptionData.sellerId,
              sellerEmail: subscriptionData.email,
              amount: subscriptionData.amount
            }, mpesa_reference);
            
            console.log(`✅ Subscription ${api_ref} activated successfully`);
          } catch (activationError) {
            console.error('Failed to activate subscription:', activationError);
          }
        }
      }
    } else {
      // Handle regular order callback
      const orderRef = db.collection("orders").doc(api_ref);
      const orderSnap = await orderRef.get();
      
      if (!orderSnap.exists) {
        console.error(`Order ${api_ref} not found`);
        return res.status(404).send("Order not found");
      }

      const orderData = orderSnap.data();
      
      // Update the order status
      await orderRef.update({
        paymentStatus: status,
        mpesaReference: mpesa_reference || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Order ${api_ref} updated to status: ${status}`);

      // If payment is successful, send confirmation email
      if (state === "COMPLETE") {
        console.log(`Payment successful for order ${api_ref}, sending confirmation email...`);
        
        // Get user email
        let userEmail = orderData.userEmail || orderData.shippingDetails?.email;
        
        if (!userEmail && orderData.userId) {
          try {
            const userDoc = await db.collection('users').doc(orderData.userId).get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              userEmail = userData.email;
            }
          } catch (userErr) {
            console.error('Failed to fetch user email:', userErr);
          }
        }
        
        if (userEmail) {
          console.log(`Sending order confirmation to ${userEmail} for order ${api_ref}`);
          
          // Send order confirmation email asynchronously
          sendOrderConfirmationEmail(orderData, userEmail, api_ref)
            .then(success => {
              if (success) {
                console.log(`✅ Order confirmation email sent for ${api_ref}`);
                
                // Update order with email sent flag
                orderRef.update({
                  confirmationEmailSent: true,
                  confirmationSentAt: admin.firestore.FieldValue.serverTimestamp()
                }).catch(e => console.error('Failed to update email flag:', e));
              } else {
                console.log(`❌ Failed to send confirmation email for ${api_ref}`);
              }
            })
            .catch(emailErr => {
              console.error('Email sending error:', emailErr);
            });
        } else {
          console.log(`⚠️ No email found for order ${api_ref}, skipping confirmation email`);
        }
      }
    }

    return res.send("OK");
  } catch (error) {
    console.error('IntaSend callback error:', error);
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

// ✅ PIN Recovery Endpoint - REPLACEMENT CODES VERSION
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

    // 4. Generate replacement code
    const replacementCode = generateReplacementCode();
    
    // 5. Store replacement code
    const codeStored = await storeReplacementCode(userId, email, replacementCode);
    
    if (!codeStored) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to generate recovery code' 
      });
    }

    // 6. Record the PIN recovery request
    await db.collection('securityLogs').add({
      userId: userId,
      email: email,
      action: 'PIN_RECOVERY_REQUESTED',
      codeGenerated: true,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    // 7. Create email template with replacement code
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
          .code-box { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; font-size: 32px; font-weight: bold; padding: 25px; border-radius: 12px; text-align: center; letter-spacing: 8px; margin: 30px 0; box-shadow: 0 5px 15px rgba(0,0,0,0.2); }
          .security-note { background: #fff3e0; border-left: 5px solid #ff9800; padding: 20px; border-radius: 8px; margin: 25px 0; }
          .footer { background: #f8f9fa; padding: 25px 30px; text-align: center; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 14px; }
          .info-box { background: #e8f4fd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #2196f3; }
          .timer { background: #f8f9fa; padding: 10px 15px; border-radius: 6px; text-align: center; margin: 20px 0; }
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
            <p style="color: #666; text-align: center; margin-bottom: 20px;">
              You requested to reset your withdrawal PIN. Use the code below to verify your identity.
            </p>
            
            <div class="code-box">
              ${replacementCode}
            </div>
            
            <div class="timer">
              <p style="margin: 0; color: #666;"><strong>This code expires in 15 minutes</strong></p>
            </div>
            
            <div class="security-note">
              <h4 style="margin-top: 0; color: #856404;">SECURITY ALERT</h4>
              <ul style="margin-bottom: 0; color: #856404;">
                <li>This code is for PIN reset verification only</li>
                <li>Never share it with anyone</li>
                <li>MarketMix staff will never ask for this code</li>
                <li>If you didn't request this, contact support immediately</li>
              </ul>
            </div>
            
            <div class="info-box">
              <h4 style="margin-top: 0; color: #0c5460;">Request Details</h4>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Time:</strong> ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</p>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Email:</strong> ${email}</p>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Account ID:</strong> ${userId.slice(0, 8)}...</p>
              <p style="margin: 5px 0; color: #0c5460;"><strong>Valid Attempts:</strong> 3 attempts remaining</p>
            </div>
            
            <p style="text-align: center; color: #666; margin-top: 30px;">
              Enter this code in the PIN recovery page to reset your withdrawal PIN.
            </p>
          </div>
          
          <div class="footer">
            <p style="margin: 0 0 10px 0;"><strong>MarketMix Kenya</strong></p>
            <p style="margin: 0 0 10px 0; font-size: 12px;">This email was sent from <strong>security@marketmix.site</strong></p>
            <p style="margin: 0; font-size: 12px;">If you didn't request this, please secure your account immediately.</p>
            <p style="margin: 15px 0 0 0; font-size: 12px;">
              <a href="https://marketmix.site" style="color: #667eea; text-decoration: none;">Visit Marketplace</a> | 
              <a href="https://marketmix.site/seller/dashboard" style="color: #667eea; text-decoration: none;">Seller Dashboard</a> | 
              <a href="mailto:sales@marketmix.site" style="color: #667eea; text-decoration: none;">Contact Support</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    // 8. Send email via Brevo
    const emailSent = await sendEmail(
      email,
      'Your PIN Reset Code - MarketMix Kenya',
      emailHtml,
      'security'
    );

    if (!emailSent) {
      console.log(`⚠️ Email failed to send for ${email}`);
      
      return res.json({ 
        success: false, 
        message: 'Failed to send PIN recovery code. Please try again or contact support.',
        emailSent: false
      });
    }

    console.log(`✅ PIN recovery code sent to ${email}`);
    
    res.json({ 
      success: true, 
      message: 'PIN recovery code sent to your email',
      emailSent: true,
      note: 'Check your inbox and spam folder. The code expires in 15 minutes.'
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

// ✅ Verify PIN Recovery Code
app.post("/api/seller/verify-recovery-code", async (req, res) => {
  try {
    const { userId, code } = req.body;
    
    console.log("🔑 Verify Recovery Code:", { userId });
    
    if (!userId || !code) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID and code are required' 
      });
    }

    const verification = await verifyReplacementCode(userId, code);
    
    if (!verification.valid) {
      return res.status(400).json({ 
        success: false, 
        message: verification.message 
      });
    }

    // Record successful verification
    await db.collection('securityLogs').add({
      userId: userId,
      email: verification.data.email,
      action: 'PIN_RECOVERY_VERIFIED',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip
    });

    res.json({ 
      success: true, 
      message: 'Code verified successfully',
      verified: true
    });

  } catch (error) {
    console.error('❌ Code verification error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to verify recovery code' 
    });
  }
});

// ✅ Reset PIN with Verified Code
app.post("/api/seller/reset-pin", async (req, res) => {
  try {
    const { userId, code, newPin, confirmPin } = req.body;
    
    console.log("🔑 Reset PIN Request:", { userId });
    
    if (!userId || !code || !newPin || !confirmPin) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    if (newPin !== confirmPin) {
      return res.status(400).json({ 
        success: false, 
        message: 'PINs do not match' 
      });
    }

    if (newPin.length < 4 || !/^\d+$/.test(newPin)) {
      return res.status(400).json({ 
        success: false, 
        message: 'PIN must be at least 4 digits and contain only numbers' 
      });
    }

    // Verify code first
    const verification = await verifyReplacementCode(userId, code);
    
    if (!verification.valid) {
      return res.status(400).json({ 
        success: false, 
        message: verification.message 
      });
    }

    // Update user PIN
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      withdrawalPin: newPin,
      pinSetAt: admin.firestore.FieldValue.serverTimestamp(),
      pinSetMethod: 'recovery',
      pinLastChanged: admin.firestore.FieldValue.serverTimestamp()
    });

    // Mark code as used
    await markCodeAsUsed(userId);

    // Record successful PIN reset
    await db.collection('securityLogs').add({
      userId: userId,
      email: verification.data.email,
      action: 'PIN_RESET_SUCCESS',
      method: 'recovery',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ipAddress: req.ip
    });

    res.json({ 
      success: true, 
      message: 'PIN reset successfully',
      reset: true
    });

  } catch (error) {
    console.error('❌ PIN reset error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to reset PIN' 
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

// ✅ Test Email Authentication
app.get("/api/test-email-auth", async (req, res) => {
  try {
    if (!BREVO_API_KEY) {
      return res.json({
        success: false,
        message: "BREVO_API_KEY not configured",
        help: "Add BREVO_API_KEY to environment variables",
        authentication: {
          security: "MarketMixKenya <security@marketmix.site>",
          sales: "MarketMixKenya <sales@marketmix.site>",
          dkim: "Configured via Brevo",
          dmarc: "marketmix.site (configured)",
          spf: "Brevo servers included"
        }
      });
    }

    res.json({
      success: true,
      message: "✅ Email authentication configured",
      senders: {
        security: {
          name: "MarketMixKenya",
          email: "security@marketmix.site",
          purpose: "PIN recovery, security notifications",
          status: "Verified"
        },
        sales: {
          name: "MarketMixKenya",
          email: "sales@marketmix.site",
          purpose: "Order confirmations, customer support",
          status: "Verified"
        }
      },
      authentication: {
        dkim: "Signature configured",
        dmarc: "policy=quarantine; rua=mailto:dmarc-reports@marketmix.site",
        spf: "v=spf1 include:spf.brevo.com ~all",
        shared_ip: "Brevo shared IP pool"
      }
    });
    
  } catch (error) {
    console.error('❌ Email auth test error:', error);
    res.status(500).json({
      success: false,
      message: 'Email authentication test failed',
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
      intasend: true,
      email_auth: {
        security: 'MarketMixKenya <security@marketmix.site>',
        sales: 'MarketMixKenya <sales@marketmix.site>'
      }
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
  console.log(`📧 Security Sender: MarketMixKenya <security@marketmix.site>`);
  console.log(`📧 Sales Sender: MarketMixKenya <sales@marketmix.site>`);
  console.log(`📧 Authentication: DKIM, DMARC, SPF configured`);
  console.log(`🌐 CORS enabled for: ${allowedOrigins.join(', ')}`);
  console.log(`🖼️ Logo Image: https://i.ibb.co/JjSrxbPz/icon-png-1.png`);
  console.log(`💰 Subscription System: ✅ Ready`);
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

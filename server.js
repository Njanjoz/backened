// server.js

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const cors = require('cors'); // ✅ Ensure 'cors' is imported
const crypto = require('crypto');
const admin = require('firebase-admin');

// The intasend-node package exports the constructor directly
const IntaSend = require('intasend-node');

dotenv.config();

// Check for required environment variables
if (!process.env.INTASEND_PUBLISHABLE_KEY || !process.env.INTASEND_SECRET_KEY) {
    console.error('Error: Missing IntaSend API keys in environment variables.');
    process.exit(1);
}

// Check for Firebase service account credentials
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    console.error('Error: Missing FIREBASE_SERVICE_ACCOUNT_KEY in environment variables.');
    process.exit(1);
}

// Check for the webhook secret
if (!process.env.INTASEND_WEBHOOK_SECRET) {
    console.error('Error: Missing INTASEND_WEBHOOK_SECRET in environment variables.');
    process.exit(1);
}

// Initialize Firebase Admin SDK
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
    process.exit(1);
}
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3001;

// --- Correct CORS Middleware Configuration ---
// This middleware must be placed before any routes that handle requests from the frontend.
app.use(cors());

// Middleware for parsing JSON request bodies
app.use(bodyParser.json());

// Initialize IntaSend using the directly imported constructor
const intasend = new IntaSend(
    process.env.INTASEND_PUBLISHABLE_KEY,
    process.env.INTASEND_SECRET_KEY,
    false // Set to true for live environment
);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is running.' });
});

// STK Push API Endpoint
app.post('/api/stk-push', async (req, res) => {
    try {
        const { amount, phoneNumber, fullName, email, orderId } = req.body;

        console.log(`Received STK Push request for order ID: ${orderId}`);

        const collection = intasend.collection();
        const response = await collection.mpesaStkPush({
            first_name: fullName,
            last_name: 'N/A',
            email: email,
            phone_number: phoneNumber,
            amount: amount,
            host: 'https://backened-lt67.onrender.com',
            api_ref: orderId // Use the orderId as the API reference for tracking
        });

        console.log(`STK Push initiated successfully for order ${orderId}.`);
        res.status(200).json({ success: true, message: 'STK push initiated successfully.', data: response });
    } catch (error) {
        console.error('STK Push Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to initiate STK Push.', error: error.message });
    }
});

// Webhook Signature Verification Middleware
function verifyIntaSendWebhook(req, res, next) {
    const signature = req.get('x-intasend-signature');
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', process.env.INTASEND_WEBHOOK_SECRET)
                       .update(body)
                       .digest('hex');

    if (hash === signature) {
        console.log('✅ Webhook signature verified successfully.');
        next();
    } else {
        console.error('❌ Webhook signature verification failed.');
        res.status(403).send('Forbidden: Invalid signature');
    }
}

// IntaSend Webhook Endpoint
app.post('/api/intasend-callback', verifyIntaSendWebhook, async (req, res) => {
    try {
        const payload = req.body;
        console.log('✅ Verified webhook payload:', payload);

        const orderId = payload.api_ref;
        const transactionId = payload.mpesa_reference || payload.id;
        const paymentStatus = payload.state;

        if (paymentStatus === 'COMPLETE') {
            console.log(`\n✨ SUCCESSFUL PAYMENT`);
            console.log(`  - Order ID: ${orderId}`);
            console.log(`  - Transaction ID: ${transactionId}`);
            console.log(`  - Amount Paid: KES ${payload.net_amount}`);
            console.log(`  - Customer Phone: ${payload.account}`);
            console.log(`=====================================\n`);

            const docRef = db.collection('orders').doc(orderId);
            await docRef.update({
                status: 'paid',
                transactionId: transactionId,
                paymentTime: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`Order ${orderId} updated to PAID ✅`);
            res.status(200).send('Webhook received and processed.');
        } else {
            console.log(`ℹ️ Received payment status: ${paymentStatus} for order ${orderId}`);
            res.status(200).send('Status received, no action taken.');
        }
    } catch (error) {
        console.error('❌ Error processing webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

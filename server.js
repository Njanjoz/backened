/**
 * server.js - A complete Node.js server with a secure IntaSend webhook handler.
 * This file is designed to be a replacement for a backend server.
 */

// 1. Import necessary libraries
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');

// 2. Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// 3. Initialize Firebase Admin SDK
// This assumes you have your service account key stored as an environment variable
// on your server (e.g., in a .env file or on Render).
// Replace the placeholders with your actual variable names if they differ.
// Example: If you pasted the JSON key directly, make sure to parse it correctly.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?
  JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY) :
  { projectId: 'your-project-id' }; // Fallback for local testing
  
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Get a reference to the Firestore database
const db = admin.firestore();

// 4. IntaSend Webhook Secret
// Make sure this environment variable is set on your server.
const intaSendWebhookSecret = process.env.INTASEND_WEBHOOK_SECRET;
if (!intaSendWebhookSecret) {
    console.error('❌ INTASEND_WEBHOOK_SECRET environment variable is not set!');
    process.exit(1);
}

// 5. Webhook Signature Verification Middleware
// This function verifies that the request came from IntaSend.
function verifyIntaSendWebhook(req, res, next) {
    const signature = req.get('x-intasend-signature');
    const body = JSON.stringify(req.body);

    // Create a SHA-256 HMAC hash of the request body using your secret key
    const hash = crypto.createHmac('sha256', intaSendWebhookSecret)
                       .update(body)
                       .digest('hex');

    // Compare the generated hash with the signature from the request header
    if (hash === signature) {
        console.log('✅ Webhook signature verified successfully.');
        next(); // Proceed to the webhook handler
    } else {
        console.error('❌ Webhook signature verification failed.');
        res.status(403).send('Forbidden: Invalid signature');
    }
}

// 6. Define the webhook endpoint
app.post('/api/intasend-callback', bodyParser.json(), verifyIntaSendWebhook, async (req, res) => {
    try {
        const payload = req.body;
        console.log('✅ Verified webhook payload:', payload);

        // Use the correct payload fields based on the IntaSend documentation
        const orderId = payload.api_ref; // The API reference you used for the STK Push
        const transactionId = payload.mpesa_reference || payload.id;
        const paymentStatus = payload.state;

        if (paymentStatus === 'COMPLETE') {
            console.log(`\n✨ SUCCESSFUL PAYMENT`);
            console.log(`  - Order ID: ${orderId}`);
            console.log(`  - Transaction ID: ${transactionId}`);
            console.log(`  - Amount Paid: KES ${payload.net_amount}`);
            console.log(`  - Customer Phone: ${payload.account}`);
            console.log(`=====================================\n`);

            // --- Your "Print Order" / Database Update Logic ---
            // 1. Get a reference to the order document in Firestore.
            const docRef = db.collection('orders').doc(orderId);

            // 2. Update the document with the new payment status and transaction details.
            await docRef.update({
                status: 'paid',
                transactionId: transactionId,
                paymentTime: admin.firestore.FieldValue.serverTimestamp(),
                paidAmount: payload.net_amount,
                payerPhone: payload.account
            });

            console.log(`Order ${orderId} updated to PAID ✅`);
            
            // Send a 200 OK response to IntaSend to stop them from retrying.
            res.status(200).send('Webhook received and processed.');
        } else {
            // Handle other states like 'FAILED' or 'PENDING' if needed
            console.log(`ℹ️ Received payment status: ${paymentStatus} for order ${orderId}`);
            res.status(200).send('Status received, no action taken.');
        }

    } catch (error) {
        console.error('❌ Error processing webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

// 7. Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

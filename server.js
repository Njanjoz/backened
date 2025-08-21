// server.js

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const IntaSend = require('intasend-node');
const cors = require('cors');

// Import Firebase Admin SDK
const admin = require('firebase-admin');

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

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Initialize IntaSend
const intasend = new IntaSend(
    process.env.INTASEND_PUBLISHABLE_KEY,
    process.env.INTASEND_SECRET_KEY,
    false // Set to true for live environment
);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is running.' });
});

// STK Push API Endpoint - This is called by the frontend to initiate a payment
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
            host: process.env.REACT_APP_FRONTEND_URL,
            api_ref: orderId // Use the orderId as the API reference for tracking
        });

        console.log(`STK Push initiated successfully for order ${orderId}.`);
        res.status(200).json({ success: true, message: 'STK push initiated successfully.', data: response });
    } catch (error) {
        console.error('STK Push Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to initiate STK Push.', error: error.message });
    }
});

// Status Polling Endpoint - This is called by the frontend to check the payment status
app.get('/api/orders/:orderId/status', async (req, res) => {
    try {
        const { orderId } = req.params;
        const orderDocRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderDocRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        const data = orderDoc.data();
        res.status(200).json({ success: true, status: data.paymentStatus });
    } catch (error) {
        console.error('Error fetching order status:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch order status.', error: error.message });
    }
});

// IntaSend Webhook Endpoint - This is called by IntaSend automatically
app.post('/api/intasend-callback', async (req, res) => {
    const transaction = req.body;
    console.log("IntaSend Callback received:", transaction);

    try {
        // Verify the webhook's authenticity using IntaSend's built-in handler
        const callback = intasend.callback({
            public_key: process.env.INTASEND_PUBLISHABLE_KEY,
            secret_key: process.env.INTASEND_SECRET_KEY,
        });

        const verified = callback.verify(req.body);

        if (!verified) {
            console.error('Webhook verification failed.');
            return res.status(403).json({ success: false, message: 'Invalid callback signature.' });
        }

        const orderId = transaction.api_ref;
        const paymentStatus = transaction.state; // 'COMPLETE' or 'FAILED'

        let statusToUpdate = 'failed';
        if (paymentStatus === 'COMPLETE') {
            statusToUpdate = 'paid';
        } else if (paymentStatus === 'FAILED') {
            statusToUpdate = 'failed';
        } else {
            console.warn(`Unexpected payment state from IntaSend: ${paymentStatus}`);
            return res.status(200).json({ success: true, message: "OK" });
        }

        // Update the order document in Firestore with the final status
        const orderRef = db.collection('orders').doc(orderId);
        await orderRef.update({
            paymentStatus: statusToUpdate,
            paymentDetails: {
                transactionId: transaction.receipt_number || 'N/A',
                amount: transaction.amount || 'N/A',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            }
        });

        console.log(`Order ${orderId} updated to status: ${statusToUpdate}`);

        // IntaSend expects a simple 200 OK response to confirm receipt
        res.status(200).json({ success: true, message: "Callback received" });
    } catch (error) {
        console.error('Error processing IntaSend callback:', error.message);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

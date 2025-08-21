// server.js

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const cors = require('cors');
const admin = require('firebase-admin');

// --- FINAL FIX START ---
// The package exports the constructor directly, so we require it and assign it
// to the variable name we want to use.
const IntaSend = require('intasend-node');
const Callback = IntaSend.Callback; // Access the Callback class from the main export
// --- FINAL FIX END ---

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

// --- FINAL FIX START ---
// Initialize IntaSend using the directly imported constructor
const intasend = new IntaSend(
    process.env.INTASEND_PUBLISHABLE_KEY,
    process.env.INTASEND_SECRET_KEY,
    false // Set to true for live environment
);
// --- FINAL FIX END ---

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

// IntaSend Webhook Endpoint - This is called by IntaSend automatically
app.post('/api/intasend-callback', async (req, res) => {
    const transaction = req.body;
    console.log("IntaSend Callback received:", transaction);

    try {
        // --- FINAL FIX START ---
        // Initialize Callback using the directly imported constructor
        const callback = new Callback({
            public_key: process.env.INTASEND_PUBLISHABLE_KEY,
            secret_key: process.env.INTASEND_SECRET_KEY,
        });
        const verified = callback.verify(req.body);
        // --- FINAL FIX END ---

        if (!verified) {
            console.error('Webhook verification failed.');
            return res.status(403).json({ success: false, message: 'Invalid callback signature.' });
        }
        
        const orderId = transaction.api_ref;
        const paymentStatus = transaction.state;

        let statusToUpdate;
        if (paymentStatus === 'COMPLETE') {
            statusToUpdate = 'paid';
        } else if (paymentStatus === 'FAILED') {
            statusToUpdate = 'failed';
        } else if (paymentStatus === 'PROCESSING' || paymentStatus === 'PENDING') {
            console.warn(`Ignoring webhook with status: ${paymentStatus}.`);
            return res.status(200).json({ success: true, message: "OK, nothing to update" });
        }

        // Update the order document in Firestore with the final status
        const orderRef = db.collection('orders').doc(orderId);
        await orderRef.update({
            paymentStatus: statusToUpdate,
            paymentDetails: {
                transactionId: transaction.mpesa_reference || 'N/A',
                amount: transaction.net_amount || 'N/A',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            }
        });

        console.log(`Order ${orderId} updated to status: ${statusToUpdate}`);

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

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const IntaSend = require('intasend-node');
const cors = require('cors'); 
const admin = require('firebase-admin');

dotenv.config(); 

const app = express();
const PORT = process.env.PORT || 3001;

// Define a list of allowed origins for CORS.
// This is crucial for local testing where your frontend is on a different domain/port.
const allowedOrigins = [
  'http://localhost:5173', // Your frontend's local development server
  'https://backened-lt67.onrender.com' // Your deployed backend
];

// Configure CORS middleware to check if the incoming request origin is allowed.
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // If the origin is in our allowed list, permit the request.
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

// Middleware
app.use(bodyParser.json());

// Check for all necessary environment variables
if (!process.env.INTASEND_PUBLISHABLE_KEY || !process.env.INTASEND_SECRET_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    console.error('Error: Missing required environment variables.');
    process.exit(1);
}

// Initialize Firebase Admin SDK
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
} catch (e) {
  console.error('Error initializing Firebase Admin SDK:', e);
  process.exit(1);
}

const db = admin.firestore();

// Initialize IntaSend
const intasend = new IntaSend(
    process.env.INTASEND_PUBLISHABLE_KEY,
    process.env.INTASEND_SECRET_KEY,
    false // false = sandbox, true = live
);

// ============================
// Routes
// ============================

// STK Push initiation
app.post('/api/stk-push', async (req, res) => {
    try {
        const { amount, phoneNumber, fullName, email } = req.body;

        // CRITICAL VALIDATION: Check for missing fields before making the API call
        if (!amount || !phoneNumber || !fullName || !email) {
            console.error('Validation Error: Missing required fields in request body.');
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields (amount, phoneNumber, fullName, or email).' 
            });
        }

        const collection = intasend.collection();
        const response = await collection.mpesaStkPush({
            first_name: fullName,
            last_name: 'N/A',
            email: email,
            phone_number: phoneNumber,
            amount: amount,
            host: process.env.BACKEND_URL || "https://backened-lt67.onrender.com", 
            api_ref: `order_${Date.now()}`
        });

        // Save the initial transaction to Firestore with a 'pending' status
        const docRef = db.collection('payments').doc(response.invoice.invoice_id);
        await docRef.set({
            invoiceId: response.invoice.invoice_id,
            apiRef: response.invoice.api_ref,
            status: 'PENDING',
            amount: amount,
            phoneNumber: phoneNumber,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Initial transaction stored in Firestore: ${response.invoice.invoice_id}`);
        
        res.status(200).json({ success: true, data: response });
    } catch (error) {
        console.error('STK Push Error:', error);
        res.status(500).json({ success: false, message: 'Failed to initiate STK Push.', error: error.message });
    }
});

// IntaSend callback endpoint
app.post('/api/intasend-callback', async (req, res) => {
    console.log("IntaSend callback received:", req.body);
    
    // Check for the required data from the callback
    const invoiceId = req.body.invoice_id;
    const state = req.body.state;
    const mpesaReference = req.body.mpesa_reference || null;

    if (invoiceId && state) {
        // Update the document in Firestore with the new state
        const docRef = db.collection('payments').doc(invoiceId);
        try {
            await docRef.update({
                status: state,
                mpesaReference: mpesaReference,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Transaction ${invoiceId} updated to status: ${state}`);
        } catch (error) {
            console.error(`Error updating transaction ${invoiceId} in Firestore:`, error);
        }
    }

    // Always acknowledge callback to IntaSend
    res.status(200).send("OK");
});

// New endpoint for frontend to check transaction status
app.get('/api/transaction/:invoiceId', async (req, res) => {
    try {
        const invoiceId = req.params.invoiceId;
        const docRef = db.collection('payments').doc(invoiceId);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, message: 'Transaction not found.' });
        }

        const data = doc.data();
        res.status(200).json({ success: true, data: data });
    } catch (error) {
        console.error('Error fetching transaction status:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch transaction status.', error: error.message });
    }
});


// ============================
// Start Server
// ============================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

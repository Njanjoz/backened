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

        // CRITICAL: Log the incoming data to see exactly what is being received
        console.log('Incoming STK Push request data:', { amount, phoneNumber, fullName, email });

        // More specific validation checks
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount.' });
        }
        
        // --- IMPROVEMENT 1: Phone number validation
        // Use a regex to strictly validate the number format for M-Pesa
        const phoneRegex = /^(2547|2541)\d{8}$/;
        if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
            return res.status(400).json({ success: false, message: 'Invalid phone number format. Use 2547XXXXXXXX or 2541XXXXXXXX.' });
        }

        if (!fullName || fullName.trim() === '') {
            return res.status(400).json({ success: false, message: 'Full name is required.' });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, message: 'Invalid email address.' });
        }

        // --- IMPROVEMENT 2: Split full name
        const names = fullName.trim().split(" ");
        const firstName = names[0];
        const lastName = names.slice(1).join(" ") || "N/A";
        
        const collection = intasend.collection();
        const response = await collection.mpesaStkPush({
            first_name: firstName,
            last_name: lastName,
            email: email,
            phone_number: phoneNumber, // Use the validated number directly
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
        // --- IMPROVEMENT 3: Better error logging
        console.error('STK Push Error raw:', error);
        let errorMessage = 'Failed to initiate STK Push.';

        if (error.response && error.response.data) {
            console.error('STK Push Error parsed:', error.response.data);
            try {
                const parsedError = JSON.parse(error.response.data.toString());
                errorMessage = parsedError.error_message || JSON.stringify(parsedError);
            } catch (e) {
                errorMessage = error.response.data.toString();
            }
        } else if (Buffer.isBuffer(error)) {
            errorMessage = error.toString();
        } else {
            errorMessage = error.message || error.toString();
        }

        res.status(500).json({
            success: false,
            message: errorMessage
        });
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
            await docRef.set({
                status: state,
                mpesaReference: mpesaReference,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true }); // Use set with merge: true to create or update the document

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

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
        const { amount, phoneNumber, fullName, email, orderId } = req.body; // Receive orderId from the frontend

        // CRITICAL: Log the incoming data to see exactly what is being received
        console.log('Incoming STK Push request data:', { amount, phoneNumber, fullName, email, orderId });

        // More specific validation checks
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount.' });
        }
        
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

        const names = fullName.trim().split(" ");
        const firstName = names[0];
        const lastName = names.slice(1).join(" ") || "N/A";
        
        const collection = intasend.collection();
        const response = await collection.mpesaStkPush({
            first_name: firstName,
            last_name: lastName,
            email: email,
            phone_number: phoneNumber,
            amount: amount,
            host: process.env.BACKEND_URL || "https://backened-lt67.onrender.com", 
            api_ref: orderId // CRITICAL: Use the orderId as the API reference
        });

        // The frontend has already created the document, we just need to ensure it exists
        const docRef = db.collection('orders').doc(orderId);
        await docRef.update({
            invoiceId: response.invoice.invoice_id,
            status: 'STK_PUSH_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Initial transaction stored in Firestore: ${orderId}`);
        
        res.status(200).json({ success: true, data: response });
    } catch (error) {
        // Better error logging
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
    
    // The IntaSend callback uses api_ref to pass our orderId
    const { api_ref, state, mpesa_reference } = req.body;
    
    // Check for the required data from the callback
    if (api_ref && state) {
        const orderId = api_ref;
        const orderDocRef = db.collection('orders').doc(orderId);
        
        // CRITICAL: Map IntaSend state to our payment status
        let paymentStatus = 'pending';
        if (state === 'COMPLETE') {
            paymentStatus = 'paid';
        } else if (state === 'FAILED' || state === 'CANCELLED') {
            paymentStatus = 'failed';
        }

        try {
            // Now, update the correct order document with the new state
            await orderDocRef.set({
                paymentStatus: paymentStatus,
                mpesaReference: mpesa_reference || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            console.log(`Order ${orderId} updated to paymentStatus: ${paymentStatus}`);
            
        } catch (error) {
            console.error(`Error updating order ${orderId} in Firestore:`, error);
        }
    } else {
        console.error("Callback data incomplete. Missing api_ref or state.");
    }

    // Always acknowledge callback to IntaSend
    res.status(200).send("OK");
});

// New endpoint for frontend to check transaction status
app.get('/api/transaction/:invoiceId', async (req, res) => {
    try {
        const invoiceId = req.params.invoiceId;
        const docs = await db.collection('orders').where('invoiceId', '==', invoiceId).get();

        if (docs.empty) {
            return res.status(404).json({ success: false, message: 'Transaction not found.' });
        }

        const data = docs.docs[0].data();
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

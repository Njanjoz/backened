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
// Define a list of allowed origins for CORS.
const allowedOrigins = [
  'http://localhost:5173', // Your frontend's local development server
  'https://backened-lt67.onrender.com', // Your deployed backend
  'https://my-campus-store-frontend.vercel.app',
  'https://marketmix.site', // ✅ Added your production frontend
  'https://localhost' // ADDED FOR CAPACITOR ANDROID APPS
];


// Configure CORS middleware to check if the incoming request origin is allowed.
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
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
        const { amount, phoneNumber, fullName, email, orderId } = req.body; 

        console.log('Incoming STK Push request data:', { amount, phoneNumber, fullName, email, orderId });

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount.' });
        }
        
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
            host: process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com", 
            api_ref: orderId 
        });

        const docRef = db.collection('orders').doc(orderId);
        await docRef.update({
            invoiceId: response.invoice.invoice_id,
            status: 'STK_PUSH_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Initial transaction stored in Firestore: ${orderId}`);
        
        res.status(200).json({ success: true, data: response });
    } catch (error) {
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
    
    const { api_ref, state, mpesa_reference } = req.body;
    
    if (api_ref && state) {
        const orderId = api_ref;
        const orderDocRef = db.collection('orders').doc(orderId);
        
        let paymentStatus = 'pending';
        if (state === 'COMPLETE') {
            paymentStatus = 'paid';
        } else if (state === 'FAILED' || state === 'CANCELLED') {
            paymentStatus = 'failed';
        }

        try {
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
// NEW: Route to Update Product Stock
// ============================
app.post('/api/update-stock', async (req, res) => {
    try {
        const { productId, quantity } = req.body;

        if (!productId || typeof quantity !== 'number' || quantity <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid product ID or quantity.' });
        }

        // Use a Firestore transaction to ensure the stock is updated atomically
        const productRef = db.collection('products').doc(productId);

        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(productRef);

            if (!doc.exists) {
                console.error(`Attempted to update stock for non-existent product: ${productId}`);
                return res.status(404).json({ success: false, message: 'Product not found.' });
            }

            const currentQuantity = doc.data().quantity || 0;
            const newQuantity = currentQuantity - quantity;
            
            if (newQuantity < 0) {
                console.error(`Insufficient stock for product ${productId}. Current: ${currentQuantity}, Ordered: ${quantity}`);
                return res.status(400).json({ success: false, message: 'Not enough stock available.' });
            }

            transaction.update(productRef, { quantity: newQuantity });
        });

        console.log(`Stock for product ${productId} updated successfully.`);
        res.status(200).json({ success: true, message: 'Inventory updated successfully.' });

    } catch (error) {
        console.error('Error updating inventory:', error);
        res.status(500).json({ success: false, message: 'Failed to update inventory.', error: error.message });
    }
});


// ============================
// Start Server
// ============================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// FULL BACKEND CODE REPLACEMENT (server.js or index.js)

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
const allowedOrigins = [
    'http://localhost:5173', // Your frontend's local development server
    'https://backened-lt67.onrender.com', // Your deployed backend
    'https://my-campus-store-frontend.vercel.app',
    'https://marketmix.site', // Your production frontend
    'http://localhost', // ADDED FOR CAPACITOR ANDROID APPS (NOTE: http:// is required)
    'capacitor://localhost' // ADDED FOR CAPACITOR (secure context)
];


// Configure CORS middleware to check if the incoming request origin is allowed.
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps/curl/postman/same-server calls)
        if (!origin) return callback(null, true);
        
        // Check if the origin is in our allowed list
        if (allowedOrigins.indexOf(origin) === -1) {
            // For debugging, log the blocked origin
            console.warn(`CORS block: Origin not allowed: ${origin}`);
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true, // Allow cookies/authorization headers
    optionsSuccessStatus: 204
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
// Constants
// ============================
const WITHDRAWAL_FEE_RATE = 0.055; // 5.5% fee

// ============================
// Routes
// ============================

// STK Push initiation (Existing Code)
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

// IntaSend callback endpoint (Existing Code)
app.post('/api/intasend-callback', async (req, res) => {
    console.log("IntaSend callback received:", req.body);
    
    const { api_ref, state, mpesa_reference } = req.body;
    
    if (api_ref && state) {
        // NOTE: This logic assumes the callback is for an STK collection (order).
        // You MUST implement additional logic to check if api_ref belongs to an order or a withdrawal record
        // if you use this endpoint for both.

        const docRef = db.collection('orders').doc(api_ref); // Assuming api_ref is the orderId
        
        let paymentStatus = 'pending';
        if (state === 'COMPLETE') {
            paymentStatus = 'paid';
        } else if (state === 'FAILED' || state === 'CANCELLED') {
            paymentStatus = 'failed';
        }

        try {
            await docRef.set({
                paymentStatus: paymentStatus,
                mpesaReference: mpesa_reference || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            console.log(`Order ${api_ref} updated to paymentStatus: ${paymentStatus}`);
            
        } catch (error) {
            console.error(`Error updating document ${api_ref} in Firestore:`, error);
        }
    } else {
        console.error("Callback data incomplete. Missing api_ref or state.");
    }

    res.status(200).send("OK");
});

// New endpoint for frontend to check transaction status (Existing Code)
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

// ============================================
// REVISED: Seller Withdrawal Endpoint (5.5% Fee)
// ============================================
app.post('/api/seller/withdraw', async (req, res) => {
    let withdrawalDocRef;
    const { sellerId, amount: requestedAmount, phoneNumber } = req.body;
    
    try {
        if (!sellerId || !requestedAmount || isNaN(requestedAmount) || requestedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid seller ID or amount.' });
        }

        const amount = parseFloat(requestedAmount);
        
        // Basic phone number validation
        const phoneRegex = /^(2547|2541)\d{8}$/;
        if (!phoneNumber || !phoneRegex.test(phoneNumber)) {
            return res.status(400).json({ success: false, message: 'Invalid M-Pesa phone number format. Use 2547XXXXXXXX or 2541XXXXXXXX.' });
        }

        const netPayoutAmount = parseFloat((amount * (1 - WITHDRAWAL_FEE_RATE)).toFixed(2));
        const feeAmount = parseFloat((amount * WITHDRAWAL_FEE_RATE).toFixed(2));
        
        const userRef = db.collection('users').doc(sellerId);
        
        // --- 1. Firestore Transaction: Check Balance & Deduct (Phase 1) ---
        // This MUST be the first step to lock the balance.
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                throw new Error('Seller account not found.');
            }
            
            const currentBalance = userDoc.data().revenue || 0; 
            
            if (currentBalance < amount) {
                throw new Error('Insufficient withdrawable balance.');
            }

            // Deduct the full requested amount from the seller's balance
            const newBalance = currentBalance - amount;

            // Update the balance 
            transaction.update(userRef, {
                revenue: newBalance, // BALANCE IS DEDUCTED HERE (frontend updates instantly)
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            
            // Log transaction to a 'withdrawals' collection (PENDING_PAYOUT)
            withdrawalDocRef = db.collection('withdrawals').doc();
            transaction.set(withdrawalDocRef, {
                sellerId,
                requestedAmount: amount,
                feeAmount: feeAmount,
                netPayoutAmount: netPayoutAmount,
                phoneNumber,
                status: 'PENDING_PAYOUT', 
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });

        // Balance is now deducted in Firestore. Next, attempt the external Payout.

        // --- 2. Initiate IntaSend Payout (B2C M-Pesa Disbursement) ---
        const payouts = intasend.payouts();
        const apiRef = withdrawalDocRef.id; // Use the withdrawal document ID as the API reference
        
        const payoutResponse = await payouts.b2c({
            phone_number: phoneNumber,
            amount: netPayoutAmount, // Payout the net amount after fee
            api_ref: apiRef,
            // Use the same host for the callback, best practice is to have a dedicated payout callback URL
            host: process.env.RENDER_BACKEND_URL || "https://backened-lt67.onrender.com", 
        });

        // --- 3. Update Status in Firestore with IntaSend Reference (Success) ---
        await withdrawalDocRef.update({
            trackingId: payoutResponse.tracking_id, // IntaSend tracking ID
            status: 'PAYOUT_INITIATED',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            intasendResponse: payoutResponse,
        });

        res.status(200).json({ 
            success: true, 
            message: 'Withdrawal initiated successfully. Check your phone for the M-Pesa notification.', 
            data: {
                requestedAmount: amount,
                fee: feeAmount,
                netPayout: netPayoutAmount,
                trackingId: payoutResponse.tracking_id,
            }
        });

    } catch (error) {
        console.error('Seller Withdrawal Error (General Catch):', error);
        
        // --- CRITICAL REVERSAL LOGIC (Phase 2 Failure) ---
        // If the error occurred AFTER the Firestore transaction completed (i.e., step 2 failed),
        // we MUST reverse the balance deduction.
        if (withdrawalDocRef && withdrawalDocRef.id) {
            try {
                // Read the existing document for verification before reversing
                const withdrawalDoc = await withdrawalDocRef.get();
                const currentStatus = withdrawalDoc.data()?.status;

                // Only attempt reversal if the payout never started or failed to initiate
                if (currentStatus === 'PENDING_PAYOUT') {
                    // Start a new transaction to reverse the balance safely
                    await db.runTransaction(async (transaction) => {
                        const userDoc = await transaction.get(userRef);
                        const currentRevenue = userDoc.data().revenue || 0;
                        const reversedAmount = parseFloat(requestedAmount); // Reverse the full amount deducted

                        transaction.update(userRef, {
                            revenue: currentRevenue + reversedAmount, // REVERSE DEDUCTION
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });

                        // Update the withdrawal record to reflect the failure and reversal
                        transaction.update(withdrawalDocRef, {
                            status: 'PAYOUT_FAILED_REVERSED',
                            reversalReason: `IntaSend API call failed: ${error.message || 'Unknown API error.'}`,
                            reversalTime: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    });
                    
                    console.log(`CRITICAL: Balance of KSH ${requestedAmount} reversed for seller ${sellerId} due to IntaSend failure.`);
                }
            } catch (reversalError) {
                console.error('CRITICAL: FAILED TO REVERSE BALANCE AFTER PAYOUT FAILURE:', reversalError);
                // ALERT: At this point, you must log/alert for manual intervention!
            }
        }
        
        // Check for specific Firestore transaction errors (like Insufficient balance)
        if (error.message.includes('Insufficient withdrawable balance.')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (error.message.includes('Seller account not found.')) {
            return res.status(404).json({ success: false, message: error.message });
        }
        
        // General error response
        res.status(500).json({ 
            success: false, 
            message: 'A critical error occurred. The withdrawal may have been reversed. Please try again or contact support.', 
            error: error.message 
        });
    }
});


// New: Route to Update Product Stock (Existing Code)
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
                throw new Error('Product not found.'); // Throw inside transaction to handle error
            }

            const currentQuantity = doc.data().quantity || 0;
            const newQuantity = currentQuantity - quantity;
            
            if (newQuantity < 0) {
                console.error(`Insufficient stock for product ${productId}. Current: ${currentQuantity}, Ordered: ${quantity}`);
                throw new Error('Not enough stock available.');
            }

            transaction.update(productRef, { quantity: newQuantity });
        });

        console.log(`Stock for product ${productId} updated successfully.`);
        res.status(200).json({ success: true, message: 'Inventory updated successfully.' });

    } catch (error) {
        console.error('Error updating inventory:', error);
        
        let message = 'Failed to update inventory.';
        if (error.message.includes('Product not found')) {
             message = 'Product not found.';
             return res.status(404).json({ success: false, message });
        }
        if (error.message.includes('Not enough stock available')) {
             message = 'Not enough stock available.';
             return res.status(400).json({ success: false, message });
        }

        res.status(500).json({ success: false, message: message, error: error.message });
    }
});


// ============================
// Start Server
// ============================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

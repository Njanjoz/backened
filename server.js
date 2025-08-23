// server.js

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const IntaSend = require('intasend-node');
const cors = require('cors'); 

dotenv.config(); 

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(bodyParser.json());
app.use(cors()); 

// Check for API keys before starting the server
if (!process.env.INTASEND_PUBLISHABLE_KEY || !process.env.INTASEND_SECRET_KEY) {
    console.error('Error: Missing IntaSend API keys in environment variables.');
    process.exit(1);
}

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

        res.status(200).json({ success: true, data: response });
    } catch (error) {
        console.error('STK Push Error:', error);
        res.status(500).json({ success: false, message: 'Failed to initiate STK Push.', error: error.message });
    }
});

// IntaSend callback endpoint
app.post('/api/intasend-callback', (req, res) => {
    console.log("IntaSend callback received:", req.body);

    // 👉 TODO: Save transaction details to DB or update order status here

    // Always acknowledge callback
    res.status(200).send("OK");
});

// ============================
// Start Server
// ============================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

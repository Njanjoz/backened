const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const IntaSend = require('intasend-node');
const cors = require('cors'); 

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

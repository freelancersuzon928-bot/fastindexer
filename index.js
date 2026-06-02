const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// LowDB Setup
const adapter = new FileSync('db.json');
const db = low(adapter);

// Initialize Default Schema
db.defaults({ requests: [] }).write();

const app = express();
const PORT = 3000;

// Middleware Setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static Files Folder
app.use(express.static(path.join(__dirname, 'public')));

// Simple test route to ensure server works
app.get('/api/health', (req, res) => {
    res.json({ status: "alive", message: "FastIndexer backend is responding!" });
});

// POST Route to Handle Indexing Submissions (Frontend Plan Selection)
app.post('/api/submit', (req, res) => {
    try {
        const { plan, urls, senderNumber, txnid, gateway, customJson } = req.body;

        // Basic Validation
        if (!plan || !urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ success: false, message: "Required fields or URLs are missing!" });
        }

        let status = "pending";
        let expiryDate = null;
        const requestedAt = new Date().toISOString();

        // 4 Packages Pricing Logic Validation
        if (plan === "free_trial") {
            if (urls.length > 5) {
                return res.status(400).json({ success: false, message: "Free trial limit is 5 URLs max!" });
            }
            status = "approved"; // Auto-approve free trial
        } else {
            // Paid plans (starter, 6_months, 1_year) validation
            if (!senderNumber || !txnid || !gateway) {
                return res.status(400).json({ success: false, message: "Payment details missing for paid plan!" });
            }

            let currentDate = new Date();
            if (plan === "starter") {
                expiryDate = "one-time-credit";
            } else if (plan === "6_months") {
                currentDate.setMonth(currentDate.getMonth() + 6);
                expiryDate = currentDate.toISOString();
            } else if (plan === "1_year") {
                currentDate.setFullYear(currentDate.getFullYear() + 1);
                expiryDate = currentDate.toISOString();
            }
        }

        // Object structure to save inside LowDB (db.json)
        const newRequest = {
            id: Date.now().toString(),
            plan,
            urls,
            senderNumber: senderNumber || null,
            txnid: txnid || null,
            gateway: gateway || null,
            customJson: customJson || null,
            status,
            requestedAt,
            expiryDate
        };

        // Push data to db.json array
        db.get('requests').push(newRequest).write();

        return res.status(200).json({
            success: true,
            message: plan === "free_trial" ? "Free trial processed instantly!" : "Payment submitted for verification!",
            data: newRequest
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API Route to Process Google Indexing Requests
app.post('/api/index-now', async (req, res) => {
    try {
        const { urls, customJson } = req.body;

        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ success: false, message: "No URLs provided for indexing!" });
        }

        let serviceAccountKey;

        if (customJson) {
            try {
                serviceAccountKey = typeof customJson === 'string' ? JSON.parse(customJson) : customJson;
            } catch (e) {
                return res.status(400).json({ success: false, message: "Invalid JSON format in Service Account Key!" });
            }
        } else {
            try {
                serviceAccountKey = require('./service-account.json');
            } catch (e) {
                return res.status(500).json({ success: false, message: "Default service-account.json file is missing on server!" });
            }
        }

        const indexResults = [];
        for (const url of urls) {
            const result = await sendToGoogleIndexer(serviceAccountKey, url.trim());
            indexResults.push(result);
        }

        return res.status(200).json({
            success: true,
            message: "Indexing process completed!",
            results: indexResults
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API to Get All Requests for Admin Panel
app.get('/api/admin/requests', (req, res) => {
    try {
        const requests = db.get('requests').value() || [];
        return res.status(200).json({ success: true, data: requests });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// API to Approve a Payment Request Manually
app.post('/api/admin/approve', (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: "Request ID is required!" });

        db.get('requests')
          .find({ id: id })
          .assign({ status: 'approved' })
          .write();

        return res.status(200).json({ success: true, message: "Payment successfully approved!" });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback Middleware for Single Page Application (Must be placed after all API routes)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server started successfully on port ${PORT}`);
});

// Core Google Indexing API Function
async function sendToGoogleIndexer(serviceAccountKey, url, type = 'URL_UPDATED') {
    try {
        const jwtClient = new google.auth.JWT(
            serviceAccountKey.client_email,
            null,
            serviceAccountKey.private_key,
            ['https://www.googleapis.com/auth/indexing'],
            null
        );

        await jwtClient.authorize();

        const response = await google.indexing({ version: 'v3', auth: jwtClient }).urlNotifications.publish({
            requestBody: {
                url: url,
                type: type
            }
        });

        return { success: true, url, data: response.data };
    } catch (error) {
        return { success: false, url, error: error.message };
    }
}
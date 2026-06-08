// =============================================
//     FastIndexer - Backend Server
//     MongoDB + Credit + Auth System + Resend Email + Google Indexing API
// =============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');
const { Resend } = require('resend');
const { google } = require('googleapis');
const serviceAccount = require('./service-account.json');

const app = express();
const PORT = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'your@email.com';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const onlineUsers = new Map();
function cleanOldSessions() {
  const now = Date.now();
  for (const [id, lastSeen] of onlineUsers.entries()) {
    if (now - lastSeen > 60000) onlineUsers.delete(id);
  }
}
setInterval(cleanOldSessions, 30000);

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'fastindexer_salt').digest('hex');
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

const userSchema = new mongoose.Schema({
  email:         { type: String, required: true, unique: true },
  name:          { type: String, default: 'User' },
  password:      { type: String, default: '' },
  credit:        { type: Number, default: 0 },
  plan:          { type: String, default: 'Free' },
  indexnowKey:  { type: String, default: '' },
  indexnowHost: { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const siteSchema = new mongoose.Schema({
  host:        { type: String, required: true, unique: true },
  indexnowKey: { type: String, required: true },
  label:       { type: String, default: '' },
  addedAt:     { type: Date, default: Date.now }
});
const Site = mongoose.model('Site', siteSchema);

const submissionSchema = new mongoose.Schema({
  userEmail:   { type: String, required: true },
  plan:        { type: String, required: true },
  urls:        [String],
  status:      { type: String, default: 'pending' },
  results:     [{ url: String, success: Boolean, method: String, error: String }],
  submittedAt: { type: Date, default: Date.now }
});
const Submission = mongoose.model('Submission', submissionSchema);

const paymentSchema = new mongoose.Schema({
  userEmail:    { type: String, required: true },
  plan:         { type: String, required: true },
  amount:       { type: Number, required: true },
  creditAdded:  { type: Number, required: true },
  senderNumber: { type: String, required: true },
  txnid:        { type: String, required: true },
  status:       { type: String, default: 'pending' },
  submittedAt:  { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);

const PACKAGES = {
  'Free':     { price: 0,    credit: 5    },
  'Starter':  { price: 199,  credit: 50   },
  '6 Months': { price: 1499, credit: 1200 },
  '1 Year':   { price: 2499, credit: 3600 }
};

const PAYMENT_NUMBERS = {
  bkash: '+8801755178188',
  nagad: '+8801907763300'
};

// =============================================
//   GOOGLE INDEXING API
// =============================================

async function sendToGoogleIndexing(urls) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    const authClient = await auth.getClient();
    const indexing = google.indexing({ version: 'v3', auth: authClient });

    const results = await Promise.all(urls.map(async (url) => {
      try {
        await indexing.urlNotifications.publish({
          requestBody: {
            url: url,
            type: 'URL_UPDATED',
          },
        });
        return { url, success: true, method: 'Google' };
      } catch (err) {
        return { url, success: false, method: 'Google', error: err.message };
      }
    }));
    return results;
  } catch (err) {
    return urls.map(url => ({ url, success: false, method: 'Google', error: err.message }));
  }
}

// =============================================
//   EMAIL FUNCTIONS (Resend)
// =============================================

async function sendWelcomeEmail(userEmail, userName, credit) {
  try {
    await resend.emails.send({
      from: 'FastIndexer <noreply@fastindexer.com>',
      to: userEmail,
      subject: '🎉 FastIndexer-এ স্বাগতম! আপনার ' + credit + ' টি Free Credit পেয়েছেন',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 30px;">
          <div style="background: #1a1a2e; padding: 20px; border-radius: 10px; text-align: center;">
            <h1 style="color: #00d4ff; margin: 0;">⚡ FastIndexer</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 15px;">
            <h2 style="color: #333;">স্বাগতম, ${userName}! 🎉</h2>
            <p style="color: #555; font-size: 16px;">আপনার FastIndexer অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে।</p>
            <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <strong style="color: #2e7d32;">🎁 আপনি পেয়েছেন: ${credit} টি Free Credit!</strong>
            </div>
            <p style="color: #555;">এখনই আপনার ওয়েবসাইটের URL গুলো Google-এ index করুন।</p>
            <a href="https://fastindexer-production.up.railway.app" style="display: inline-block; background: #00d4ff; color: #000; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin-top: 10px;">এখনই শুরু করুন →</a>
          </div>
          <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">FastIndexer | Dhaka, Bangladesh</p>
        </div>
      `
    });
    console.log('✅ Welcome email sent to:', userEmail);
  } catch (err) {
    console.error('❌ Welcome email error:', err.message);
  }
}

async function sendPaymentSubmitEmailToAdmin(paymentData) {
  try {
    await resend.emails.send({
      from: 'FastIndexer <noreply@fastindexer.com>',
      to: ADMIN_EMAIL,
      subject: '💰 নতুন Payment Request: ' + paymentData.plan + ' - ' + paymentData.userEmail,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 30px;">
          <div style="background: #1a1a2e; padding: 20px; border-radius: 10px; text-align: center;">
            <h1 style="color: #00d4ff; margin: 0;">⚡ FastIndexer Admin</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 15px;">
            <h2 style="color: #e65100;">💰 নতুন Payment Request!</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px; color: #777; width: 40%;">User Email</td>
                <td style="padding: 10px; font-weight: bold; color: #333;">${paymentData.userEmail}</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px; color: #777;">Plan</td>
                <td style="padding: 10px; font-weight: bold; color: #333;">${paymentData.plan}</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px; color: #777;">Amount</td>
                <td style="padding: 10px; font-weight: bold; color: #4caf50;">৳${paymentData.amount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px; color: #777;">Credit যোগ হবে</td>
                <td style="padding: 10px; font-weight: bold; color: #333;">${paymentData.creditAdded} Credit</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px; color: #777;">Sender Number</td>
                <td style="padding: 10px; font-weight: bold; color: #333;">${paymentData.senderNumber}</td>
              </tr>
              <tr>
                <td style="padding: 10px; color: #777;">Transaction ID</td>
                <td style="padding: 10px; font-weight: bold; color: #e65100;">${paymentData.txnid}</td>
              </tr>
            </table>
            <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <strong style="color: #e65100;">⚠️ Admin Panel থেকে verify করে approve করুন।</strong>
            </div>
            <a href="https://fastindexer-production.up.railway.app/admin.html" style="display: inline-block; background: #ff9800; color: #000; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold;">Admin Panel →</a>
          </div>
        </div>
      `
    });
    console.log('✅ Payment alert email sent to admin');
  } catch (err) {
    console.error('❌ Payment alert email error:', err.message);
  }
}

async function sendPaymentApprovedEmail(userEmail, userName, plan, creditAdded, newCredit) {
  try {
    await resend.emails.send({
      from: 'FastIndexer <noreply@fastindexer.com>',
      to: userEmail,
      subject: '✅ Payment Approved! আপনার ' + creditAdded + ' Credit যোগ হয়েছে',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 30px;">
          <div style="background: #1a1a2e; padding: 20px; border-radius: 10px; text-align: center;">
            <h1 style="color: #00d4ff; margin: 0;">⚡ FastIndexer</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 15px;">
            <h2 style="color: #2e7d32;">✅ Payment Approved!</h2>
            <p style="color: #555; font-size: 16px;">প্রিয় ${userName},</p>
            <p style="color: #555;">আপনার পেমেন্ট সফলভাবে verify করা হয়েছে!</p>
            <div style="background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 5px 0; color: #2e7d32;"><strong>Plan:</strong> ${plan}</p>
              <p style="margin: 5px 0; color: #2e7d32;"><strong>Credit যোগ হয়েছে:</strong> ${creditAdded}</p>
              <p style="margin: 5px 0; color: #2e7d32;"><strong>মোট Credit এখন:</strong> ${newCredit}</p>
            </div>
            <a href="https://fastindexer-production.up.railway.app" style="display: inline-block; background: #4caf50; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; font-weight: bold; margin-top: 10px;">Dashboard এ যান →</a>
          </div>
          <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">FastIndexer | Dhaka, Bangladesh</p>
        </div>
      `
    });
    console.log('✅ Approval email sent to:', userEmail);
  } catch (err) {
    console.error('❌ Approval email error:', err.message);
  }
}

// =============================================

function extractHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function sendToIndexNow(urls, indexnowKey, indexnowHost) {
  return new Promise((resolve) => {
    if (!indexnowKey || !indexnowHost) {
      return resolve(urls.map(url => ({ success: false, url, method: 'IndexNow', error: 'IndexNow key বা host পাওয়া যায়নি।' })));
    }
    const body = JSON.stringify({
      host: indexnowHost, key: indexnowKey,
      keyLocation: `https://${indexnowHost}/${indexnowKey}.txt`,
      urlList: urls
    });
    const options = {
      hostname: 'api.indexnow.org', path: '/indexnow', method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const ok = res.statusCode === 200 || res.statusCode === 202;
        resolve(urls.map(url => ({ success: ok, url, method: 'IndexNow', error: !ok ? `Status: ${res.statusCode}` : null })));
      });
    });
    req.on('error', (e) => { resolve(urls.map(url => ({ success: false, url, method: 'IndexNow', error: e.message }))); });
    req.write(body); req.end();
  });
}

// =============================================
//   AUTH Routes
// =============================================
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password কমপক্ষে ৬ character হতে হবে।' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ success: false, message: 'এই email দিয়ে আগেই account আছে।' });
    const user = await User.create({ email, name, password: hashPassword(password), credit: 5, plan: 'Free' });
    sendWelcomeEmail(user.email, user.name, user.credit);
    res.json({ success: true, message: 'Account তৈরি হয়েছে! 5 free credit পেয়েছেন।', user: { email: user.email, name: user.name, credit: user.credit, plan: user.plan } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email ও password দিন।' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'Account পাওয়া যায়নি।' });
    if (user.password !== hashPassword(password)) return res.status(401).json({ success: false, message: 'Password ভুল।' });
    res.json({ success: true, message: 'Login সফল!', user: { email: user.email, name: user.name, credit: user.credit, plan: user.plan } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/ping', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) onlineUsers.set(sessionId, Date.now());
  res.json({ success: true });
});

app.get('/api/public/stats', async (req, res) => {
  try {
    cleanOldSessions();
    const totalUsers = await User.countDocuments();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todaySubmissions = await Submission.countDocuments({ submittedAt: { $gte: todayStart } });
    
    const todayDocs = await Submission.find({ submittedAt: { $gte: todayStart } }, 'urls');
    const todayUrls = todayDocs.reduce((sum, doc) => sum + (Array.isArray(doc.urls) ? doc.urls.length : 1), 0);
    
    const allDocs = await Submission.find({}, 'urls');
    const totalUrls = allDocs.reduce((sum, doc) => sum + (Array.isArray(doc.urls) ? doc.urls.length : 1), 0);
    
    res.json({ success: true, todayUrls, totalUrls, todaySubmissions, totalUsers, onlineUsers: onlineUsers.size });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    cleanOldSessions();
    const totalUsers = await User.countDocuments();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todaySubmissions = await Submission.countDocuments({ submittedAt: { $gte: todayStart }, userEmail: { $ne: 'admin' } });
    res.json({ success: true, onlineUsers: onlineUsers.size, totalUsers, todaySubmissions });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/user/get-or-create', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email, name: name || email.split('@')[0], credit: 5 });
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/user/credit', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({ success: true, credit: user.credit, plan: user.plan, indexnowKey: user.indexnowKey, indexnowHost: user.indexnowHost });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/user/update-key', async (req, res) => {
  try {
    const { email, indexnowKey, indexnowHost } = req.body;
    if (!email || !indexnowKey || !indexnowHost) {
      return res.status(400).json({ success: false, message: 'সব তথ্য প্রদান করুন।' });
    }
    const cleanHost = indexnowHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const user = await User.findOneAndUpdate(
      { email },
      { indexnowKey: indexnowKey.trim(), indexnowHost: cleanHost },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({ success: true, message: 'IndexNow Key এবং Host সফলভাবে সেভ হয়েছে।' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/payment-info', (req, res) => {
  res.json({ success: true, ...PAYMENT_NUMBERS, packages: PACKAGES });
});

app.post('/api/payment/submit', async (req, res) => {
  try {
    const { email, plan, senderNumber, txnid } = req.body;
    if (!email || !plan || !senderNumber || !txnid) return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });
    if (!PACKAGES[plan] || plan === 'Free') return res.status(400).json({ success: false, message: 'বৈধ পেইড প্ল্যান সিলেক্ট করুন।' });
    const pkg = PACKAGES[plan];
    const payment = await Payment.create({ userEmail: email, plan, amount: pkg.price, creditAdded: pkg.credit, senderNumber, txnid, status: 'pending' });
    sendPaymentSubmitEmailToAdmin({ userEmail: email, plan, amount: pkg.price, creditAdded: pkg.credit, senderNumber, txnid });
    res.json({ success: true, message: 'পেমেন্ট রিকোয়েস্ট পাঠানো হয়েছে।', paymentId: payment._id });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// =============================================
//   Admin - Site Manager
// =============================================
app.post('/api/admin/site/add', async (req, res) => {
  try {
    const { password, host, indexnowKey, label } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await Site.findOneAndUpdate({ host: cleanHost }, { indexnowKey: indexnowKey.trim(), label: label || cleanHost }, { upsert: true, new: true });
    res.json({ success: true, message: `${cleanHost} register হয়েছে!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/sites', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const sites = await Site.find().sort({ addedAt: -1 });
    res.json({ success: true, total: sites.length, data: sites });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/site/delete', async (req, res) => {
  try {
    const { password, host } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    await Site.findOneAndDelete({ host });
    res.json({ success: true, message: `${host} delete হয়েছে।` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// =============================================
//   Admin URL Submit
// =============================================
app.post('/api/index-now', async (req, res) => {
  try {
    const { urls, password } = req.body;
    if (!urls || urls.length === 0) return res.status(400).json({ success: false, message: 'URLs দিন।' });
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const hostGroups = {};
    const unknownUrls = [];
    for (const url of urls) {
      const host = extractHost(url);
      if (!host) { unknownUrls.push(url); continue; }
      if (!hostGroups[host]) hostGroups[host] = [];
      hostGroups[host].push(url);
    }
    const allResults = [];
    for (const [host, hostUrls] of Object.entries(hostGroups)) {
      const site = await Site.findOne({ host });
      if (!site) {
        hostUrls.forEach(url => allResults.push({ success: false, url, method: 'IndexNow', error: `${host} register করা নেই।` }));
        continue;
      }
      const results = await sendToIndexNow(hostUrls, site.indexnowKey, host);
      allResults.push(...results);
    }
    unknownUrls.forEach(url => allResults.push({ success: false, url, method: 'IndexNow', error: 'Invalid URL' }));
    const successCount = allResults.filter(r => r.success).length;
    await Submission.create({ userEmail: 'admin', plan: 'Admin', urls, status: 'completed', results: allResults });
    res.json({ success: true, message: `${urls.length}টি URL submit হয়েছে! ${successCount}টি সফল।`, results: allResults });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// =============================================
//   User URL Submit — IndexNow + Google Indexing API
// =============================================
app.post('/api/submit', async (req, res) => {
  try {
    const { email, urls } = req.body;
    if (!email || !urls) return res.status(400).json({ success: false, message: 'Email এবং URLs দিন।' });
    
    const urlArray = Array.isArray(urls) ? urls : urls.split('\n').map(u => u.trim()).filter(Boolean);
    if (urlArray.length === 0) return res.status(400).json({ success: false, message: 'কমপক্ষে একটি URL দিন।' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    
    if (!user.indexnowKey || !user.indexnowHost) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ আপনার প্রোফাইলে কোনো IndexNow Key বা Website URL সেভ করা নেই। অনুগ্রহ করে প্রথমে Profile পেজে গিয়ে আপনার সাইট সেটআপ বা ভেরিফাই করুন!' 
      });
    }

    if (user.credit < urlArray.length) return res.status(400).json({ success: false, message: `Credit কম! আপনার ${user.credit} credit আছে, দরকার ${urlArray.length}।` });

    const hostGroups = {};
    const unknownUrls = [];
    for (const url of urlArray) {
      const host = extractHost(url);
      if (!host) { unknownUrls.push(url); continue; }
      if (!hostGroups[host]) hostGroups[host] = [];
      hostGroups[host].push(url);
    }

    const allResults = [];
    for (const [host, hostUrls] of Object.entries(hostGroups)) {
      if (host.toLowerCase() !== user.indexnowHost.toLowerCase()) {
        hostUrls.forEach(url => allResults.push({ 
          success: false, 
          url, 
          method: 'IndexNow', 
          error: `ভুল ডোমেইন! আপনার প্রোফাইলে ${user.indexnowHost} সেভ করা, কিন্তু আপনি ${host} এর লিঙ্ক সাবমিট করছেন।` 
        }));
        continue;
      }
      
      // IndexNow (Bing/Yandex)
      const indexNowResults = await sendToIndexNow(hostUrls, user.indexnowKey, user.indexnowHost);
      allResults.push(...indexNowResults);

      // Google Indexing API
      const googleResults = await sendToGoogleIndexing(hostUrls);
      console.log('Google Indexing results:', googleResults);
    }

    unknownUrls.forEach(url => allResults.push({ success: false, url, method: 'IndexNow', error: 'Invalid URL' }));

    const successCount = allResults.filter(r => r.success).length;
    user.credit -= urlArray.length;
    await user.save();
    await Submission.create({ userEmail: email, plan: user.plan, urls: urlArray, status: 'completed', results: allResults });
    res.json({ 
      success: true, 
      message: `${urlArray.length}টি URL submit হয়েছে! IndexNow ও Google উভয়তে পাঠানো হয়েছে।`, 
      remainingCredit: user.credit, 
      results: allResults 
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const { email } = req.query;
    const query = email ? { userEmail: email } : {};
    const submissions = await Submission.find(query).sort({ submittedAt: -1 }).limit(50);
    res.json({ success: true, total: submissions.length, data: submissions });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/payments', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const payments = await Payment.find().sort({ submittedAt: -1 });
    res.json({ success: true, total: payments.length, data: payments });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/approve-payment', async (req, res) => {
  try {
    const { password, paymentId } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment পাওয়া যায়নি।' });
    if (payment.status === 'approved') return res.status(400).json({ success: false, message: 'আগেই approve হয়েছে।' });
    const user = await User.findOneAndUpdate(
      { email: payment.userEmail },
      { $inc: { credit: payment.creditAdded }, plan: payment.plan },
      { new: true }
    );
    payment.status = 'approved';
    await payment.save();
    if (user) sendPaymentApprovedEmail(user.email, user.name, payment.plan, payment.creditAdded, user.credit);
    res.json({ success: true, message: `${payment.userEmail} কে ${payment.creditAdded} credit দেওয়া হয়েছে!` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/add-credit', async (req, res) => {
  try {
    const { password, email, credit } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const user = await User.findOneAndUpdate({ email }, { $inc: { credit: parseInt(credit) } }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({ success: true, message: `${credit} credit যোগ হয়েছে!`, newCredit: user.credit });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ success: false, message: 'Access Denied!' });
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, total: users.length, data: users });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`  🚀 FastIndexer চালু আছে!`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
});
// =============================================
//     FastIndexer - Backend Server
//     MongoDB + Credit + Auth System
// =============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Online Users Tracking
const onlineUsers = new Map();
function cleanOldSessions() {
  const now = Date.now();
  for (const [id, lastSeen] of onlineUsers.entries()) {
    if (now - lastSeen > 60000) onlineUsers.delete(id);
  }
}
setInterval(cleanOldSessions, 30000);

// Simple password hash (no bcrypt needed)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'fastindexer_salt').digest('hex');
}

// =============================================
//   MongoDB
// =============================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// =============================================
//   Schemas
// =============================================
const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true },
  name:         { type: String, default: 'User' },
  password:     { type: String, default: '' },
  credit:       { type: Number, default: 0 },
  plan:         { type: String, default: 'Free' },
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

// =============================================
//   Constants
// =============================================
const PACKAGES = {
  'Free':     { price: 0,    credit: 5    },
  'Starter':  { price: 199,  credit: 50   },
  '6 Months': { price: 1499, credit: 1200 },
  '1 Year':   { price: 2499, credit: 2400 }
};

const PAYMENT_NUMBERS = {
  bkash: '+8801755178188',
  nagad: '+8801907763300'
};

// =============================================
//   IndexNow Function
// =============================================
function extractHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function sendToIndexNow(urls, indexnowKey, indexnowHost) {
  return new Promise((resolve) => {
    if (!indexnowKey || !indexnowHost) {
      return resolve(urls.map(url => ({
        success: false, url, method: 'IndexNow',
        error: 'IndexNow key বা host পাওয়া যায়নি।'
      })));
    }

    const body = JSON.stringify({
      host: indexnowHost,
      key: indexnowKey,
      keyLocation: `https://${indexnowHost}/${indexnowKey}.txt`,
      urlList: urls
    });

    const options = {
      hostname: 'api.indexnow.org',
      path: '/indexnow',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const ok = res.statusCode === 200 || res.statusCode === 202;
        resolve(urls.map(url => ({
          success: ok, url, method: 'IndexNow',
          error: !ok ? `Status: ${res.statusCode}` : null
        })));
      });
    });

    req.on('error', (e) => {
      resolve(urls.map(url => ({
        success: false, url, method: 'IndexNow', error: e.message
      })));
    });

    req.write(body);
    req.end();
  });
}

// =============================================
//   AUTH Routes
// =============================================

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password কমপক্ষে ৬ character হতে হবে।' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'এই email দিয়ে আগেই account আছে।' });
    }

    const hashed = hashPassword(password);
    const user = await User.create({
      email, name, password: hashed, credit: 5, plan: 'Free'
    });

    res.json({
      success: true,
      message: 'Account তৈরি হয়েছে! 5 free credit পেয়েছেন।',
      user: { email: user.email, name: user.name, credit: user.credit, plan: user.plan }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email ও password দিন।' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account পাওয়া যায়নি।' });
    }

    const hashed = hashPassword(password);
    if (user.password !== hashed) {
      return res.status(401).json({ success: false, message: 'Password ভুল।' });
    }

    res.json({
      success: true,
      message: 'Login সফল!',
      user: {
        email: user.email,
        name: user.name,
        credit: user.credit,
        plan: user.plan,
        indexnowKey: user.indexnowKey || '',
        indexnowHost: user.indexnowHost || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Online Ping
// =============================================
app.post('/api/ping', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) onlineUsers.set(sessionId, Date.now());
  res.json({ success: true });
});

// =============================================
//   Admin Stats
// =============================================
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    cleanOldSessions();
    const totalUsers = await User.countDocuments();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySubmissions = await Submission.countDocuments({
      submittedAt: { $gte: todayStart },
      userEmail: { $ne: 'admin' }
    });
    res.json({ success: true, onlineUsers: onlineUsers.size, totalUsers, todaySubmissions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Public Stats (login ছাড়াই দেখা যাবে)
// =============================================
app.get('/api/public/stats', async (req, res) => {
  try {
    cleanOldSessions();

    const totalUsers = await User.countDocuments();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todaySubmissions = await Submission.countDocuments({
      submittedAt: { $gte: todayStart },
      userEmail: { $ne: 'admin' }
    });

    const todayDocs = await Submission.find({
      submittedAt: { $gte: todayStart },
      userEmail: { $ne: 'admin' }
    }, 'urls');

    const todayUrls = todayDocs.reduce((sum, sub) => {
      return sum + (Array.isArray(sub.urls) ? sub.urls.length : 1);
    }, 0);

    res.json({
      success: true,
      onlineUsers: onlineUsers.size,
      totalUsers,
      todaySubmissions,
      todayUrls
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   User Routes
// =============================================
app.post('/api/user/get-or-create', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ email, name: name || email.split('@')[0], credit: 5 });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/user/credit', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({
      success: true,
      credit: user.credit,
      plan: user.plan,
      indexnowKey: user.indexnowKey || '',
      indexnowHost: user.indexnowHost || ''
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/update-key', async (req, res) => {
  try {
    const { email, indexnowKey, indexnowHost } = req.body;
    if (!email || !indexnowKey || !indexnowHost) {
      return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });
    }
    const cleanHost = indexnowHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const user = await User.findOneAndUpdate(
      { email },
      { indexnowKey: indexnowKey.trim(), indexnowHost: cleanHost },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({ success: true, message: 'IndexNow key সেভ হয়েছে!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Payment Routes
// =============================================
app.get('/api/payment-info', (req, res) => {
  res.json({ success: true, ...PAYMENT_NUMBERS, packages: PACKAGES });
});

app.post('/api/payment/submit', async (req, res) => {
  try {
    const { email, plan, senderNumber, txnid } = req.body;
    if (!email || !plan || !senderNumber || !txnid) {
      return res.status(400).json({ success: false, message: 'সব তথ্য দিন।' });
    }
    if (!PACKAGES[plan] || plan === 'Free') {
      return res.status(400).json({ success: false, message: 'বৈধ পেইড প্ল্যান সিলেক্ট করুন।' });
    }
    const pkg = PACKAGES[plan];
    const payment = await Payment.create({
      userEmail: email, plan,
      amount: pkg.price, creditAdded: pkg.credit,
      senderNumber, txnid, status: 'pending'
    });
    res.json({ success: true, message: 'পেমেন্ট রিকোয়েস্ট পাঠানো হয়েছে।', paymentId: payment._id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Admin - Site Manager
// =============================================
app.post('/api/admin/site/add', async (req, res) => {
  try {
    const { password, host, indexnowKey, label } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await Site.findOneAndUpdate(
      { host: cleanHost },
      { indexnowKey: indexnowKey.trim(), label: label || cleanHost },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: `${cleanHost} register হয়েছে!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/sites', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const sites = await Site.find().sort({ addedAt: -1 });
    res.json({ success: true, total: sites.length, data: sites });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/site/delete', async (req, res) => {
  try {
    const { password, host } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    await Site.findOneAndDelete({ host });
    res.json({ success: true, message: `${host} delete হয়েছে।` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Admin - URL Submit (Unlimited)
// =============================================
app.post('/api/index-now', async (req, res) => {
  try {
    const { urls, password } = req.body;
    if (!urls || urls.length === 0) {
      return res.status(400).json({ success: false, message: 'URLs দিন।' });
    }
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }

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
        hostUrls.forEach(url => allResults.push({
          success: false, url, method: 'IndexNow',
          error: `${host} register করা নেই। Site Manager এ add করুন।`
        }));
        continue;
      }
      const results = await sendToIndexNow(hostUrls, site.indexnowKey, host);
      allResults.push(...results);
    }

    unknownUrls.forEach(url => allResults.push({
      success: false, url, method: 'IndexNow', error: 'Invalid URL'
    }));

    const successCount = allResults.filter(r => r.success).length;
    await Submission.create({
      userEmail: 'admin', plan: 'Admin', urls, status: 'completed', results: allResults
    });

    res.json({
      success: true,
      message: `${urls.length}টি URL submit হয়েছে! ${successCount}টি সফল।`,
      results: allResults
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   User URL Submit
// =============================================
app.post('/api/submit', async (req, res) => {
  try {
    const { email, urls } = req.body;
    if (!email || !urls) {
      return res.status(400).json({ success: false, message: 'Email এবং URLs দিন।' });
    }

    const urlArray = Array.isArray(urls)
      ? urls : urls.split('\n').map(u => u.trim()).filter(Boolean);

    if (urlArray.length === 0) {
      return res.status(400).json({ success: false, message: 'কমপক্ষে একটি URL দিন।' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });

    if (!user.indexnowKey || !user.indexnowHost) {
      return res.status(400).json({ success: false, message: 'আপনার IndexNow key ও site host দিন।' });
    }

    if (user.credit < urlArray.length) {
      return res.status(400).json({
        success: false,
        message: `Credit কম! আপনার ${user.credit} credit আছে, দরকার ${urlArray.length}।`
      });
    }

    const results = await sendToIndexNow(urlArray, user.indexnowKey, user.indexnowHost);
    const successCount = results.filter(r => r.success).length;

    user.credit -= urlArray.length;
    await user.save();

    await Submission.create({
      userEmail: email, plan: user.plan, urls: urlArray, status: 'completed', results
    });

    res.json({
      success: true,
      message: `${urlArray.length}টি URL submit হয়েছে! ${successCount}টি সফল।`,
      remainingCredit: user.credit,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const { email } = req.query;
    const query = email ? { userEmail: email } : {};
    const submissions = await Submission.find(query).sort({ submittedAt: -1 }).limit(50);
    res.json({ success: true, total: submissions.length, data: submissions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Admin Routes
// =============================================
app.get('/api/admin/payments', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const payments = await Payment.find().sort({ submittedAt: -1 });
    res.json({ success: true, total: payments.length, data: payments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/approve-payment', async (req, res) => {
  try {
    const { password, paymentId } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment পাওয়া যায়নি।' });
    if (payment.status === 'approved') {
      return res.status(400).json({ success: false, message: 'আগেই approve হয়েছে।' });
    }
    await User.findOneAndUpdate(
      { email: payment.userEmail },
      { $inc: { credit: payment.creditAdded }, plan: payment.plan }
    );
    payment.status = 'approved';
    await payment.save();
    res.json({ success: true, message: `${payment.userEmail} কে ${payment.creditAdded} credit দেওয়া হয়েছে!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/add-credit', async (req, res) => {
  try {
    const { password, email, credit } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const user = await User.findOneAndUpdate(
      { email },
      { $inc: { credit: parseInt(credit) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });
    res.json({ success: true, message: `${credit} credit যোগ হয়েছে!`, newCredit: user.credit });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied!' });
    }
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, total: users.length, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   Server Start
// =============================================
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`  🚀 FastIndexer চালু আছে!`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
});

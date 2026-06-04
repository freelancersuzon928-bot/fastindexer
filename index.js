// =============================================
//     FastIndexer - Backend Server
//     MongoDB + Credit System সহ
// =============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true },
  name:      { type: String, default: 'User' },
  credit:    { type: Number, default: 0 },
  plan:      { type: String, default: 'Free' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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
  userEmail:   { type: String, required: true },
  plan:        { type: String, required: true },
  amount:      { type: Number, required: true },
  creditAdded: { type: Number, required: true },
  senderNumber:{ type: String, required: true },
  txnid:       { type: String, required: true },
  status:      { type: String, default: 'pending' },
  submittedAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);

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
//   IndexNow Function — client এর key ও host দিয়ে
// =============================================
async function sendToIndexNow(urls, host, key) {
  return new Promise((resolve) => {
    // URL থেকে host বের করো যদি না দেওয়া হয়
    if (!host && urls.length > 0) {
      try {
        const u = new URL(urls[0]);
        host = u.hostname;
      } catch(e) {
        host = 'fastindexer-production.up.railway.app';
      }
    }

    const body = JSON.stringify({
      host: host,
      key: key || 'your-indexnow-key',
      keyLocation: `https://${host}/${key || 'your-indexnow-key'}.txt`,
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
      resolve(urls.map(url => ({
        success: res.statusCode === 200 || res.statusCode === 202,
        url,
        method: 'IndexNow',
        error: res.statusCode !== 200 && res.statusCode !== 202 ? `Status: ${res.statusCode}` : null
      })));
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
//   API Routes
// =============================================

app.get('/api/payment-info', (req, res) => {
  res.json({ success: true, ...PAYMENT_NUMBERS, packages: PACKAGES });
});

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

    res.json({ success: true, credit: user.credit, plan: user.plan });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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

    res.json({
      success: true,
      message: 'পেমেন্ট রিকোয়েস্ট পাঠানো হয়েছে। Admin ভেরিফাই করলে credit যোগ হবে।',
      paymentId: payment._id
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   ADMIN - Unlimited URL Submit
// =============================================
app.post('/api/index-now', async (req, res) => {
  try {
    const { urls, password, host, key } = req.body;

    if (!urls || urls.length === 0) {
      return res.status(400).json({ success: false, message: 'URLs দিন।' });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied! Admin password ভুল।' });
    }

    const results = await sendToIndexNow(urls, host, key);
    const successCount = results.filter(r => r.success).length;

    await Submission.create({
      userEmail: 'admin',
      plan: 'Admin',
      urls: urls,
      status: 'completed',
      results
    });

    res.json({
      success: true,
      message: `${urls.length}টি URL submit হয়েছে! ${successCount}টি সফল।`,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// URL Submit (Credit based - for users)
app.post('/api/submit', async (req, res) => {
  try {
    const { email, urls, host, key } = req.body;

    if (!email || !urls) {
      return res.status(400).json({ success: false, message: 'Email এবং URLs দিন।' });
    }

    const urlArray = Array.isArray(urls)
      ? urls
      : urls.split('\n').map(u => u.trim()).filter(Boolean);

    if (urlArray.length === 0) {
      return res.status(400).json({ success: false, message: 'কমপক্ষে একটি URL দিন।' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });

    if (user.credit < urlArray.length) {
      return res.status(400).json({
        success: false,
        message: `Credit কম! আপনার ${user.credit} credit আছে, দরকার ${urlArray.length}।`
      });
    }

    const results = await sendToIndexNow(urlArray, host, key);
    const successCount = results.filter(r => r.success).length;

    user.credit -= urlArray.length;
    await user.save();

    await Submission.create({
      userEmail: email, plan: user.plan,
      urls: urlArray, status: 'completed', results
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

    res.json({
      success: true,
      message: `${payment.userEmail} কে ${payment.creditAdded} credit দেওয়া হয়েছে!`
    });
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

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`  🚀 FastIndexer চালু আছে!`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
});

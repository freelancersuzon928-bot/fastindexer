// =============================================
//     FastIndexer - Backend Server
//     MongoDB + Credit System + Client IndexNow Key
// =============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// =============================================
//   MongoDB সংযোগ
// =============================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// =============================================
//   MongoDB Schema & Models
// =============================================

const userSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true },
  name:           { type: String, default: 'User' },
  credit:         { type: Number, default: 0 },
  plan:           { type: String, default: 'Free' },
  indexnowKey:    { type: String, default: '' },  // Client এর IndexNow key
  indexnowHost:   { type: String, default: '' },  // Client এর site host
  createdAt:      { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const submissionSchema = new mongoose.Schema({
  userEmail:    { type: String, required: true },
  plan:         { type: String, required: true },
  urls:         [String],
  senderNumber: { type: String, default: 'N/A' },
  txnid:        { type: String, default: 'N/A' },
  status:       { type: String, default: 'pending' },
  results:      [{ url: String, success: Boolean, method: String, error: String }],
  submittedAt:  { type: Date, default: Date.now }
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
//   প্যাকেজ এবং পেমেন্ট তথ্য
// =============================================
const PACKAGES = {
  'Free':     { price: 0,    credit: 5    },
  'Starter':  { price: 199,  credit: 50   },
  'Pro':      { price: 399,  credit: 200  },
  '6 Months': { price: 1499, credit: 1200 },
  '1 Year':   { price: 2499, credit: 2400 }
};

const PAYMENT_NUMBERS = {
  bkash: '+8801755178188',
  nagad: '+8801907763300'
};

// =============================================
//   IndexNow Function — Client এর key & host দিয়ে
// =============================================
async function sendToIndexNow(urls, indexnowKey, indexnowHost) {
  return new Promise((resolve) => {

    // Admin mode: .env থেকে নেবে। User mode: client এর key & host
    const key  = indexnowKey  || process.env.INDEXNOW_KEY;
    const host = indexnowHost || process.env.INDEXNOW_HOST;

    if (!key || !host) {
      return resolve(urls.map(url => ({
        success: false, url, method: 'IndexNow',
        error: 'IndexNow key বা host পাওয়া যায়নি।'
      })));
    }

    const body = JSON.stringify({
      host:        host,
      key:         key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList:     urls
    });

    const options = {
      hostname: 'api.indexnow.org',
      path:     '/indexnow',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        const isSuccess = res.statusCode === 200 || res.statusCode === 202;
        resolve(urls.map(url => ({
          success: isSuccess,
          url,
          method: 'IndexNow',
          error: !isSuccess ? `Status: ${res.statusCode}` : null
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
//   API Routes
// =============================================

// পেমেন্ট তথ্য
app.get('/api/payment-info', (req, res) => {
  res.json({ success: true, ...PAYMENT_NUMBERS, packages: PACKAGES });
});

// User তৈরি বা get করা
app.post('/api/user/get-or-create', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        name: name || email.split('@')[0],
        credit: 5  // New user পাবে 5 free credit
      });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Credit ও IndexNow key দেখা
app.get('/api/user/credit', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });

    res.json({
      success:      true,
      credit:       user.credit,
      plan:         user.plan,
      indexnowKey:  user.indexnowKey  || '',
      indexnowHost: user.indexnowHost || ''
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User এর IndexNow key ও host আপডেট
app.post('/api/user/update-key', async (req, res) => {
  try {
    const { email, indexnowKey, indexnowHost } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email দিন।' });
    if (!indexnowKey || !indexnowHost) {
      return res.status(400).json({ success: false, message: 'IndexNow key এবং host দিন।' });
    }

    // Host থেকে https:// বা http:// সরিয়ে নেওয়া
    const cleanHost = indexnowHost.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const user = await User.findOneAndUpdate(
      { email },
      { indexnowKey: indexnowKey.trim(), indexnowHost: cleanHost },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, message: 'User পাওয়া যায়নি।' });

    res.json({
      success: true,
      message: 'IndexNow key সেভ হয়েছে!',
      indexnowKey:  user.indexnowKey,
      indexnowHost: user.indexnowHost
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Payment Submit
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
      success:   true,
      message:   'পেমেন্ট রিকোয়েস্ট পাঠানো হয়েছে। Admin ভেরিফাই করলে credit যোগ হবে।',
      paymentId: payment._id
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   ADMIN — Unlimited URL Submit (No credit deduction)
//   Admin এর নিজের IndexNow key (.env থেকে) use করবে
// =============================================
app.post('/api/index-now', async (req, res) => {
  try {
    const { urls, password } = req.body;

    if (!urls || urls.length === 0) {
      return res.status(400).json({ success: false, message: 'URLs দিন।' });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Access Denied! Admin password ভুল।' });
    }

    // Admin এর key .env থেকে নেবে
    const results = await sendToIndexNow(
      urls,
      process.env.INDEXNOW_KEY,
      process.env.INDEXNOW_HOST
    );

    const successCount = results.filter(r => r.success).length;

    await Submission.create({
      userEmail: 'admin',
      plan:      'Admin',
      urls,
      status:    'completed',
      results
    });

    console.log(`[ADMIN SUBMIT] URLs: ${urls.length} | Success: ${successCount}`);

    res.json({
      success: true,
      message: `${urls.length}টি URL submit হয়েছে! ${successCount}টি সফল।`,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================
//   User URL Submit — Client এর নিজের IndexNow key দিয়ে
// =============================================
app.post('/api/submit', async (req, res) => {
  try {
    const { email, urls } = req.body;

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

    // IndexNow key ও host check
    if (!user.indexnowKey || !user.indexnowHost) {
      return res.status(400).json({
        success: false,
        message: 'আপনার IndexNow key ও site host দিন (Settings এ)।'
      });
    }

    if (user.credit < urlArray.length) {
      return res.status(400).json({
        success:  false,
        message:  `Credit কম! আপনার ${user.credit} credit আছে, দরকার ${urlArray.length}।`
      });
    }

    // Client এর নিজের key & host দিয়ে submit
    const results = await sendToIndexNow(urlArray, user.indexnowKey, user.indexnowHost);
    const successCount = results.filter(r => r.success).length;

    user.credit -= urlArray.length;
    await user.save();

    await Submission.create({
      userEmail: email,
      plan:      user.plan,
      urls:      urlArray,
      status:    'completed',
      results
    });

    console.log(`[SUBMIT] ${email} | URLs: ${urlArray.length} | Success: ${successCount}`);

    res.json({
      success:         true,
      message:         `${urlArray.length}টি URL submit হয়েছে! ${successCount}টি সফল।`,
      remainingCredit: user.credit,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Submission history
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
//   ADMIN Routes
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

// =============================================
//   Server Start
// =============================================
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`  🚀 FastIndexer চালু আছে!`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  console.log(`  বিকাশ : ${PAYMENT_NUMBERS.bkash}`);
  console.log(`  নগদ   : ${PAYMENT_NUMBERS.nagad}`);
  console.log('========================================');
});

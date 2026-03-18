import express  from 'express';
import mongoose from 'mongoose';
import User     from '../models/User.js';
import Trade    from '../models/Trade.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// ── Admin guard middleware ────────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admins only.' });
  }
  next();
};

const guard = [protect, adminOnly];

// ── GET /api/admin/dashboard ──────────────────────────────────────────────────
router.get('/dashboard', guard, async (req, res) => {
  try {
    const now   = new Date();
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalUsers, activeSubscribers, freeUsers,
      monthlyNewUsers, totalTrades, monthTrades,
      recentUsers, planBreakdown,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ 'subscription.status': 'active' }),
      User.countDocuments({ $or: [{ 'subscription.plan': 'none' }, { 'subscription.status': { $ne: 'active' } }] }),
      User.countDocuments({ createdAt: { $gte: month } }),
      Trade.countDocuments(),
      Trade.countDocuments({ createdAt: { $gte: month } }),
      User.find().sort({ createdAt: -1 }).limit(5).select('name email subscription createdAt'),
      User.aggregate([
        { $group: { _id: '$subscription.plan', count: { $sum: 1 } } }
      ]),
    ]);

    // Revenue calc (starter=199, pro=699)
    const starterCount = planBreakdown.find(p => p._id === 'starter')?.count || 0;
    const proCount     = planBreakdown.find(p => p._id === 'pro')?.count || 0;
    const totalRevenue = (starterCount * 199) + (proCount * 699);

    // User growth last 12 months
    const userGrowth = await User.aggregate([
      { $match: { createdAt: { $gte: new Date(now.getFullYear() - 1, now.getMonth(), 1) } } },
      { $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        count: { $sum: 1 }
      }},
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    // Daily trades last 30 days
    const thirtyDays = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const dailyTrades = await Trade.aggregate([
      { $match: { createdAt: { $gte: thirtyDays } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 }
      }},
      { $sort: { '_id': 1 } }
    ]);

    res.json({
      stats: { totalUsers, activeSubscribers, freeUsers, monthlyNewUsers, totalTrades, monthTrades,
               totalRevenue, monthlyRevenue: (starterCount * 199) + (proCount * 699) },
      planBreakdown, recentUsers, userGrowth, dailyTrades,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', guard, async (req, res) => {
  try {
    const { search = '', plan = '', status = '', page = 1, limit = 20 } = req.query;
    const query = {};
    if (search) query.$or = [
      { name:  { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
    if (plan)   query['subscription.plan']   = plan;
    if (status) query['subscription.status'] = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
           .select('-password -sessions'),
      User.countDocuments(query),
    ]);
    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
router.get('/users/:id', guard, async (req, res) => {
  try {
    const user   = await User.findById(req.params.id).select('-password -sessions');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const trades = await Trade.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(10);
    const stats  = await Trade.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.params.id) } },
      { $group: { _id: null, total: { $sum: 1 }, totalPnl: { $sum: '$netPnl' },
                  wins: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } } } }
    ]);
    res.json({ user, trades, stats: stats[0] || { total: 0, totalPnl: 0, wins: 0 } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/admin/users/:id ──────────────────────────────────────────────────
router.put('/users/:id', guard, async (req, res) => {
  try {
    const { name, email, role, 'subscription.plan': plan, 'subscription.status': subStatus } = req.body;
    const update = {};
    if (name)      update.name  = name;
    if (email)     update.email = email;
    if (role)      update.role  = role;
    if (plan)      update['subscription.plan']   = plan;
    if (subStatus) update['subscription.status'] = subStatus;

    const user = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).select('-password -sessions');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete('/users/:id', guard, async (req, res) => {
  try {
    await Trade.deleteMany({ userId: req.params.id });
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User and all their trades deleted.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/trades ─────────────────────────────────────────────────────
router.get('/trades', guard, async (req, res) => {
  try {
    const { search = '', strategy = '', page = 1, limit = 25 } = req.query;
    const query = {};
    if (search)   query.$or = [{ symbol: { $regex: search, $options: 'i' } }];
    if (strategy) query.strategy = { $regex: strategy, $options: 'i' };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [trades, total] = await Promise.all([
      Trade.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
           .populate('userId', 'name email'),
      Trade.countDocuments(query),
    ]);
    res.json({ trades, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/analytics ──────────────────────────────────────────────────
router.get('/analytics', guard, async (req, res) => {
  try {
    const [
      topStrategies, topSymbols, pnlRatio, activeTraders,
    ] = await Promise.all([
      Trade.aggregate([
        { $match: { strategy: { $exists: true, $ne: '' } } },
        { $group: { _id: '$strategy', count: { $sum: 1 }, totalPnl: { $sum: '$netPnl' } } },
        { $sort: { count: -1 } }, { $limit: 8 }
      ]),
      Trade.aggregate([
        { $group: { _id: '$underlying', count: { $sum: 1 }, totalPnl: { $sum: '$netPnl' } } },
        { $sort: { count: -1 } }, { $limit: 10 }
      ]),
      Trade.aggregate([
        { $group: {
          _id: null,
          winners: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } },
          losers:  { $sum: { $cond: [{ $lt: ['$netPnl', 0] }, 1, 0] } },
          totalPnl: { $sum: '$netPnl' }, total: { $sum: 1 }
        }}
      ]),
      Trade.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - 30*24*60*60*1000) } } },
        { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, user: '$userId' } } },
        { $group: { _id: '$_id.date', activeUsers: { $sum: 1 } } },
        { $sort: { '_id': 1 } }
      ]),
    ]);
    res.json({ topStrategies, topSymbols, pnlRatio: pnlRatio[0] || {}, activeTraders });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/payments (simulated from subscriptions) ────────────────────
router.get('/payments', guard, async (req, res) => {
  try {
    const { status = '', page = 1, limit = 20 } = req.query;
    const query = { 'subscription.status': { $ne: 'none' } };
    if (status) query['subscription.status'] = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(query).sort({ 'subscription.startedAt': -1 })
          .skip(skip).limit(parseInt(limit))
          .select('name email subscription createdAt'),
      User.countDocuments(query),
    ]);

    const payments = users.map(u => ({
      _id:    u._id,
      user:   { name: u.name, email: u.email },
      plan:   u.subscription.plan,
      amount: u.subscription.plan === 'pro' ? 699 : 199,
      status: u.subscription.status,
      date:   u.subscription.startedAt || u.createdAt,
      paymentId: `TL${u._id.toString().slice(-8).toUpperCase()}`,
    }));

    res.json({ payments, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Platform Settings — stored in DB as a single doc ─────────────────────────
const SettingsSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);

const DEFAULT_SETTINGS = {
  // ── Platform ──────────────────────────────────────────────────────────────
  platformName:     'TradeLog',
  supportEmail:     'support@tradelog.in',
  starterPrice:     199,
  proPrice:         699,
  trialDays:        14,
  maintenanceMode:  false,
  allowSignups:     true,
  maxTradesPerUser: 10000,
  announcement:     '',

  // ── Landing — Hero ────────────────────────────────────────────────────────
  heroTagline:      'Built for NIFTY, BANKNIFTY & F&O Traders',
  heroTitle:        'Become a Consistently Profitable Options Trader',
  heroSubtext:      'Track trades, analyse strategies, control risk, and master your trading psychology — all in one powerful journal built for Indian options markets.',
  heroCtaPrimary:   'Get Started',
  heroCtaSecondary: 'View Pricing',
  heroStat1Value:   '10,000+',  heroStat1Label: 'Active traders',
  heroStat2Value:   '₹50Cr+',   heroStat2Label: 'P&L tracked',
  heroStat3Value:   '4.9★',     heroStat3Label: 'User rating',

  // ── Landing — Features ────────────────────────────────────────────────────
  featuresTitle:    'Everything you need to trade like a professional',
  featuresSub:      'Designed specifically for Indian options traders — not generic tools repurposed for F&O.',
  features: [
    { icon:'📒', title:'Trade Book',          desc:'Log every NIFTY, BANKNIFTY & F&O trade. Auto-calculate P&L, charges, and net returns per trade.' },
    { icon:'📊', title:'Strategy Analytics',  desc:'See which strategies — Iron Condor, Straddle, Scalp — actually make you money and which drain your capital.' },
    { icon:'🧠', title:'Psychology Tracking', desc:'Track emotions before and after each trade. Detect revenge trading, FOMO entries, and overtrading patterns.' },
    { icon:'🛡️', title:'Risk Management',     desc:'Set capital limits, daily loss caps, and position sizing rules. Get alerted before you break your own rules.' },
    { icon:'🔍', title:'Mistake Detection',   desc:'Auto-tag common mistakes: no stop loss, late entry, oversized position. Learn from patterns across hundreds of trades.' },
    { icon:'🔗', title:'Broker Sync',         desc:'Sync trades directly from Dhan API. No manual entry for broker trades — just connect and analyse.' },
    { icon:'📈', title:'Performance Dashboard',desc:'Daily P&L, equity curve, win rate, streak tracking, and drawdown analysis — your entire trading career in one view.' },
    { icon:'🎯', title:'Option Strategy Tracker',desc:'Track strategies like Straddle, Strangle, Iron Condor, Bull Call Spread — with legs, Greeks, and P&L attribution.' },
  ],

  // ── Landing — Pricing ─────────────────────────────────────────────────────
  pricingTitle:     'Simple, transparent pricing',
  pricingSub:       'Start free, upgrade when you\'re ready. Cancel anytime.',
  starterPlanName:  'Starter',
  starterPlanPer:   'Billed monthly · No setup fee',
  starterFeatures:  ['Trade journal (unlimited)','Basic analytics dashboard','Psychology tracking','Risk management tools','CSV import (all brokers)','Email support'],
  proPlanName:      'Pro Trader',
  proPlanPer:       'Billed monthly · 14-day free trial',
  proFeatures:      ['Everything in Starter','Advanced strategy analytics','Strategy performance tracking','Dhan broker auto sync','AI trade insights & patterns','Priority support + Discord'],
  proPlanBadge:     'MOST POPULAR',

  // ── Landing — Testimonials ────────────────────────────────────────────────
  testimonialsTitle: 'Trusted by Indian options traders',
  testimonials: [
    { name:'Arjun M.',  role:'Options Scalper, Mumbai',      initials:'AM', gradient:'linear-gradient(135deg,#3b82f6,#1d4ed8)', quote:'I was profitable some days and losing on others with no idea why. TradeLog showed me I had a 74% win rate on ORB trades but was destroying profits with FOMO entries after 2PM. Game changer.' },
    { name:'Priya S.',  role:'Swing Trader, Bangalore',      initials:'PS', gradient:'linear-gradient(135deg,#a855f7,#7c3aed)', quote:'The psychology tracking is unreal. I discovered I trade completely differently when I\'m overconfident — win rate drops from 65% to 31%. Now I size down automatically on those days.' },
    { name:'Rahul K.',  role:'BankNifty Trader, Hyderabad',  initials:'RK', gradient:'linear-gradient(135deg,#22c55e,#16a34a)', quote:'Dhan broker sync means my trades just appear. No manual entry. The strategy analytics showed Iron Condor is my best setup — I had no idea. Up ₹3.2L since switching focus.' },
  ],

  // ── Landing — FAQ ─────────────────────────────────────────────────────────
  faqTitle: 'Questions answered',
  faq: [
    { q:'Is TradeLog connected to brokers directly?',       a:'Yes — the Pro plan includes Dhan API sync that automatically imports your F&O trades. We only read trade data; we cannot place orders or access your funds.' },
    { q:'Can beginners use this?',                          a:'Absolutely. The Starter plan is perfect for new traders who want to understand their patterns. Just log trades manually or upload your broker CSV — no API setup needed.' },
    { q:'Is my trade data secure?',                        a:'Your data is encrypted in transit and at rest. We never share your data with third parties. You can export or delete all your data at any time from the profile page.' },
    { q:'Which brokers are supported for CSV import?',     a:'Zerodha, Dhan, Upstox, Angel One, Fyers, Groww, 5Paisa, ICICI Direct, HDFC Securities, Kotak, AliceBlue, Sharekhan, and more. Most CSVs are auto-detected.' },
    { q:'What is the 14-day free trial?',                  a:'The Pro plan comes with a full 14-day free trial. No credit card required to start. You\'ll only be charged after the trial ends if you choose to continue.' },
    { q:'Can I cancel anytime?',                           a:'Yes. No lock-in. Cancel from your profile page and you\'ll keep access until the end of your billing period. No questions asked.' },
  ],

  // ── Landing — Final CTA ───────────────────────────────────────────────────
  finalCtaTitle:  'Stop Guessing. Start Trading with Data.',
  finalCtaSub:    'Join 10,000+ Indian options traders who journal with TradeLog.',
  finalCtaBtn:    'Get Started →',
  finalCtaNote:   'No credit card required · Cancel anytime',
};

// ── GET /api/admin/settings ───────────────────────────────────────────────────
router.get('/settings', guard, async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'platform' });
    res.json({ settings: doc?.value || DEFAULT_SETTINGS });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/admin/settings ───────────────────────────────────────────────────
router.put('/settings', guard, async (req, res) => {
  try {
    const allowed = [
      'platformName','supportEmail','starterPrice','proPrice','trialDays',
      'maintenanceMode','allowSignups','maxTradesPerUser','announcement',
      // landing
      'heroTagline','heroTitle','heroSubtext','heroCtaPrimary','heroCtaSecondary',
      'heroStat1Value','heroStat1Label','heroStat2Value','heroStat2Label','heroStat3Value','heroStat3Label',
      'featuresTitle','featuresSub','features',
      'pricingTitle','pricingSub','starterPlanName','starterPlanPer','starterFeatures',
      'proPlanName','proPlanPer','proFeatures','proPlanBadge',
      'testimonialsTitle','testimonials',
      'faqTitle','faq',
      'finalCtaTitle','finalCtaSub','finalCtaBtn','finalCtaNote',
    ];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const current = await Settings.findOne({ key: 'platform' });
    const merged  = { ...DEFAULT_SETTINGS, ...(current?.value || {}), ...update };

    const doc = await Settings.findOneAndUpdate(
      { key: 'platform' },
      { $set: { value: merged } },
      { upsert: true, new: true }
    );
    res.json({ success: true, settings: doc.value });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/admin/public-settings  (no auth — used by landing page) ─────────
router.get('/public-settings', async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'platform' });
    const s   = { ...DEFAULT_SETTINGS, ...(doc?.value || {}) };
    // strip sensitive / server-only fields
    const { maintenanceMode, allowSignups, maxTradesPerUser, announcement, supportEmail, ...pub } = s;
    res.json({ settings: pub });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/make-admin ──────────────────────────────────────
router.post('/users/:id/make-admin', guard, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { $set: { role: 'admin' } }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ success: true, message: `${user.email} is now an admin`, user });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/revoke-admin ────────────────────────────────────
router.post('/users/:id/revoke-admin', guard, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { $set: { role: 'user' } }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ success: true, message: `Admin access revoked for ${user.email}`, user });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/users/:id/extend-subscription ────────────────────────────
router.post('/users/:id/extend-subscription', guard, async (req, res) => {
  try {
    const { days = 30, plan } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const currentExpiry = user.subscription?.expiry && new Date(user.subscription.expiry) > new Date()
      ? new Date(user.subscription.expiry)
      : new Date();
    const newExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);

    const update = { 'subscription.expiry': newExpiry, 'subscription.status': 'active' };
    if (plan) update['subscription.plan'] = plan;

    await User.findByIdAndUpdate(req.params.id, { $set: update });
    res.json({ success: true, message: `Subscription extended by ${days} days`, newExpiry });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/admin/broadcast ─────────────────────────────────────────────────
router.post('/broadcast', guard, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message required' });
    // Store announcement in settings
    await Settings.findOneAndUpdate(
      { key: 'platform' },
      { $set: { 'value.announcement': message } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Announcement updated for all users' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
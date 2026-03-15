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

export default router;

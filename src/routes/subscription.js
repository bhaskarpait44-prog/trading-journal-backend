import express from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

// ── GET /api/subscription/status ──────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const sub  = user.subscription || {};

    // Auto-expire if past expiry
    if (sub.status === 'active' && sub.expiry && new Date() > new Date(sub.expiry)) {
      user.subscription.status = 'expired';
      await user.save();
      return res.json({ plan: sub.plan, status: 'expired', expiry: sub.expiry });
    }

    res.json({
      plan:      sub.plan   || 'none',
      status:    sub.status || 'none',
      expiry:    sub.expiry || null,
      startedAt: sub.startedAt || null,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/subscription/activate ──────────────────────────────────────────
// Simulates payment success — in production this would be a webhook from Razorpay/Stripe
router.post('/activate', async (req, res) => {
  try {
    const { plan, paymentMethod, transactionId } = req.body;
    if (!['starter','pro'].includes(plan))
      return res.status(400).json({ message: 'Invalid plan.' });

    const durationDays = 30;
    const now    = new Date();
    const expiry = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const user = await User.findByIdAndUpdate(req.user._id, {
      $set: {
        'subscription.plan':      plan,
        'subscription.status':    'active',
        'subscription.expiry':    expiry,
        'subscription.startedAt': now,
      },
    }, { new: true });

    res.json({
      message: `${plan} plan activated successfully!`,
      plan,
      status:  'active',
      expiry,
      user:    user.toJSON(),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/subscription/cancel ─────────────────────────────────────────────
router.post('/cancel', async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $set: { 'subscription.status': 'cancelled' },
    });
    res.json({ message: 'Subscription cancelled.' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;

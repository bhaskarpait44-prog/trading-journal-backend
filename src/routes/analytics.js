import express from 'express';
import Trade from '../models/Trade.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

// ── GET /api/analytics/summary ────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = { userId: req.user._id, status: 'CLOSED' };
    if (from || to) { filter.exitDate = {}; if (from) filter.exitDate.$gte = new Date(from); if (to) filter.exitDate.$lte = new Date(to); }
    const trades     = await Trade.find(filter);
    const openTrades = await Trade.countDocuments({ userId: req.user._id, status: 'OPEN' });
    const winners    = trades.filter(t => t.netPnl > 0);
    const losers     = trades.filter(t => t.netPnl <= 0);
    const totalPnl   = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
    const avgWin     = winners.length ? winners.reduce((s,t) => s + t.netPnl, 0) / winners.length : 0;
    const avgLoss    = losers.length  ? losers.reduce((s,t)  => s + t.netPnl, 0) / losers.length  : 0;
    res.json({
      totalTrades: trades.length, openTrades, winners: winners.length, losers: losers.length,
      totalPnl, totalCharges: trades.reduce((s,t) => s + (t.charges||0), 0),
      avgWin, avgLoss, winRate: trades.length ? (winners.length / trades.length) * 100 : 0,
      profitFactor: Math.abs(avgLoss) > 0 ? Math.abs(avgWin / avgLoss) : 0,
      maxWin:  winners.length ? Math.max(...winners.map(t => t.netPnl)) : 0,
      maxLoss: losers.length  ? Math.min(...losers.map(t  => t.netPnl)) : 0,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/pnl-chart ─────────────────────────────────────────────
router.get('/pnl-chart', async (req, res) => {
  try {
    const { days = 30, from: fromQ, to: toQ } = req.query;
    // Accept explicit from/to OR fall back to days-ago
    const fromDate = fromQ ? new Date(fromQ) : (() => { const d = new Date(); d.setDate(d.getDate() - Number(days)); return d; })();
    const toDate   = toQ   ? new Date(toQ)   : new Date();
    toDate.setHours(23, 59, 59, 999); // include full last day
    const trades = await Trade.find({ userId: req.user._id, status: 'CLOSED', exitDate: { $gte: fromDate, $lte: toDate } }).sort({ exitDate: 1 });
    const dailyMap = {};
    trades.forEach(t => {
      const date = t.exitDate.toISOString().split('T')[0];
      if (!dailyMap[date]) dailyMap[date] = { date, pnl: 0, trades: 0 };
      dailyMap[date].pnl    += t.netPnl || 0;
      dailyMap[date].trades += 1;
    });
    let cumulative = 0;
    const chartData = Object.values(dailyMap).map(d => { cumulative += d.pnl; return { ...d, cumulative }; });
    res.json({ chartData });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/by-symbol ─────────────────────────────────────────────
router.get('/by-symbol', async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { userId: req.user._id, status: 'CLOSED' } },
      { $group: { _id: '$underlying', totalTrades: { $sum: 1 }, totalPnl: { $sum: '$netPnl' }, wins: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } } } },
      { $sort: { totalPnl: -1 } }, { $limit: 10 },
    ]);
    res.json({ data });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/by-strategy ───────────────────────────────────────────
router.get('/by-strategy', async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { userId: req.user._id, status: 'CLOSED', strategy: { $exists: true, $ne: '' } } },
      { $group: { _id: '$strategy', totalTrades: { $sum: 1 }, totalPnl: { $sum: '$netPnl' }, wins: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } } } },
      { $sort: { totalPnl: -1 } },
    ]);
    res.json({ data });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/analytics/psychology ─────────────────────────────────────────────
router.get('/psychology', async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.user._id, status: 'CLOSED', 'psychology.emotionBefore': { $exists: true, $ne: '' } });
    if (!trades.length) return res.json({ totalLogged: 0, avgDiscipline: 0, followedPlanRate: 0, revengeTrades: 0, revengeTradeLoss: 0, fomoTrades: 0, overtradingCount: 0, mostCommonMistake: null, emotionWinRate: [], mistakeFrequency: [], lossByEmotion: [] });

    const withDisc = trades.filter(t => t.psychology?.disciplineRating != null);
    const avgDiscipline = withDisc.length ? withDisc.reduce((s,t) => s + t.psychology.disciplineRating, 0) / withDisc.length : 0;
    const withPlan = trades.filter(t => t.psychology?.followedPlan != null);
    const followedPlanRate = withPlan.length ? (withPlan.filter(t => t.psychology.followedPlan).length / withPlan.length) * 100 : 0;

    const mistakeCount = {};
    trades.forEach(t => (t.psychology?.mistakeTags || []).forEach(tag => { mistakeCount[tag] = (mistakeCount[tag] || 0) + 1; }));
    const mistakeFrequency = Object.entries(mistakeCount).map(([tag, count]) => ({ tag, count })).sort((a,b) => b.count - a.count);

    const revengeTrades = trades.filter(t => (t.psychology?.mistakeTags||[]).includes('revenge_trade'));
    const emoMap = {};
    trades.forEach(t => {
      const em = t.psychology?.emotionBefore; if (!em) return;
      if (!emoMap[em]) emoMap[em] = { wins: 0, total: 0, pnl: 0 };
      emoMap[em].total++; emoMap[em].pnl += t.netPnl || 0;
      if ((t.netPnl||0) > 0) emoMap[em].wins++;
    });
    const emotionWinRate = Object.entries(emoMap).map(([emotion, d]) => ({ emotion, trades: d.total, wins: d.wins, winRate: d.total ? parseFloat(((d.wins/d.total)*100).toFixed(1)) : 0, totalPnl: parseFloat(d.pnl.toFixed(2)) })).sort((a,b) => b.trades - a.trades);

    const afterMap = {};
    trades.forEach(t => {
      const em = t.psychology?.emotionAfter; if (!em) return;
      if (!afterMap[em]) afterMap[em] = { total: 0, pnl: 0 };
      afterMap[em].total++; afterMap[em].pnl += t.netPnl || 0;
    });
    const lossByEmotion = Object.entries(afterMap).map(([emotion, d]) => ({ emotion, trades: d.total, totalPnl: parseFloat(d.pnl.toFixed(2)) })).sort((a,b) => a.totalPnl - b.totalPnl);

    res.json({
      totalLogged: trades.length, avgDiscipline: parseFloat(avgDiscipline.toFixed(1)),
      followedPlanRate: parseFloat(followedPlanRate.toFixed(1)),
      revengeTrades: revengeTrades.length, revengeTradeLoss: parseFloat(revengeTrades.reduce((s,t) => s+(t.netPnl||0), 0).toFixed(2)),
      fomoTrades: trades.filter(t => (t.psychology?.mistakeTags||[]).includes('fomo_entry')).length,
      overtradingCount: trades.filter(t => (t.psychology?.mistakeTags||[]).includes('overtrading')).length,
      mostCommonMistake: mistakeFrequency[0]?.tag || null,
      emotionWinRate, mistakeFrequency, lossByEmotion,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
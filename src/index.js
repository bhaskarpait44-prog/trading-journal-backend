import express    from 'express';
import cors       from 'cors';
import mongoose   from 'mongoose';
import dotenv     from 'dotenv';

dotenv.config();

// ── Startup validation ────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your_jwt_secret_here') {
  console.error('❌  JWT_SECRET is not set or is still the placeholder. Edit backend/.env');
  process.exit(1);
}

import authRoutes     from './routes/auth.js';
import tradeRoutes    from './routes/trades.js';
import analyticsRoutes from './routes/analytics.js';
import profileRoutes       from './routes/profile.js';
import subscriptionRoutes  from './routes/subscription.js';
import nseRoutes      from './routes/nse.js';
import adminRoutes    from './routes/admin.js';
import exportRoutes   from './routes/export.js';

const app  = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://trading-journal-frontend-mu.vercel.app',
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/trades',    tradeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/subscription',  subscriptionRoutes);
app.use('/api/nse',       nseRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/export',    exportRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'OK', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tradelog', {
  serverSelectionTimeoutMS: 5000,
}).then(() => {
  console.log('✅  MongoDB connected');
  app.listen(PORT, () => console.log(`🚀  Backend on http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌  MongoDB connection failed:', err.message);
  console.error('   → Make sure MongoDB is running. Windows: services.msc → MongoDB Server → Start');
  process.exit(1);
});
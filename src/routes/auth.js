import express from 'express';
import User from '../models/User.js';
import { generateToken, protect } from '../middleware/auth.js';

const router = express.Router();

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ message: 'Name is required.' });
    if (!email || !email.trim())
      return res.status(400).json({ message: 'Email is required.' });
    if (!password || password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing)
      return res.status(400).json({ message: 'An account with this email already exists.' });

    const user  = await User.create({
      name:         name.trim(),
      email:        email.toLowerCase().trim(),
      password,
      authProvider: 'local',
    });
    const token = generateToken(user._id);
    res.status(201).json({ token, user: user.toJSON() });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: err.message || 'Signup failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !user.password)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ message: 'Invalid email or password.' });

    res.json({ token: generateToken(user._id), user: user.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: err.message || 'Login failed. Please try again.' });
  }
});

// ── POST /api/auth/google ─────────────────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID)
      return res.status(501).json({ message: 'Google Sign-In is not configured on this server. Set GOOGLE_CLIENT_ID in .env.' });

    const { credential } = req.body;
    if (!credential)
      return res.status(400).json({ message: 'Google credential token is required.' });

    // Dynamically import to avoid crash at startup when key is missing
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    const ticket  = await client.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (user) {
      if (!user.googleId) {
        user.googleId     = googleId;
        user.authProvider = 'google';
        await user.save();
      }
    } else {
      user = await User.create({
        name, email, googleId,
        avatar:       picture,
        authProvider: 'google',
      });
    }

    res.json({ token: generateToken(user._id), user: user.toJSON() });
  } catch (err) {
    console.error('Google auth error:', err);
    // Surface a clear message for token verification failures
    const msg = err.message?.includes('Token used too late') ? 'Google token expired. Please try again.'
              : err.message?.includes('Invalid token')      ? 'Invalid Google token. Please try again.'
              : err.message || 'Google sign-in failed.';
    res.status(401).json({ message: msg });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', protect, (req, res) => res.json({ user: req.user }));

// ── POST /api/auth/subscribe ──────────────────────────────────────────────────
router.post('/subscribe', protect, async (req, res) => {
  try {
    const { plan, status, expiry } = req.body;
    if (!plan || !status) return res.status(400).json({ message: 'Plan and status are required.' });
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { 'subscription.plan': plan, 'subscription.status': status, 'subscription.expiry': expiry } },
      { new: true }
    );
    res.json({ user: user.toJSON(), subscription: user.subscription });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;

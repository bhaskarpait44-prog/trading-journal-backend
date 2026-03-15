import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const sessionSchema = new mongoose.Schema({
  token:     { type: String, required: true },
  device:    { type: String, default: 'Unknown' },
  ip:        { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastUsed:  { type: Date, default: Date.now },
}, { _id: true });

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String },
  googleId: { type: String },
  avatar:   { type: String },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },

  // ── Profile ──────────────────────────────────────────────────────────────
  profile: {
    gender:  { type: String, enum: ['male', 'female', 'other', 'prefer_not_to_say', ''], default: '' },
    phone:   { type: String, default: '' },
    country: { type: String, default: '' },
  },

  // ── Risk management ───────────────────────────────────────────────────────
  riskManagement: {
    totalCapital:      { type: Number, default: 0 },
    availableMargin:   { type: Number, default: 0 },
    riskPerTrade:      { type: Number, default: 1 },   // %
    maxDailyLoss:      { type: Number, default: 2 },   // %
  },

  // ── Subscription ─────────────────────────────────────────────────────────
  subscription: {
    plan:    { type: String, enum: ['none','starter','pro'], default: 'none' },
    status:  { type: String, enum: ['none','trial','active','expired','cancelled'], default: 'none' },
    expiry:  { type: Date },
    startedAt: { type: Date },
  },

  // ── Active sessions ───────────────────────────────────────────────────────
  sessions: [sessionSchema],

  preferences: {
    defaultCapital: { type: Number, default: 100000 },
    currency:       { type: String, default: 'INR' },
  },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (pwd) {
  return bcrypt.compare(pwd, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.sessions;
  return obj; // subscription is included
};

export default mongoose.model('User', userSchema);

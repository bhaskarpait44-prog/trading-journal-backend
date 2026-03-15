import mongoose from 'mongoose';

const psychologySchema = new mongoose.Schema({
  emotionBefore: {
    type: String,
    enum: ['calm','confident','fearful','revenge','overconfident','frustrated',''],
    default: '',
  },
  emotionAfter: {
    type: String,
    enum: ['satisfied','regret','angry','neutral','disappointed',''],
    default: '',
  },
  disciplineRating: { type: Number, min: 1, max: 10 },
  followedPlan:     { type: Boolean },
  mistakeTags: [{
    type: String,
    enum: ['no_stoploss','overtrading','revenge_trade','early_exit','late_entry','fomo_entry','oversized_position'],
  }],
  notes: { type: String, maxlength: 1000 },
}, { _id: false });

const tradeSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  symbol:     { type: String, required: true, uppercase: true },
  underlying: { type: String, required: true, uppercase: true },
  tradeType:  { type: String, enum: ['BUY','SELL'], required: true },
  optionType: { type: String, enum: ['CE','PE'],    required: true },
  strikePrice: { type: Number, required: true },
  expiryDate:  { type: Date,   required: true },
  lotSize:     { type: Number, required: true, default: 1 },
  quantity:    { type: Number, required: true },
  entryPrice:  { type: Number, required: true },
  exitPrice:   { type: Number },
  stopLoss:    { type: Number },
  target:      { type: Number },
  entryDate:   { type: Date, required: true },
  exitDate:    { type: Date },
  status:      { type: String, enum: ['OPEN','CLOSED','EXPIRED'], default: 'OPEN' },
  pnl:         { type: Number, default: 0 },
  pnlPercent:  { type: Number, default: 0 },
  charges:     { type: Number, default: 0 },
  netPnl:      { type: Number, default: 0 },
  strategy:    { type: String },
  setupType:   { type: String },
  notes:       { type: String },
  tags:        [{ type: String }],
  rating:      { type: Number, min: 1, max: 5 },
  source:      { type: String, enum: ['manual','csv','broker_api'], default: 'manual' },
  brokerId:    { type: String },
  broker:      { type: String },
  iv: { type: Number }, delta: { type: Number }, theta: { type: Number },
  niftyAtEntry: { type: Number },
  vixAtEntry:   { type: Number },
  psychology: { type: psychologySchema, default: () => ({}) },
}, { timestamps: true });

tradeSchema.pre('save', function (next) {
  if (this.exitPrice && this.status === 'CLOSED') {
    const mult  = this.tradeType === 'BUY' ? 1 : -1;
    const gross = mult * (this.exitPrice - this.entryPrice) * this.quantity * this.lotSize;
    this.pnl        = gross;
    this.netPnl     = gross - (this.charges || 0);
    const invested  = this.entryPrice * this.quantity * this.lotSize;
    this.pnlPercent = invested > 0 ? (gross / invested) * 100 : 0;
  }
  next();
});

tradeSchema.index({ userId: 1, entryDate: -1 });
tradeSchema.index({ userId: 1, status: 1 });
tradeSchema.index({ userId: 1, symbol: 1 });
tradeSchema.index({ userId: 1, 'psychology.emotionBefore': 1 });

export default mongoose.model('Trade', tradeSchema);

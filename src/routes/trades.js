import express from 'express';
import multer from 'multer';
import Trade from '../models/Trade.js';
import { protect } from '../middleware/auth.js';
import { parseCSVBuffer } from '../lib/csvParser.js';
import { calcCharges } from '../lib/calcCharges.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.use(protect);

function buildPositions(rawTrades, userId, source, brokerName) {
  const paired = [], buyPool = {}, sellPool = {};
  rawTrades.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
  for (const t of rawTrades) {
    const key = (t.symbol || '').toUpperCase();
    if (t.tradeType === 'BUY') {
      if (sellPool[key]?.length) {
        let rem = t.quantity;
        while (rem > 0 && sellPool[key].length) {
          const s = sellPool[key][0], mq = Math.min(s.remainingQty, rem);
          const pnl = (s.trade.entryPrice - t.entryPrice) * mq;
          const ch = (s.trade.charges||0)+(t.charges||0);
          paired.push({...s.trade,userId,source,broker:brokerName,quantity:mq,exitPrice:t.entryPrice,exitDate:t.entryDate,status:'CLOSED',charges:ch,pnl,netPnl:pnl-ch});
          s.remainingQty -= mq; rem -= mq; if(s.remainingQty===0) sellPool[key].shift();
        }
        if (rem>0){if(!buyPool[key])buyPool[key]=[];buyPool[key].push({trade:{...t,quantity:rem},remainingQty:rem});}
      } else {
        if(!buyPool[key])buyPool[key]=[];buyPool[key].push({trade:t,remainingQty:t.quantity});
      }
    } else {
      if (buyPool[key]?.length) {
        let rem = t.quantity;
        while (rem > 0 && buyPool[key].length) {
          const o = buyPool[key][0], mq = Math.min(o.remainingQty, rem);
          const pnl = (t.entryPrice - o.trade.entryPrice) * mq;
          const ch = (o.trade.charges||0)+(t.charges||0);
          paired.push({...o.trade,userId,source,broker:brokerName,quantity:mq,exitPrice:t.entryPrice,exitDate:t.entryDate,status:'CLOSED',charges:ch,pnl,netPnl:pnl-ch});
          o.remainingQty -= mq; rem -= mq; if(o.remainingQty===0) buyPool[key].shift();
        }
        if (rem>0){if(!sellPool[key])sellPool[key]=[];sellPool[key].push({trade:{...t,quantity:rem},remainingQty:rem});}
      } else {
        if(!sellPool[key])sellPool[key]=[];sellPool[key].push({trade:t,remainingQty:t.quantity});
      }
    }
  }
  for(const slots of Object.values(buyPool)) for(const s of slots) if(s.remainingQty>0) paired.push({...s.trade,userId,source,broker:brokerName,quantity:s.remainingQty,status:'OPEN'});
  for(const slots of Object.values(sellPool)) for(const s of slots) if(s.remainingQty>0) paired.push({...s.trade,userId,source,broker:brokerName,quantity:s.remainingQty,status:'OPEN'});
  return paired;
}

router.get('/', async (req, res) => {
  try {
    const { status, symbol, from, to, optionType, page=1, limit=50 } = req.query;
    const filter = { userId: req.user._id };
    if (status)     filter.status     = status;
    if (optionType) filter.optionType = optionType;
    if (symbol)     filter.symbol     = new RegExp(symbol,'i');
    if (from||to) { filter.entryDate={}; if(from)filter.entryDate.$gte=new Date(from); if(to)filter.entryDate.$lte=new Date(to); }
    const total  = await Trade.countDocuments(filter);
    const trades = await Trade.find(filter).sort({entryDate:-1}).skip((+page-1)*+limit).limit(+limit);
    res.json({trades,total,page:+page,pages:Math.ceil(total/+limit)});
  } catch(err){res.status(500).json({message:err.message});}
});

router.post('/', async (req, res) => {
  try {
    const body     = { ...req.body, userId: req.user._id, source: 'manual' };
    const exchange = body.exchange || 'NSE';
    // Always auto-calculate — ignore any charges sent from client
    if (body.exitPrice && body.status === 'CLOSED') {
      body.charges = calcCharges(body.entryPrice, body.exitPrice, body.lotSize, body.quantity, body.tradeType, exchange).total;
    } else {
      body.charges = calcCharges(body.entryPrice, 0, body.lotSize, body.quantity, body.tradeType, exchange).total;
    }
    const trade = await Trade.create(body);
    res.status(201).json({ trade });
  } catch(err) { res.status(400).json({ message: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await Trade.findOne({ _id: req.params.id, userId: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Trade not found.' });
    const body     = { ...req.body };
    const exchange = body.exchange || existing.exchange || 'NSE';
    const entry    = body.entryPrice  || existing.entryPrice;
    const exit     = body.exitPrice   || existing.exitPrice;
    const lotSize  = body.lotSize     || existing.lotSize;
    const qty      = body.quantity    || existing.quantity;
    const type     = body.tradeType   || existing.tradeType;
    const status   = body.status      || existing.status;
    // Recalculate charges whenever trade is updated
    if (exit && status === 'CLOSED') {
      body.charges = calcCharges(entry, exit, lotSize, qty, type, exchange).total;
    } else {
      body.charges = calcCharges(entry, 0, lotSize, qty, type, exchange).total;
    }
    const trade = await Trade.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      body,
      { new: true, runValidators: true }
    );
    res.json({ trade });
  } catch(err){res.status(400).json({message:err.message});}
});

router.delete('/:id', async (req, res) => {
  try {
    const trade = await Trade.findOneAndDelete({_id:req.params.id,userId:req.user._id});
    if(!trade) return res.status(404).json({message:'Trade not found.'});
    res.json({message:'Trade deleted.'});
  } catch(err){res.status(500).json({message:err.message});}
});

router.post('/:id/psychology', async (req, res) => {
  try {
    const {emotionBefore,emotionAfter,disciplineRating,followedPlan,mistakeTags,notes} = req.body;
    const trade = await Trade.findOneAndUpdate(
      {_id:req.params.id,userId:req.user._id},
      {$set:{psychology:{emotionBefore:emotionBefore||'',emotionAfter:emotionAfter||'',disciplineRating:disciplineRating?Number(disciplineRating):undefined,followedPlan:followedPlan!=null?Boolean(followedPlan):undefined,mistakeTags:Array.isArray(mistakeTags)?mistakeTags:[],notes:notes||''}}},
      {new:true,runValidators:true}
    );
    if(!trade) return res.status(404).json({message:'Trade not found.'});
    res.json({psychology:trade.psychology});
  } catch(err){res.status(400).json({message:err.message});}
});

router.get('/:id/psychology', async (req, res) => {
  try {
    const trade = await Trade.findOne({_id:req.params.id,userId:req.user._id},'psychology symbol entryDate');
    if(!trade) return res.status(404).json({message:'Trade not found.'});
    res.json({psychology:trade.psychology||{},symbol:trade.symbol,entryDate:trade.entryDate});
  } catch(err){res.status(500).json({message:err.message});}
});

router.post('/import/csv', upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({message:'No file uploaded.'});
    const {broker,trades:rawTrades,skipped} = parseCSVBuffer(req.file.buffer,req.user._id);
    if(!rawTrades.length) return res.status(400).json({message:`No options trades found. Broker: ${broker}.`,broker,skipped:skipped.slice(0,10)});
    const paired = buildPositions(rawTrades,req.user._id,'csv',broker);
    const inserted = await Trade.insertMany(paired,{ordered:false});
    res.status(201).json({message:`${inserted.length} trades imported from ${broker}.`,count:inserted.length,broker,closed:paired.filter(t=>t.status==='CLOSED').length,open:paired.filter(t=>t.status==='OPEN').length,skipped:skipped.length,tradeIds:inserted.map(t=>({_id:t._id,symbol:t.symbol,entryDate:t.entryDate}))});
  } catch(err){res.status(400).json({message:'CSV import failed: '+err.message});}
});

router.post('/import/broker', async (req, res) => {
  const { broker, clientId, accessToken, fromDate, toDate } = req.body;
  if (!accessToken) return res.status(400).json({ message: 'Access token is required.' });
  if (!clientId)    return res.status(400).json({ message: 'Client ID is required.' });

  const { default: axios } = await import('axios');
  let dhanRows = [];
  const today = new Date().toISOString().split('T')[0];
  const from  = fromDate || today;
  const to    = toDate   || today;
  const hdrs  = { 'access-token': accessToken.trim(), 'client-id': clientId.trim(), 'Content-Type': 'application/json', 'Accept': 'application/json' };

  try {
    if (from === today && to === today) {
      const r = await axios.get('https://api.dhan.co/v2/trades', { headers: hdrs, timeout: 15000 });
      dhanRows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    } else {
      let page = 0, hasMore = true;
      while (hasMore && page < 50) {
        const r = await axios.get(`https://api.dhan.co/v2/trades/${from}/${to}/${page}`, { headers: hdrs, timeout: 15000 });
        const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
        dhanRows.push(...rows); hasMore = rows.length >= 20; page++;
      }
    }
  } catch (dhanErr) {
    const status = dhanErr.response?.status;
    const d      = dhanErr.response?.data;
    let userMsg  = '';
    if (status === 401 || status === 403) userMsg = 'Invalid or expired access token. Regenerate from web.dhan.co → Profile → Access Token.';
    else if (status === 400) userMsg = `Dhan rejected the request: ${d?.errorMessage || d?.message || JSON.stringify(d)}`;
    else if (status === 429) userMsg = 'Dhan API rate limit hit. Wait a minute and try again.';
    else if (!status)        userMsg = `Cannot reach Dhan API. Check internet. (${dhanErr.message})`;
    else userMsg = `Dhan API error (HTTP ${status}): ${d?.errorMessage || d?.message || dhanErr.message}`;
    return res.status(400).json({ message: userMsg, details: d });
  }

  const fnoRows = dhanRows.filter(t =>
    ['NSE_FNO','BSE_FNO','NSE_FO','BSE_FO'].includes(t.exchangeSegment) ||
    (t.drvOptionType && t.drvOptionType !== 'NA' && t.drvOptionType !== '')
  );
  if (!fnoRows.length && dhanRows.length > 0) return res.status(400).json({ message: `Found ${dhanRows.length} trades but none are F&O options.` });
  if (!fnoRows.length) return res.status(400).json({ message: 'No trades found in this date range. Try a wider range.' });

  const rawTrades = fnoRows.map(t => {
    const sym        = (t.customSymbol || t.tradingSymbol || '').toUpperCase();
    const optionType = t.drvOptionType==='CALL'?'CE':t.drvOptionType==='PUT'?'PE':sym.endsWith('CE')?'CE':'PE';
    const underlying = sym.replace(/\d{2}[A-Z]{3}\d{2,4}(CE|PE)$/i,'').replace(/\d+.*$/,'').replace(/[-_]/g,'')||'UNKNOWN';
    const exchange   = (t.exchangeSegment||'').startsWith('BSE') ? 'BSE' : 'NSE';
    const tradeType  = t.transactionType==='BUY' ? 'BUY' : 'SELL';
    const entryPrice = parseFloat(t.tradedPrice) || 0;
    const quantity   = parseInt(t.tradedQuantity) || 1;
    // Auto-calculate charges using verified Zerodha F&O rates — ignore Dhan's reported charges
    const charges    = calcCharges(entryPrice, 0, 1, quantity, tradeType, exchange).total;
    return { symbol:sym, underlying:underlying.toUpperCase(), tradeType, optionType, exchange, strikePrice:parseFloat(t.drvStrikePrice)||0, expiryDate:t.drvExpiryDate&&t.drvExpiryDate!=='NA'?new Date(t.drvExpiryDate):new Date(), lotSize:1, quantity, entryPrice, entryDate:new Date(t.exchangeTime||t.createTime||Date.now()), brokerId:t.exchangeTradeId||t.orderId||'', charges };
  });

  try {
    const paired   = buildPositions(rawTrades, req.user._id, 'broker_api', 'dhan');
    const inserted = await Trade.insertMany(paired, { ordered: false });
    res.json({ message:`${inserted.length} trades synced from Dhan.`, count:inserted.length, closed:paired.filter(t=>t.status==='CLOSED').length, open:paired.filter(t=>t.status==='OPEN').length, tradeIds:inserted.map(t=>({_id:t._id,symbol:t.symbol,entryDate:t.entryDate})) });
  } catch(err) {
    res.status(500).json({ message: 'Failed to save trades: ' + err.message });
  }
});

// ── POST /api/trades/import/fyers ─────────────────────────────────────────────
router.post('/import/fyers', async (req, res) => {
  const { appId, accessToken, fromDate, toDate } = req.body;
  if (!accessToken) return res.status(400).json({ message: 'Access token is required.' });
  if (!appId)       return res.status(400).json({ message: 'App ID is required.' });

  const { default: axios } = await import('axios');
  const today = new Date().toISOString().split('T')[0];
  const from  = fromDate || today;
  const to    = toDate   || today;

  // Fyers API v3: Authorization header must be "APPID:access_token"
  // The appId might be entered as "XY1234-100" — we use it as-is
  const authHeader = `${appId.trim()}:${accessToken.trim()}`;

  const hdrs = {
    'Authorization': authHeader,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };

  let fyersRows = [];
  let lastError = null;

  // Try multiple Fyers API endpoints (they sometimes change)
  const endpoints = [
    'https://api-t1.fyers.in/api/v3/tradebook',
    'https://api-t2.fyers.in/api/v3/tradebook',
    'https://api.fyers.in/api/v3/tradebook',
  ];

  for (const url of endpoints) {
    try {
      const r    = await axios.get(url, { headers: hdrs, timeout: 15000 });
      const data = r.data;

      // Fyers returns { s: 'ok', tradeBook: [...] } or { s: 'error', message: '...' }
      if (data?.s === 'error' || data?.s === 'Error') {
        const errMsg = data?.message || data?.errmsg || 'Fyers API returned error';
        // Auth errors — stop trying other endpoints
        if (errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('auth') ||
            errMsg.toLowerCase().includes('invalid') || errMsg.toLowerCase().includes('unauthorized')) {
          return res.status(401).json({
            message: `Invalid token: ${errMsg}. Re-generate your access token from myapi.fyers.in.`,
          });
        }
        throw new Error(errMsg);
      }

      fyersRows = Array.isArray(data?.tradeBook) ? data.tradeBook
                : Array.isArray(data?.data)       ? data.data
                : Array.isArray(data)              ? data
                : [];
      lastError = null;
      break; // success — stop trying
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      // Don't retry on auth errors
      if (status === 401 || status === 403) break;
      // Don't retry on 400 bad request
      if (status === 400) break;
    }
  }

  if (lastError) {
    const status = lastError.response?.status;
    const d      = lastError.response?.data;
    let msg;
    if (status === 401 || status === 403) {
      msg = 'Access token is invalid or expired. Go to myapi.fyers.in → Generate Token and paste the fresh token.';
    } else if (status === 400) {
      msg = `Bad request: ${d?.message || d?.errmsg || 'Check your App ID format (e.g. XY1234-100)'}`;
    } else if (status === 429) {
      msg = 'Fyers API rate limit hit. Wait 1 minute and try again.';
    } else if (status === 502 || status === 503 || status === 504) {
      msg = 'Fyers API servers are temporarily down (502/503). Try again in a few minutes, or use CSV export instead.';
    } else if (!status) {
      msg = `Cannot reach Fyers API. Check your internet connection. (${lastError.message})`;
    } else {
      msg = `Fyers API error (HTTP ${status}): ${d?.message || d?.errmsg || lastError.message}`;
    }
    return res.status(400).json({ message: msg });
  }

  // Filter by date range
  if (from || to) {
    fyersRows = fyersRows.filter(t => {
      const d = (t.orderDateTime || t.tradeDate || t.order_date_time || '').slice(0,10);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });
  }

  // Filter F&O options only
  const fnoRows = fyersRows.filter(t => {
    const sym = (t.symbol || t.tradingSymbol || '').toUpperCase();
    // Fyers symbols: NSE:NIFTY24DEC22500CE or MCX:... 
    return sym.includes(':') && (sym.endsWith('CE') || sym.endsWith('PE'))
        || (!sym.includes(':') && (sym.endsWith('CE') || sym.endsWith('PE')));
  });

  if (!fnoRows.length && fyersRows.length > 0)
    return res.status(400).json({ message: `Found ${fyersRows.length} trades but none are F&O options.` });
  if (!fnoRows.length)
    return res.status(400).json({ message: 'No trades found in this date range. Try a wider range.' });

  const rawTrades = fnoRows.map(t => {
    const fullSym    = (t.symbol || t.tradingSymbol || '').toUpperCase();
    // Strip exchange prefix: NSE:NIFTY24DEC22500CE → NIFTY24DEC22500CE
    const sym        = fullSym.includes(':') ? fullSym.split(':')[1] : fullSym;
    const exchange   = fullSym.startsWith('BSE') ? 'BSE' : 'NSE';
    const optionType = sym.endsWith('CE') ? 'CE' : 'PE';
    // Strip option type + strike + expiry from end to get underlying
    const underlying = sym.replace(/\d{2}[A-Z]{3}\d{2,6}(CE|PE)$/i,'').replace(/\d+.*$/,'') || 'UNKNOWN';
    // Strike: last numeric sequence before CE/PE
    const strikeMatch = sym.match(/(\d+)(CE|PE)$/i);
    const strikePrice = strikeMatch ? parseFloat(strikeMatch[1]) : 0;
    // Expiry from symbol (e.g. 24DEC = Dec 2024)
    const expMatch = sym.match(/(\d{2})([A-Z]{3})(\d{2,4})/i);
    let expiryDate = new Date();
    if (expMatch) {
      const yr  = expMatch[3].length === 2 ? '20' + expMatch[3] : expMatch[3];
      expiryDate = new Date(`${expMatch[1]} ${expMatch[2]} ${yr}`);
    }

    const tradeType  = (t.side === 1 || t.side === 'BUY'  || t.transactionType === 'BUY')  ? 'BUY' : 'SELL';
    const entryPrice = parseFloat(t.tradePrice || t.tradedPrice || t.rate || 0);
    const quantity   = parseInt(t.tradedQty || t.qty || t.quantity || 1);
    const charges    = calcCharges(entryPrice, 0, 1, quantity, tradeType, exchange).total;
    const entryDate  = new Date(t.orderDateTime || t.tradeDate || Date.now());

    return {
      symbol: sym, underlying: underlying.toUpperCase(), tradeType, optionType, exchange,
      strikePrice, expiryDate, lotSize: 1, quantity, entryPrice, entryDate,
      brokerId: t.tradeId || t.orderId || '', charges,
    };
  });

  try {
    const paired   = buildPositions(rawTrades, req.user._id, 'broker_api', 'fyers');
    const inserted = await Trade.insertMany(paired, { ordered: false });
    res.json({
      message: `${inserted.length} trades synced from Fyers.`,
      count: inserted.length,
      closed: paired.filter(t => t.status === 'CLOSED').length,
      open:   paired.filter(t => t.status === 'OPEN').length,
      tradeIds: inserted.map(t => ({ _id: t._id, symbol: t.symbol, entryDate: t.entryDate })),
    });
  } catch(err) {
    res.status(500).json({ message: 'Failed to save trades: ' + err.message });
  }
});

export default router;
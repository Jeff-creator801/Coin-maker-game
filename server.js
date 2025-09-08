// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import axios from "axios";
import admin from "firebase-admin";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // serve index.html + manifest

// ENV checks
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT env required');
  process.exit(1);
}
if (!process.env.TON_API_KEY) {
  console.error('TON_API_KEY env required');
  process.exit(1);
}
if (!process.env.OWNER_TON_WALLET) {
  console.warn('OWNER_TON_WALLET not set — using placeholder (set env var on Render)');
}

// init Firebase Admin (Firestore)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const firestore = admin.firestore();

const TON_API_KEY = process.env.TON_API_KEY;
const OWNER_TON_WALLET = process.env.OWNER_TON_WALLET || 'UQAmTM_EE8D6seecLKf-h8aXVQasliniDDQ52EvBj7PqExNr';

function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function parseTonValue(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  // if value is very big assume nanotons
  if (n > 1e12) return n / 1e9;
  return n;
}
function normalizeAddr(a){ return String(a || '').replace(/[^0-9A-Za-z]/g,'').toLowerCase(); }

// health
app.get('/api/health', (req, res) => res.json({ ok:true, ts: Date.now() }));

/**
 * GET /api/tokens
 * returns array of tokens
 */
app.get('/api/tokens', async (req, res) => {
  try {
    const snap = await firestore.collection('tokens').orderBy('createdAt','desc').get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(arr);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/tokens/create
 * body: { type: 'user'|'listing', name, ticker, owner?, totalSupply?, pricePerToken? }
 */
app.post('/api/tokens/create', async (req, res) => {
  try {
    const { type, name, ticker, owner, totalSupply, pricePerToken } = req.body;
    if (!type || !name || !ticker) return res.status(400).json({ error: 'missing' });
    const id = uid();
    const token = { type, name, ticker, owner: owner || OWNER_TON_WALLET, createdAt: Date.now() };
    if (type === 'listing') {
      if (!totalSupply || !pricePerToken) return res.status(400).json({ error: 'listing_missing' });
      token.totalSupply = Number(totalSupply);
      token.remainingSupply = Number(totalSupply);
      token.pricePerToken = Number(pricePerToken);
    } else {
      token.dynamicPrice = Number(req.body.dynamicPrice || 0.1);
      token.supplyIssued = 0;
    }
    await firestore.collection('tokens').doc(id).set(token);
    res.json({ ok:true, id, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/tokens/:id/buy
 * body: { buyer (ton address), amountTokens }
 * creates sale record
 */
app.post('/api/tokens/:id/buy', async (req, res) => {
  try {
    const tokenId = req.params.id;
    const { buyer, amountTokens } = req.body;
    if (!buyer || !amountTokens) return res.status(400).json({ error: 'missing' });
    const tokenDoc = await firestore.collection('tokens').doc(tokenId).get();
    if (!tokenDoc.exists) return res.status(404).json({ error: 'token_not_found' });
    const token = tokenDoc.data();
    const amount = Number(amountTokens);
    if (amount <= 0) return res.status(400).json({ error: 'bad_amount' });

    let cost = 0;
    const receiver = token.owner || OWNER_TON_WALLET;
    if (token.type === 'listing') {
      if ((token.remainingSupply || 0) < amount) return res.status(400).json({ error: 'not_enough_supply' });
      cost = Number((amount * Number(token.pricePerToken)).toFixed(9));
    } else {
      cost = Number((amount * Number(token.dynamicPrice || 0.1)).toFixed(9));
    }

    const saleId = uid();
    const sale = {
      id: saleId,
      tokenId, tokenTicker: token.ticker || '',
      buyer, seller: receiver,
      amountTokens: amount, cost, status:'pending', createdAt: Date.now()
    };
    await firestore.collection('sales').doc(saleId).set(sale);
    // add shallow history entries
    await firestore.collection('history').doc(uid()).set({ when: Date.now(), type: 'sale_created', saleId, ...sale });
    res.json({ ok:true, saleId, cost, receiver });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/sales/:saleId/confirm
 * body: { txHash }
 * Verifies tx via TonCenter (if txHash provided) or scans seller address recent txs
 * On success: marks sale confirmed, adjusts token supply/price, credits buyer balances
 */
app.post('/api/sales/:saleId/confirm', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { txHash } = req.body;
    const saleDoc = await firestore.collection('sales').doc(saleId).get();
    if (!saleDoc.exists) return res.status(404).json({ error: 'sale_not_found' });
    const sale = saleDoc.data();
    if (sale.status === 'confirmed') return res.json({ ok:true, message:'already_confirmed' });

    async function finalize(foundHash) {
      await firestore.collection('sales').doc(saleId).update({ status: 'confirmed', txHash: foundHash || null, confirmedAt: Date.now() });
      // token updates
      const tokenRef = firestore.collection('tokens').doc(sale.tokenId);
      const tokenDoc = await tokenRef.get();
      if (tokenDoc.exists) {
        const token = tokenDoc.data();
        if (token.type === 'listing') {
          const newRem = Math.max(0, (token.remainingSupply || 0) - sale.amountTokens);
          await tokenRef.update({ remainingSupply: newRem });
        } else {
          const issued = (token.supplyIssued || 0) + sale.amountTokens;
          const oldPrice = Number(token.dynamicPrice || 0.1);
          const alpha = 0.005;
          const factor = 1 + alpha * sale.amountTokens;
          const newPrice = Number((oldPrice * factor).toFixed(9));
          await tokenRef.update({ supplyIssued: issued, dynamicPrice: newPrice });
        }
      }
      // credit buyer balance
      const balRef = firestore.collection('balances').doc(`${sale.tokenId}__${sale.buyer}`);
      const bSnap = await balRef.get();
      const prev = bSnap.exists ? Number(bSnap.data().amount || 0) : 0;
      await balRef.set({ tokenId: sale.tokenId, address: sale.buyer, amount: prev + sale.amountTokens });
      // history
      await firestore.collection('history').doc(uid()).set({ when: Date.now(), type: 'buy_confirmed', saleId, tokenId: sale.tokenId, buyer: sale.buyer, seller: sale.seller, amount: sale.amountTokens, cost: sale.cost });
      return { ok:true, message: 'sale_confirmed' };
    }

    // If txHash -> verify directly
    if (txHash) {
      try {
        const url = `https://toncenter.com/api/v2/getTransaction?hash=${encodeURIComponent(txHash)}&api_key=${encodeURIComponent(TON_API_KEY)}`;
        const r = await axios.get(url, { timeout: 10000 }).catch(() => ({ data: null }));
        if (r.data && r.data.ok && r.data.result) {
          const tx = r.data.result;
          const in_msg = tx.in_msg || tx.in_message || null;
          let val = 0;
          let sender = null;
          if (in_msg && in_msg.value) val = parseTonValue(in_msg.value);
          else if (tx.value) val = parseTonValue(tx.value);
          if (in_msg && (in_msg.source || in_msg.source_address)) sender = in_msg.source || in_msg.source_address;
          const okAmount = val >= (Number(sale.cost) - 0.0000001);
          const okSender = sender ? (normalizeAddr(sender) === normalizeAddr(sale.buyer)) : true;
          if (okAmount && okSender) return res.json(await finalize(txHash));
          else return res.status(400).json({ ok:false, reason:'tx_mismatch', foundAmount: val, sender });
        }
      } catch(e) { console.warn('txHash lookup fail', e.message || e); }
    }

    // No txHash or not matched -> scan seller address recent txs
    const txsUrl = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(sale.seller)}&limit=50&api_key=${encodeURIComponent(TON_API_KEY)}`;
    const rTx = await axios.get(txsUrl, { timeout: 10000 }).catch(() => ({ data: null }));
    if (!rTx.data || !rTx.data.ok) {
      await firestore.collection('sales').doc(saleId).update({ status: 'pending_check' });
      return res.json({ ok:false, reason: 'txs_unavailable' });
    }
    const txs = rTx.data.result || [];
    // find candidate
    let matched = null;
    for (const tx of txs) {
      const utime = tx.utime || tx.time || 0;
      const now = Math.floor(Date.now()/1000);
      if (utime && (now - utime > 60*60*24)) continue; // older than 24h skip
      const in_msg = tx.in_msg || tx.in_message || null;
      let val = 0;
      if (in_msg && in_msg.value) val = parseTonValue(in_msg.value);
      else if (tx.value) val = parseTonValue(tx.value);
      if (val >= (Number(sale.cost) - 0.0000001)) {
        // optionally check sender
        const sender = in_msg && (in_msg.source || in_msg.source_address) || tx.source || null;
        if (!sender || normalizeAddr(sender) === normalizeAddr(sale.buyer)) { matched = tx; break; }
        // else accept anyway if amount matches (some wallets hide source)
        matched = tx; break;
      }
    }
    if (!matched) {
      await firestore.collection('sales').doc(saleId).update({ status: 'pending_check' });
      return res.json({ ok:false, reason: 'not_found' });
    }
    const foundHash = matched.id || matched.hash || (matched.in_msg && matched.in_msg.hash) || null;
    return res.json(await finalize(foundHash));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/transfer
 * body: { tokenId, from, to, amount }
 * NOTE: this trusts 'from' and is a prototype. For production require signature verification.
 */
app.post('/api/transfer', async (req, res) => {
  try {
    const { tokenId, from, to, amount } = req.body;
    if (!tokenId || !from || !to || !amount) return res.status(400).json({ error: 'missing' });
    const amt = Number(amount);
    if (amt <= 0) return res.status(400).json({ error: 'bad_amount' });
    const fromRef = firestore.collection('balances').doc(`${tokenId}__${from}`);
    const toRef = firestore.collection('balances').doc(`${tokenId}__${to}`);
    const fSnap = await fromRef.get();
    const have = fSnap.exists ? Number(fSnap.data().amount || 0) : 0;
    if (have < amt) return res.status(400).json({ error: 'insufficient' });
    await fromRef.set({ tokenId, address: from, amount: have - amt });
    const tSnap = await toRef.get();
    const prev = tSnap.exists ? Number(tSnap.data().amount || 0) : 0;
    await toRef.set({ tokenId, address: to, amount: prev + amt });
    await firestore.collection('history').doc(uid()).set({ when: Date.now(), type: 'transfer', tokenId, from, to, amount: amt });
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/balances/:address
 */
app.get('/api/balances/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    const col = await firestore.collection('balances').where('address','==',addr).get();
    const arr = col.docs.map(d => d.data());
    res.json(arr);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/history/:address
 */
app.get('/api/history/:address', async (req, res) => {
  try {
    const addr = req.params.address;
    const col = await firestore.collection('history').where('buyer','==',addr).limit(100).get().catch(()=>({docs:[]}));
    const arr = col.docs ? col.docs.map(d => d.data()) : [];
    res.json(arr);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// serve index.html fallback
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Coin Maker server running on ${PORT}`));

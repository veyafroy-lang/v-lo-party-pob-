require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const sharp = require('sharp');

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = String(process.env.JWT_SECRET || '');
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'davicon.bj@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || '');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const EVENT_NAME = String(process.env.EVENT_NAME || 'VELO PARTY POBE');
const EVENT_DATE = String(process.env.EVENT_DATE || '');
const EVENT_LOCATION = String(process.env.EVENT_LOCATION || '');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET manquant ou trop court (minimum 32 caractères).');
if (!ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD ou ADMIN_PASSWORD_HASH est obligatoire.');
const EFFECTIVE_ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_HASH || bcrypt.hashSync(ADMIN_PASSWORD, 12);
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont obligatoires.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const PRICES = {
  '2000': 'Entrée simple',
  '5000': 'VIP',
  '10000': 'VIP',
  '15000': 'VIP',
  '20000': 'VIP'
};

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }
});

const redeemLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessaie plus tard.' }
});

function now() { return new Date().toISOString(); }

function hashCode(code) {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function generateAccessCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'VPB-';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

function generateTicketNumber() {
  return `VPB-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`;
}

function validatePrice(price) {
  const p = String(price);
  return Object.prototype.hasOwnProperty.call(PRICES, p) ? Number(p) : null;
}

function authRequired(req, res, next) {
  try {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Non authentifié.' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.email !== ADMIN_EMAIL) return res.status(401).json({ error: 'Accès refusé.' });
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée.' });
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
  };
}

app.get('/api/health', async (req, res) => {
  const { error } = await supabase.from('access_codes').select('id', { head: true, count: 'exact' }).limit(1);
  if (error) return res.status(503).json({ ok: false, database: 'error' });
  res.json({ ok: true, database: 'ok', event: EVENT_NAME });
});

app.get('/api/config', (req, res) => {
  res.json({ event: EVENT_NAME, date: EVENT_DATE, location: EVENT_LOCATION });
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email !== ADMIN_EMAIL || !(await bcrypt.compare(password, EFFECTIVE_ADMIN_PASSWORD_HASH))) {
    return res.status(401).json({ error: 'Identifiants invalides.' });
  }
  const token = jwt.sign({ email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('admin_token', token, cookieOptions());
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token', cookieOptions());
  res.json({ ok: true });
});

app.get('/api/admin/me', authRequired, (req, res) => {
  res.json({ email: ADMIN_EMAIL, event: EVENT_NAME });
});

app.post('/api/admin/codes', authRequired, async (req, res) => {
  const price = validatePrice(req.body.price);
  const quantity = Math.min(Math.max(Number(req.body.quantity || 1), 1), 500);
  if (!price || !Number.isInteger(quantity)) return res.status(400).json({ error: 'Tarif ou quantité invalide.' });

  const generated = [];
  for (let i = 0; i < quantity; i++) {
    let inserted = false;
    for (let attempt = 0; attempt < 20 && !inserted; attempt++) {
      const code = generateAccessCode();
      const { error } = await supabase.from('access_codes').insert({
        code_hash: hashCode(code),
        code_last4: code.slice(-4),
        ticket_type: PRICES[String(price)],
        price,
        status: 'AVAILABLE',
        created_at: now()
      });
      if (!error) {
        generated.push(code);
        inserted = true;
      } else if (!String(error.message || '').toLowerCase().includes('duplicate') && error.code !== '23505') {
        console.error(error);
        return res.status(500).json({ error: 'Impossible de générer les codes.' });
      }
    }
    if (!inserted) return res.status(500).json({ error: 'Impossible de générer un code unique.' });
  }

  res.json({ ok: true, price, type: PRICES[String(price)], codes: generated });
});

app.get('/api/admin/stats', authRequired, async (req, res) => {
  const [allCodes, usedCodes, allTickets, checkedIn] = await Promise.all([
    supabase.from('access_codes').select('id', { count: 'exact', head: true }),
    supabase.from('access_codes').select('id', { count: 'exact', head: true }).eq('status', 'USED'),
    supabase.from('tickets').select('id', { count: 'exact', head: true }),
    supabase.from('tickets').select('id', { count: 'exact', head: true }).not('checked_in_at', 'is', null)
  ]);
  const firstError = [allCodes, usedCodes, allTickets, checkedIn].find(x => x.error);
  if (firstError) return res.status(500).json({ error: 'Impossible de charger les statistiques.' });

  const { data: byPrice, error } = await supabase.from('tickets').select('price');
  if (error) return res.status(500).json({ error: 'Impossible de charger les statistiques.' });
  const counts = {};
  for (const row of byPrice || []) counts[row.price] = (counts[row.price] || 0) + 1;

  res.json({
    totalCodes: allCodes.count || 0,
    usedCodes: usedCodes.count || 0,
    totalTickets: allTickets.count || 0,
    checkedIn: checkedIn.count || 0,
    byPrice: Object.entries(counts).map(([price, count]) => ({ price: Number(price), count }))
  });
});

app.get('/api/admin/tickets', authRequired, async (req, res) => {
  const { data, error } = await supabase
    .from('tickets')
    .select('ticket_number, holder_name, ticket_type, price, created_at, checked_in_at')
    .order('id', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: 'Impossible de charger les tickets.' });
  res.json(data || []);
});

app.post('/api/ticket/redeem', redeemLimiter, async (req, res) => {
  const rawCode = String(req.body.code || '').trim().toUpperCase();
  const holderName = String(req.body.holderName || '').trim().replace(/\s+/g, ' ');
  if (!rawCode || !holderName) return res.status(400).json({ error: 'Code et nom obligatoires.' });
  if (holderName.length > 100) return res.status(400).json({ error: 'Nom trop long.' });
  if (!/^VPB-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(rawCode)) return res.status(400).json({ error: 'Format de code invalide.' });

  const args = {
    p_code_hash: hashCode(rawCode),
    p_ticket_number: generateTicketNumber(),
    p_public_token: crypto.randomBytes(32).toString('hex'),
    p_holder_name: holderName
  };

  let result = await supabase.rpc('redeem_ticket', args);
  if (result.error && result.error.code === '23505') {
    args.p_ticket_number = generateTicketNumber();
    args.p_public_token = crypto.randomBytes(32).toString('hex');
    result = await supabase.rpc('redeem_ticket', args);
  }
  if (result.error) {
    if (String(result.error.message || '').includes('INVALID_OR_USED')) return res.status(409).json({ error: 'Code invalide ou déjà utilisé.' });
    console.error(result.error);
    return res.status(500).json({ error: 'Impossible de générer le ticket.' });
  }

  const ticket = result.data?.[0];
  if (!ticket) return res.status(500).json({ error: 'Ticket non généré.' });
  res.json({
    ok: true,
    ticket: {
      ticketNumber: ticket.ticket_number,
      holderName: ticket.holder_name,
      ticketType: ticket.ticket_type,
      price: ticket.price,
      token: ticket.public_token
    }
  });
});

app.get('/api/ticket/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Ticket introuvable.' });
  const { data, error } = await supabase
    .from('tickets')
    .select('ticket_number, holder_name, ticket_type, price, created_at, checked_in_at')
    .eq('public_token', token)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Ticket introuvable.' });
  res.json(data);
});

app.post('/api/checkin', authRequired, async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'QR invalide.' });

  const { data, error } = await supabase.rpc('checkin_ticket', { p_public_token: token });
  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erreur lors de la validation.' });
  }
  const row = data?.[0];
  if (!row) return res.status(404).json({ error: 'TICKET INVALIDE.' });
  if (row.error_code === 'NOT_FOUND') return res.status(404).json({ error: 'TICKET INVALIDE.' });
  if (row.error_code === 'ALREADY_USED') {
    return res.status(409).json({
      error: 'TICKET DÉJÀ UTILISÉ.',
      ticket: {
        ticketNumber: row.ticket_number,
        holderName: row.holder_name,
        ticketType: row.ticket_type,
        price: row.price,
        checkedInAt: row.checked_in_at
      }
    });
  }
  res.json({
    ok: true,
    message: 'ENTRÉE VALIDÉE.',
    ticket: {
      ticketNumber: row.ticket_number,
      holderName: row.holder_name,
      ticketType: row.ticket_type,
      price: row.price,
      checkedInAt: row.checked_in_at
    }
  });
});

app.get('/api/ticket/:token/image', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).send('Ticket introuvable.');
  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('ticket_number, holder_name, ticket_type, price, public_token')
    .eq('public_token', token)
    .maybeSingle();
  if (error || !ticket) return res.status(404).send('Ticket introuvable.');

  try {
    const qrData = await QRCode.toDataURL(ticket.public_token, { errorCorrectionLevel: 'H', margin: 1, width: 420 });
    const logo = await sharp(path.join(__dirname, 'public', 'logo.jpeg'))
      .resize({ width: 380, height: 380, fit: 'contain' })
      .png().toBuffer();
    const logoBase64 = `data:image/png;base64,${logo.toString('base64')}`;
    const svg = `
    <svg width="1200" height="760" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="760" rx="44" fill="#080808"/>
      <rect x="28" y="28" width="1144" height="704" rx="34" fill="#111" stroke="#f4d000" stroke-width="5"/>
      <image href="${logoBase64}" x="55" y="55" width="270" height="270" preserveAspectRatio="xMidYMid meet"/>
      <text x="360" y="105" fill="#ffd900" font-size="46" font-family="Arial" font-weight="700">${escapeXml(EVENT_NAME)}</text>
      <text x="360" y="170" fill="white" font-size="30" font-family="Arial">TICKET D'ENTRÉE</text>
      <text x="360" y="245" fill="#35d34a" font-size="54" font-family="Arial" font-weight="700">${escapeXml(ticket.ticket_type)}</text>
      <text x="360" y="305" fill="#fff" font-size="38" font-family="Arial">${Number(ticket.price).toLocaleString('fr-FR')} FCFA</text>
      <text x="70" y="385" fill="#ddd" font-size="27" font-family="Arial">Bénéficiaire</text>
      <text x="70" y="430" fill="white" font-size="38" font-family="Arial" font-weight="700">${escapeXml(ticket.holder_name)}</text>
      <text x="70" y="500" fill="#ddd" font-size="27" font-family="Arial">N° Ticket</text>
      <text x="70" y="545" fill="#ffd900" font-size="35" font-family="Arial" font-weight="700">${escapeXml(ticket.ticket_number)}</text>
      <text x="70" y="625" fill="#aaa" font-size="23" font-family="Arial">Présentez ce QR code à l'entrée.</text>
      <image href="${qrData}" x="805" y="270" width="300" height="300"/>
      <text x="360" y="675" fill="#fff" font-size="23" font-family="Arial">${escapeXml(EVENT_NAME)}</text>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${ticket.ticket_number}.png"`);
    res.send(png);
  } catch (e) {
    console.error(e);
    res.status(500).send("Erreur de génération de l'image.");
  }
});

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

app.listen(PORT, () => console.log(`VELO PARTY POBE — serveur sur le port ${PORT}`));

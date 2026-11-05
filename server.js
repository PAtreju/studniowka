'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'content.json');
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// ---------- treści (pytania, klasa) ----------

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

function normalizeContent(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Nieprawidłowe dane.');
  const ids = new Set();
  const uid = (v, title) => {
    let id = str(v, 60) || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'gra';
    while (ids.has(id)) id += '-' + crypto.randomBytes(2).toString('hex');
    ids.add(id);
    return id;
  };
  const classList = [...new Set((Array.isArray(raw.classList) ? raw.classList : []).map((n) => str(n, 40)).filter(Boolean))];

  const quizzes = (Array.isArray(raw.quizzes) ? raw.quizzes : []).map((qz, i) => {
    const title = str(qz.title, 80) || `Quiz ${i + 1}`;
    const questions = (Array.isArray(qz.questions) ? qz.questions : []).map((q, j) => {
      const text = str(q.text, 200);
      const answers = (Array.isArray(q.answers) ? q.answers : []).map((a) => str(a, 80)).filter(Boolean).slice(0, 4);
      if (!text) throw new Error(`„${title}”, pytanie ${j + 1}: brak treści.`);
      if (answers.length < 2) throw new Error(`„${title}”, pytanie ${j + 1}: potrzeba min. 2 odpowiedzi.`);
      const correct = Number(q.correct);
      if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) {
        throw new Error(`„${title}”, pytanie ${j + 1}: zaznacz poprawną odpowiedź.`);
      }
      return { text, answers, correct, time: clampInt(q.time, 5, 120, 20) };
    });
    return { id: uid(qz.id, title), title, questions };
  });

  const polls = (Array.isArray(raw.polls) ? raw.polls : []).map((pl, i) => {
    const title = str(pl.title, 80) || `Plebiscyt ${i + 1}`;
    const questions = (Array.isArray(pl.questions) ? pl.questions : []).map((q, j) => {
      const text = str(q.text, 200);
      if (!text) throw new Error(`„${title}”, pytanie ${j + 1}: brak treści.`);
      const options = [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => str(o, 40)).filter(Boolean))];
      if (options.length === 1) throw new Error(`„${title}”, pytanie ${j + 1}: podaj min. 2 opcje albo żadnej (wtedy głosujemy na klasę).`);
      return { text, options, time: clampInt(q.time, 5, 300, 30) };
    });
    return { id: uid(pl.id, title), title, questions };
  });

  return { classList, quizzes, polls };
}

let content = normalizeContent(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));

function saveContent(next) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
  content = next;
}

function gamesSummary() {
  const sum = (s) => ({ id: s.id, title: s.title, count: s.questions.length });
  return { quizzes: content.quizzes.map(sum), polls: content.polls.map(sum), classCount: content.classList.length };
}

// ---------- adres do dołączenia ----------

function lanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const score = (c) =>
    (c.address.startsWith('192.168.') ? 3 : c.address.startsWith('10.') ? 2 : c.address.startsWith('172.') ? 1 : 0) +
    (/^(en|wl|eth|Wi-Fi)/i.test(c.name) ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] ? candidates[0].address : 'localhost';
}

const joinUrl = () => PUBLIC_URL || `http://${lanIp()}:${PORT}/`;
let qrCache = { url: null, svg: null };
async function joinInfo() {
  const url = joinUrl();
  if (qrCache.url !== url) {
    qrCache = { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }
  return { url, qr: qrCache.svg };
}

// ---------- HTTP ----------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, pingTimeout: 30000 });

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(['/host', '/editor', '/api/content'], (_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  next();
});
app.use(express.json({ limit: '1mb' }));
const pub = path.join(__dirname, 'public');
// Cloudflare trzyma pliki JS/CSS do 4 godzin, więc HTML odwołuje się do nich z ?v=<skrót treści>.
function versionedHtml(dir, file) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');
  return html.replace(/(href|src)="\/([\w.-]+\.(?:js|css))"/g, (m, attr, name) => {
    try {
      const h = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, name))).digest('hex').slice(0, 10);
      return `${attr}="/${name}?v=${h}"`;
    } catch { return m; }
  });
}

const pages = Object.fromEntries(['play', 'host', 'editor'].map((n) => [n, versionedHtml(pub, n + '.html')]));
const page = (n) => (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(pages[n]);
app.get('/', page('play'));
app.get('/host', page('host'));
app.get('/editor', page('editor'));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource')));
app.use(express.static(pub, { index: false }));

const HOST_KEY_BUF = Buffer.from(HOST_KEY);
const keyOk = (k) => {
  if (typeof k !== 'string') return false;
  const b = Buffer.from(k);
  return b.length === HOST_KEY_BUF.length && crypto.timingSafeEqual(b, HOST_KEY_BUF);
};

// ---------- ograniczenia (publiczny dostęp) ----------

const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 300;
// za tunelem Cloudflare prawdziwy adres klienta jest w CF-Connecting-IP
const ipOf = (headers, fallback) => String(headers['cf-connecting-ip'] || fallback || '?');

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) hits.set(key, (e = { n: 0, reset: now + windowMs }));
    e.n += 1;
    return e.n <= max;
  };
}
const keyFailLimit = limiter(10, 10 * 60 * 1000); // 10 złych kluczy / 10 min / IP
const joinLimit = limiter(150, 60 * 1000); // cała sala bywa za jednym NAT-em
const connLimit = limiter(300, 60 * 1000);
const keyBlocked = new Map();
function checkKey(ip, key) {
  if ((keyBlocked.get(ip) || 0) > Date.now()) return { ok: false, error: 'Za dużo prób. Spróbuj za kilka minut.' };
  if (keyOk(key)) return { ok: true };
  if (!keyFailLimit(ip)) keyBlocked.set(ip, Date.now() + 10 * 60 * 1000);
  return { ok: false, error: 'Zły klucz prowadzącego.' };
}

const requireKey = (req, res, next) => {
  const r = checkKey(ipOf(req.headers, req.socket.remoteAddress), req.get('x-host-key'));
  return r.ok ? next() : res.status(r.error.startsWith('Za dużo') ? 429 : 401).json({ error: r.error });
};

app.get('/api/join-info', async (_req, res) => res.json(await joinInfo()));
app.get('/api/content', requireKey, (_req, res) => res.json(content));
app.put('/api/content', requireKey, (req, res) => {
  try {
    saveContent(normalizeContent(req.body));
    io.to('host').emit('games', gamesSummary());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- gra + Socket.IO ----------

let pending = false;
const game = new Game({
  getContent: () => content,
  onUpdate: () => {
    if (pending) return;
    pending = true;
    setImmediate(broadcast);
  },
});

function broadcast() {
  pending = false;
  io.to('host').emit('state', game.hostView());
  for (const id of game.players.keys()) io.to('p:' + id).emit('state', game.playerView(id));
}

const socketsPerPlayer = new Map();

io.on('connection', (socket) => {
  const ip = ipOf(socket.handshake.headers, socket.handshake.address);
  if (!connLimit(ip)) return socket.disconnect(true);

  socket.on('host:auth', async (key, cb) => {
    if (typeof cb !== 'function') return;
    const r = checkKey(ip, key);
    if (!r.ok) return cb(r);
    socket.data.host = true;
    socket.join('host');
    cb({ ok: true, games: gamesSummary(), join: await joinInfo(), state: game.hostView() });
  });

  socket.on('host:cmd', (msg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.host) return reply({ ok: false, error: 'Brak uprawnień.' });
    try {
      const { cmd, type, id } = msg || {};
      if (cmd === 'select') game.select(type, id);
      else if (cmd === 'next') game.next();
      else if (cmd === 'idle') game.toIdle();
      else if (cmd === 'kick') {
        if (game.kick(id)) io.to('p:' + id).emit('kicked');
      } else throw new Error('Nieznana komenda.');
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });

  socket.on('player:join', ({ name, id } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (socket.data.playerId) return cb({ ok: false, error: 'Już dołączono.' });
    if (!joinLimit(ip)) return cb({ ok: false, error: 'Za dużo prób dołączenia. Spróbuj za minutę.' });
    const known = typeof id === 'string' && game.players && game.players.has && game.players.has(id);
    if (!known && game.players && game.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Sala jest pełna.' });
    const r = game.addPlayer(name, id);
    if (!r.ok) return cb(r);
    const pid = r.player.id;
    socket.data.playerId = pid;
    socket.join('p:' + pid);
    socketsPerPlayer.set(pid, (socketsPerPlayer.get(pid) || 0) + 1);
    game.setConnected(pid, true);
    cb({ ok: true, id: pid, name: r.player.name, state: game.playerView(pid) });
  });

  socket.on('player:answer', (choice, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.playerId) return reply({ ok: false, error: 'Nie jesteś w grze.' });
    reply(game.answer(socket.data.playerId, choice));
  });

  socket.on('disconnect', () => {
    const pid = socket.data.playerId;
    if (!pid) return;
    const n = (socketsPerPlayer.get(pid) || 1) - 1;
    if (n > 0) return socketsPerPlayer.set(pid, n);
    socketsPerPlayer.delete(pid);
    game.setConnected(pid, false);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const url = joinUrl();
    const base = url.replace(/\/$/, '');
    console.log('\n🎉 Teleturniej studniówkowy działa!\n');
    console.log(`  Ekran prowadzącego: ${base}/host?key=${HOST_KEY}`);
    console.log(`  Edytor pytań:       ${base}/editor?key=${HOST_KEY}`);
    console.log(`  Dołączanie (QR):    ${url}`);
    console.log(`\n  Klucz prowadzącego: ${HOST_KEY}  (ustaw na stałe: HOST_KEY=... npm start)\n`);
  });
}

module.exports = { server, game, HOST_KEY, normalizeContent };

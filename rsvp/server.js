'use strict';
const express = require('express');
const path = require('path');
const { Store } = require('./lib/store');
const { createAuth, loadSecret } = require('./lib/auth');
const { bulkAdd } = require('./lib/guests');
const mail = require('./lib/mail');
const { createGmail } = require('./lib/gmail');
const { TOKEN_RE, localToEpoch, newToken, newId, EMAIL_RE, str, csvCell } = require('./lib/util');

function createApp(opts = {}) {
  const env = opts.env || process.env;
  const password = env.ADMIN_PASSWORD;
  if (!password) throw new Error('Ustaw zmienną ADMIN_PASSWORD.');
  const dataDir = env.DATA_DIR || path.join(__dirname, 'data');
  const now = opts.now || Date.now;
  const tz = env.EVENT_TZ || 'Europe/Warsaw';
  const store = new Store(dataDir);
  const auth = createAuth({ secret: loadSecret(dataDir, env.SESSION_SECRET), password, now });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY || 'loopback'); // w Dockerze za cloudflared: TRUST_PROXY=uniquelocal

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const pub = path.join(__dirname, 'public');
  const fonts = (pkg) => express.static(path.join(__dirname, 'node_modules', '@fontsource', pkg, 'files'), { maxAge: '30d', immutable: true });
  app.use('/fonts/bodoni', fonts('bodoni-moda'));
  app.use('/fonts/manrope', fonts('manrope'));
  app.use(express.static(pub, { index: false, maxAge: 0 }));

  const baseUrl = (req) => (env.PUBLIC_BASE_URL || env.PUBLIC_URL ? (env.PUBLIC_BASE_URL || env.PUBLIC_URL).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
  const deadlinePassed = () => {
    const d = store.db.settings.deadline;
    const e = d ? localToEpoch(d, tz) : null;
    return e != null && now() > e;
  };

  app.get('/', noStore, (req, res) => res.type('text').send('Studniówka RSVP. Otwórz osobisty link z zaproszenia.'));
  app.get('/admin', noStore, (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  const RESERVED = new Set(['admin', 'api', 'fonts']);
  const guestPage = (req, res, next) => {
    if (!TOKEN_RE.test(req.params.token) || RESERVED.has(req.params.token.toLowerCase())) return next();
    res.set('Cache-Control', 'no-store').sendFile(path.join(pub, 'guest.html'));
  };
  app.get('/r/:token', guestPage);
  app.get('/:token', guestPage);

  // light per-IP limit on lookups that miss, so guessing tokens is pointless
  const misses = new Map();
  const tooManyMisses = (ip) => {
    const m = misses.get(ip);
    if (m && m.resetAt < now()) { misses.delete(ip); return false; }
    return !!m && m.count >= 30;
  };
  const noteMiss = (ip) => {
    const m = misses.get(ip);
    if (!m || m.resetAt < now()) misses.set(ip, { count: 1, resetAt: now() + 10 * 60 * 1000 });
    else m.count++;
  };
  const lookup = (req, res) => {
    if (tooManyMisses(req.ip)) { res.status(429).json({ error: 'rate_limited' }); return null; }
    const g = store.byToken(req.params.token);
    if (!g) { noteMiss(req.ip); res.status(404).json({ error: 'not_found' }); return null; }
    return g;
  };

  // ---------- guest API ----------
  const guestView = (g) => ({
    status: g.status, plusOneAllowed: g.plusOneAllowed,
    plusOne: g.plusOne, plusOneName: g.plusOneName, message: g.message, respondedAt: g.respondedAt,
  });
  const publicEvent = () => { const { mailSubject, mailBody, ...rest } = store.db.settings; return rest; };
  const guestPayload = (g) => ({ guest: guestView(g), event: publicEvent(), deadlinePassed: deadlinePassed() });

  app.get('/api/r/:token', noStore, (req, res) => {
    const g = lookup(req, res);
    if (!g) return;
    if (!g.openedAt) { g.openedAt = new Date(now()).toISOString(); store.save(); }
    res.json(guestPayload(g));
  });

  app.post('/api/r/:token', noStore, (req, res) => {
    const g = lookup(req, res);
    if (!g) return;
    if (deadlinePassed()) return res.status(403).json({ error: 'deadline', message: 'Termin odpowiedzi minął. Napisz do organizatora.' });
    const b = req.body || {};
    if (b.status !== 'yes' && b.status !== 'no') return res.status(400).json({ error: 'bad_status', message: 'Wybierz „Będę” albo „Nie dam rady”.' });
    g.status = b.status;
    g.plusOne = b.status === 'yes' && g.plusOneAllowed && b.plusOne === true;
    g.plusOneName = g.plusOne ? str(b.plusOneName, 100) : '';
    g.message = str(b.message, 500);
    g.respondedAt = new Date(now()).toISOString();
    if (!g.openedAt) g.openedAt = g.respondedAt;
    store.save();
    res.json(guestPayload(g));
  });

  // ---------- admin API ----------
  const admin = express.Router();
  admin.use(noStore);

  const requireJson = (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Wyślij dane jako JSON.' });
    }
    next();
  };
  admin.use(requireJson);

  admin.post('/login', (req, res) => {
    const ip = req.ip;
    if (auth.limited(ip)) return res.status(429).json({ error: 'Za dużo prób logowania. Odczekaj kilka minut i spróbuj ponownie.' });
    if (!auth.check((req.body || {}).password)) {
      auth.fail(ip);
      return res.status(401).json({ error: 'Nieprawidłowe hasło. Spróbuj ponownie.' });
    }
    auth.ok(ip);
    auth.issue(res, req.secure);
    res.json({ ok: true });
  });
  admin.post('/logout', (req, res) => { auth.clear(res, req.secure); res.json({ ok: true }); });

  admin.use(auth.require);

  const adminGuest = (g, req) => ({ ...g, link: `${baseUrl(req)}/${g.token}` });
  const people = (g) => (g.status === 'yes' ? 1 + (g.plusOne ? 1 : 0) : 0);

  admin.get('/me', (req, res) => res.json({ ok: true }));

  admin.get('/state', (req, res) => {
    const gs = store.db.guests;
    res.json({
      settings: store.db.settings,
      deadlinePassed: deadlinePassed(),
      guests: gs.map((g) => adminGuest(g, req)),
      counts: {
        total: gs.length,
        yes: gs.filter((g) => g.status === 'yes').length,
        no: gs.filter((g) => g.status === 'no').length,
        pending: gs.filter((g) => g.status === 'pending').length,
        plusOnes: gs.filter((g) => g.status === 'yes' && g.plusOne).length,
        people: gs.reduce((n, g) => n + people(g), 0),
      },
    });
  });

  const SETTING_LIMITS = { title: 120, place: 160, address: 200, dressCode: 120, note: 600 };
  admin.put('/settings', (req, res) => {
    const b = req.body || {};
    const s = {};
    for (const [k, max] of Object.entries(SETTING_LIMITS)) s[k] = str(b[k], max);
    s.date = str(b.date, 10);
    s.time = str(b.time, 5);
    s.deadline = str(b.deadline, 16);
    if (s.date && !/^\d{4}-\d\d-\d\d$/.test(s.date)) return res.status(400).json({ error: 'Podaj datę wydarzenia w formacie RRRR-MM-DD.' });
    if (s.time && !/^\d\d:\d\d$/.test(s.time)) return res.status(400).json({ error: 'Podaj godzinę w formacie GG:MM.' });
    if (s.deadline && localToEpoch(s.deadline, tz) == null) return res.status(400).json({ error: 'Podaj termin odpowiedzi jako datę i godzinę.' });
    if (!s.title) return res.status(400).json({ error: 'Wpisz nazwę wydarzenia.' });
    s.mailSubject = store.db.settings.mailSubject;
    s.mailBody = store.db.settings.mailBody;
    store.db.settings = s;
    store.save();
    res.json({ settings: s });
  });

  const readGuestFields = (b) => {
    const name = str(b.name, 120);
    const email = str(b.email, 200).toLowerCase();
    if (!name) return { error: 'Wpisz imię i nazwisko gościa.' };
    if (email && !EMAIL_RE.test(email)) return { error: 'Adres e-mail wygląda na niepoprawny. Popraw go albo zostaw pole puste.' };
    return { name, email, plusOneAllowed: b.plusOneAllowed === true };
  };

  admin.post('/guests', (req, res) => {
    const f = readGuestFields(req.body || {});
    if (f.error) return res.status(400).json({ error: f.error });
    if (f.email && store.db.guests.some((g) => g.email === f.email)) return res.status(409).json({ error: 'Gość z tym adresem e-mail już jest na liście.' });
    const g = {
      id: newId(), token: newToken((t) => store.db.guests.some((x) => x.token === t)), ...f, status: 'pending', plusOne: false, plusOneName: '',
      message: '', respondedAt: null, openedAt: null, sentAt: null, sendError: '', createdAt: new Date(now()).toISOString(),
    };
    store.db.guests.push(g);
    store.save();
    res.status(201).json({ guest: adminGuest(g, req) });
  });

  admin.post('/guests/bulk', (req, res) => {
    const b = req.body || {};
    if (typeof b.text !== 'string' || b.text.length > 100000) return res.status(400).json({ error: 'Wklej listę gości, jedna osoba w wierszu.' });
    const r = bulkAdd(store, b.text, b.plusOneAllowed === true, new Date(now()).toISOString());
    if (r.added.length) store.save();
    res.json({ added: r.added.length, skipped: r.skipped.length, errors: r.errors, skippedList: r.skipped });
  });

  admin.put('/guests/:id', (req, res) => {
    const g = store.byId(req.params.id);
    if (!g) return res.status(404).json({ error: 'Nie znaleziono gościa.' });
    const f = readGuestFields(req.body || {});
    if (f.error) return res.status(400).json({ error: f.error });
    if (f.email && store.db.guests.some((o) => o.id !== g.id && o.email === f.email)) return res.status(409).json({ error: 'Inny gość ma już ten adres e-mail.' });
    Object.assign(g, f);
    if (!g.plusOneAllowed) { g.plusOne = false; g.plusOneName = ''; }
    store.save();
    res.json({ guest: adminGuest(g, req) });
  });

  admin.post('/guests/:id/reset', (req, res) => {
    const g = store.byId(req.params.id);
    if (!g) return res.status(404).json({ error: 'Nie znaleziono gościa.' });
    Object.assign(g, { status: 'pending', plusOne: false, plusOneName: '', message: '', respondedAt: null });
    store.save();
    res.json({ guest: adminGuest(g, req) });
  });

  admin.delete('/guests/:id', (req, res) => {
    const i = store.db.guests.findIndex((g) => g.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Nie znaleziono gościa.' });
    store.db.guests.splice(i, 1);
    store.save();
    res.json({ ok: true });
  });

  admin.get('/export.csv', (req, res) => {
    const label = { pending: 'czeka', yes: 'będzie', no: 'nie będzie' };
    const head = ['Imię i nazwisko', 'E-mail', 'Status', 'Osoba towarzysząca', 'Imię osoby towarzyszącej', 'Liczba osób', 'Wiadomość', 'Odpowiedź', 'Link otwarty', 'Link'];
    const rows = store.db.guests.map((g) => [
      g.name, g.email, label[g.status], g.plusOne ? 'tak' : (g.plusOneAllowed ? 'nie' : 'brak'), g.plusOneName,
      people(g), g.message, g.respondedAt || '', g.openedAt || '', `${baseUrl(req)}/${g.token}`,
    ]);
    const body = [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="goscie-studniowka.csv"' });
    res.send('\ufeff' + body);
  });


  // ---------- mail ----------
  const mcfg = mail.mailConfig(env);
  const gmail = mcfg.kind === 'gmail' ? createGmail({ dataDir, env, fetchImpl: opts.fetch, now }) : null;
  const transport = opts.transport || (gmail ? { sendMail: (m) => gmail.sendMail(m) } : mail.makeTransport(mcfg));
  const canSend = () => !!opts.transport || (gmail ? gmail.canSend() : !!transport);
  const NOT_READY = 'Wysyłka nie jest gotowa. Skonfiguruj pocztę i połącz konto w zakładce Wyślij zaproszenia.';
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const checker = mail.createChecker({ resolveDomain: opts.resolveDomain || mail.defaultResolveDomain, now });
  const mailState = { running: false, aborted: '', mode: '', total: 0, done: 0, failed: 0, current: '', startedAt: null, finishedAt: null };
  let lastCheck = null;
  const CHECK_TTL = 30 * 60 * 1000;
  const linkFor = (req, g) => `${baseUrl(req)}/${g.token}`;
  const rowsFor = (req) => store.db.guests.map((g) => ({ guest: g, link: linkFor(req, g) }));
  const fp = () => mail.fingerprint(store.db.settings, store.db.guests);
  const REQUIRED_LINK = 'W treści wiadomości musi być znacznik {link}, bo bez niego gość nie dostanie swojego linku.';

  admin.get('/mail/config', (req, res) => {
    res.json({
      transport: mcfg.kind, configured: canSend(), missing: gmail ? gmail.status().missing : mcfg.missing,
      from: gmail ? gmail.status().email : mcfg.from, fromName: env.MAIL_FROM_NAME || '', replyTo: mcfg.replyTo, delayMs: mcfg.delayMs, testTransport: mcfg.json,
      google: gmail ? gmail.status() : null,
    });
  });

  admin.put('/mail/template', (req, res) => {
    const subject = str((req.body || {}).subject, 200);
    const body = String((req.body || {}).body || '').replace(/\r\n/g, '\n').slice(0, 5000).trim();
    if (!subject) return res.status(400).json({ error: 'Wpisz temat wiadomości.' });
    if (!body.includes('{link}')) return res.status(400).json({ error: REQUIRED_LINK });
    store.db.settings.mailSubject = subject;
    store.db.settings.mailBody = body;
    store.save();
    res.json({ subject, body });
  });

  admin.post('/mail/preview', (req, res) => {
    const b = req.body || {};
    const g = store.byId(b.guestId) || store.db.guests[0] || { name: 'Anna Kowalska', token: 'AbCd1234', email: '' };
    const m = mail.buildMessage(store.db.settings, g, linkFor(req, g), { subject: typeof b.subject === 'string' ? b.subject : null, body: typeof b.body === 'string' ? b.body : null });
    res.json({ subject: m.subject, text: m.text, html: m.html, missingLink: !(typeof b.body === 'string' ? b.body : store.db.settings.mailBody).includes('{link}') });
  });

  // HTML preview for an iframe: needs inline styles, so it gets its own CSP and is sandboxed by the page
  admin.get('/mail/preview.html', (req, res) => {
    const g = store.byId(String(req.query.guestId || '')) || store.db.guests[0] || { name: 'Anna Kowalska', token: 'AbCd1234' };
    const m = mail.buildMessage(store.db.settings, g, linkFor(req, g));
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' });
    res.type('html').send(m.html);
  });

  admin.get('/mail/check', async (req, res) => {
    const rows = await checker.check(rowsFor(req));
    lastCheck = { at: now(), fp: fp() };
    const ok = rows.filter((r) => !r.blocking).length;
    res.json({ rows, summary: { total: rows.length, ready: ok, blocked: rows.length - ok, unsent: rows.filter((r) => !r.blocking && !r.sentAt).length, failed: rows.filter((r) => r.sendError && !r.sentAt).length, sent: rows.filter((r) => r.sentAt).length }, template: { subject: store.db.settings.mailSubject, body: store.db.settings.mailBody } });
  });

  const sendOne = async (to, name, m) => transport.sendMail({
    from: mcfg.from || undefined, to: { name, address: to }, ...(mcfg.replyTo ? { replyTo: mcfg.replyTo } : {}),
    subject: m.subject, text: m.text, html: m.html,
  });

  admin.post('/mail/test', async (req, res) => {
    if (!canSend()) return res.status(409).json({ error: NOT_READY });
    const b = req.body || {};
    const to = str(b.to, 200).toLowerCase();
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Wpisz poprawny adres, na który wysłać test.' });
    const body = typeof b.body === 'string' ? b.body : store.db.settings.mailBody;
    if (!body.includes('{link}')) return res.status(400).json({ error: REQUIRED_LINK });
    // test nigdy nie zawiera prawdziwego linku gościa – kliknięcie w teście nie może potwierdzić za kogoś
    const g = { name: 'Gość testowy', token: 'TestTest' };
    const m = mail.buildMessage(store.db.settings, g, linkFor(req, g), { subject: typeof b.subject === 'string' ? b.subject : null, body });
    m.subject = '[TEST] ' + m.subject;
    try { await sendOne(to, g.name, m); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: 'Nie udało się wysłać testu: ' + String(e.message).slice(0, 200) }); }
  });

  admin.post('/google/disconnect', (req, res) => {
    if (!gmail) return res.status(409).json({ error: 'Gmail nie jest używany jako sposób wysyłki.' });
    gmail.disconnect();
    res.json({ ok: true });
  });

  admin.get('/mail/status', (req, res) => res.json(mailState));

  async function runSend(ids, links) {
    mailState.running = true;
    try {
      for (let i = 0; i < ids.length; i++) {
        const g = store.byId(ids[i]);
        if (!g) { mailState.done++; continue; }
        if (i > 0 && mcfg.delayMs) await sleep(mcfg.delayMs);
        mailState.current = g.name;
        try {
          await sendOne(g.email.trim().toLowerCase(), g.name, mail.buildMessage(store.db.settings, g, links.get(g.id)));
          g.sentAt = new Date(now()).toISOString();
          g.sendError = '';
        } catch (e) {
          g.sendError = String(e.message || e).slice(0, 300);
          mailState.failed++;
          if (e.code === 'invalid_grant') { mailState.done++; mailState.aborted = e.message; store.save(); break; }
        }
        mailState.done++;
        store.save();
      }
    } finally {
      mailState.running = false; mailState.current = ''; mailState.finishedAt = new Date(now()).toISOString();
    }
  }

  admin.post('/mail/send', async (req, res) => {
    if (!canSend()) return res.status(409).json({ error: NOT_READY });
    if (mailState.running) return res.status(409).json({ error: 'Wysyłka już trwa. Poczekaj, aż się skończy.' });
    const b = req.body || {};
    if (b.confirm !== 'WYŚLIJ') return res.status(400).json({ error: 'Wpisz WYŚLIJ, żeby potwierdzić wysyłkę.' });
    if (!lastCheck || lastCheck.fp !== fp() || now() - lastCheck.at > CHECK_TTL) return res.status(412).json({ error: 'Najpierw sprawdź listę odbiorców. Wynik sprawdzenia traci ważność po zmianie gości albo treści i po 30 minutach.' });
    if (!store.db.settings.mailBody.includes('{link}')) return res.status(400).json({ error: REQUIRED_LINK });
    const mode = b.mode;
    const rows = await checker.check(rowsFor(req));
    let pick;
    if (mode === 'unsent') pick = rows.filter((r) => !r.sentAt);
    else if (mode === 'failed') pick = rows.filter((r) => r.sendError && !r.sentAt);
    else if (mode === 'selected' && Array.isArray(b.guestIds)) { const set = new Set(b.guestIds); pick = rows.filter((r) => set.has(r.id)); }
    else return res.status(400).json({ error: 'Wybierz, do kogo wysłać.' });
    pick = pick.filter((r) => !r.blocking);
    if (!pick.length) return res.status(400).json({ error: 'Nie ma nikogo do wysłania w tym wyborze.' });
    if (b.count !== pick.length) return res.status(409).json({ error: `Liczba odbiorców się zmieniła (teraz ${pick.length}). Odśwież i potwierdź jeszcze raz.` });
    if (mailState.running) return res.status(409).json({ error: 'Wysyłka już trwa. Poczekaj, aż się skończy.' });
    Object.assign(mailState, { running: true, aborted: '', mode, total: pick.length, done: 0, failed: 0, current: '', startedAt: new Date(now()).toISOString(), finishedAt: null });
    const links = new Map(pick.map((r) => [r.id, r.link]));
    runSend(pick.map((r) => r.id), links).catch((e) => console.error(e));
    res.status(202).json({ total: pick.length });
  });


  // ---------- Google OAuth (Gmail) ----------
  const sessionOf = (req) => auth.sessionValue(req);
  const toAdmin = (res, q) => res.redirect(303, '/admin' + (q ? '?' + q : ''));
  app.get('/admin/google/start', noStore, (req, res) => {
    if (!auth.isAuthed(req)) return toAdmin(res);
    if (!gmail || !gmail.status().clientConfigured) return toAdmin(res, 'google=missing');
    res.redirect(303, gmail.authUrl(gmail.newState(sessionOf(req))));
  });
  app.get('/admin/google/callback', noStore, async (req, res) => {
    if (!auth.isAuthed(req)) return toAdmin(res);
    if (!gmail) return toAdmin(res, 'google=error');
    const { code, state, error } = req.query;
    if (typeof state !== 'string' || !gmail.takeState(state, sessionOf(req))) return toAdmin(res, 'google=state');
    if (error || typeof code !== 'string') return toAdmin(res, 'google=denied');
    try { await gmail.exchangeCode(code); toAdmin(res, 'google=connected'); }
    catch (e) { console.error('Google OAuth: wymiana kodu nie powiodła się (' + (e.code || 'error') + ')'); toAdmin(res, 'google=error'); }
  });

  app.use('/api/admin', admin);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Niepoprawne dane.' });
    console.error(err);
    res.status(500).json({ error: 'Coś poszło nie tak. Spróbuj ponownie.' });
  });

  app.locals.store = store;
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  let app;
  try { app = createApp(); } catch (e) { console.error(e.message); process.exit(1); }
  app.listen(port, () => console.log(`RSVP działa na http://localhost:${port} (panel: /admin)`));
}

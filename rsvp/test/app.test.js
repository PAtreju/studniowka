'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../server');
const { parseLine } = require('../lib/guests');
const { newToken } = require('../lib/util');

let clock = Date.parse('2027-01-10T12:00:00Z');

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
  const app = createApp({ env: { ADMIN_PASSWORD: 'sekret', DATA_DIR: dir, SESSION_SECRET: 'x'.repeat(32), ...extra }, now: () => clock });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const headers = { ...(cookie && !opts.anon ? { cookie } : {}) };
    if (body !== undefined) headers['content-type'] = opts.type || 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)), redirect: 'manual' });
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json, buf };
  };
  const login = async () => {
    const r = await call('POST', '/api/admin/login', { password: 'sekret' }, { anon: true });
    cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  const close = () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, call, login, close, dir, app };
}

async function withGuest(t, extra) {
  const h = await boot(extra);
  t.after(h.close);
  await h.login();
  const r = await h.call('POST', '/api/admin/guests', { name: 'Test Gość', email: 'Test@Example.com', plusOneAllowed: true });
  assert.equal(r.status, 201);
  return { h, g: r.json.guest };
}

test('token: 8 chars base62, link is short', async (t) => {
  const { g } = await withGuest(t, { PUBLIC_URL: 'https://rsvp.example.test/' });
  assert.match(g.token, /^[A-Za-z0-9]{8}$/);
  assert.equal(g.link, `https://rsvp.example.test/${g.token}`);
  assert.equal(g.email, 'test@example.com');
  assert.ok(!/gość|example\.com/i.test(g.link.replace('rsvp.example.test', '')));
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newToken());
  assert.equal(seen.size, 500);
});

test('guest page served on /<token> and /r/<token>, uniform for unknown', async (t) => {
  const { h, g } = await withGuest(t);
  for (const p of [`/${g.token}`, `/r/${g.token}`, '/AAAAAAAA']) {
    const r = await h.call('GET', p, undefined, { anon: true });
    assert.equal(r.status, 200);
    assert.match(r.text, /<html/);
    assert.ok(!r.text.includes('Test Gość'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await h.call('GET', '/short', undefined, { anon: true })).status, 404);
  assert.equal((await h.call('GET', '/guest.js', undefined, { anon: true })).status, 200);
  assert.equal((await h.call('GET', '/admin', undefined, { anon: true })).status, 200);
});

test('GET shows data and records open, never confirms', async (t) => {
  const { h, g } = await withGuest(t);
  const r = await h.call('GET', `/api/r/${g.token}`, undefined, { anon: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.guest.name, 'Test Gość');
  assert.equal(r.json.guest.status, 'pending');
  assert.equal(r.json.guest.plusOneAllowed, true);
  assert.equal(r.json.guest.token, undefined);
  assert.equal(r.json.guest.email, undefined);
  const s = await h.call('GET', '/api/admin/state');
  assert.equal(s.json.guests[0].status, 'pending');
  assert.ok(s.json.guests[0].openedAt);
});

test('unknown token: uniform 404 and per-IP rate limit', async (t) => {
  const h = await boot();
  t.after(h.close);
  const a = await h.call('GET', '/api/r/zzzzzzzz', undefined, { anon: true });
  const b = await h.call('GET', '/api/r/short', undefined, { anon: true });
  assert.equal(a.status, 404);
  assert.equal(a.text, b.text);
  assert.equal((await h.call('POST', '/api/r/zzzzzzzz', { status: 'yes' }, { anon: true })).text, a.text);
  let last;
  for (let i = 0; i < 40; i++) last = await h.call('GET', `/api/r/${String(i).padStart(8, 'q')}`, undefined, { anon: true });
  assert.equal(last.status, 429);
});

test('POST confirm, change answer, plus-one rules', async (t) => {
  const { h, g } = await withGuest(t);
  const url = `/api/r/${g.token}`;
  let r = await h.call('POST', url, { status: 'yes', plusOne: true, plusOneName: '<b>Ola</b>', message: 'wege' }, { anon: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.guest.status, 'yes');
  assert.equal(r.json.guest.plusOne, true);
  assert.equal(r.json.guest.plusOneName, '<b>Ola</b>'); // stored raw, escaped on render
  assert.ok(r.json.guest.respondedAt);
  let s = await h.call('GET', '/api/admin/state');
  assert.equal(s.json.counts.people, 2);
  r = await h.call('POST', url, { status: 'no', plusOne: true }, { anon: true });
  assert.equal(r.json.guest.status, 'no');
  assert.equal(r.json.guest.plusOne, false);
  s = await h.call('GET', '/api/admin/state');
  assert.equal(s.json.counts.people, 0);
  assert.equal(s.json.counts.no, 1);
  r = await h.call('POST', url, { status: 'maybe' }, { anon: true });
  assert.equal(r.status, 400);
  const g2 = (await h.call('POST', '/api/admin/guests', { name: 'Bez Osoby', email: '' })).json.guest;
  r = await h.call('POST', `/api/r/${g2.token}`, { status: 'yes', plusOne: true }, { anon: true });
  assert.equal(r.json.guest.plusOne, false);
});

test('deadline enforcement', async (t) => {
  const { h, g } = await withGuest(t);
  // deadline 2027-01-10 14:00 Warsaw (= 13:00Z); clock is 12:00Z
  await h.call('PUT', '/api/admin/settings', { title: 'S', deadline: '2027-01-10T14:00' });
  let r = await h.call('POST', `/api/r/${g.token}`, { status: 'yes' }, { anon: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.deadlinePassed, false);
  clock = Date.parse('2027-01-10T13:30:00Z');
  r = await h.call('POST', `/api/r/${g.token}`, { status: 'no' }, { anon: true });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'deadline');
  r = await h.call('GET', `/api/r/${g.token}`, undefined, { anon: true });
  assert.equal(r.json.deadlinePassed, true);
  assert.equal(r.json.guest.status, 'yes');
  clock = Date.parse('2027-01-10T12:00:00Z');
});

test('admin routes require auth', async (t) => {
  const { h, g } = await withGuest(t);
  const routes = [
    ['GET', '/api/admin/me'], ['GET', '/api/admin/state'], ['PUT', '/api/admin/settings', { title: 'x' }],
    ['POST', '/api/admin/guests', { name: 'a' }], ['POST', '/api/admin/guests/bulk', { text: 'A B, a@b.pl' }],
    ['PUT', `/api/admin/guests/${g.id}`, { name: 'x' }], ['POST', `/api/admin/guests/${g.id}/reset`, {}],
    ['DELETE', `/api/admin/guests/${g.id}`], ['GET', '/api/admin/export.csv'],
  ];
  for (const [m, u, b] of routes) {
    const r = await h.call(m, u, b, { anon: true });
    assert.equal(r.status, 401, `${m} ${u}`);
    assert.ok(!r.text.includes('Test Gość'));
  }
  const forged = await h.call('GET', '/api/admin/state', undefined, { anon: true });
  assert.equal(forged.status, 401);
  const bad = await fetch(h.base + '/api/admin/state', { headers: { cookie: 'rsvp_session=9999999999999.forged' } });
  assert.equal(bad.status, 401);
});

test('login: wrong password, cookie flags, rate limit, secure behind https proxy', async (t) => {
  const h = await boot();
  t.after(h.close);
  let r = await h.call('POST', '/api/admin/login', { password: 'nope' }, { anon: true });
  assert.equal(r.status, 401);
  r = await h.call('POST', '/api/admin/login', { password: 'sekret' }, { anon: true });
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.doesNotMatch(c, /Secure/);
  const res = await fetch(h.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password: 'sekret' }) });
  assert.match(res.headers.get('set-cookie'), /Secure/);
  r = await h.call('POST', '/api/admin/login', 'password=sekret', { anon: true, type: 'text/plain', raw: true });
  assert.equal(r.status, 415);
  for (let i = 0; i < 9; i++) r = await h.call('POST', '/api/admin/login', { password: 'bad' }, { anon: true });
  assert.equal(r.status, 429);
  r = await h.call('POST', '/api/admin/login', { password: 'sekret' }, { anon: true });
  assert.equal(r.status, 429);
});

test('security headers', async (t) => {
  const h = await boot();
  t.after(h.close);
  const r = await h.call('GET', '/admin', undefined, { anon: true });
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('admin: edit, reset, delete, settings validation', async (t) => {
  const { h, g } = await withGuest(t);
  await h.call('POST', `/api/r/${g.token}`, { status: 'yes', plusOne: true, message: 'hej' }, { anon: true });
  let r = await h.call('PUT', `/api/admin/guests/${g.id}`, { name: 'Nowe Imię', email: 'n@example.com', plusOneAllowed: false });
  assert.equal(r.json.guest.plusOne, false);
  assert.equal(r.json.guest.name, 'Nowe Imię');
  r = await h.call('POST', `/api/admin/guests/${g.id}/reset`, {});
  assert.equal(r.json.guest.status, 'pending');
  assert.equal(r.json.guest.message, '');
  assert.equal((await h.call('PUT', '/api/admin/settings', { title: '' })).status, 400);
  assert.equal((await h.call('PUT', '/api/admin/settings', { title: 'S', date: 'jutro' })).status, 400);
  assert.equal((await h.call('POST', '/api/admin/guests', { name: 'X', email: 'bad' })).status, 400);
  assert.equal((await h.call('POST', '/api/admin/guests', { name: 'Y', email: 'n@example.com' })).status, 409);
  assert.equal((await h.call('DELETE', `/api/admin/guests/${g.id}`)).status, 200);
  assert.equal((await h.call('GET', `/api/r/${g.token}`, undefined, { anon: true })).status, 404);
});

test('CSV export: BOM, header, escaping, formula guard', async (t) => {
  const { h, g } = await withGuest(t);
  await h.call('POST', `/api/r/${g.token}`, { status: 'yes', message: '=HYPERLINK("x");\nlinia' }, { anon: true });
  const r = await h.call('GET', '/api/admin/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv; charset=utf-8/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.deepEqual([...Buffer.from(r.buf).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const [head] = r.text.replace(/^\ufeff/, '').split('\r\n');
  assert.ok(head.startsWith('Imię i nazwisko;E-mail;Status'));
  assert.ok(r.text.includes('Test Gość;test@example.com;będzie'));
  assert.ok(r.text.includes(`"'=HYPERLINK(""x"");\nlinia"`));
  assert.ok(r.text.includes(`/${g.token}`));
});

test('bulk add: lines, tsv, header, trim, lowercase, duplicates', async (t) => {
  const h = await boot();
  t.after(h.close);
  await h.login();
  const text = [
    'email\tImie\tNazwisko',
    'Anna.Test@Example.com\tAnna \tKowalska ',
    'jan@example.com\tJan\tNowak',
    'Ewa Zielińska, EWA@example.com',
    'Piotr Bez Maila',
    'anna.test@example.com\tAnna\tDuplikat',
    '',
    'zły adres, nie-email@',
  ].join('\r\n');
  const r = await h.call('POST', '/api/admin/guests/bulk', { text, plusOneAllowed: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 4);
  assert.equal(r.json.skipped, 1);
  assert.equal(r.json.errors.length, 1);
  const s = (await h.call('GET', '/api/admin/state')).json.guests;
  const names = s.map((g) => g.name);
  assert.deepEqual(names, ['Anna Kowalska', 'Jan Nowak', 'Ewa Zielińska', 'Piotr Bez Maila']);
  assert.equal(s[0].email, 'anna.test@example.com');
  assert.equal(s[2].email, 'ewa@example.com');
  assert.ok(s.every((g) => g.plusOneAllowed && /^[A-Za-z0-9]{8}$/.test(g.token)));
  assert.equal(new Set(s.map((g) => g.token)).size, 4);
  const again = await h.call('POST', '/api/admin/guests/bulk', { text });
  assert.equal(again.json.added, 1); // only the email-less line has no duplicate key
});

test('parseLine detects email column anywhere', () => {
  assert.deepEqual(parseLine('Imię\tNazwisko\tx@y.pl'), { name: 'Imię Nazwisko', email: 'x@y.pl' });
  assert.deepEqual(parseLine('email\tImie\tNazwisko'), { skip: true });
});

test('CLI import script and persistence with atomic db.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-cli-'));
  const file = path.join(dir, 'in.tsv');
  fs.writeFileSync(file, 'email\tImie\tNazwisko\na@example.com\tAda \tTest\nb@example.com\tBob\tTest\na@example.com\tAda\tTwice\n');
  const run = () => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'import.js'), file], { env: { ...process.env, DATA_DIR: dir } }).toString();
  assert.match(run(), /Dodano: 2, pominięto duplikaty: 1/);
  assert.match(run(), /Dodano: 0, pominięto duplikaty: 3/);
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(db.guests.length, 2);
  assert.equal(db.guests[0].name, 'Ada Test');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

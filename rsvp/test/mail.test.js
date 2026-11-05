'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const mail = require('../lib/mail');

// Nothing here touches the network: transport and DNS are fakes.
async function boot({ delay = 2000, fail = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-mail-'));
  const sent = [];
  const sleeps = [];
  let inflight = 0;
  let maxInflight = 0;
  const transport = {
    sendMail: async (m) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setImmediate(r));
      inflight--;
      if (fail.includes(m.to.address)) throw new Error('550 odrzucono');
      sent.push(m);
    },
  };
  const resolveDomain = async (d) => ({ state: d.startsWith('nie-ma') ? 'none' : d.startsWith('timeout') ? 'unknown' : 'ok', via: 'MX' });
  const app = createApp({
    env: {
      ADMIN_PASSWORD: 'p', DATA_DIR: dir, SESSION_SECRET: 's'.repeat(32), SMTP_HOST: 'smtp.invalid', SMTP_USER: 'u', SMTP_PASS: 'x',
      MAIL_FROM: 'Studniówka <a@example.com>', MAIL_REPLY_TO: 'org@example.com', MAIL_DELAY_MS: String(delay), PUBLIC_URL: 'https://rsvp.example.test',
    },
    transport,
    resolveDomain,
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); },
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  const idle = async () => {
    for (let i = 0; i < 500; i++) {
      const s = (await call('GET', '/api/admin/mail/status')).json;
      if (!s.running) return s;
      await new Promise((x) => setTimeout(x, 5));
    }
    throw new Error('send never finished');
  };
  return { call, sent, sleeps, idle, maxInflight: () => maxInflight, close() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const addGuests = (h, lines) => h.call('POST', '/api/admin/guests/bulk', { text: lines.join('\n') });
const send = (h, body) => h.call('POST', '/api/admin/mail/send', { confirm: 'WYŚLIJ', ...body });
const check = (h) => h.call('GET', '/api/admin/mail/check');

test('placeholders render; html is escaped and has no remote resources', () => {
  const g = { name: 'Anna Maria Kowalska', token: 'AbCd1234' };
  const m = mail.buildMessage({ mailSubject: 'Hej {imie}', mailBody: 'Cześć {imie} ({nazwisko}) {link}' }, g, 'https://x.test/AbCd1234');
  assert.equal(m.subject, 'Hej Anna');
  assert.equal(m.text, 'Cześć Anna (Maria Kowalska) https://x.test/AbCd1234');
  assert.match(m.html, /href="https:\/\/x\.test\/AbCd1234"/);
  const evil = mail.buildMessage({ mailSubject: 's', mailBody: '<script>alert(1)</script> {link}' }, { name: '<img src=x>' }, 'https://x.test/a');
  assert.ok(!evil.html.includes('<script>') && !evil.html.includes('<img'));
  assert.ok(!/<img|src=|url\(/i.test(m.html));
});

test('template save requires {link}; settings save keeps the template', async (t) => {
  const h = await boot(); t.after(h.close);
  assert.equal((await h.call('PUT', '/api/admin/mail/template', { subject: 'x', body: 'bez linku' })).status, 400);
  assert.equal((await h.call('PUT', '/api/admin/mail/template', { subject: 'Temat', body: 'Hej {imie} {link}' })).status, 200);
  assert.equal((await check(h)).json.template.subject, 'Temat');
  assert.ok(mail.DEFAULT_BODY.includes('{link}'));
  const p = (await h.call('POST', '/api/admin/mail/preview', { body: 'tylko {imie}' })).json;
  assert.equal(p.missingLink, true);
  await h.call('PUT', '/api/admin/settings', { title: 'Nowy' });
  assert.equal((await check(h)).json.template.body, 'Hej {imie} {link}');
});

test('check step flags missing/invalid email, normalisation, DNS failure and DNS unknown', async (t) => {
  const h = await boot(); t.after(h.close);
  await addGuests(h, ['Ok Ok, ok@example.com', 'Brak Maila', 'Wielkie Litery, Big@Example.COM', 'Zła Domena, a@nie-ma.example', 'Wolny Dns, b@timeout.example']);
  const r = (await check(h)).json;
  const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(by['Ok Ok'].blocking, false);
  assert.equal(by['Ok Ok'].problems.length, 0);
  assert.equal(by['Brak Maila'].blocking, true);
  assert.equal(by['Wielkie Litery'].email, 'big@example.com');
  assert.ok(by['Zła Domena'].blocking && /nie istnieje/.test(by['Zła Domena'].problems[0].text));
  assert.equal(by['Wolny Dns'].blocking, false);
  assert.equal(by['Wolny Dns'].problems[0].level, 'warn');
  assert.match(by['Ok Ok'].link, /^https:\/\/rsvp\.example\.test\/[A-Za-z0-9]{8}$/);
  assert.equal(r.summary.total, 5);
  assert.equal(r.summary.blocked, 2);
});

test('checker flags duplicates and whitespace/case normalisation, caches per domain', async () => {
  let lookups = 0;
  const c = mail.createChecker({ resolveDomain: async () => { lookups++; return { state: 'ok' }; }, now: Date.now });
  const rows = await c.check([
    { guest: { id: '1', name: 'A', email: ' X@Y.pl ' }, link: 'l1' },
    { guest: { id: '2', name: 'B', email: 'x@y.pl' }, link: 'l2' },
  ]);
  assert.ok(rows[0].problems.some((p) => /więcej niż raz/.test(p.text)));
  assert.ok(rows[0].problems.some((p) => /małymi literami/.test(p.text)));
  await c.check([{ guest: { id: '3', name: 'C', email: 'z@y.pl' }, link: 'l3' }]);
  assert.equal(lookups, 1);
});

test('send needs a fresh check, the confirmation word and the exact count', async (t) => {
  const h = await boot(); t.after(h.close);
  await addGuests(h, ['A A, a@example.com', 'B B, b@example.com']);
  assert.equal((await send(h, { mode: 'unsent', count: 2 })).status, 412);
  await check(h);
  assert.equal((await h.call('POST', '/api/admin/mail/send', { confirm: 'wyslij', mode: 'unsent', count: 2 })).status, 400);
  assert.equal((await h.call('POST', '/api/admin/mail/send', { mode: 'unsent', count: 2 })).status, 400);
  assert.equal((await send(h, { mode: 'unsent', count: 5 })).status, 409);
  assert.equal(h.sent.length, 0);
  await h.call('POST', '/api/admin/guests', { name: 'C C', email: 'c@example.com' });
  assert.equal((await send(h, { mode: 'unsent', count: 3 })).status, 412); // guest list changed since the check
});

test('sequential throttled send, per-guest status, lock, no re-send, retry failed', async (t) => {
  const h = await boot({ delay: 1500, fail: ['b@example.com'] }); t.after(h.close);
  await addGuests(h, ['A A, a@example.com', 'B B, b@example.com', 'C C, c@example.com', 'Zła, z@nie-ma.example']);
  await check(h);
  const r = await send(h, { mode: 'unsent', count: 3 });
  assert.equal(r.status, 202);
  assert.equal((await send(h, { mode: 'unsent', count: 3 })).status, 409); // locked while running
  const s = await h.idle();
  assert.equal(s.total, 3);
  assert.equal(s.done, 3);
  assert.equal(s.failed, 1);
  assert.equal(h.maxInflight(), 1);
  assert.deepEqual(h.sleeps, [1500, 1500]); // throttled between messages, not before the first
  assert.deepEqual(h.sent.map((m) => m.to.address), ['a@example.com', 'c@example.com']);
  const m = h.sent[0];
  assert.equal(m.replyTo, 'org@example.com');
  assert.equal(m.from, 'Studniówka <a@example.com>');
  assert.ok(m.text.includes('https://rsvp.example.test/'));
  assert.ok(m.html.includes('<a href="https://rsvp.example.test/') && m.html.includes('style="'));
  const by = Object.fromEntries((await h.call('GET', '/api/admin/state')).json.guests.map((g) => [g.name, g]));
  assert.ok(by['A A'].sentAt);
  assert.equal(by['A A'].sendError, '');
  assert.equal(by['B B'].sentAt, null);
  assert.match(by['B B'].sendError, /550/);
  assert.equal(by['Zła'].sentAt, null);
  assert.equal(by['Zła'].sendError, ''); // blocked recipient never attempted
  // "unsent" now only covers B (failed again); A and C are not sent twice
  await check(h);
  assert.equal((await send(h, { mode: 'unsent', count: 1 })).status, 202);
  await h.idle();
  assert.equal(h.sent.length, 2);
  await check(h);
  assert.equal((await send(h, { mode: 'failed', count: 1 })).status, 202);
  assert.equal((await h.idle()).failed, 1);
});

test('resend to selected guests only', async (t) => {
  const h = await boot({ delay: 0 }); t.after(h.close);
  await addGuests(h, ['A A, a@example.com', 'B B, b@example.com']);
  const gs = (await h.call('GET', '/api/admin/state')).json.guests;
  await check(h);
  await send(h, { mode: 'unsent', count: 2 });
  await h.idle();
  assert.equal(h.sent.length, 2);
  await check(h);
  assert.equal((await send(h, { mode: 'unsent', count: 1 })).status, 400); // nothing left unsent
  const r = await send(h, { mode: 'selected', guestIds: [gs[1].id], count: 1 });
  assert.equal(r.status, 202);
  await h.idle();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].to.address, 'b@example.com');
  assert.deepEqual(h.sleeps, []);
});

test('test mail validates address and marks the subject', async (t) => {
  const h = await boot(); t.after(h.close);
  await addGuests(h, ['A A, a@example.com']);
  assert.equal((await h.call('POST', '/api/admin/mail/test', { to: 'nie-mail' })).status, 400);
  assert.equal((await h.call('POST', '/api/admin/mail/test', { to: 'me@example.com', body: 'bez' })).status, 400);
  assert.equal((await h.call('POST', '/api/admin/mail/test', { to: 'Me@Example.com' })).status, 200);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].subject, /^\[TEST\] /);
  assert.equal(h.sent[0].to.address, 'me@example.com');
});

test('mail routes need login; unconfigured disables sending; json transport stays local', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-mail2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = createApp({ env: { ADMIN_PASSWORD: 'p', DATA_DIR: dir, SESSION_SECRET: 's'.repeat(32) } });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const routes = [['GET', '/mail/config'], ['GET', '/mail/check'], ['GET', '/mail/status'], ['GET', '/mail/preview.html'], ['PUT', '/mail/template'], ['POST', '/mail/send'], ['POST', '/mail/test'], ['POST', '/mail/preview']];
  for (const [m, u] of routes) {
    const r = await fetch(base + '/api/admin' + u, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 401, u);
  }
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"p"}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const cfg = await (await fetch(base + '/api/admin/mail/config', { headers: { cookie } })).json();
  assert.equal(cfg.configured, false);
  assert.equal(cfg.transport, 'gmail');
  assert.deepEqual(cfg.missing, ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'PUBLIC_BASE_URL']);
  const s = await fetch(base + '/api/admin/mail/send', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"confirm":"WYŚLIJ"}' });
  assert.equal(s.status, 409);
  const j = mail.mailConfig({ MAIL_TRANSPORT: 'json' });
  assert.equal(j.configured, true);
  const info = await mail.makeTransport(j).sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' });
  assert.equal(JSON.parse(info.message).subject, 's');
  const d = mail.mailConfig({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'f' });
  assert.equal(d.port, 465);
  assert.equal(d.secure, true);
  assert.equal(d.delayMs, 2000);
});

test('HTML preview route: own CSP for inline styles, frameable only by itself', async (t) => {
  const h = await boot(); t.after(h.close);
  await addGuests(h, ['A A, a@example.com']);
  const r = await h.call('GET', '/api/admin/mail/preview.html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(r.text, /Zaproszenie/);
});

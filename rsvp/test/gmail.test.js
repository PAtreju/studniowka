'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { buildRaw, encodeWord } = require('../lib/mime');

// Google is mocked through the injected fetch: no network is ever used.
const idToken = (email) => 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s';

function mockGoogle({ refreshFails = false } = {}) {
  const log = { token: [], send: [], calls: [] };
  const fetchImpl = async (url, init = {}) => {
    log.calls.push(String(url));
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url) === 'https://oauth2.example.test/token') {
      const p = new URLSearchParams(init.body);
      log.token.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') === 'bad') return json(400, { error: 'invalid_grant' });
        if (p.get('code') === 'norefresh') return json(200, { access_token: 'at0', expires_in: 3600, id_token: idToken('org@example.com') });
        return json(200, { access_token: 'at1', refresh_token: 'RT-secret', expires_in: 3600, id_token: idToken('org@example.com') });
      }
      if (refreshFails) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'at2', expires_in: 3600 });
    }
    if (String(url) === 'https://gmail.example.test/gmail/v1/users/me/messages/send') {
      log.send.push({ auth: init.headers.authorization, raw: Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8') });
      return json(200, { id: 'm1' });
    }
    throw new Error('unexpected network call: ' + url);
  };
  return { fetchImpl, log };
}

async function boot(google, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-gm-'));
  let clock = Date.parse('2027-01-10T12:00:00Z');
  const app = createApp({
    env: {
      ADMIN_PASSWORD: 'p', DATA_DIR: dir, SESSION_SECRET: 's'.repeat(32), GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
      PUBLIC_BASE_URL: 'https://rsvp.example.test/', GOOGLE_TOKEN_URL: 'https://oauth2.example.test/token', GMAIL_API_URL: 'https://gmail.example.test/gmail/v1',
      MAIL_FROM_NAME: 'Studniówka', MAIL_DELAY_MS: '0', ...extraEnv,
    },
    fetch: google.fetchImpl, now: () => clock, resolveDomain: async () => ({ state: 'ok' }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, o = {}) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { ...(cookie && !o.anon ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"p"}' });
  cookie = r.headers.get('set-cookie').split(';')[0];
  const connect = async () => {
    const st = await call('GET', '/admin/google/start');
    const state = new URL(st.headers.get('location')).searchParams.get('state');
    return call('GET', `/admin/google/callback?code=goodcode&state=${state}`);
  };
  const idle = async () => { for (let i = 0; i < 500; i++) { const s = (await call('GET', '/api/admin/mail/status')).json; if (!s.running) return s; await new Promise((x) => setTimeout(x, 5)); } throw new Error('stuck'); };
  return { call, dir, connect, idle, advance: (ms) => { clock += ms; }, close() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('mime: RFC 2047 subject, multipart/alternative, UTF-8, no header injection', () => {
  const raw = buildRaw({ from: { name: 'Studniówka', address: 'a@example.com' }, to: { name: 'Zażółć\r\nBcc: x@y.pl', address: 'b@example.com' }, subject: 'Zaproszenie na studniówkę – Żółć', text: 'Cześć', html: '<p>Cześć</p>' });
  const [head, ...rest] = raw.split('\r\n\r\n');
  assert.match(head, /^From: =\?UTF-8\?B\?/m);
  assert.doesNotMatch(head, /^Bcc:/m);
  const subj = head.match(/^Subject: ([\s\S]*?)\r\n(?=[A-Z][A-Za-z-]+:)/m)[1].replace(/\r\n /g, ' ');
  const decoded = subj.split(' ').map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('');
  assert.equal(decoded, 'Zaproszenie na studniówkę – Żółć');
  for (const w of subj.split(' ')) assert.ok(w.length <= 75);
  assert.match(head, /Content-Type: multipart\/alternative; boundary=/);
  assert.match(rest.join('\n\n'), /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(rest.join('\n\n'), /Content-Type: text\/html; charset=UTF-8/);
  assert.equal(encodeWord('plain ascii'), 'plain ascii');
});

test('OAuth: start redirect, state bound to session, callback stores token (0600), no secrets in API', async (t) => {
  const g = mockGoogle();
  const h = await boot(g); t.after(h.close);
  const cfg0 = (await h.call('GET', '/api/admin/mail/config')).json;
  assert.equal(cfg0.transport, 'gmail');
  assert.equal(cfg0.configured, false);
  assert.equal(cfg0.google.redirectUri, 'https://rsvp.example.test/admin/google/callback');
  assert.equal(cfg0.google.connected, false);
  const st = await h.call('GET', '/admin/google/start');
  assert.equal(st.status, 303);
  const u = new URL(st.headers.get('location'));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://rsvp.example.test/admin/google/callback');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  const state = u.searchParams.get('state');
  assert.ok(state.length >= 20);
  // wrong state, logged-out callback and replayed state do nothing
  assert.match((await h.call('GET', '/admin/google/callback?code=goodcode&state=nope')).headers.get('location'), /google=state/);
  assert.equal((await h.call('GET', `/admin/google/callback?code=goodcode&state=${state}`, undefined, { anon: true })).headers.get('location'), '/admin');
  assert.equal(g.log.token.length, 0);
  const ok = await h.call('GET', `/admin/google/callback?code=goodcode&state=${state}`);
  assert.match(ok.headers.get('location'), /google=connected/);
  assert.match((await h.call('GET', `/admin/google/callback?code=goodcode&state=${state}`)).headers.get('location'), /google=state/); // single use
  assert.equal(g.log.token[0].redirect_uri, 'https://rsvp.example.test/admin/google/callback');
  const file = path.join(h.dir, 'google-token.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, 'RT-secret');
  const cfg = await h.call('GET', '/api/admin/mail/config');
  assert.equal(cfg.json.configured, true);
  assert.equal(cfg.json.google.email, 'org@example.com');
  assert.ok(!cfg.text.includes('RT-secret') && !cfg.text.includes('csecret') && !cfg.text.includes('at1'));
  assert.ok(!(await h.call('GET', '/api/admin/state')).text.includes('RT-secret'));
});

test('OAuth: routes need login, denied/missing refresh token handled', async (t) => {
  const g = mockGoogle();
  const h = await boot(g); t.after(h.close);
  assert.equal((await h.call('GET', '/admin/google/start', undefined, { anon: true })).headers.get('location'), '/admin');
  assert.equal((await h.call('POST', '/api/admin/google/disconnect', {}, { anon: true })).status, 401);
  const st = await h.call('GET', '/admin/google/start');
  const state = new URL(st.headers.get('location')).searchParams.get('state');
  assert.match((await h.call('GET', `/admin/google/callback?error=access_denied&state=${state}`)).headers.get('location'), /google=denied/);
  const st2 = await h.call('GET', '/admin/google/start');
  const s2 = new URL(st2.headers.get('location')).searchParams.get('state');
  assert.match((await h.call('GET', `/admin/google/callback?code=norefresh&state=${s2}`)).headers.get('location'), /google=error/);
  assert.equal(fs.existsSync(path.join(h.dir, 'google-token.json')), false);
});

test('send via Gmail API: raw message, refresh token use, From is connected account', async (t) => {
  const g = mockGoogle();
  const h = await boot(g); t.after(h.close);
  await h.connect();
  await h.call('POST', '/api/admin/guests', { name: 'Zażółć Gęślą', email: 'gosc@example.com' });
  const r = await h.call('POST', '/api/admin/mail/test', { to: 'me@example.com' });
  assert.equal(r.status, 200);
  assert.equal(g.log.send.length, 1);
  assert.equal(g.log.send[0].auth, 'Bearer at1');
  const raw = g.log.send[0].raw;
  assert.match(raw, /^From: =\?UTF-8\?B\?[^\r\n]+<org@example\.com>/m);
  assert.match(raw, /^To: [^\r\n]*<me@example\.com>/m);
  assert.match(raw, /multipart\/alternative/);
  const text = Buffer.from(raw.split('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /Cześć Zażółć/);
  assert.match(text, /https:\/\/rsvp\.example\.test\/[A-Za-z0-9]{8}/);
  // token expires -> refreshed with the stored refresh token
  h.advance(2 * 3600 * 1000);
  await h.call('POST', '/api/admin/mail/test', { to: 'me@example.com' });
  assert.equal(g.log.token.at(-1).grant_type, 'refresh_token');
  assert.equal(g.log.token.at(-1).refresh_token, 'RT-secret');
  assert.equal(g.log.send[1].auth, 'Bearer at2');
});

test('full send flow over Gmail with check, confirmation and per-guest status', async (t) => {
  const g = mockGoogle();
  const h = await boot(g); t.after(h.close);
  await h.call('POST', '/api/admin/guests/bulk', { text: 'A A, a@example.com\nB B, b@example.com' });
  assert.equal((await h.call('GET', '/api/admin/mail/check')).status, 200);
  assert.equal((await h.call('POST', '/api/admin/mail/send', { confirm: 'WYŚLIJ', mode: 'unsent', count: 2 })).status, 409); // not connected yet
  await h.connect();
  await h.call('GET', '/api/admin/mail/check');
  assert.equal((await h.call('POST', '/api/admin/mail/send', { confirm: 'WYŚLIJ', mode: 'unsent', count: 2 })).status, 202);
  const s = await h.idle();
  assert.equal(s.done, 2);
  assert.equal(g.log.send.length, 2);
  const guests = (await h.call('GET', '/api/admin/state')).json.guests;
  assert.ok(guests.every((x) => x.sentAt && x.sendError === ''));
});

test('invalid_grant: marks reconnect needed, aborts the run, never leaks the token', async (t) => {
  const g = mockGoogle({ refreshFails: true });
  const h = await boot(g); t.after(h.close);
  await h.call('POST', '/api/admin/guests/bulk', { text: 'A A, a@example.com\nB B, b@example.com' });
  await h.connect();
  h.advance(2 * 3600 * 1000); // cached access token is stale, refresh will fail
  await h.call('GET', '/api/admin/mail/check');
  assert.equal((await h.call('POST', '/api/admin/mail/send', { confirm: 'WYŚLIJ', mode: 'unsent', count: 2 })).status, 202);
  const s = await h.idle();
  assert.match(s.aborted, /Połącz ponownie/);
  assert.equal(g.log.send.length, 0);
  const guests = (await h.call('GET', '/api/admin/state')).json.guests;
  assert.match(guests[0].sendError, /Połącz ponownie/);
  assert.equal(guests[1].sendError, ''); // second guest was never attempted
  const cfg = (await h.call('GET', '/api/admin/mail/config')).json;
  assert.equal(cfg.google.needsReconnect, true);
  assert.equal(cfg.configured, false);
  assert.equal((await h.call('POST', '/api/admin/mail/test', { to: 'me@example.com' })).status, 409);
  await h.connect(); // reconnecting clears the flag
  assert.equal((await h.call('GET', '/api/admin/mail/config')).json.configured, true);
});

test('disconnect removes the stored token', async (t) => {
  const h = await boot(mockGoogle()); t.after(h.close);
  await h.connect();
  assert.equal((await h.call('POST', '/api/admin/google/disconnect', {})).status, 200);
  assert.equal(fs.existsSync(path.join(h.dir, 'google-token.json')), false);
  const cfg = (await h.call('GET', '/api/admin/mail/config')).json;
  assert.equal(cfg.google.connected, false);
  assert.equal(cfg.configured, false);
});

test('missing client credentials: start does not redirect to Google', async (t) => {
  const h = await boot(mockGoogle(), { GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' }); t.after(h.close);
  const st = await h.call('GET', '/admin/google/start');
  assert.match(st.headers.get('location'), /google=missing/);
  const cfg = (await h.call('GET', '/api/admin/mail/config')).json;
  assert.deepEqual(cfg.missing, ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
  assert.equal(cfg.google.redirectUri, 'https://rsvp.example.test/admin/google/callback');
});

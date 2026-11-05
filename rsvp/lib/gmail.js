'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildRaw } = require('./mime');

const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.send';

class GmailError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function createGmail({ dataDir, env, fetchImpl, now }) {
  const doFetch = fetchImpl || fetch;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  const baseUrl = (env.PUBLIC_BASE_URL || env.PUBLIC_URL || '').replace(/\/+$/, '');
  const urls = {
    auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    api: (env.GMAIL_API_URL || 'https://gmail.googleapis.com/gmail/v1').replace(/\/+$/, ''),
  };
  const redirectUri = baseUrl ? baseUrl + '/admin/google/callback' : '';
  const file = path.join(dataDir, 'google-token.json');
  const missing = [];
  if (!clientId) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!baseUrl) missing.push('PUBLIC_BASE_URL');

  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not connected */ }
  let access = null; // { token, exp }
  let refreshing = null;
  const states = new Map(); // oauth state -> { session, exp }

  function persist(obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    saved = obj;
  }

  function status() {
    return {
      clientConfigured: missing.length === 0, missing, redirectUri,
      connected: !!(saved && saved.refreshToken), email: saved ? saved.email : '',
      needsReconnect: !!(saved && saved.invalid),
    };
  }
  const canSend = () => { const s = status(); return s.clientConfigured && s.connected && !s.needsReconnect; };

  function newState(session) {
    for (const [k, v] of states) if (v.exp < now()) states.delete(k);
    const s = crypto.randomBytes(24).toString('base64url');
    states.set(s, { session, exp: now() + 10 * 60 * 1000 });
    return s;
  }
  function takeState(s, session) {
    const v = states.get(s);
    states.delete(s);
    return !!v && v.exp > now() && v.session === session;
  }

  function authUrl(state) {
    const u = new URL(urls.auth);
    u.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state,
    }).toString();
    return u.toString();
  }

  async function tokenRequest(params) {
    const res = await doFetch(urls.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString(),
    });
    let j = {};
    try { j = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new GmailError('Google odrzucił żądanie tokenu', j.error === 'invalid_grant' ? 'invalid_grant' : 'token_error');
    return j;
  }

  const emailFromIdToken = (t) => {
    try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch { return ''; }
  };

  async function exchangeCode(code) {
    const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const email = emailFromIdToken(j.id_token);
    if (!j.refresh_token) throw new GmailError('Google nie zwrócił zgody na wysyłkę offline. Spróbuj połączyć ponownie.', 'no_refresh');
    if (!email) throw new GmailError('Google nie podał adresu konta.', 'no_email');
    access = { token: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000 };
    persist({ refreshToken: j.refresh_token, email, connectedAt: new Date(now()).toISOString() });
    return email;
  }

  async function accessToken() {
    if (!saved || !saved.refreshToken) throw new GmailError('Konto Gmail nie jest połączone.', 'not_connected');
    if (saved.invalid) throw new GmailError('Połączenie z Gmailem wygasło. Połącz ponownie.', 'invalid_grant');
    if (access && access.exp - 60000 > now()) return access.token;
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refreshToken })
        .then((j) => { access = { token: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000 }; return access.token; })
        .catch((e) => {
          if (e.code === 'invalid_grant') { persist({ ...saved, invalid: true }); access = null; throw new GmailError('Połączenie z Gmailem wygasło. Połącz ponownie.', 'invalid_grant'); }
          throw e;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // nodemailer-shaped: { to:{name,address}, replyTo, subject, text, html }
  async function sendMail(m) {
    const token = await accessToken();
    const raw = buildRaw({
      from: { name: env.MAIL_FROM_NAME || '', address: saved.email },
      to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html,
      date: new Date(now()), domain: saved.email.split('@')[1],
    });
    const res = await doFetch(`${urls.api}/users/me/messages/send`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
    });
    if (res.status === 401) { access = null; throw new GmailError('Gmail odrzucił autoryzację. Spróbuj ponownie albo połącz konto od nowa.', 'unauthorized'); }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error.message; } catch { /* empty */ }
      throw new GmailError(`Gmail zwrócił błąd ${res.status}${msg ? ': ' + String(msg).slice(0, 160) : ''}`, 'send_error');
    }
    return res.json().catch(() => ({}));
  }

  function disconnect() {
    saved = null; access = null;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  return { status, canSend, newState, takeState, authUrl, exchangeCode, sendMail, disconnect, redirectUri };
}

module.exports = { createGmail, GmailError };

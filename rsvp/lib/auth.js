'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeEqual } = require('./util');

const COOKIE = 'rsvp_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

function loadSecret(dir, envSecret) {
  if (envSecret) return envSecret;
  const f = path.join(dir, 'session-secret');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ secret, password, now }) {
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  const attempts = new Map();

  function issue(res, secure) {
    const exp = String(now() + TTL_MS);
    const value = `${exp}.${sign(exp)}`;
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`);
  }
  function clear(res, secure) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  }
  function isAuthed(req) {
    const v = parseCookies(req.headers.cookie)[COOKIE];
    if (!v) return false;
    const [exp, sig] = v.split('.');
    if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
    return Number(exp) > now();
  }
  function require_(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'Zaloguj się, aby wejść do panelu.' });
  }
  function limited(ip) {
    const a = attempts.get(ip);
    if (a && a.resetAt < now()) { attempts.delete(ip); return false; }
    return !!a && a.count >= 8;
  }
  function fail(ip) {
    const a = attempts.get(ip);
    if (!a || a.resetAt < now()) attempts.set(ip, { count: 1, resetAt: now() + 15 * 60 * 1000 });
    else a.count++;
  }
  return {
    sessionValue: (req) => parseCookies(req.headers.cookie)[COOKIE] || '',
    isAuthed, require: require_, issue, clear, limited, fail,
    ok: (ip) => attempts.delete(ip),
    check: (p) => typeof p === 'string' && safeEqual(p, password),
  };
}

module.exports = { createAuth, loadSecret };

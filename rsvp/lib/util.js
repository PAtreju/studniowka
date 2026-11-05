'use strict';
const crypto = require('crypto');

function tzOffsetMs(epoch, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - epoch;
}

// "YYYY-MM-DDTHH:mm" wall-clock time in the given zone -> epoch ms (null if malformed)
function localToEpoch(str, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let e = guess - tzOffsetMs(guess, tz);
  e = guess - tzOffsetMs(e, tz);
  return e;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_RE = /^[A-Za-z0-9]{8}$/;

// 8 random base62 chars (~47 bits); rejection sampling avoids modulo bias.
function newToken(exists = () => false) {
  for (;;) {
    let t = '';
    while (t.length < 8) {
      for (const b of crypto.randomBytes(16)) {
        if (b < 248 && t.length < 8) t += B62[b % 62]; // 248 = 62 * 4
      }
    }
    if (!exists(t)) return t;
  }
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  if (/[";\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { TOKEN_RE, localToEpoch, newToken, newId, safeEqual, EMAIL_RE, str, csvCell };

'use strict';
const crypto = require('crypto');

const clean = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

// RFC 2047 encoded-words, each <= 75 chars, split on code point boundaries
function encodeWord(s) {
  s = clean(s);
  if (isAscii(s)) return s;
  const words = [];
  let cur = [];
  const flush = () => { if (cur.length) { words.push('=?UTF-8?B?' + Buffer.from(cur.join(''), 'utf8').toString('base64') + '?='); cur = []; } };
  for (const ch of s) {
    if (Buffer.byteLength(cur.join('') + ch, 'utf8') > 36) flush();
    cur.push(ch);
  }
  flush();
  return words.join('\r\n ');
}

function address(a) {
  const addr = clean(a.address);
  if (!a.name) return addr;
  const name = clean(a.name);
  const shown = isAscii(name) ? '"' + name.replace(/(["\\])/g, '\\$1') + '"' : encodeWord(name);
  return `${shown} <${addr}>`;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();

// -> RFC 2822 string (CRLF), multipart/alternative text + html, UTF-8
function buildRaw({ from, to, replyTo, subject, text, html, date = new Date(), domain = 'localhost' }) {
  const boundary = '=_rsvp_' + crypto.randomBytes(12).toString('hex');
  const head = [
    `From: ${address(from)}`,
    `To: ${address(to)}`,
    ...(replyTo ? [`Reply-To: ${clean(replyTo)}`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${clean(domain) || 'localhost'}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', b64(body)].join('\r\n');
  return head.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + '\r\n' + part('text/html', html) + `\r\n--${boundary}--\r\n`;
}

module.exports = { buildRaw, encodeWord };

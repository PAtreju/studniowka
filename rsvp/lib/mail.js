'use strict';
const dns = require('dns').promises;
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { EMAIL_RE } = require('./util');

const DEFAULT_SUBJECT = 'Zaproszenie na studniówkę';
const DEFAULT_BODY = [
  'Cześć {imie},',
  '',
  'zapraszamy Cię na studniówkę! Szczegóły i potwierdzenie obecności znajdziesz pod swoim osobistym linkiem. Wystarczy jedno kliknięcie, niczego nie trzeba wypełniać:',
  '',
  '{link}',
  '',
  'Do zobaczenia!',
].join('\n');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { imie: parts[0] || '', nazwisko: parts.slice(1).join(' ') };
}

function renderTemplate(tpl, guest, link) {
  const { imie, nazwisko } = splitName(guest.name);
  const vars = { imie, nazwisko, link };
  return String(tpl).replace(/\{(imie|nazwisko|link)\}/g, (_, k) => vars[k]);
}

// Mail nie jest imienny: nagłówek karty to nazwa wydarzenia, nie nazwisko gościa.
// Link w środku zdania („klikając w {link}”) pokazujemy jako „ten link”, sam w akapicie – jako adres.
function renderHtml(subject, text, guest, link, settings = {}) {
  const heading = settings.title || 'Studniówka';
  const urlRe = /https?:\/\/[^\s<]+[^\s<.,;:!?)"”]/g;
  const paras = text.split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^>/.test(l))) {
      const q = lines.map((l) => esc(l.replace(/^> ?/, '')));
      const by = q.length > 1 ? q.pop() : '';
      return `<div style="margin:28px 8px 28px;padding:20px 8px 18px;border-top:1px solid #B59555;border-bottom:1px solid #B59555;text-align:center">
<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:20px;line-height:1.45;color:#2A0A14">${q.join('<br>')}</p>
${by ? `<p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:0.02em;color:#6B5058">${by}</p>` : ''}
</div>`;
    }
    const alone = p.trim() === link;
    const linked = esc(p).replace(/\n/g, '<br>').replace(urlRe, (u) => {
      const own = u === esc(link);
      const label = own && !alone ? 'ten link' : u;
      return `<a href="${u}" style="color:#2A0A14;${own ? 'font-weight:bold;' : ''}word-break:break-all">${label}</a>`;
    });
    return `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#2A0A14">${linked}</p>`;
  }).join('');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#2A0A14">
<div style="background:#2A0A14;padding:24px 12px">
<div style="max-width:520px;margin:0 auto;background:#F7F0E3;padding:10px">
<div style="border:1px solid #B59555;padding:3px"><div style="border:1px solid #B59555;padding:32px 24px;text-align:center">
<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:16px;color:#6B5058">Zaproszenie</p>
<p style="margin:14px 0 22px;font-family:'Bodoni 72',Didot,Georgia,serif;font-size:34px;line-height:1.1;color:#2A0A14">${esc(heading)}</p>
<div style="text-align:left">${paras}</div>
<p style="margin:24px 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#2A0A14;color:#E8CF9A;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 28px">Potwierdź obecność</a></p>
</div></div></div></div></div></body></html>`;
}

function buildMessage(settings, guest, link, over = {}) {
  const subject = renderTemplate(over.subject != null ? over.subject : settings.mailSubject, guest, link);
  const raw = renderTemplate(over.body != null ? over.body : settings.mailBody, guest, link);
  // linie zaczynające się od "> " to cytat: w HTML ozdobny blok, w tekście wcięcie
  const text = raw.replace(/^> ?/gm, '    ');
  return { subject, text, html: renderHtml(subject, raw, guest, link, settings) };
}

function mailConfig(env) {
  const kind = ['gmail', 'smtp', 'json'].includes(env.MAIL_TRANSPORT) ? env.MAIL_TRANSPORT : 'gmail';
  const port = Number(env.SMTP_PORT) || 465;
  const secure = env.SMTP_SECURE != null && env.SMTP_SECURE !== '' ? !/^(0|false|no)$/i.test(env.SMTP_SECURE) : port === 465;
  const smtpMissing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((k) => !env[k]);
  const json = kind === 'json';
  return {
    kind, json, missing: kind === 'smtp' ? smtpMissing : [], configured: json || (kind === 'smtp' && smtpMissing.length === 0),
    host: env.SMTP_HOST, port, secure, user: env.SMTP_USER, pass: env.SMTP_PASS,
    from: env.MAIL_FROM || (json ? 'Studniówka <test@example.invalid>' : ''), replyTo: env.MAIL_REPLY_TO || '',
    delayMs: env.MAIL_DELAY_MS != null && env.MAIL_DELAY_MS !== '' ? Math.max(0, Number(env.MAIL_DELAY_MS) || 0) : 2000,
  };
}

function makeTransport(cfg) {
  if (cfg.json) return nodemailer.createTransport({ jsonTransport: true });
  if (cfg.kind !== 'smtp' || !cfg.configured) return null;
  return nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass } });
}

// DNS: MX, else A/AAAA. Returns { state: 'ok'|'none'|'unknown', via }
async function defaultResolveDomain(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) return { state: 'ok', via: 'MX' };
  } catch (e) {
    if (!['ENODATA', 'ENOTFOUND'].includes(e.code)) return { state: 'unknown', via: '' };
  }
  for (const fn of ['resolve4', 'resolve6']) {
    try {
      const r = await dns[fn](domain);
      if (r && r.length) return { state: 'ok', via: 'A' };
    } catch (e) {
      if (!['ENODATA', 'ENOTFOUND'].includes(e.code)) return { state: 'unknown', via: '' };
    }
  }
  return { state: 'none', via: '' };
}

function createChecker({ resolveDomain, now }) {
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  async function domainState(domain) {
    const c = cache.get(domain);
    if (c && c.at + TTL > now()) return c.value;
    let value;
    try { value = await Promise.race([resolveDomain(domain), new Promise((r) => setTimeout(() => r({ state: 'unknown', via: '' }), 6000).unref())]); } catch { value = { state: 'unknown', via: '' }; }
    cache.set(domain, { at: now(), value });
    return value;
  }
  // rows: [{ guest, link }]
  async function check(rows) {
    const norm = rows.map(({ guest }) => String(guest.email || '').trim().toLowerCase());
    const counts = new Map();
    norm.forEach((e) => e && counts.set(e, (counts.get(e) || 0) + 1));
    const domains = [...new Set(norm.filter((e) => EMAIL_RE.test(e)).map((e) => e.split('@')[1]))];
    const states = new Map();
    await Promise.all(domains.map(async (d) => states.set(d, await domainState(d))));
    return rows.map(({ guest, link }, i) => {
      const raw = String(guest.email || '');
      const email = norm[i];
      const problems = [];
      let blocking = false;
      if (!email) { problems.push({ level: 'error', text: 'Brak adresu e-mail. Uzupełnij go w zakładce Goście.' }); blocking = true; }
      else if (!EMAIL_RE.test(email)) { problems.push({ level: 'error', text: 'Adres wygląda na niepoprawny. Popraw go w zakładce Goście.' }); blocking = true; }
      else {
        const st = states.get(email.split('@')[1]);
        if (st.state === 'none') { problems.push({ level: 'error', text: `Domena ${email.split('@')[1]} nie istnieje albo nie przyjmuje poczty. Sprawdź literówkę.` }); blocking = true; }
        else if (st.state === 'unknown') problems.push({ level: 'warn', text: 'Nie udało się sprawdzić domeny (DNS nie odpowiedział). Wysyłka jest możliwa.' });
        if (counts.get(email) > 1) problems.push({ level: 'warn', text: 'Ten adres występuje na liście więcej niż raz.' });
      }
      if (email && raw !== email) problems.push({ level: 'info', text: 'Adres zostanie zapisany małymi literami i bez spacji.' });
      return { id: guest.id, name: guest.name, rawEmail: raw, email, link, problems, blocking, sentAt: guest.sentAt || null, sendError: guest.sendError || '' };
    });
  }
  return { check };
}

function fingerprint(settings, guests) {
  return crypto.createHash('sha256').update(JSON.stringify([settings.mailSubject, settings.mailBody, guests.map((g) => [g.id, g.email, g.token])])).digest('hex');
}

module.exports = { DEFAULT_SUBJECT, DEFAULT_BODY, renderTemplate, renderHtml, buildMessage, mailConfig, makeTransport, defaultResolveDomain, createChecker, fingerprint, esc };

'use strict';
const { newToken, newId, EMAIL_RE, str } = require('./util');

// One pasted line -> { name, email } | { skip: true } | { error }
function parseLine(line) {
  const raw = line.replace(/\r/g, '');
  if (!raw.trim()) return { skip: true };
  let cells;
  if (raw.includes('\t')) cells = raw.split('\t').map((c) => c.trim());
  else if (raw.includes(';') && !raw.includes(',')) cells = raw.split(';').map((c) => c.trim());
  else cells = raw.split(',').map((c) => c.trim());
  cells = cells.filter((c) => c !== '');
  const at = cells.findIndex((c) => c.includes('@'));
  let email = '';
  let nameCells = cells;
  if (at >= 0) {
    email = cells[at].toLowerCase();
    nameCells = cells.filter((_, i) => i !== at);
  } else if (/^(email|e-mail|imi[eę])\b/i.test(cells[0] || '')) {
    return { skip: true }; // header row
  }
  const name = str(nameCells.join(' ').replace(/\s+/g, ' '), 120);
  if (!name) return { error: 'brak imienia i nazwiska' };
  if (email && !EMAIL_RE.test(email)) return { error: 'niepoprawny adres e-mail' };
  return { name, email };
}

// Adds guests to store.db (does not save). Returns { added, skipped, errors }.
function bulkAdd(store, text, plusOneAllowed, now) {
  const added = [];
  const skipped = [];
  const errors = [];
  const emails = new Set(store.db.guests.map((g) => g.email).filter(Boolean));
  const lines = String(text || '').split('\n').slice(0, 2000);
  lines.forEach((line, i) => {
    const r = parseLine(line);
    if (r.skip) return;
    if (r.error) return errors.push({ line: i + 1, reason: r.error });
    if (r.email && emails.has(r.email)) return skipped.push({ line: i + 1, name: r.name, reason: 'ten adres już jest na liście' });
    if (r.email) emails.add(r.email);
    const g = {
      id: newId(), token: newToken((t) => store.db.guests.some((x) => x.token === t)), name: r.name, email: r.email,
      plusOneAllowed: !!plusOneAllowed, status: 'pending', plusOne: false, plusOneName: '',
      message: '', respondedAt: null, openedAt: null, sentAt: null, sendError: '', createdAt: now,
    };
    store.db.guests.push(g);
    added.push(g);
  });
  return { added, skipped, errors };
}

module.exports = { parseLine, bulkAdd };

'use strict';
const fs = require('fs');
const path = require('path');
const { TOKEN_RE } = require('./util');
const { DEFAULT_SUBJECT, DEFAULT_BODY } = require('./mail');

const DEFAULT_SETTINGS = {
  title: 'Studniówka',
  date: '',
  time: '',
  place: '',
  address: '',
  dressCode: '',
  deadline: '',
  note: '',
  mailSubject: DEFAULT_SUBJECT,
  mailBody: DEFAULT_BODY,
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.db = { settings: { ...DEFAULT_SETTINGS }, guests: [] };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      this.db.guests = Array.isArray(raw.guests) ? raw.guests : [];
    } else {
      this.save();
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.db, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  byToken(token) {
    if (!TOKEN_RE.test(token)) return null;
    return this.db.guests.find((g) => g.token === token) || null;
  }

  byId(id) {
    return this.db.guests.find((g) => g.id === id) || null;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

// Osobny plik danych, żeby test nie nadpisał prawdziwych pytań
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gs-')), 'content.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'content.json'), tmp);
process.env.DATA_FILE = tmp;
process.env.HOST_KEY = 'testkey';
const { server } = require('../server');

const emit = (s, ev, arg) => new Promise((r) => s.emit(ev, arg, r));
const nextState = (s, pred) => new Promise((r) => {
  const h = (st) => { if (pred(st)) { s.off('state', h); r(st); } };
  s.on('state', h);
});

test('serwer: HTTP + pełna runda przez Socket.IO', async (t) => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  t.after(() => { sockets.forEach((s) => s.close()); server.close(); });
  const conn = () => { const s = io(url, { transports: ['websocket'] }); sockets.push(s); return s; };

  const info = await (await fetch(url + '/api/join-info')).json();
  assert.match(info.qr, /<svg/);
  assert.equal((await fetch(url + '/api/content')).status, 401);
  const content = await (await fetch(url + '/api/content', { headers: { 'x-host-key': 'testkey' } })).json();
  const bad = await fetch(url + '/api/content', { method: 'PUT', headers: { 'x-host-key': 'testkey', 'content-type': 'application/json' }, body: JSON.stringify({ quizzes: [{ title: 'x', questions: [{ text: '', answers: [] }] }] }) });
  assert.equal(bad.status, 400);
  for (const p of ['/', '/host', '/editor', '/style.css', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(url + p)).status, 200, p);
  }

  const host = conn();
  assert.equal((await emit(host, 'host:auth', 'zły')).ok, false);
  assert.ok((await emit(host, 'host:auth', 'testkey')).ok);

  const p1 = conn();
  const p2 = conn();
  const j1 = await emit(p1, 'player:join', { name: 'Ola' });
  assert.ok(j1.ok);
  assert.equal((await emit(p2, 'player:join', { name: 'ola' })).ok, false);
  assert.ok((await emit(p2, 'player:join', { name: 'Kuba' })).ok);
  assert.equal((await emit(p1, 'host:cmd', { cmd: 'next' })).ok, false, 'gracz nie może sterować');

  const quiz = content.quizzes[0];
  assert.ok((await emit(host, 'host:cmd', { cmd: 'select', type: 'quiz', id: quiz.id })).ok);
  const q = nextState(p1, (s) => s.phase === 'question');
  await emit(host, 'host:cmd', { cmd: 'next' });
  await q;
  const revealed = nextState(host, (s) => s.phase === 'reveal');
  assert.ok((await emit(p1, 'player:answer', quiz.questions[0].correct)).ok);
  assert.ok((await emit(p2, 'player:answer', (quiz.questions[0].correct + 1) % 2)).ok);
  const hs = await revealed;
  assert.equal(hs.reveal.total, 2);
  const lb = nextState(host, (s) => s.phase === 'leaderboard');
  await emit(host, 'host:cmd', { cmd: 'next' });
  assert.equal((await lb).leaderboard[0].name, 'Ola');

  // ponowne połączenie tym samym id zachowuje punkty
  p1.close();
  const p1b = conn();
  const back = await emit(p1b, 'player:join', { id: j1.id, name: 'Ola' });
  assert.ok(back.ok);
  assert.ok(back.state.you.score > 0);
});

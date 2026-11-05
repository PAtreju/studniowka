'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, quizPoints } = require('../game');

const content = {
  classList: ['Ania', 'Bartek', 'Kasia'],
  quizzes: [{ id: 'q', title: 'Q', questions: [
    { text: '1+1?', answers: ['1', '2', '3'], correct: 1, time: 10 },
    { text: '2+2?', answers: ['4', '5'], correct: 0, time: 10 },
  ] }],
  polls: [{ id: 'p', title: 'P', questions: [
    { text: 'Kto?', options: [], time: 30 },
    { text: 'Co?', options: ['X', 'Y'], time: 30 },
  ] }],
};

function make() {
  let t = 1000;
  const g = new Game({ getContent: () => content, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  return { g, tick: (ms) => (t += ms) };
}

test('punkty: szybciej = więcej, 500..1000', () => {
  assert.equal(quizPoints(0, 10000), 1000);
  assert.equal(quizPoints(10000, 10000), 500);
  assert.equal(quizPoints(20000, 10000), 500);
});

test('nazwy graczy są unikalne, ponowne dołączenie po id', () => {
  const { g } = make();
  const a = g.addPlayer('  Ania  ');
  assert.ok(a.ok);
  assert.equal(a.player.name, 'Ania');
  assert.equal(g.addPlayer('ania').ok, false);
  assert.equal(g.addPlayer('').ok, false);
  assert.equal(g.addPlayer('x', a.player.id).player, a.player);
});

test('pełny przebieg quizu', () => {
  const { g, tick } = make();
  const a = g.addPlayer('A').player;
  const b = g.addPlayer('B').player;
  g.select('quiz', 'q');
  assert.equal(g.phase, 'lobby');
  g.next();
  assert.equal(g.phase, 'question');
  assert.equal(g.playerView(a.id).question.correct, undefined, 'poprawna odpowiedź nie wycieka przed czasem');
  tick(2000);
  assert.ok(g.answer(a.id, 1).ok);
  assert.equal(g.answer(a.id, 0).ok, false, 'tylko jedna odpowiedź');
  assert.equal(g.answer(b.id, 9).ok, false, 'zły indeks');
  assert.ok(g.answer(b.id, 0).ok);
  assert.equal(g.phase, 'reveal', 'wszyscy odpowiedzieli → automatyczne odkrycie');
  assert.equal(a.score, 900);
  assert.equal(b.score, 0);
  assert.deepEqual(g.reveal.counts, [1, 1, 0]);
  g.next();
  assert.equal(g.phase, 'leaderboard');
  assert.equal(g.playerView(a.id).you.rank, 1);
  g.next();
  assert.equal(g.qIndex, 1);
  g.next(); // zakończ czas bez odpowiedzi
  assert.equal(g.phase, 'reveal');
  assert.equal(a.last.answered, false);
  g.next();
  g.next();
  assert.equal(g.phase, 'final');
  assert.equal(g.playerView(b.id).podium[0].name, 'A');
  g.next();
  assert.equal(g.phase, 'idle');
});

test('plebiscyt: głosowanie na klasę, remisy, podsumowanie', () => {
  const { g } = make();
  const ps = ['A', 'B', 'C', 'D'].map((n) => g.addPlayer(n).player);
  g.select('poll', 'p');
  g.next();
  assert.deepEqual(g.current().options, ['Ania', 'Bartek', 'Kasia']);
  g.answer(ps[0].id, 0);
  g.answer(ps[1].id, 0);
  g.answer(ps[2].id, 2);
  g.answer(ps[3].id, 2);
  assert.equal(g.phase, 'reveal');
  assert.deepEqual(g.reveal.winners, ['Ania', 'Kasia']);
  assert.equal(g.reveal.ranking.length, 2);
  g.next();
  assert.deepEqual(g.current().options, ['X', 'Y']);
  g.answer(ps[0].id, 1);
  g.next();
  assert.deepEqual(g.reveal.winners, ['Y']);
  g.next();
  assert.equal(g.phase, 'final');
  assert.equal(g.playerView(ps[0].id).history.length, 2);
});

test('rozłączony gracz nie blokuje automatycznego odkrycia; kick', () => {
  const { g } = make();
  const a = g.addPlayer('A').player;
  const b = g.addPlayer('B').player;
  g.select('quiz', 'q');
  g.next();
  g.answer(a.id, 1);
  assert.equal(g.phase, 'question');
  g.setConnected(b.id, false);
  assert.equal(g.phase, 'reveal');
  assert.ok(g.kick(b.id));
  assert.equal(g.players.size, 1);
});

test('spóźniona odpowiedź jest odrzucana', () => {
  const { g, tick } = make();
  const a = g.addPlayer('A').player;
  g.select('quiz', 'q');
  g.next();
  tick(11000);
  assert.equal(g.answer(a.id, 1).ok, false);
});

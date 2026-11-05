'use strict';
const crypto = require('crypto');

// Fazy gry:
// idle        – nic nie wybrano, gracze mogą już dołączać
// lobby       – wybrana gra, czekamy na start
// question    – trwa pytanie / głosowanie
// reveal      – wyniki pytania
// leaderboard – ranking (tylko quiz)
// final       – podsumowanie gry

const MAX_NAME = 20;
const GRACE_MS = 600; // tolerancja opóźnień sieci przy odpowiedzi

function quizPoints(elapsedMs, limitMs) {
  const frac = Math.min(Math.max(elapsedMs / limitMs, 0), 1);
  return Math.round(1000 - 500 * frac); // 1000 za błyskawiczną, 500 na ostatnią chwilę
}

class Game {
  constructor({ getContent, onUpdate = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.getContent = getContent;
    this.onUpdate = onUpdate;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.players = new Map();
    this.timer = null;
    this.toIdle();
  }

  // ---------- gracze ----------

  addPlayer(rawName, existingId) {
    if (existingId && this.players.has(existingId)) {
      return { ok: true, player: this.players.get(existingId) };
    }
    const name = String(rawName || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) return { ok: false, error: 'Podaj swoje imię lub ksywkę.' };
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return { ok: false, error: 'Ta nazwa jest już zajęta – wybierz inną.' };
    const player = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      score: 0,
      streak: 0,
      connected: true,
      joinedAt: this.now(),
      last: null, // wynik ostatniego pytania
    };
    this.players.set(player.id, player);
    this.changed();
    return { ok: true, player };
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    this.changed();
    if (!connected) this.maybeAutoReveal();
  }

  kick(id) {
    if (!this.players.delete(id)) return false;
    if (this.answers) this.answers.delete(id);
    this.changed();
    this.maybeAutoReveal();
    return true;
  }

  // ---------- sterowanie ----------

  toIdle() {
    this.stopTimer();
    this.phase = 'idle';
    this.mode = null; // 'quiz' | 'poll'
    this.set = null;
    this.qIndex = -1;
    this.answers = new Map();
    this.startedAt = 0;
    this.endsAt = 0;
    this.reveal = null;
    this.history = [];
    this.changed();
  }

  select(type, id) {
    const content = this.getContent();
    const list = type === 'quiz' ? content.quizzes : type === 'poll' ? content.polls : null;
    const src = list && list.find((s) => s.id === id);
    if (!src) throw new Error('Nie znaleziono takiej gry.');
    if (!src.questions.length) throw new Error('Ta gra nie ma pytań.');
    this.stopTimer();
    // kopia – edycja w trakcie gry nie psuje rozgrywki
    this.set = {
      id: src.id,
      title: src.title,
      questions: src.questions.map((q) =>
        type === 'quiz'
          ? { text: q.text, options: [...q.answers], correct: q.correct, time: q.time }
          : { text: q.text, options: q.options && q.options.length >= 2 ? [...q.options] : [...content.classList], time: q.time }
      ),
    };
    if (type === 'poll' && this.set.questions.some((q) => q.options.length < 2)) {
      throw new Error('Lista klasy jest pusta – uzupełnij ją w edytorze.');
    }
    this.mode = type;
    this.phase = 'lobby';
    this.qIndex = -1;
    this.answers = new Map();
    this.reveal = null;
    this.history = [];
    for (const p of this.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.last = null;
    }
    this.changed();
  }

  next() {
    switch (this.phase) {
      case 'lobby':
        return this.goQuestion(0);
      case 'question':
        return this.doReveal();
      case 'reveal':
        if (this.mode === 'quiz') {
          this.phase = 'leaderboard';
          return this.changed();
        }
        return this.advance();
      case 'leaderboard':
        return this.advance();
      case 'final':
        return this.toIdle();
      default:
        return undefined;
    }
  }

  advance() {
    if (this.qIndex + 1 < this.set.questions.length) return this.goQuestion(this.qIndex + 1);
    this.phase = 'final';
    this.changed();
  }

  goQuestion(i) {
    this.stopTimer();
    const q = this.set.questions[i];
    this.phase = 'question';
    this.qIndex = i;
    this.answers = new Map();
    this.reveal = null;
    for (const p of this.players.values()) p.last = null;
    this.startedAt = this.now();
    this.endsAt = this.startedAt + q.time * 1000;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.phase === 'question' && this.qIndex === i) this.doReveal();
    }, q.time * 1000 + GRACE_MS);
    this.changed();
  }

  answer(playerId, choice) {
    if (this.phase !== 'question') return { ok: false, error: 'Teraz nie można odpowiadać.' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'Nie jesteś w grze.' };
    if (this.answers.has(playerId)) return { ok: false, error: 'Już odpowiedziałeś.' };
    const q = this.current();
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return { ok: false, error: 'Zła odpowiedź.' };
    const t = this.now();
    if (t > this.endsAt + GRACE_MS) return { ok: false, error: 'Czas minął!' };
    this.answers.set(playerId, { choice: c, at: Math.min(t, this.endsAt) });
    this.changed();
    this.maybeAutoReveal();
    return { ok: true };
  }

  maybeAutoReveal() {
    if (this.phase !== 'question') return;
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.length > 0 && active.every((p) => this.answers.has(p.id))) this.doReveal();
  }

  doReveal() {
    if (this.phase !== 'question') return;
    this.stopTimer();
    const q = this.current();
    const counts = q.options.map(() => 0);
    for (const a of this.answers.values()) counts[a.choice]++;

    if (this.mode === 'quiz') {
      const limit = q.time * 1000;
      for (const p of this.players.values()) {
        const a = this.answers.get(p.id);
        if (!a) {
          p.streak = 0;
          p.last = { answered: false, correct: false, points: 0 };
        } else if (a.choice === q.correct) {
          const points = quizPoints(a.at - this.startedAt, limit);
          p.score += points;
          p.streak += 1;
          p.last = { answered: true, correct: true, points, choice: a.choice };
        } else {
          p.streak = 0;
          p.last = { answered: true, correct: false, points: 0, choice: a.choice };
        }
      }
      this.reveal = { counts, correct: q.correct, total: this.answers.size };
    } else {
      const max = Math.max(0, ...counts);
      const winners = max > 0 ? q.options.filter((_, i) => counts[i] === max) : [];
      const ranking = q.options
        .map((name, i) => ({ name, votes: counts[i] }))
        .filter((r) => r.votes > 0)
        .sort((a, b) => b.votes - a.votes);
      this.reveal = { counts, winners, ranking, total: this.answers.size, max };
      this.history.push({ question: q.text, winners, votes: max, total: this.answers.size });
      for (const p of this.players.values()) {
        const a = this.answers.get(p.id);
        p.last = a ? { answered: true, choice: a.choice } : { answered: false };
      }
    }
    this.phase = 'reveal';
    this.changed();
  }

  // ---------- widoki ----------

  current() {
    return this.set && this.qIndex >= 0 ? this.set.questions[this.qIndex] : null;
  }

  leaderboard() {
    const sorted = [...this.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    let rank = 0;
    let prev = null;
    return sorted.map((p, i) => {
      if (p.score !== prev) {
        rank = i + 1;
        prev = p.score;
      }
      return { id: p.id, name: p.name, score: p.score, rank, streak: p.streak };
    });
  }

  questionView(withCorrect) {
    const q = this.current();
    if (!q) return null;
    return {
      index: this.qIndex,
      total: this.set.questions.length,
      text: q.text,
      options: q.options,
      time: q.time,
      endsAt: this.endsAt,
      ...(withCorrect && this.phase !== 'question' && this.mode === 'quiz' ? { correct: q.correct } : {}),
    };
  }

  base() {
    return {
      phase: this.phase,
      mode: this.mode,
      title: this.set ? this.set.title : null,
      serverNow: this.now(),
    };
  }

  hostView() {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected, score: p.score }));
    return {
      ...this.base(),
      players,
      connectedCount: players.filter((p) => p.connected).length,
      answeredCount: this.answers.size,
      question: this.questionView(true),
      reveal: this.reveal,
      leaderboard: this.mode === 'quiz' ? this.leaderboard().slice(0, 10) : null,
      history: this.history,
    };
  }

  playerView(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const v = { ...this.base(), you: { id: p.id, name: p.name, score: p.score, streak: p.streak, last: p.last } };
    if (this.mode === 'quiz' && this.phase !== 'idle' && this.phase !== 'lobby') {
      const lb = this.leaderboard();
      const me = lb.find((r) => r.id === id);
      v.you.rank = me ? me.rank : null;
      v.you.of = lb.length;
      if (this.phase === 'final') v.podium = lb.slice(0, 3).map(({ name, score, rank }) => ({ name, score, rank }));
    }
    if (['question', 'reveal', 'leaderboard'].includes(this.phase)) {
      v.question = this.questionView(true);
      const a = this.answers.get(id);
      v.you.answered = a ? a.choice : null;
    }
    if (this.mode === 'poll' && this.phase === 'reveal') v.winners = this.reveal.winners;
    if (this.mode === 'poll' && this.phase === 'final') v.history = this.history;
    return v;
  }

  // ---------- pomocnicze ----------

  stopTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  changed() {
    this.onUpdate();
  }
}

module.exports = { Game, quizPoints };

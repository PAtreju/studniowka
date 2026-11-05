/* global io, $, esc, LETTERS, syncClock, runTimer, stopTimer, toast, namesList */
const socket = io();
let state = null;
let games = { quizzes: [], polls: [], classCount: 0 };
let join = { url: '', qr: '' };
let renderedKey = null;

// ---------- autoryzacja ----------

const params = new URLSearchParams(location.search);
if (params.get('key')) {
  localStorage.setItem('hostKey', params.get('key'));
  history.replaceState(null, '', '/host');
}

function auth() {
  const key = localStorage.getItem('hostKey');
  if (!key) return showAuth();
  socket.emit('host:auth', key, (res) => {
    if (!res.ok) return showAuth(res.error);
    $('#auth').classList.add('hidden');
    games = res.games;
    join = res.join;
    renderedKey = null;
    onState(res.state);
  });
}
function showAuth(err) {
  $('#auth').classList.remove('hidden');
  $('#authErr').textContent = err || '';
  $('#authKey').focus();
}
$('#authForm').addEventListener('submit', (e) => {
  e.preventDefault();
  localStorage.setItem('hostKey', $('#authKey').value.trim());
  auth();
});

socket.on('connect', () => {
  $('#conn').classList.add('hidden');
  auth();
});
socket.on('disconnect', () => $('#conn').classList.remove('hidden'));
socket.on('state', onState);
socket.on('games', (g) => {
  games = g;
  if (state && state.phase === 'idle') {
    renderedKey = null;
    onState(state);
  }
});

function cmd(c, extra = {}) {
  socket.emit('host:cmd', { cmd: c, ...extra }, (res) => {
    if (res && !res.ok) toast(res.error);
  });
}

// ---------- sterowanie ----------

$('#btnNext').addEventListener('click', () => cmd('next'));
$('#btnMenu').addEventListener('click', () => {
  if (state && state.phase !== 'idle' && !confirm('Zakończyć grę i wrócić do menu?')) return;
  cmd('idle');
});
$('#btnFs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') && state && state.phase !== 'idle') {
    e.preventDefault();
    cmd('next');
  }
  if (e.key === 'f') $('#btnFs').click();
});

$('#stage').addEventListener('click', (e) => {
  const g = e.target.closest('[data-select]');
  if (g) return cmd('select', { type: g.dataset.type, id: g.dataset.select });
  const k = e.target.closest('[data-kick]');
  if (k && confirm(`Usunąć gracza „${k.dataset.name}”?`)) cmd('kick', { id: k.dataset.kick });
});

// ---------- renderowanie ----------

function onState(s) {
  if (!s) return;
  state = s;
  syncClock(s);
  $('#playerCount').textContent = s.connectedCount;
  $('#topTitle').textContent = s.title || 'Teleturniej Studniówkowy';
  $('#joinSmall').textContent = s.phase === 'idle' || s.phase === 'lobby' ? '' : 'Dołącz: ' + join.url.replace(/^https?:\/\//, '');
  updateNextButton();

  const key = [s.phase, s.mode, s.title, s.question && s.question.index].join('|');
  if (key !== renderedKey) {
    renderedKey = key;
    stopTimer();
    $('#stage').innerHTML = render(s);
    if (s.phase === 'question') runTimer($('#stage .timer'), s.question.endsAt, s.question.time);
  }
  update(s);
}

function updateNextButton() {
  const s = state;
  const b = $('#btnNext');
  b.classList.toggle('hidden', s.phase === 'idle');
  $('#btnMenu').classList.toggle('hidden', s.phase === 'idle');
  $('#hint').classList.toggle('hidden', s.phase === 'idle');
  const last = s.question && s.question.index + 1 >= s.question.total;
  const labels = {
    lobby: 'Start ▶',
    question: 'Zakończ czas ⏹',
    reveal: s.mode === 'quiz' ? 'Ranking →' : last ? 'Podsumowanie 🏆' : 'Następne pytanie →',
    leaderboard: last ? 'Wyniki końcowe 🏆' : 'Następne pytanie →',
    final: 'Zakończ ✓',
  };
  b.textContent = labels[s.phase] || 'Dalej →';
  b.disabled = s.phase === 'lobby' && s.connectedCount === 0;
}

function render(s) {
  switch (s.phase) {
    case 'idle': return renderIdle();
    case 'lobby': return renderLobby(s);
    case 'question': return renderQuestion(s);
    case 'reveal': return s.mode === 'quiz' ? renderQuizReveal(s) : renderPollReveal(s);
    case 'leaderboard': return renderLeaderboard(s);
    case 'final': return s.mode === 'quiz' ? renderQuizFinal(s) : renderPollFinal(s);
    default: return '';
  }
}

// Fragmenty zmieniające się bez przebudowy ekranu
function update(s) {
  const chips = $('#chips');
  if (chips) {
    const ps = s.players.filter((p) => p.connected);
    chips.innerHTML = ps.length
      ? ps.map((p) => `<button class="chip pop" data-kick="${esc(p.id)}" data-name="${esc(p.name)}" title="Kliknij, aby usunąć">${esc(p.name)}</button>`).join('')
      : '<p class="muted">Czekamy na pierwszych graczy…</p>';
  }
  const cnt = $('#idleCount');
  if (cnt) cnt.textContent = s.connectedCount;
  const ans = $('#answered');
  if (ans) ans.innerHTML = `<b>${s.answeredCount}</b> / ${s.connectedCount} ${s.mode === 'quiz' ? 'odpowiedzi' : 'głosów'}`;
}

function qrBlock(big) {
  return `<div class="qr ${big ? 'big' : ''}">${join.qr}</div>
    <div class="join-url">${esc(join.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</div>`;
}

function renderIdle() {
  const card = (g, type) => `
    <button class="game-card ${type}" data-select="${esc(g.id)}" data-type="${type}">
      <span class="game-kind">${type === 'quiz' ? '⚡ Quiz na czas' : '🗳️ Plebiscyt'}</span>
      <span class="game-title">${esc(g.title)}</span>
      <span class="muted">${g.count} ${g.count === 1 ? 'pytanie' : g.count < 5 ? 'pytania' : 'pytań'}</span>
    </button>`;
  return `
  <section class="idle rise">
    <div class="join-panel">
      <h2>Zeskanuj i dołącz!</h2>
      ${qrBlock(false)}
      <p class="muted">W grze: <b id="idleCount">0</b></p>
    </div>
    <div class="menu">
      <h1 class="hero">Wybierz grę</h1>
      <h3>Quizy</h3>
      <div class="cards">${games.quizzes.map((g) => card(g, 'quiz')).join('') || '<p class="muted">Brak quizów.</p>'}</div>
      <h3>Plebiscyty</h3>
      <div class="cards">${games.polls.map((g) => card(g, 'poll')).join('') || '<p class="muted">Brak plebiscytów.</p>'}</div>
      <p><a class="link" href="/editor" target="_blank">✏️ Edytuj pytania i listę klasy</a></p>
    </div>
  </section>`;
}

function renderLobby(s) {
  return `
  <section class="lobby rise">
    <div class="lobby-qr">
      ${qrBlock(true)}
    </div>
    <div class="lobby-info">
      <span class="kind">${s.mode === 'quiz' ? '⚡ Quiz na czas' : '🗳️ Plebiscyt klasowy'}</span>
      <h1 class="hero">${esc(s.title)}</h1>
      <p class="muted lead">Zeskanuj kod telefonem, wpisz swoje imię i czekaj na start.</p>
      <div id="chips" class="chips"></div>
    </div>
  </section>`;
}

function qHeader(s) {
  return `<div class="q-head">
    <span class="pill">Pytanie ${s.question.index + 1} / ${s.question.total}</span>
    ${s.phase === 'question' ? `<span id="answered" class="pill"></span>` : `<span class="pill">${s.reveal.total} ${s.mode === 'quiz' ? 'odpowiedzi' : 'głosów'}</span>`}
  </div>`;
}

function renderQuestion(s) {
  const q = s.question;
  let body;
  if (s.mode === 'quiz') {
    body = `<div class="options">${q.options
      .map((o, i) => `<div class="option opt-${i} pop" style="animation-delay:${i * 80}ms"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></div>`)
      .join('')}</div>`;
  } else {
    body = `<div class="vote-call pop">
      <div class="big-emoji">📱</div>
      <p>Głosujcie na telefonach!</p>
      ${q.options.length <= 8 ? `<div class="chips center">${q.options.map((o) => `<span class="chip static">${esc(o)}</span>`).join('')}</div>` : ''}
    </div>`;
  }
  return `
  <section class="question">
    ${qHeader(s)}
    <div class="q-row">
      <h1 class="q-text rise">${esc(q.text)}</h1>
      <div class="timer" style="--size:min(16vh,140px)"></div>
    </div>
    ${body}
  </section>`;
}

function renderQuizReveal(s) {
  const q = s.question;
  const r = s.reveal;
  const max = Math.max(1, ...r.counts);
  return `
  <section class="question">
    ${qHeader(s)}
    <h1 class="q-text">${esc(q.text)}</h1>
    <div class="options reveal">${q.options
      .map((o, i) => {
        const ok = i === r.correct;
        return `<div class="option opt-${i} ${ok ? 'correct pop' : 'wrong'}">
          <span class="letter">${ok ? '✓' : LETTERS[i]}</span>
          <span class="otext">${esc(o)}</span>
          <span class="bar"><i style="width:${(r.counts[i] / max) * 100}%"></i></span>
          <b class="count">${r.counts[i]}</b>
        </div>`;
      })
      .join('')}</div>
  </section>`;
}

function renderPollReveal(s) {
  const q = s.question;
  const r = s.reveal;
  const top = r.ranking.slice(0, 6);
  const max = Math.max(1, r.max);
  const winner = r.winners.length
    ? `<div class="winner pop">
        <div class="crown">👑</div>
        <div class="winner-name">${esc(namesList(r.winners))}</div>
        <div class="muted">${r.max} ${r.max === 1 ? 'głos' : r.max < 5 ? 'głosy' : 'głosów'}${r.winners.length > 1 ? ' – remis!' : ''}</div>
      </div>`
    : `<div class="winner pop"><div class="winner-name muted">Nikt nie zagłosował 🤷</div></div>`;
  return `
  <section class="question">
    ${qHeader(s)}
    <h1 class="q-text center">${esc(q.text)}</h1>
    ${winner}
    <div class="ranking">${top
      .map((x, i) => `<div class="rank-row rise" style="animation-delay:${300 + i * 90}ms">
        <span class="rname">${esc(x.name)}</span>
        <span class="bar"><i style="width:${(x.votes / max) * 100}%"></i></span>
        <b>${x.votes}</b></div>`)
      .join('')}</div>
  </section>`;
}

function renderLeaderboard(s) {
  return `
  <section class="board">
    <h1 class="hero center">Ranking</h1>
    <ol class="lb">${s.leaderboard
      .map((p, i) => `<li class="rise" style="animation-delay:${i * 70}ms">
        <span class="lb-rank">${p.rank}</span>
        <span class="lb-name">${esc(p.name)} ${p.streak >= 3 ? `<span class="streak">🔥${p.streak}</span>` : ''}</span>
        <b class="lb-score">${p.score}</b></li>`)
      .join('') || '<p class="muted center">Brak graczy</p>'}</ol>
  </section>`;
}

function renderQuizFinal(s) {
  const lb = s.leaderboard;
  const pod = [lb[1], lb[0], lb[2]];
  const place = ['second', 'first', 'third'];
  const medal = ['🥈', '🥇', '🥉'];
  return `
  <section class="final">
    <h1 class="hero center">🏆 Zwycięzcy 🏆</h1>
    <div class="podium">${pod
      .map((p, i) => (p
        ? `<div class="step ${place[i]} rise" style="animation-delay:${[600, 1200, 200][i]}ms">
            <div class="medal">${medal[i]}</div>
            <div class="pname">${esc(p.name)}</div>
            <div class="pscore">${p.score} pkt</div>
            <div class="block">${p.rank}</div>
          </div>`
        : '<div class="step empty"></div>'))
      .join('')}</div>
    ${lb.length > 3 ? `<ol class="lb small" start="4">${lb.slice(3).map((p) => `<li><span class="lb-rank">${p.rank}</span><span class="lb-name">${esc(p.name)}</span><b class="lb-score">${p.score}</b></li>`).join('')}</ol>` : ''}
  </section>`;
}

function renderPollFinal(s) {
  return `
  <section class="final">
    <h1 class="hero center">🏆 Wyniki plebiscytu</h1>
    <div class="awards">${s.history
      .map((h, i) => `<div class="award rise" style="animation-delay:${i * 120}ms">
        <div class="muted">${esc(h.question)}</div>
        <div class="award-name">${h.winners.length ? '👑 ' + esc(namesList(h.winners)) : '—'}</div>
        <div class="muted small">${h.votes} z ${h.total} głosów</div>
      </div>`)
      .join('')}</div>
  </section>`;
}

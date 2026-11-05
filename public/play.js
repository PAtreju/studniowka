/* global io, $, esc, LETTERS, syncClock, runTimer, stopTimer, toast, namesList */
const socket = io();
const STORE = 'studniowkaPlayer';
let me = load();
let state = null;
let renderedKey = null;
let search = '';
let sending = false;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch { return null; }
}
function save(v) {
  me = v;
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch { /* tryb prywatny – trudno */ }
}

// ---------- połączenie ----------

socket.on('connect', () => {
  $('#conn').classList.add('hidden');
  if (me) join(me.name, me.id);
  else if (renderedKey !== 'join') showJoin(); // nie kasuj wpisywanego imienia przy ponownym połączeniu
});
socket.on('disconnect', () => $('#conn').classList.remove('hidden'));
socket.on('state', (s) => s && onState(s));
socket.on('kicked', () => {
  save(null);
  state = null;
  showJoin('Prowadzący usunął Cię z gry. Możesz dołączyć ponownie pod inną nazwą.');
});

function join(name, id) {
  socket.emit('player:join', { name, id }, (res) => {
    if (!res.ok) {
      if (id) save(null);
      return showJoin(res.error, name);
    }
    save({ id: res.id, name: res.name });
    onState(res.state);
  });
}

function showJoin(err, name = '') {
  renderedKey = 'join';
  stopTimer();
  $('#me').textContent = '';
  $('#view').innerHTML = `
    <form id="joinForm" class="join">
      <h1>Dołącz do gry</h1>
      <p class="muted">Wpisz imię lub ksywkę – zobaczą ją wszyscy na ekranie.</p>
      <input id="name" maxlength="20" autocomplete="nickname" placeholder="Twoje imię" value="${esc(name)}" />
      <button class="btn primary big">Wchodzę</button>
      <p class="err">${esc(err || '')}</p>
    </form>`;
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('#name').value.trim();
    if (!n) return;
    join(n);
  });
  $('#name').focus();
}

function answer(i) {
  if (sending) return;
  sending = true;
  socket.emit('player:answer', i, (res) => {
    sending = false;
    if (!res.ok) toast(res.error);
    if (navigator.vibrate) navigator.vibrate(30);
  });
}

// ---------- widoki ----------

function onState(s) {
  state = s;
  syncClock(s);
  const y = s.you;
  $('#me').innerHTML = `${esc(y.name)}${s.mode === 'quiz' && s.phase !== 'idle' && s.phase !== 'lobby' ? `, <b>${y.score}</b> pkt` : ''}`;

  const answered = s.you.answered != null;
  const key = [s.phase, s.mode, s.title, s.question && s.question.index, answered].join('|');
  if (key === renderedKey) return;
  renderedKey = key;
  stopTimer();
  const v = $('#view');
  v.innerHTML = render(s);
  if (s.phase === 'question' && !answered) {
    runTimer($('.timer', v), s.question.endsAt, s.question.time);
    if (s.mode === 'poll') bindPoll();
  }
}

function render(s) {
  const y = s.you;
  switch (s.phase) {
    case 'idle':
      return screen('', `Jesteś w grze, ${esc(y.name)}`, 'Za chwilę zaczynamy. Patrz na ekran.');
    case 'lobby':
      return screen('', esc(s.title), 'Jesteś na liście. Czekaj na start.');
    case 'question':
      return y.answered != null ? renderWaiting(s) : s.mode === 'quiz' ? renderQuiz(s) : renderPoll(s);
    case 'reveal':
      return s.mode === 'quiz' ? renderQuizResult(s) : renderPollResult(s);
    case 'leaderboard':
      return screen('', `${y.rank}. miejsce`, `Masz ${y.score} pkt. W grze: ${y.of}.`);
    case 'final':
      return s.mode === 'quiz' ? renderQuizFinal(s) : renderPollFinal(s);
    default:
      return '';
  }
}

function screen(icon, title, sub, cls = '') {
  return `<section class="screen pop ${cls}">
    ${icon ? `<div class="icon">${icon}</div>` : ''}
    <h1>${title}</h1>
    ${sub ? `<p class="muted">${sub}</p>` : ''}
  </section>`;
}

function qTop(s) {
  return `<div class="qtop">
    <span class="muted">Pytanie ${s.question.index + 1} z ${s.question.total}</span>
    <div class="timer" style="--size:54px"></div>
  </div>
  <h2 class="qtext">${esc(s.question.text)}</h2>`;
}

function renderQuiz(s) {
  return `${qTop(s)}
  <div class="answers n${s.question.options.length}">${s.question.options
    .map((o, i) => `<button class="ans opt-${i}" data-ans="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`)
    .join('')}</div>`;
}

function renderPoll(s) {
  const many = s.question.options.length > 8;
  return `${qTop(s)}
  ${many ? `<input id="search" class="search" placeholder="Szukaj osoby…" value="${esc(search)}" autocomplete="off" />` : ''}
  <div id="people" class="people">${s.question.options
    .map((o, i) => `<button class="person" data-i="${i}" data-n="${esc(o.toLowerCase())}">${esc(o)}</button>`)
    .join('')}</div>`;
}

function bindPoll() {
  $('#people').addEventListener('click', (e) => {
    const b = e.target.closest('.person');
    if (!b) return;
    if (confirm(`Głosujesz na: ${b.textContent}?`)) answer(Number(b.dataset.i));
  });
  const input = $('#search');
  if (!input) return;
  const filter = () => {
    search = input.value;
    const q = search.trim().toLowerCase();
    document.querySelectorAll('.person').forEach((b) => b.classList.toggle('hidden', q && !b.dataset.n.includes(q)));
  };
  input.addEventListener('input', filter);
  filter();
}

function renderWaiting(s) {
  const choice = s.question.options[s.you.answered];
  return screen(
    '',
    s.mode === 'quiz' ? 'Odpowiedź wysłana' : 'Głos oddany',
    s.mode === 'quiz' ? `Twoja odpowiedź: <b>${LETTERS[s.you.answered]}</b> – ${esc(choice)}` : `Zagłosowałeś na: <b>${esc(choice)}</b>`
  );
}

function renderQuizResult(s) {
  search = '';
  const l = s.you.last || {};
  const correctText = s.question.options[s.question.correct];
  if (!l.answered) return screen('', 'Brak odpowiedzi', `Poprawna: ${esc(correctText)}`, 'bad');
  if (l.correct) {
    return screen('', `Dobrze, +${l.points}`, `${s.you.streak >= 2 ? `Seria: ${s.you.streak} z rzędu. ` : ''}Jesteś na ${s.you.rank}. miejscu.`, 'good');
  }
  return screen('', 'Niestety źle', `Poprawna: ${esc(correctText)}`, 'bad');
}

function renderPollResult(s) {
  search = '';
  const w = s.winners || [];
  return screen('', w.length ? esc(namesList(w)) : 'Brak głosów', esc(s.question.text), 'winner');
}

function renderQuizFinal(s) {
  const y = s.you;
  return `${screen('', `${y.rank}. miejsce`, `${y.score} pkt. W grze było ${y.of}.`, y.rank <= 3 ? 'good' : '')}
    <ol class="mini-podium">${(s.podium || []).map((p) => `<li><b>${p.rank}.</b> <span class="pn">${esc(p.name)}</span> <span class="muted">${p.score}</span></li>`).join('')}</ol>`;
}

function renderPollFinal(s) {
  return `<section><h1 class="results-title">Wyniki plebiscytu</h1>
    <ul class="awards">${(s.history || [])
      .map((h) => `<li><span class="muted">${esc(h.question)}</span><b>${h.winners.length ? esc(namesList(h.winners)) : '—'}</b></li>`)
      .join('')}</ul></section>`;
}

// odpowiedzi quizu – delegacja zdarzeń (bez inline onclick, zgodnie z CSP)
$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ans]');
  if (b) answer(Number(b.dataset.ans));
});

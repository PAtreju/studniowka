// Wspólne pomocnicze funkcje dla ekranu i telefonu.
const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const LETTERS = ['A', 'B', 'C', 'D'];

// Różnica między zegarem serwera a lokalnym – liczniki czasu są zgodne na wszystkich urządzeniach.
let clockOffset = 0;
function syncClock(state) {
  if (state && state.serverNow) clockOffset = state.serverNow - Date.now();
}
const serverNow = () => Date.now() + clockOffset;

// Odlicza czas do endsAt w elemencie .timer
let timerHandle = null;
function runTimer(el, endsAt, totalSec) {
  stopTimer();
  if (!el) return;
  const tick = () => {
    const left = Math.max(0, endsAt - serverNow());
    const sec = Math.ceil(left / 1000);
    el.textContent = sec;
    el.style.setProperty('--p', Math.min(1, left / (totalSec * 1000)));
    el.classList.toggle('low', sec <= 5);
    if (left <= 0) stopTimer();
  };
  tick();
  timerHandle = setInterval(tick, 200);
}
function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

let toastHandle = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 3000);
}

function namesList(arr) {
  if (!arr || !arr.length) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' i ' + arr[arr.length - 1];
}

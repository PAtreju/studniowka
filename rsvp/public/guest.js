(function () {
  'use strict';
  var card = document.getElementById('card');
  var token = location.pathname.replace(/\/+$/, '').split('/').pop();
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var data = null;
  var editing = false;
  var justConfirmed = false;
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function ornament() {
    var s = svg('svg', { class: 'orn', width: 120, height: 14, viewBox: '0 0 120 14', 'aria-hidden': 'true' });
    s.appendChild(svg('path', { d: 'M0 7H50M70 7H120', stroke: 'currentColor', 'stroke-width': 1, fill: 'none' }));
    s.appendChild(svg('path', { d: 'M60 1L66 7L60 13L54 7Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
    return s;
  }

  function seal(animate) {
    var s = svg('svg', { class: 'seal' + (animate ? ' stamp' : ''), viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Czerwona lakowa pieczęć' });
    var pts = [], n = 22, i, a, r;
    var seed = 7;
    for (i = 0; i < n; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      a = (i / n) * Math.PI * 2;
      r = 44 + (seed / 233280) * 4 + (i % 2 ? 1.5 : -1);
      pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
    }
    var d = 'M' + ((pts[0][0] + pts[n - 1][0]) / 2).toFixed(1) + ' ' + ((pts[0][1] + pts[n - 1][1]) / 2).toFixed(1);
    for (i = 0; i < n; i++) {
      var nx = pts[(i + 1) % n];
      d += ' Q' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1) + ' ' + ((pts[i][0] + nx[0]) / 2).toFixed(1) + ' ' + ((pts[i][1] + nx[1]) / 2).toFixed(1);
    }
    s.appendChild(svg('path', { d: d + 'Z', fill: '#C8102E' }));
    s.appendChild(svg('circle', { cx: 50, cy: 50, r: 31, fill: 'none', stroke: 'rgba(0,0,0,.28)', 'stroke-width': 2 }));
    s.appendChild(svg('circle', { cx: 50, cy: 50, r: 33, fill: 'none', stroke: 'rgba(255,255,255,.22)', 'stroke-width': 1 }));
    var t = svg('text', { x: 50, y: 63, 'text-anchor': 'middle', 'font-family': "'Bodoni Moda', serif", 'font-style': 'italic', 'font-size': 40, fill: 'rgba(60,0,10,.55)' });
    t.textContent = 'S';
    s.appendChild(t);
    var t2 = svg('text', { x: 49, y: 62, 'text-anchor': 'middle', 'font-family': "'Bodoni Moda', serif", 'font-style': 'italic', 'font-size': 40, fill: 'rgba(255,200,205,.35)' });
    t2.textContent = 'S';
    s.appendChild(t2);
    return s;
  }

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  }
  function fmtDeadline(v) {
    var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(v || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var day = new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(d);
    return day + ' o ' + m[4] + ':' + m[5];
  }

  function shell(children) {
    card.textContent = '';
    card.appendChild(el('div', { class: 'frame' }, [el('div', { class: 'frame-in' }, children)]));
  }

  function lost(title, text) {
    document.title = 'Zaproszenie na studniówkę';
    shell([
      el('p', { class: 'kicker', text: 'Zaproszenie' }),
      ornament(),
      el('div', { class: 'lost' }, [el('h1', { text: title }), el('p', { text: text })]),
    ]);
  }

  function invitation() {
    var ev = data.event, g = data.guest;
    var date = fmtDate(ev.date);
    var parts = [
      el('p', { class: 'kicker', text: 'Zaproszenie' }),
      el('h1', { class: 'event-title', text: ev.title }),
      ornament(),
    ];
    var det = [];
    if (date) det.push(el('p', { class: 'when', text: date }));
    if (ev.time) det.push(el('p', { class: 'hour', text: 'godz. ' + ev.time }));
    if (ev.place) det.push(el('p', { class: 'where', text: ev.place }));
    if (ev.address) det.push(el('p', { class: 'addr', text: ev.address }));
    if (ev.dressCode) det.push(el('p', { class: 'dress', text: 'Dress code: ' + ev.dressCode }));
    if (det.length) parts.push(el('div', { class: 'details' }, det));
    if (ev.note) parts.push(el('p', { class: 'note', text: ev.note }));
    parts.push(ornament());
    return parts;
  }

  function respondArea() {
    var g = data.guest, ev = data.event;
    var err = el('p', { class: 'err', role: 'alert', hidden: true });
    var plus = null, plusName = null, plusWrap = null;
    var opts = el('div', { class: 'opts' });
    if (g.plusOneAllowed) {
      plus = el('input', { type: 'checkbox', id: 'plus' });
      plus.checked = !!g.plusOne;
      plusName = el('input', { type: 'text', id: 'plusname', maxlength: 100, autocomplete: 'off', value: g.plusOneName || '' });
      plusWrap = el('label', { class: 'field' }, [el('span', { text: 'Imię i nazwisko osoby towarzyszącej (opcjonalnie)' }), plusName]);
      plusWrap.hidden = !plus.checked;
      plus.addEventListener('change', function () { plusWrap.hidden = !plus.checked; });
      opts.appendChild(el('label', { class: 'switch' }, [plus, el('span', { class: 'track', 'aria-hidden': 'true' }), el('span', { text: 'Przyjdę z osobą towarzyszącą' })]));
      opts.appendChild(plusWrap);
    }
    var msg = el('textarea', { id: 'msg', maxlength: 500, rows: 3, placeholder: 'Np. dieta wegetariańska, alergie, prośby' });
    msg.value = g.message || '';
    var det = el('details', { class: 'msg' }, [el('summary', { text: 'Dodaj wiadomość' }), el('label', { class: 'field' }, [el('span', { text: 'Dieta, uwagi dla organizatora' }), msg])]);
    if (g.message) det.open = true;
    opts.appendChild(det);

    function send(status, btn) {
      var btns = card.querySelectorAll('.btn');
      btns.forEach(function (b) { b.disabled = true; });
      err.hidden = true;
      fetch('/api/r/' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status, plusOne: !!(plus && plus.checked && status === 'yes'), plusOneName: plusName ? plusName.value : '', message: msg.value }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) {
            btns.forEach(function (b) { b.disabled = false; });
            err.textContent = res.j.message || 'Nie udało się zapisać odpowiedzi. Spróbuj ponownie za chwilę.';
            err.hidden = false;
            if (res.j.error === 'deadline') { load(); }
            return;
          }
          data = res.j; editing = false; justConfirmed = status === 'yes'; render();
          var h = card.querySelector('h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
        })
        .catch(function () {
          btns.forEach(function (b) { b.disabled = false; });
          err.textContent = 'Brak połączenia. Sprawdź internet i spróbuj ponownie.';
          err.hidden = false;
        });
    }

    var yes = el('button', { class: 'btn btn-yes', type: 'button', text: 'Będę', onclick: function () { send('yes'); } });
    var no = el('button', { class: 'btn btn-no', type: 'button', text: 'Nie dam rady', onclick: function () { send('no'); } });
    var kids = [];
    if (ev.deadline) kids.push(el('p', { class: 'deadline', text: 'Prosimy o odpowiedź do ' + fmtDeadline(ev.deadline) + '.' }));
    else kids.push(el('p', { class: 'deadline', text: 'Prosimy o odpowiedź.' }));
    kids.push(opts, el('div', { class: 'btns' }, [yes, no]), err);
    if (editing) kids.push(el('button', { class: 'link', type: 'button', text: 'Zostaw bez zmian', onclick: function () { editing = false; render(); } }));
    return el('div', { class: 'respond' }, kids);
  }

  function doneArea() {
    var g = data.guest, locked = data.deadlinePassed;
    var kids = [];
    if (g.status === 'yes') {
      kids.push(seal(justConfirmed && !reduce));
      kids.push(el('h2', { text: 'Do zobaczenia!' }));
      kids.push(el('p', { text: 'Twoja obecność jest potwierdzona.' }));
      if (g.plusOne) kids.push(el('p', { class: 'meta', text: g.plusOneName ? 'Z osobą towarzyszącą: ' + g.plusOneName + '.' : 'Przyjdziesz z osobą towarzyszącą.' }));
    } else {
      kids.push(el('h2', { text: 'Dziękujemy za odpowiedź' }));
      kids.push(el('p', { text: 'Szkoda, że Cię nie będzie. Będziemy o Tobie myśleć.' }));
    }
    if (locked) kids.push(el('p', { class: 'closed', text: 'Termin odpowiedzi minął. Jeśli coś się zmieniło, napisz do organizatora.' }));
    else kids.push(el('button', { class: 'link', type: 'button', text: 'Zmień odpowiedź', onclick: function () { editing = true; justConfirmed = false; render(); } }));
    return el('div', { class: 'done' }, kids);
  }

  function render() {
    document.title = 'Zaproszenie: ' + (data.event.title || 'Studniówka');
    var g = data.guest, area;
    if (g.status === 'pending' || editing) {
      if (data.deadlinePassed) area = el('div', { class: 'done' }, [el('h2', { text: 'Termin odpowiedzi minął' }), el('p', { text: 'Jeśli chcesz dać znać, czy będziesz, napisz bezpośrednio do organizatora.' })]);
      else area = respondArea();
    } else area = doneArea();
    shell(invitation().concat([area]));
  }

  function load() {
    fetch('/api/r/' + encodeURIComponent(token), { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 404) { lost('Nie znamy tego linku', 'Sprawdź, czy skopiowałeś cały adres z wiadomości. Jeśli to nie pomoże, napisz do organizatora.'); return null; }
        if (r.status === 429) { lost('Chwila przerwy', 'Spróbuj ponownie za kilka minut.'); return null; }
        return r.json();
      })
      .then(function (j) { if (j) { data = j; render(); } })
      .catch(function () { lost('Nie udało się otworzyć zaproszenia', 'Sprawdź połączenie z internetem i odśwież stronę.'); });
  }
  load();
})();

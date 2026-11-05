(function () {
  'use strict';

  var app = document.getElementById('app');
  var saveBtn = document.getElementById('save');
  var dirtyEl = document.getElementById('dirty');
  var msgEl = document.getElementById('msg');
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab'));

  var LIMITS = {
    quizzes: { min: 5, max: 120 },
    polls: { min: 5, max: 300 }
  };

  var state = null;        // working copy: { classText, quizzes, polls }
  var savedJson = '';      // JSON of last loaded/saved content
  var tab = 'class';
  var open = {};           // open <details> ids
  var invalidField = null; // data-f of field marked invalid
  var hostKey = null;
  var saving = false;

  /* ---------- helpers ---------- */

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function slug(s) {
    var base = String(s || '')
      .replace(/ł/g, 'l').replace(/Ł/g, 'L')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 30).replace(/-+$/, '');
    return (base || 'zestaw') + '-' + Math.random().toString(36).slice(2, 7);
  }

  function lines(text) {
    return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function toState(c) {
    c = c || {};
    return {
      classText: (Array.isArray(c.classList) ? c.classList : []).join('\n'),
      quizzes: (Array.isArray(c.quizzes) ? c.quizzes : []).map(function (z) {
        return {
          id: z.id || slug(z.title),
          title: z.title || '',
          questions: (z.questions || []).map(function (q) {
            return {
              text: q.text || '',
              answers: Array.isArray(q.answers) ? q.answers.slice() : ['', ''],
              correct: typeof q.correct === 'number' ? q.correct : 0,
              time: typeof q.time === 'number' ? q.time : 15
            };
          })
        };
      }),
      polls: (Array.isArray(c.polls) ? c.polls : []).map(function (p) {
        return {
          id: p.id || slug(p.title),
          title: p.title || '',
          questions: (p.questions || []).map(function (q) {
            return {
              text: q.text || '',
              optText: (Array.isArray(q.options) ? q.options : []).join('\n'),
              time: typeof q.time === 'number' ? q.time : 30
            };
          })
        };
      })
    };
  }

  function serialize() {
    return {
      classList: lines(state.classText),
      quizzes: state.quizzes.map(function (z) {
        return {
          id: z.id,
          title: z.title.trim(),
          questions: z.questions.map(function (q) {
            return {
              text: q.text.trim(),
              answers: q.answers.map(function (a) { return a.trim(); }),
              correct: q.correct,
              time: q.time
            };
          })
        };
      }),
      polls: state.polls.map(function (p) {
        return {
          id: p.id,
          title: p.title.trim(),
          questions: p.questions.map(function (q) {
            return { text: q.text.trim(), options: lines(q.optText), time: q.time };
          })
        };
      })
    };
  }

  function isDirty() {
    return !!state && JSON.stringify(serialize()) !== savedJson;
  }

  function refreshDirty() {
    var d = isDirty();
    dirtyEl.hidden = !d;
    saveBtn.disabled = !state || saving;
    return d;
  }

  function setMsg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function onChange() {
    // clear stale save message when user keeps editing
    if (msgEl.textContent) setMsg('');
    refreshDirty();
  }

  window.addEventListener('beforeunload', function (e) {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------- auth + API ---------- */

  function readKeyFromUrl() {
    try {
      var u = new URL(location.href);
      var k = u.searchParams.get('key');
      if (k) {
        try { localStorage.setItem('hostKey', k); } catch (e) { /* ignore */ }
        u.searchParams.delete('key');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
        return k;
      }
    } catch (e) { /* ignore */ }
    try { return localStorage.getItem('hostKey'); } catch (e) { return null; }
  }

  var keyModal = document.getElementById('keyModal');
  var keyForm = document.getElementById('keyForm');
  var keyInput = document.getElementById('keyInput');
  var keyHint = document.getElementById('keyHint');
  var keyResolve = null;

  keyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = keyInput.value.trim();
    if (!v) return;
    hostKey = v;
    try { localStorage.setItem('hostKey', v); } catch (err) { /* ignore */ }
    keyModal.hidden = true;
    keyInput.value = '';
    if (keyResolve) { var r = keyResolve; keyResolve = null; r(); }
  });

  function askKey(wrong) {
    keyHint.textContent = wrong ? 'Nieprawidłowy klucz. Spróbuj ponownie.' : 'Podaj klucz, aby edytować treści.';
    keyHint.className = wrong ? 'bad' : 'muted';
    keyModal.hidden = false;
    setTimeout(function () { keyInput.focus(); }, 0);
    return new Promise(function (resolve) { keyResolve = resolve; });
  }

  function api(method, body) {
    function attempt() {
      var opts = { method: method, headers: { 'x-host-key': hostKey || '' } };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      return fetch('/api/content', opts).then(function (res) {
        if (res.status === 401) {
          return askKey(!!hostKey).then(attempt);
        }
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      });
    }
    if (!hostKey) return askKey(false).then(attempt);
    return attempt();
  }

  /* ---------- rendering ---------- */

  function fieldAttrs(f, extra) {
    var a = { 'data-f': f };
    if (f === invalidField) a.class = 'invalid';
    if (extra) Object.keys(extra).forEach(function (k) {
      a[k] = (k === 'class' && a.class) ? a.class + ' ' + extra[k] : extra[k];
    });
    return a;
  }

  function textInput(f, value, placeholder, onInput, label) {
    var a = fieldAttrs(f, {
      type: 'text', value: value, placeholder: placeholder || '',
      'aria-label': label || placeholder || '', autocomplete: 'off',
      oninput: function (e) {
        onInput(e.target.value);
        e.target.classList.remove('invalid');
        if (invalidField === f) invalidField = null;
        onChange();
      }
    });
    var el = h('input', a);
    el.value = value;
    return el;
  }

  function timeInput(f, q, lim) {
    var el = h('input', fieldAttrs(f, {
      type: 'number', inputmode: 'numeric', min: lim.min, max: lim.max, step: 1,
      'aria-label': 'Czas w sekundach',
      oninput: function (e) {
        q.time = e.target.value === '' ? NaN : Number(e.target.value);
        e.target.classList.remove('invalid');
        if (invalidField === f) invalidField = null;
        onChange();
      }
    }));
    el.value = isNaN(q.time) ? '' : q.time;
    return el;
  }

  function move(arr, i, d) {
    var j = i + d;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }

  function render() {
    tabBtns.forEach(function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab));
    });
    app.textContent = '';
    if (!state) return;
    if (tab === 'class') app.appendChild(renderClass());
    else if (tab === 'quizzes') renderSets('quizzes', app);
    else renderSets('polls', app);
    refreshDirty();
  }

  function renderClass() {
    var count = h('span', { class: 'count', text: String(lines(state.classText).length) });
    var ta = h('textarea', fieldAttrs('class:text', {
      rows: 14, 'aria-label': 'Lista uczniów', placeholder: 'Jedno imię na linię',
      oninput: function (e) {
        state.classText = e.target.value;
        count.textContent = String(lines(state.classText).length);
        e.target.classList.remove('invalid');
        if (invalidField === 'class:text') invalidField = null;
        onChange();
      }
    }));
    ta.value = state.classText;
    return h('section', { class: 'card' }, [
      h('h2', { text: 'Klasa' }),
      h('p', { class: 'hint' }, ['Jedno imię (lub imię i nazwisko) w każdej linii. Liczba osób: ', count]),
      h('div', { style: 'margin-top:10px' }, [ta])
    ]);
  }

  function renderSets(kind, root) {
    var isQuiz = kind === 'quizzes';
    var list = state[kind];
    var noun = isQuiz ? 'quiz' : 'plebiscyt';

    if (!list.length) {
      root.appendChild(h('p', { class: 'hint', text: isQuiz ? 'Brak quizów. Dodaj pierwszy.' : 'Brak plebiscytów. Dodaj pierwszy.' }));
    }

    list.forEach(function (set, si) {
      var det = h('details', { class: 'set' });
      if (open[set.id]) det.open = true;
      det.addEventListener('toggle', function () { open[set.id] = det.open; });

      var sumTitle = h('span', { class: 'set-title', text: set.title || '(bez nazwy)' });
      det.appendChild(h('summary', null, [
        sumTitle,
        h('span', { class: 'badge', text: set.questions.length + ' pyt.' })
      ]));

      var body = h('div', { class: 'set-body' });
      var titleF = kind + ':' + si + ':title';
      var titleIn = textInput(titleF, set.title, 'Nazwa', function (v) {
        set.title = v;
        sumTitle.textContent = v || '(bez nazwy)';
      }, 'Nazwa ' + (isQuiz ? 'quizu' : 'plebiscytu'));
      body.appendChild(h('div', { class: 'row set-head' }, [
        titleIn,
        h('button', {
          class: 'btn small danger', type: 'button', text: 'Usuń ' + noun,
          onclick: function () {
            if (!confirm('Usunąć „' + (set.title || 'bez nazwy') + '”?')) return;
            list.splice(si, 1);
            render();
            onChange();
          }
        })
      ]));

      var qErr = kind + ':' + si + ':questions';
      set.questions.forEach(function (q, qi) {
        body.appendChild(renderQuestion(kind, si, set, q, qi));
      });
      if (qErr === invalidField) {
        body.appendChild(h('p', { class: 'err-text', 'data-f': qErr, tabindex: '-1', text: 'Dodaj co najmniej jedno pytanie.' }));
      }
      body.appendChild(h('button', {
        class: 'btn add', type: 'button', text: '+ Dodaj pytanie',
        onclick: function () {
          set.questions.push(isQuiz
            ? { text: '', answers: ['', '', '', ''], correct: 0, time: 15 }
            : { text: '', optText: '', time: 30 });
          if (invalidField === qErr) invalidField = null;
          open[set.id] = true;
          render();
          onChange();
        }
      }));
      det.appendChild(body);
      root.appendChild(det);
    });

    root.appendChild(h('button', {
      class: 'btn add', type: 'button', text: '+ Dodaj ' + noun,
      onclick: function () {
        var title = isQuiz ? 'Nowy quiz' : 'Nowy plebiscyt';
        var s = { id: slug(title), title: title, questions: [] };
        s.questions.push(isQuiz
          ? { text: '', answers: ['', '', '', ''], correct: 0, time: 15 }
          : { text: '', optText: '', time: 30 });
        list.push(s);
        open[s.id] = true;
        render();
        onChange();
      }
    }));
  }

  function renderQuestion(kind, si, set, q, qi) {
    var isQuiz = kind === 'quizzes';
    var p = kind + ':' + si + ':q:' + qi + ':';
    var lim = LIMITS[kind];
    var box = h('div', { class: 'q' });

    box.appendChild(h('div', { class: 'q-head' }, [
      h('span', { class: 'q-num', text: 'Pytanie ' + (qi + 1) }),
      h('button', {
        class: 'btn small icon', type: 'button', text: '↑', title: 'Przesuń w górę', 'aria-label': 'Przesuń w górę',
        disabled: qi === 0,
        onclick: function () { move(set.questions, qi, -1); render(); onChange(); }
      }),
      h('button', {
        class: 'btn small icon', type: 'button', text: '↓', title: 'Przesuń w dół', 'aria-label': 'Przesuń w dół',
        disabled: qi === set.questions.length - 1,
        onclick: function () { move(set.questions, qi, 1); render(); onChange(); }
      }),
      h('button', {
        class: 'btn small danger', type: 'button', text: 'Usuń',
        onclick: function () {
          if (!confirm('Usunąć pytanie ' + (qi + 1) + '?')) return;
          set.questions.splice(qi, 1);
          render(); onChange();
        }
      })
    ]));

    box.appendChild(textInput(p + 'text', q.text, 'Treść pytania', function (v) { q.text = v; }, 'Treść pytania ' + (qi + 1)));

    if (isQuiz) {
      var answers = h('div', { class: 'answers', role: 'radiogroup', 'aria-label': 'Odpowiedzi' });
      q.answers.forEach(function (a, ai) {
        var f = p + 'ans:' + ai;
        var row = h('div', { class: 'ans' + (q.correct === ai ? ' correct' : '') });
        var radio = h('input', {
          type: 'radio', name: 'c-' + si + '-' + qi, 'aria-label': 'Poprawna odpowiedź ' + (ai + 1),
          title: 'Zaznacz jako poprawną',
          onchange: function () {
            q.correct = ai;
            Array.prototype.forEach.call(answers.children, function (r, i) {
              r.classList.toggle('correct', i === ai);
            });
            onChange();
          }
        });
        radio.checked = q.correct === ai;
        row.appendChild(radio);
        row.appendChild(textInput(f, a, 'Odpowiedź ' + (ai + 1), function (v) { q.answers[ai] = v; }, 'Odpowiedź ' + (ai + 1)));
        row.appendChild(h('button', {
          class: 'btn small icon danger', type: 'button', text: '✕', title: 'Usuń odpowiedź', 'aria-label': 'Usuń odpowiedź ' + (ai + 1),
          disabled: q.answers.length <= 2,
          onclick: function () {
            q.answers.splice(ai, 1);
            if (q.correct === ai) q.correct = 0;
            else if (q.correct > ai) q.correct--;
            render(); onChange();
          }
        }));
        answers.appendChild(row);
      });
      box.appendChild(h('label', { class: 'lbl', text: 'Odpowiedzi (zaznacz poprawną)' }));
      box.appendChild(answers);
      if (q.answers.length < 4) {
        box.appendChild(h('div', { class: 'q-foot' }, [h('button', {
          class: 'btn small', type: 'button', text: '+ Dodaj odpowiedź',
          onclick: function () { q.answers.push(''); render(); onChange(); }
        })]));
      }
    } else {
      var f2 = p + 'options';
      var ta = h('textarea', fieldAttrs(f2, {
        rows: 3, placeholder: 'Własne opcje, jedna na linię', 'aria-label': 'Własne opcje',
        oninput: function (e) { q.optText = e.target.value; onChange(); }
      }));
      ta.value = q.optText;
      box.appendChild(h('label', { class: 'lbl', text: 'Własne opcje (opcjonalnie)' }));
      box.appendChild(ta);
      box.appendChild(h('p', { class: 'hint', text: 'Puste = głosowanie na osoby z klasy' }));
    }

    box.appendChild(h('div', { class: 'time-row' }, [
      h('label', { class: 'muted', text: 'Czas (s):' }),
      timeInput(p + 'time', q, lim),
      h('span', { class: 'hint', text: lim.min + '–' + lim.max })
    ]));
    return box;
  }

  /* ---------- validation ---------- */

  function validate() {
    var s = state;
    var i, j, k;

    var names = lines(s.classText);
    var seen = {};
    for (i = 0; i < names.length; i++) {
      var low = names[i].toLowerCase();
      if (seen[low]) return { tab: 'class', f: 'class:text', msg: 'Klasa: imię „' + names[i] + '” powtarza się.' };
      seen[low] = true;
    }

    var kinds = ['quizzes', 'polls'];
    for (var ki = 0; ki < kinds.length; ki++) {
      var kind = kinds[ki];
      var isQuiz = kind === 'quizzes';
      var lim = LIMITS[kind];
      var label = isQuiz ? 'Quizy' : 'Plebiscyty';
      for (i = 0; i < s[kind].length; i++) {
        var set = s[kind][i];
        var where = label + ' – „' + (set.title.trim() || 'bez nazwy') + '”: ';
        if (!set.title.trim()) return { tab: kind, f: kind + ':' + i + ':title', set: set, msg: label + ': nazwa nie może być pusta.' };
        if (!set.questions.length) return { tab: kind, f: kind + ':' + i + ':questions', set: set, msg: where + 'dodaj co najmniej jedno pytanie.' };
        for (j = 0; j < set.questions.length; j++) {
          var q = set.questions[j];
          var p = kind + ':' + i + ':q:' + j + ':';
          var qw = where + 'pytanie ' + (j + 1) + ': ';
          if (!q.text.trim()) return { tab: kind, f: p + 'text', set: set, msg: qw + 'treść nie może być pusta.' };
          if (isQuiz) {
            if (q.answers.length < 2 || q.answers.length > 4) return { tab: kind, f: p + 'text', set: set, msg: qw + 'wymagane 2–4 odpowiedzi.' };
            for (k = 0; k < q.answers.length; k++) {
              if (!q.answers[k].trim()) return { tab: kind, f: p + 'ans:' + k, set: set, msg: qw + 'odpowiedź ' + (k + 1) + ' jest pusta.' };
            }
            if (!(q.correct >= 0 && q.correct < q.answers.length)) return { tab: kind, f: p + 'ans:0', set: set, msg: qw + 'zaznacz poprawną odpowiedź.' };
          } else {
            var opts = lines(q.optText);
            if (opts.length === 1) return { tab: kind, f: p + 'options', set: set, msg: qw + 'podaj co najmniej dwie opcje albo zostaw puste.' };
            if (!opts.length && !names.length) return { tab: 'class', f: 'class:text', msg: qw + 'brak opcji, więc potrzebna jest lista klasy (zakładka Klasa).' };
          }
          if (!(isFinite(q.time) && Math.floor(q.time) === q.time && q.time >= lim.min && q.time <= lim.max)) {
            return { tab: kind, f: p + 'time', set: set, msg: qw + 'czas musi być liczbą całkowitą ' + lim.min + '–' + lim.max + ' s.' };
          }
        }
      }
    }
    return null;
  }

  function showInvalid(err) {
    tab = err.tab;
    if (err.set) open[err.set.id] = true;
    invalidField = err.f;
    render();
    var el = app.querySelector('[data-f="' + err.f + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- load / save ---------- */

  function load() {
    app.innerHTML = '';
    app.appendChild(h('p', { class: 'loading', text: 'Wczytywanie…' }));
    api('GET').then(function (r) {
      if (!r.ok) throw new Error((r.data && r.data.error) || ('Błąd serwera (' + r.status + ')'));
      state = toState(r.data);
      savedJson = JSON.stringify(serialize());
      render();
    }).catch(function (err) {
      state = null;
      app.textContent = '';
      app.appendChild(h('div', { class: 'load-error' }, [
        h('p', { text: 'Nie udało się wczytać treści: ' + err.message }),
        h('button', { class: 'btn', type: 'button', text: 'Spróbuj ponownie', onclick: load })
      ]));
      refreshDirty();
    });
  }

  function save() {
    if (!state || saving) return;
    var err = validate();
    if (err) {
      setMsg(err.msg, 'error');
      showInvalid(err);
      return;
    }
    invalidField = null;
    var payload = serialize();
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Zapisywanie…';
    setMsg('');
    api('PUT', payload).then(function (r) {
      if (!r.ok) throw new Error((r.data && r.data.error) || ('Błąd serwera (' + r.status + ')'));
      savedJson = JSON.stringify(payload);
      setMsg('Zapisano ✓', 'ok');
    }).catch(function (e) {
      setMsg('Nie zapisano: ' + (e && e.message ? e.message : 'błąd sieci'), 'error');
    }).then(function () {
      saving = false;
      saveBtn.textContent = 'Zapisz';
      refreshDirty();
    });
  }

  saveBtn.addEventListener('click', save);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  tabBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      tab = b.getAttribute('data-tab');
      invalidField = null;
      render();
    });
  });

  hostKey = readKeyFromUrl();
  refreshDirty();
  load();
})();

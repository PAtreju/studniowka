(function () {
  'use strict';
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var state = { data: null, tab: 'guests', filter: 'all', q: '' };
  var toastTimer;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }
  function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && url.indexOf('/login') < 0) { showLogin(); throw new Error('auth'); }
        if (!r.ok) { var e = new Error(j.error || 'Coś poszło nie tak. Spróbuj ponownie.'); e.user = true; throw e; }
        return j;
      });
    });
  }
  function fmt(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }
  function field(label, input) { return el('label', { class: 'f' }, [el('span', { text: label }), input]); }

  // ---------- login ----------
  function showLogin() {
    var err = el('p', { class: 'msg-err', role: 'alert', hidden: true });
    var pw = el('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
    var form = el('form', { onsubmit: function (e) {
      e.preventDefault();
      err.hidden = true;
      api('POST', '/api/admin/login', { password: pw.value }).then(load).catch(function (x) {
        if (x.message === 'auth') return;
        err.textContent = x.message; err.hidden = false; pw.select();
      });
    } }, [field('Hasło', pw), el('button', { class: 'btn btn-primary', type: 'submit', text: 'Zaloguj' }), err]);
    document.title = 'Logowanie: panel organizatora';
    app.textContent = '';
    app.appendChild(el('div', { class: 'login' }, [el('h1', { text: 'Panel organizatora' }), el('p', { text: 'Zaloguj się, żeby zarządzać listą gości.' }), form]));
    pw.focus();
  }

  // ---------- data ----------
  function load() {
    return api('GET', '/api/admin/state').then(function (d) { state.data = d; render(); }).catch(function (e) {
      if (e.message !== 'auth') { app.textContent = ''; app.appendChild(el('p', { class: 'boot', text: e.message })); }
    });
  }

  function render() {
    document.title = 'Panel organizatora';
    app.textContent = '';
    var top = el('div', { class: 'top' }, [
      el('h1', { text: state.data.settings.title || 'Panel organizatora' }),
      el('span', { class: 'sp' }),
      el('a', { class: 'btn btn-sm', href: '/api/admin/export.csv', text: 'Pobierz CSV' }),
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Wyloguj', onclick: function () { api('POST', '/api/admin/logout', {}).then(showLogin); } }),
    ]);
    var tabs = el('div', { class: 'tabs', role: 'tablist' }, [['guests', 'Goście'], ['mail', 'Wyślij zaproszenia'], ['custom', 'Wiadomość do wybranych'], ['settings', 'Ustawienia wydarzenia']].map(function (t) {
      return el('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(state.tab === t[0]), text: t[1], onclick: function () { state.tab = t[0]; render(); } });
    }));
    var main = el('main');
    app.appendChild(top); app.appendChild(tabs); app.appendChild(main);
    if (state.tab === 'guests') guestsTab(main); else if (state.tab === 'mail') mailTab(main); else if (state.tab === 'custom') customTab(main); else settingsTab(main);
  }

  // ---------- guests ----------
  function guestsTab(main) {
    var c = state.data.counts;
    main.appendChild(el('div', { class: 'summary' }, [
      el('span', { class: 'big', text: String(c.people) }),
      el('span', { class: 'lead', text: plural(c.people, 'osoba potwierdziła', 'osoby potwierdziły', 'osób potwierdziło') + ' przybycie' }),
      el('span', { class: 'rest', text: 'Gości: ' + c.total + '. Będzie: ' + c.yes + ', nie będzie: ' + c.no + ', czeka na odpowiedź: ' + c.pending + '. Osób towarzyszących: ' + c.plusOnes + '.' }),
    ]));

    var name = el('input', { type: 'text', id: 'g-name', autocomplete: 'off', required: true, maxlength: 120 });
    var email = el('input', { type: 'email', id: 'g-email', autocomplete: 'off', maxlength: 200 });
    var plus = el('input', { type: 'checkbox', id: 'g-plus' });
    var err = el('p', { class: 'msg-err', role: 'alert', hidden: true });
    main.appendChild(el('form', { class: 'add', onsubmit: function (e) {
      e.preventDefault(); err.hidden = true;
      api('POST', '/api/admin/guests', { name: name.value, email: email.value, plusOneAllowed: plus.checked })
        .then(function () { toast('Dodano gościa'); return load(); })
        .catch(function (x) { if (x.message !== 'auth') { err.textContent = x.message; err.hidden = false; } });
    } }, [
      field('Imię i nazwisko', name), field('E-mail', email),
      el('label', { class: 'check' }, [plus, 'Może przyjść z osobą towarzyszącą']),
      el('button', { class: 'btn btn-primary', type: 'submit', text: 'Dodaj gościa' }),
    ]));
    main.appendChild(err);

    var bulkTa = el('textarea', { id: 'bulk', placeholder: 'Anna Kowalska, anna@example.com\nJan Nowak, jan@example.com', spellcheck: 'false' });
    var bulkPlus = el('input', { type: 'checkbox' });
    main.appendChild(el('details', { class: 'bulk' }, [
      el('summary', { text: 'Dodaj wiele osób naraz' }),
      el('p', { class: 'hint', text: 'Wklej listę, jedna osoba w wierszu: „Imię Nazwisko, e-mail”. Działa też wklejony arkusz z kolumnami e-mail, imię, nazwisko. Duplikaty adresów zostaną pominięte.' }),
      bulkTa,
      el('div', { class: 'add bulk-row' }, [
        el('label', { class: 'check' }, [bulkPlus, 'Wszyscy mogą przyjść z osobą towarzyszącą']),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Dodaj z listy', onclick: function () {
          api('POST', '/api/admin/guests/bulk', { text: bulkTa.value, plusOneAllowed: bulkPlus.checked }).then(function (r) {
            var t = 'Dodano: ' + r.added + ', pominięto duplikaty: ' + r.skipped;
            if (r.errors.length) t += '. Do poprawy: ' + r.errors.map(function (e) { return 'wiersz ' + e.line + ' (' + e.reason + ')'; }).join(', ');
            toast('Dodano: ' + r.added);
            return load().then(function () {
              var o = document.querySelector('.bulk-out'); if (o) { o.textContent = t; o.hidden = false; }
            });
          }).catch(fail);
        } }),
      ]),
    ]));
    main.appendChild(el('p', { class: 'msg-ok bulk-out', role: 'status', hidden: true }));

    var q = el('input', { type: 'text', id: 'q', placeholder: 'Szukaj po imieniu lub e-mailu', value: state.q, autocomplete: 'off' });
    var sel = el('select', { id: 'flt', onchange: function () { state.filter = sel.value; list(); } }, [['all', 'Wszyscy'], ['pending', 'Czekają'], ['yes', 'Będą'], ['no', 'Nie będzie']].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: state.filter === o[0] });
    }));
    q.addEventListener('input', function () { state.q = q.value; list(); });
    main.appendChild(el('div', { class: 'tools' }, [el('div', { class: 'grow' }, [field('Szukaj', q)]), el('div', { class: 'sel' }, [field('Pokaż', sel)])]));
    var holder = el('div');
    main.appendChild(holder);
    list();

    function list() {
      holder.textContent = '';
      var needle = state.q.trim().toLowerCase();
      var gs = state.data.guests.filter(function (g) {
        return (state.filter === 'all' || g.status === state.filter) && (!needle || (g.name + ' ' + g.email).toLowerCase().indexOf(needle) >= 0);
      });
      if (!gs.length) { holder.appendChild(el('p', { class: 'empty', text: state.data.guests.length ? 'Nikt nie pasuje do tego filtra.' : 'Lista jest pusta. Dodaj pierwszego gościa powyżej.' })); return; }
      var tbody = el('tbody');
      gs.forEach(function (g) { tbody.appendChild(row(g)); });
      holder.appendChild(el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Gość', 'Status', 'Osoba towarzysząca', 'Wiadomość', 'Odpowiedź', 'Link otwarty', 'Działania'].map(function (h) { return el('th', { text: h }); }))]),
        tbody,
      ]));
    }
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (n === 1) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function copy(text) {
    function fallback() {
      var t = el('textarea', { class: 'sr-copy' }); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('Skopiowano link'); } catch (e) { window.prompt('Skopiuj link:', text); }
      t.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast('Skopiowano link'); }, fallback);
    else fallback();
  }

  function row(g) {
    var label = { pending: 'czeka', yes: 'będzie', no: 'nie będzie' }[g.status];
    var plusTxt = !g.plusOneAllowed ? '' : (g.plusOne ? (g.plusOneName || 'tak, bez imienia') : 'może, nie zgłosił');
    return el('tr', {}, [
      el('td', { class: 'c-name' }, [el('div', { class: 'gname', text: g.name }), el('div', { class: 'gmail', text: g.email || 'brak e-maila' })]),
      el('td', { 'data-l': 'Status' }, [el('span', { class: 'badge st-' + g.status, text: label })]),
      el('td', { 'data-l': 'Osoba towarzysząca', class: g.plusOneAllowed ? '' : 'mut', text: plusTxt || (g.plusOneAllowed ? '' : 'niedozwolona') }),
      el('td', { 'data-l': 'Wiadomość', class: 'gmsg', hidden: !g.message, text: g.message }),
      el('td', { 'data-l': 'Odpowiedź', class: 'small', text: fmt(g.respondedAt) || 'brak' }),
      el('td', { 'data-l': 'Link otwarty', class: 'small', text: fmt(g.openedAt) || 'jeszcze nie' }),
      el('td', { class: 'c-act' }, [el('div', { class: 'acts' }, [
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Kopiuj link', onclick: function () { copy(g.link); } }),
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Napisz wiadomość', onclick: function () { custom.pick = {}; custom.pick[g.id] = true; state.tab = 'custom'; render(); } }),
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Edytuj', onclick: function () { editDialog(g); } }),
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Wyzeruj odpowiedź', disabled: g.status === 'pending', onclick: function () {
          if (!confirm('Wyzerować odpowiedź gościa ' + g.name + '? Wróci do statusu „czeka”.')) return;
          api('POST', '/api/admin/guests/' + g.id + '/reset', {}).then(function () { toast('Odpowiedź wyzerowana'); return load(); }).catch(fail);
        } }),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Usuń', onclick: function () {
          if (!confirm('Usunąć gościa ' + g.name + '? Jego link przestanie działać. Tej operacji nie można cofnąć.')) return;
          api('DELETE', '/api/admin/guests/' + g.id).then(function () { toast('Usunięto gościa'); return load(); }).catch(fail);
        } }),
      ])]),
    ]);
  }
  function fail(x) { if (x.message !== 'auth') toast(x.message); }

  function editDialog(g) {
    var name = el('input', { type: 'text', value: g.name, required: true, maxlength: 120 });
    var email = el('input', { type: 'email', value: g.email, maxlength: 200 });
    var plus = el('input', { type: 'checkbox' }); plus.checked = g.plusOneAllowed;
    var err = el('p', { class: 'msg-err', role: 'alert', hidden: true });
    var dlg = el('dialog', { 'aria-labelledby': 'dlg-t' }, [
      el('h2', { id: 'dlg-t', text: 'Edytuj gościa' }),
      el('form', { method: 'dialog', onsubmit: function (e) {
        e.preventDefault(); err.hidden = true;
        api('PUT', '/api/admin/guests/' + g.id, { name: name.value, email: email.value, plusOneAllowed: plus.checked })
          .then(function () { dlg.close(); toast('Zapisano zmiany'); return load(); })
          .catch(function (x) { if (x.message !== 'auth') { err.textContent = x.message; err.hidden = false; } });
      } }, [
        field('Imię i nazwisko', name), field('E-mail', email),
        el('label', { class: 'check' }, [plus, 'Może przyjść z osobą towarzyszącą']),
        err,
        el('div', { class: 'row-end' }, [
          el('button', { class: 'btn', type: 'button', text: 'Anuluj', onclick: function () { dlg.close(); } }),
          el('button', { class: 'btn btn-primary', type: 'submit', text: 'Zapisz' }),
        ]),
      ]),
    ]);
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }


  // ---------- mail ----------
  var mailUi = { cfg: null, check: null, status: null, timer: null, guestId: '', mode: 'unsent', selected: {} };

  function renderLocal(tpl, g, link) {
    var parts = (g.name || '').trim().split(/\s+/);
    var v = { imie: parts[0] || '', nazwisko: parts.slice(1).join(' '), link: link };
    return tpl.replace(/\{(imie|nazwisko|link)\}/g, function (_, k) { return v[k]; });
  }

  function mailTab(main) {
    clearInterval(mailUi.timer);
    var s = state.data.settings;
    var wrap = el('div', { class: 'mail' });
    main.appendChild(wrap);
    Promise.all([api('GET', '/api/admin/mail/config'), api('GET', '/api/admin/mail/status')]).then(function (r) {
      mailUi.cfg = r[0]; mailUi.status = r[1];
      draw();
      if (mailUi.status.running) poll();
    }).catch(fail);

    function draw() {
      wrap.textContent = '';
      var cfg = mailUi.cfg;
      if (cfg.transport === 'gmail') wrap.appendChild(gmailBlock(cfg));
      else if (!cfg.configured) {
        wrap.appendChild(el('div', { class: 'notice' }, [
          el('h2', { text: 'Wysyłka nie jest jeszcze skonfigurowana' }),
          el('p', { text: 'Ustaw na serwerze zmienne środowiskowe i uruchom aplikację ponownie. Do tego czasu przyciski wysyłki są wyłączone, ale możesz już pisać i sprawdzać wiadomość.' }),
          el('p', { class: 'code', text: 'Brakuje: ' + cfg.missing.join(', ') }),
        ]));
      } else {
        wrap.appendChild(el('p', { class: 'small', text: 'Nadawca: ' + cfg.from + (cfg.replyTo ? '. Odpowiedzi trafią na ' + cfg.replyTo : '') + '. Przerwa między wiadomościami: ' + (cfg.delayMs / 1000) + ' s.' }));
      }
      wrap.appendChild(compose());
      wrap.appendChild(checkSection());
    }


    function gmailBlock(cfg) {
      var g = cfg.google, kids = [];
      kids.push(el('h2', { text: 'Konto Gmail do wysyłki' }));
      if (g.connected && !g.needsReconnect) {
        kids.push(el('p', { text: 'Połączone jako ' + g.email + (cfg.fromName ? ' (nazwa nadawcy: ' + cfg.fromName + ')' : '') + '. Przerwa między wiadomościami: ' + (cfg.delayMs / 1000) + ' s.' }));
        kids.push(el('div', { class: 'acts-row' }, [el('button', { class: 'btn btn-sm', type: 'button', text: 'Rozłącz', onclick: function () {
          if (!confirm('Rozłączyć konto ' + g.email + '? Wysyłka zostanie wyłączona, aż połączysz konto ponownie.')) return;
          api('POST', '/api/admin/google/disconnect', {}).then(function () { toast('Konto rozłączone'); render(); }).catch(fail);
        } })]));
      } else {
        if (g.needsReconnect) kids.push(el('p', { class: 'msg-err', text: 'Połączenie z Gmailem wygasło albo zostało odwołane. Połącz konto ponownie.' }));
        else kids.push(el('p', { text: 'Żeby wysyłać zaproszenia ze swojego konta Google, połącz je. Aplikacja dostaje tylko prawo do wysyłania wiadomości, nie czyta poczty.' }));
        if (g.clientConfigured) kids.push(el('div', { class: 'acts-row' }, [el('a', { class: 'btn btn-primary', href: '/admin/google/start', text: g.needsReconnect ? 'Połącz ponownie' : 'Połącz konto Gmail' })]));
        else kids.push(el('p', { class: 'code', text: 'Brakuje zmiennych: ' + g.missing.join(', ') }));
      }
      if (g.redirectUri) {
        kids.push(el('p', { class: 'small', text: 'Adres przekierowania do wpisania w kliencie OAuth w Google Cloud (Authorized redirect URIs):' }));
        kids.push(el('p', { class: 'code uri', text: g.redirectUri }));
      } else kids.push(el('p', { class: 'small', text: 'Ustaw PUBLIC_BASE_URL (np. https://rsvp.shroomdev.pl), a pokażemy tu adres przekierowania dla Google.' }));
      return el('div', { class: 'notice' }, kids);
    }

    function compose() {
      var subj = el('input', { type: 'text', value: s.mailSubject, maxlength: 200 });
      var body = el('textarea', { class: 'tall', maxlength: 5000 });
      body.value = s.mailBody;
      var msg = el('p', { role: 'status', hidden: true });
      var guests = state.data.guests;
      var sel = el('select', { onchange: function () { mailUi.guestId = sel.value; refresh(); } }, guests.map(function (g) { return el('option', { value: g.id, text: g.name, selected: g.id === mailUi.guestId }); }));
      var pre = el('pre', { class: 'preview-text' });
      var frame = el('iframe', { class: 'preview-frame', sandbox: 'allow-same-origin', title: 'Podgląd wiadomości HTML' });
      var warn = el('p', { class: 'msg-err', hidden: true, text: 'Brakuje znacznika {link}. Bez niego nie da się zapisać szablonu.' });
      function current() { return guests.filter(function (g) { return g.id === (mailUi.guestId || (guests[0] && guests[0].id)); })[0] || { name: 'Anna Kowalska', link: 'https://…/AbCd1234' }; }
      function refresh() {
        var g = current();
        pre.textContent = 'Temat: ' + renderLocal(subj.value, g, g.link) + '\n\n' + renderLocal(body.value, g, g.link);
        warn.hidden = body.value.indexOf('{link}') >= 0;
        if (g.id) frame.src = '/api/admin/mail/preview.html?guestId=' + encodeURIComponent(g.id) + '&t=' + Date.now();
      }
      subj.addEventListener('input', function () { refresh(); });
      body.addEventListener('input', function () { refresh(); });
      refresh();
      var testTo = el('input', { type: 'email', placeholder: 'twoj@adres.pl', autocomplete: 'email' });
      var testMsg = el('p', { role: 'status', hidden: true });
      return el('section', { class: 'step' }, [
        el('h2', { text: '1. Treść wiadomości' }),
        el('p', { class: 'small', text: 'W temacie i treści działają znaczniki {imie}, {nazwisko} i {link}. Znacznik {link} jest obowiązkowy.' }),
        field('Temat', subj), field('Treść', body), warn,
        el('div', { class: 'acts-row' }, [el('button', { class: 'btn btn-primary', type: 'button', text: 'Zapisz szablon', onclick: function () {
          api('PUT', '/api/admin/mail/template', { subject: subj.value, body: body.value }).then(function (r) {
            s.mailSubject = r.subject; s.mailBody = r.body; toast('Zapisano szablon'); mailUi.check = null;
            msg.className = 'msg-ok'; msg.textContent = 'Zapisano. Sprawdź listę ponownie przed wysyłką.'; msg.hidden = false; refresh();
          }).catch(function (x) { if (x.message !== 'auth') { msg.className = 'msg-err'; msg.textContent = x.message; msg.hidden = false; } });
        } })]),
        msg,
        el('div', { class: 'pv' }, [
          field('Podgląd dla gościa', sel),
          el('div', { class: 'pv-grid' }, [el('div', {}, [el('p', { class: 'small', text: 'Wersja tekstowa (na żywo)' }), pre]), el('div', {}, [el('p', { class: 'small', text: 'Wersja HTML (z ostatnio zapisanego szablonu)' }), frame])]),
        ]),
        el('div', { class: 'test' }, [
          field('Wyślij test do mnie na adres', testTo),
          el('button', { class: 'btn', type: 'button', disabled: !mailUi.cfg.configured, text: 'Wyślij test do mnie', onclick: function () {
            testMsg.hidden = true;
            api('POST', '/api/admin/mail/test', { to: testTo.value, subject: subj.value, body: body.value, guestId: current().id }).then(function () {
              testMsg.className = 'msg-ok'; testMsg.textContent = 'Test poszedł na ' + testTo.value + '. Sprawdź skrzynkę, także spam.'; testMsg.hidden = false;
            }).catch(function (x) { if (x.message !== 'auth') { testMsg.className = 'msg-err'; testMsg.textContent = x.message; testMsg.hidden = false; } });
          } }),
          testMsg,
        ]),
      ]);
    }

    function checkSection() {
      var box = el('div');
      var sec = el('section', { class: 'step' }, [
        el('h2', { text: '2. Sprawdź odbiorców' }),
        el('p', { class: 'small', text: 'Sprawdzenie jest obowiązkowe przed wysyłką. Pokazuje adresy po normalizacji, końcowy link i wynik sprawdzenia domeny (MX lub A).' }),
        el('button', { class: 'btn btn-primary', type: 'button', text: mailUi.check ? 'Sprawdź ponownie' : 'Sprawdź listę', onclick: function (e) {
          e.target.disabled = true; e.target.textContent = 'Sprawdzam…';
          api('GET', '/api/admin/mail/check').then(function (r) { mailUi.check = r; draw(); }).catch(function (x) { fail(x); e.target.disabled = false; e.target.textContent = 'Sprawdź listę'; });
        } }),
        box,
      ]);
      if (!mailUi.check) return sec;
      var c = mailUi.check, sm = c.summary;
      box.appendChild(el('p', { class: 'check-sum', text: 'Gotowych do wysyłki: ' + sm.ready + ' z ' + sm.total + '. Do poprawy: ' + sm.blocked + '. Wysłano już: ' + sm.sent + '. Nieudanych: ' + sm.failed + '.' }));
      var tbody = el('tbody');
      c.rows.forEach(function (r) {
        var cb = el('input', { type: 'checkbox', 'aria-label': 'Zaznacz: ' + r.name, disabled: r.blocking });
        cb.checked = !!mailUi.selected[r.id];
        cb.addEventListener('change', function () { mailUi.selected[r.id] = cb.checked; });
        var probs = r.problems.length ? el('ul', { class: 'probs' }, r.problems.map(function (p) { return el('li', { class: 'p-' + p.level, text: p.text }); })) : el('span', { class: 'st-yes', text: 'W porządku' });
        tbody.appendChild(el('tr', {}, [
          el('td', { class: 'c-sel' }, [cb]),
          el('td', { class: 'c-name' }, [el('div', { class: 'gname', text: r.name }), el('div', { class: 'gmail', text: r.email || 'brak e-maila' + '' }), r.rawEmail && r.rawEmail !== r.email ? el('div', { class: 'small', text: 'było: „' + r.rawEmail + '”' }) : null]),
          el('td', { 'data-l': 'Link', class: 'small linkcell', text: r.link }),
          el('td', { 'data-l': 'Kontrola' }, [probs]),
          el('td', { 'data-l': 'Wysyłka', class: 'small' }, [r.sentAt ? el('span', { class: 'st-yes', text: 'wysłano ' + fmt(r.sentAt) }) : r.sendError ? el('span', { class: 'st-no', text: 'błąd: ' + r.sendError }) : 'jeszcze nie']),
        ]));
      });
      box.appendChild(el('table', { class: 'chk' }, [el('thead', {}, [el('tr', {}, ['', 'Gość', 'Link', 'Kontrola', 'Wysyłka'].map(function (h) { return el('th', { text: h }); }))]), tbody]));
      sec.appendChild(sendSection());
      return sec;
    }

    function recipientsFor(mode) {
      var rows = mailUi.check.rows.filter(function (r) { return !r.blocking; });
      if (mode === 'unsent') return rows.filter(function (r) { return !r.sentAt; });
      if (mode === 'failed') return rows.filter(function (r) { return r.sendError && !r.sentAt; });
      return rows.filter(function (r) { return mailUi.selected[r.id]; });
    }

    function sendSection() {
      var prog = el('div', { class: 'progress', role: 'status', 'aria-live': 'polite' });
      var modes = [['unsent', 'Tylko ci, którzy jeszcze nie dostali'], ['failed', 'Ponów nieudane'], ['selected', 'Zaznaczeni w tabeli (także ponownie)']];
      var radios = modes.map(function (m) {
        var inp = el('input', { type: 'radio', name: 'mode', value: m[0] });
        inp.checked = mailUi.mode === m[0];
        inp.addEventListener('change', function () { mailUi.mode = m[0]; upd(); });
        var span = el('span');
        return { inp: inp, span: span, label: m[1], mode: m[0], node: el('label', { class: 'check' }, [inp, span]) };
      });
      var go = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { confirmDialog(recipientsFor(mailUi.mode)); } });
      function upd() {
        radios.forEach(function (r) { r.span.textContent = r.label + ' (' + recipientsFor(r.mode).length + ')'; });
        var n = recipientsFor(mailUi.mode).length;
        go.textContent = 'Wyślij do ' + n + ' ' + plural(n, 'osoby', 'osób', 'osób');
        go.disabled = !mailUi.cfg.configured || n === 0 || (mailUi.status && mailUi.status.running);
      }
      upd();
      var wrap2 = el('div', { class: 'send' }, [el('h2', { text: '3. Wyślij' })].concat(radios.map(function (r) { return r.node; }), [go, prog]));
      showProgress(prog);
      mailUi.progNode = prog;
      return wrap2;
    }

    function confirmDialog(rcpt) {
      var n = rcpt.length;
      var word = el('input', { type: 'text', autocomplete: 'off', 'aria-label': 'Wpisz WYŚLIJ', placeholder: 'WYŚLIJ' });
      var err = el('p', { class: 'msg-err', role: 'alert', hidden: true });
      var ok = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Wyślij do ' + n + ' ' + plural(n, 'osoby', 'osób', 'osób') });
      var dlg = el('dialog', { 'aria-labelledby': 'cd-t' }, [
        el('h2', { id: 'cd-t', text: 'Wyślij do ' + n + ' ' + plural(n, 'osoby', 'osób', 'osób') }),
        el('p', { text: 'Wiadomości pójdą na prawdziwe adresy, jedna po drugiej, z przerwą ' + (mailUi.cfg.delayMs / 1000) + ' s. Tego nie da się cofnąć. Żeby potwierdzić, wpisz WYŚLIJ.' }),
        el('form', { method: 'dialog', onsubmit: function (e) {
          e.preventDefault();
          if (word.value.trim() !== 'WYŚLIJ') { err.textContent = 'Wpisz dokładnie WYŚLIJ wielkimi literami.'; err.hidden = false; return; }
          ok.disabled = true;
          api('POST', '/api/admin/mail/send', { confirm: word.value.trim(), mode: mailUi.mode, count: n, guestIds: rcpt.map(function (r) { return r.id; }) })
            .then(function () { dlg.close(); toast('Wysyłka ruszyła'); mailUi.status = { running: true, total: n, done: 0, failed: 0 }; draw(); poll(); })
            .catch(function (x) { ok.disabled = false; if (x.message !== 'auth') { err.textContent = x.message; err.hidden = false; } });
        } }, [field('Potwierdzenie', word), err, el('div', { class: 'row-end' }, [el('button', { class: 'btn', type: 'button', text: 'Anuluj', onclick: function () { dlg.close(); } }), ok])]),
      ]);
      dlg.addEventListener('close', function () { dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
      word.focus();
    }

    function showProgress(node) {
      var st = mailUi.status;
      if (!st || !st.total) { node.textContent = ''; return; }
      node.textContent = (st.running ? 'Wysyłanie: ' : 'Zakończono: ') + st.done + ' z ' + st.total + ', błędy: ' + st.failed + (st.running && st.current ? '. Teraz: ' + st.current : '') + '.' + (st.aborted ? ' Przerwano: ' + st.aborted : '');
    }
    function poll() {
      clearInterval(mailUi.timer);
      mailUi.timer = setInterval(function () {
        if (state.tab !== 'mail') { clearInterval(mailUi.timer); return; }
        api('GET', '/api/admin/mail/status').then(function (st) {
          mailUi.status = st;
          if (mailUi.progNode) showProgress(mailUi.progNode);
          if (!st.running) {
            clearInterval(mailUi.timer);
            toast('Wysyłka zakończona');
            api('GET', '/api/admin/state').then(function (d) { state.data = d; return api('GET', '/api/admin/mail/check'); }).then(function (c) { mailUi.check = c; if (state.tab === 'mail') draw(); });
          }
        }).catch(function () { clearInterval(mailUi.timer); });
      }, 2500);
    }
  }

  // ---------- wiadomość do wybranych ----------
  var custom = { pick: {}, q: '', subject: '', body: '', timer: null };

  function customTab(main) {
    clearInterval(custom.timer);
    var guests = state.data.guests;
    var cfg = null;
    var subj = el('input', { type: 'text', maxlength: 200, value: custom.subject, placeholder: 'Np. Przypomnienie o studniówce' });
    var body = el('textarea', { class: 'tall', maxlength: 5000, placeholder: 'Treść wiadomości' });
    body.value = custom.body;
    var q = el('input', { type: 'search', placeholder: 'Szukaj osoby lub adresu', value: custom.q, 'aria-label': 'Szukaj gościa' });
    var listBox = el('div', { class: 'pick-list' });
    var countP = el('p', { class: 'small' });
    var pre = el('pre', { class: 'preview-text' });
    var frame = el('iframe', { class: 'preview-frame', sandbox: 'allow-same-origin', title: 'Podgląd wiadomości HTML' });
    var frameTimer = null;
    function refreshFrame() {
      clearTimeout(frameTimer);
      frameTimer = setTimeout(function () {
        var first = picked()[0];
        api('POST', '/api/admin/mail/custom/draft', { subject: subj.value, body: body.value, guestId: first ? first.id : '' })
          .then(function () { frame.src = '/api/admin/mail/custom/preview.html?t=' + Date.now(); }).catch(function () {});
      }, 400);
    }
    var testTo = el('input', { type: 'email', placeholder: 'twoj@adres.pl', autocomplete: 'email' });
    var msg = el('p', { role: 'status', hidden: true });
    var prog = el('p', { class: 'progress', role: 'status', 'aria-live': 'polite' });
    var asInv = el('input', { type: 'checkbox' });
    asInv.checked = !!custom.asInvite;
    asInv.addEventListener('change', function () { custom.asInvite = asInv.checked; upd(); });
    var go = el('button', { class: 'btn btn-primary', type: 'button', onclick: function () { confirmCustom(); } });
    var testBtn = el('button', { class: 'btn', type: 'button', text: 'Wyślij test do mnie', onclick: function () {
      show('', '');
      api('POST', '/api/admin/mail/test', { custom: true, to: testTo.value, subject: subj.value, body: body.value })
        .then(function () { show('msg-ok', 'Test poszedł na ' + testTo.value + '. Link w teście jest fałszywy.'); })
        .catch(function (x) { if (x.message !== 'auth') show('msg-err', x.message); });
    } });

    function show(cls, text) { msg.className = cls; msg.textContent = text; msg.hidden = !text; }
    function picked() { return guests.filter(function (g) { return custom.pick[g.id]; }); }
    function drawList() {
      listBox.textContent = '';
      var t = custom.q.trim().toLowerCase();
      guests.filter(function (g) { return !t || (g.name + ' ' + (g.email || '')).toLowerCase().indexOf(t) >= 0; }).forEach(function (g) {
        var cb = el('input', { type: 'checkbox', disabled: !g.email });
        cb.checked = !!custom.pick[g.id];
        cb.addEventListener('change', function () { if (cb.checked) custom.pick[g.id] = true; else delete custom.pick[g.id]; upd(); });
        var extra = g.lastMessageAt ? 'ostatnia wiadomość ' + fmt(g.lastMessageAt) : g.lastMessageError ? 'błąd ostatniej wiadomości' : '';
        listBox.appendChild(el('label', { class: 'check pick' }, [cb, el('span', {}, [el('b', { text: g.name }), ' ', el('span', { class: 'small', text: (g.email || 'brak e-maila') + (extra ? ', ' + extra : '') })])]));
      });
    }
    function upd() {
      custom.subject = subj.value; custom.body = body.value;
      var ps = picked(), n = ps.length, g = ps[0] || { name: 'Anna Kowalska', link: 'https://rsvp.shroomdev.pl/AbCd1234' };
      countP.textContent = n ? 'Wybrano: ' + n + ' (' + ps.map(function (x) { return x.name; }).join(', ') + ')' : 'Nikogo nie wybrano.';
      pre.textContent = 'Do: ' + (ps[0] ? ps[0].email : '…') + '\nTemat: ' + renderLocal(subj.value, g, g.link) + '\n\n' + renderLocal(body.value, g, g.link).replace(/^> ?/gm, '    ');
      refreshFrame();
      var running = mailUi.status && mailUi.status.running;
      go.textContent = 'Wyślij do ' + n + ' ' + plural(n, 'osoby', 'osób', 'osób');
      var needLink = asInv.checked && body.value.indexOf('{link}') < 0;
      go.disabled = !cfg || !cfg.configured || !n || !subj.value.trim() || !body.value.trim() || running || needLink;
      if (needLink) show('msg-err', 'Zaproszenie musi zawierać {link}, żeby gość mógł potwierdzić obecność.');
      else if (msg.textContent.indexOf('{link}') >= 0) show('', '');
      testBtn.disabled = !cfg || !cfg.configured;
    }
    function progress() {
      var st = mailUi.status;
      prog.textContent = st && st.total && st.mode === 'custom' ? (st.running ? 'Wysyłanie: ' : 'Zakończono: ') + st.done + ' z ' + st.total + ', błędy: ' + st.failed + '.' : '';
    }
    function poll() {
      clearInterval(custom.timer);
      custom.timer = setInterval(function () {
        if (state.tab !== 'custom') { clearInterval(custom.timer); return; }
        api('GET', '/api/admin/mail/status').then(function (st) {
          mailUi.status = st; progress(); upd();
          if (!st.running) {
            clearInterval(custom.timer);
            toast(st.failed ? 'Wysłano, ale z błędami: ' + st.failed : 'Wiadomości wysłane');
            api('GET', '/api/admin/state').then(function (d) { state.data = d; guests = d.guests; drawList(); upd(); });
          }
        }).catch(function () { clearInterval(custom.timer); });
      }, 2000);
    }
    function confirmCustom() {
      var ps = picked(), n = ps.length;
      var word = el('input', { type: 'text', autocomplete: 'off', 'aria-label': 'Wpisz WYŚLIJ', placeholder: 'WYŚLIJ' });
      var err = el('p', { class: 'msg-err', role: 'alert', hidden: true });
      var ok = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Wyślij do ' + n + ' ' + plural(n, 'osoby', 'osób', 'osób') });
      var dlg = el('dialog', { 'aria-labelledby': 'cc-t' }, [
        el('h2', { id: 'cc-t', text: 'Wysłać wiadomość „' + subj.value.trim() + '”?' }),
        el('p', { text: 'Odbiorcy: ' + ps.map(function (g) { return g.name + ' <' + g.email + '>'; }).join(', ') + '.' }),
        el('p', { text: 'Tego nie da się cofnąć. Żeby potwierdzić, wpisz WYŚLIJ.' }),
        el('form', { method: 'dialog', onsubmit: function (e) {
          e.preventDefault();
          if (word.value.trim() !== 'WYŚLIJ') { err.textContent = 'Wpisz dokładnie WYŚLIJ wielkimi literami.'; err.hidden = false; return; }
          ok.disabled = true;
          api('POST', '/api/admin/mail/custom', { confirm: 'WYŚLIJ', asInvite: asInv.checked, subject: subj.value, body: body.value, count: n, guestIds: ps.map(function (g) { return g.id; }) })
            .then(function () { dlg.close(); toast('Wysyłka ruszyła'); mailUi.status = { running: true, mode: 'custom', total: n, done: 0, failed: 0 }; progress(); upd(); poll(); })
            .catch(function (x) { ok.disabled = false; if (x.message !== 'auth') { err.textContent = x.message; err.hidden = false; } });
        } }, [field('Potwierdzenie', word), err, el('div', { class: 'row-end' }, [el('button', { class: 'btn', type: 'button', text: 'Anuluj', onclick: function () { dlg.close(); } }), ok])]),
      ]);
      dlg.addEventListener('close', function () { dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
      word.focus();
    }

    q.addEventListener('input', function () { custom.q = q.value; drawList(); });
    subj.addEventListener('input', upd);
    body.addEventListener('input', upd);
    main.appendChild(el('div', { class: 'mail' }, [
      el('section', { class: 'step' }, [
        el('h2', { text: 'Do kogo' }),
        el('p', { class: 'small', text: 'Zaznacz jedną lub kilka osób.' }),
        q, listBox, countP,
        el('div', { class: 'acts-row' }, [el('button', { class: 'btn btn-sm', type: 'button', text: 'Odznacz wszystkich', onclick: function () { custom.pick = {}; drawList(); upd(); } })]),
      ]),
      el('section', { class: 'step' }, [
        el('h2', { text: 'Treść' }),
        el('p', { class: 'small', text: 'Możesz użyć {imie}, {nazwisko} i {link} (osobisty link gościa), ale nie musisz. Linie zaczynające się od „> ” to cytat.' }),
        field('Temat', subj), field('Treść', body),
        el('label', { class: 'check' }, [asInv, el('span', { text: 'To jest zaproszenie: oznacz te osoby jako zaproszone, żeby wysyłka zaproszeń do wszystkich je pominęła' })]),
        el('p', { class: 'small', text: 'Podgląd dla pierwszej wybranej osoby. Tak zobaczy to gość (HTML), a obok wersja tekstowa dla programów bez HTML.' }),
        el('div', { class: 'pv-grid' }, [el('div', {}, [frame]), el('div', {}, [pre])]),
      ]),
      el('section', { class: 'step' }, [
        el('h2', { text: 'Wyślij' }),
        el('div', { class: 'test' }, [field('Wyślij test do mnie na adres', testTo), testBtn]),
        msg, go, prog,
      ]),
    ]));
    drawList(); upd();
    Promise.all([api('GET', '/api/admin/mail/config'), api('GET', '/api/admin/mail/status')]).then(function (r) {
      cfg = r[0]; mailUi.cfg = r[0]; mailUi.status = r[1];
      if (!cfg.configured) show('msg-err', 'Wysyłka nie jest gotowa. Najpierw połącz konto Gmail w zakładce Wyślij zaproszenia.');
      progress(); upd();
      if (r[1].running) poll();
    }).catch(fail);
  }

  // ---------- settings ----------
  function settingsTab(main) {
    var s = state.data.settings;
    var f = {
      title: el('input', { type: 'text', value: s.title, maxlength: 120, required: true }),
      date: el('input', { type: 'date', value: s.date }),
      time: el('input', { type: 'time', value: s.time }),
      place: el('input', { type: 'text', value: s.place, maxlength: 160 }),
      address: el('input', { type: 'text', value: s.address, maxlength: 200 }),
      dressCode: el('input', { type: 'text', value: s.dressCode, maxlength: 120 }),
      deadline: el('input', { type: 'datetime-local', value: s.deadline }),
      note: el('textarea', { maxlength: 600 }),
    };
    f.note.value = s.note;
    var msg = el('p', { role: 'status', hidden: true });
    main.appendChild(el('form', { class: 'settings', onsubmit: function (e) {
      e.preventDefault(); msg.hidden = true;
      var body = {}; Object.keys(f).forEach(function (k) { body[k] = f[k].value; });
      api('PUT', '/api/admin/settings', body).then(function (r) {
        state.data.settings = r.settings; toast('Zapisano ustawienia');
        msg.className = 'msg-ok'; msg.textContent = 'Zapisano. Goście zobaczą zmiany od razu.'; msg.hidden = false;
        return load().then(function () { state.tab = 'settings'; render(); });
      }).catch(function (x) { if (x.message !== 'auth') { msg.className = 'msg-err'; msg.textContent = x.message; msg.hidden = false; } });
    } }, [
      el('h2', { text: 'Ustawienia wydarzenia' }),
      field('Nazwa wydarzenia', f.title),
      el('div', { class: 'two' }, [field('Data', f.date), field('Godzina', f.time)]),
      field('Miejsce', f.place), field('Adres', f.address), field('Dress code', f.dressCode),
      field('Termin odpowiedzi (czas polski; po nim goście nie zmienią odpowiedzi)', f.deadline),
      field('Krótka informacja dla gości', f.note),
      el('div', {}, [el('button', { class: 'btn btn-primary', type: 'submit', text: 'Zapisz' })]),
      msg,
    ]));
  }

  var gq = new URLSearchParams(location.search).get('google');
  if (gq) {
    state.tab = 'mail';
    history.replaceState(null, '', '/admin');
    var gm = { connected: 'Konto Gmail połączone', denied: 'Nie zgodziłeś się na dostęp. Konto nie zostało połączone.', state: 'Link połączenia wygasł. Spróbuj połączyć konto jeszcze raz.', error: 'Nie udało się połączyć konta. Spróbuj ponownie.', missing: 'Najpierw ustaw dane klienta Google na serwerze.' };
    setTimeout(function () { toast(gm[gq] || 'Gotowe'); }, 600);
  }
  api('GET', '/api/admin/me').then(load).catch(function (e) { if (e.message !== 'auth') showLogin(); });
})();

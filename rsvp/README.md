# RSVP na studniówkę

Osobiste linki dla gości, panel organizatora i wysyłka zaproszeń. Node + Express, dane w jednym pliku JSON, bez budowania front-endu.

```bash
npm install
ADMIN_PASSWORD=haslo npm start     # http://localhost:3001, panel: /admin
npm test
```

## Jak to działa

- Organizator w `/admin` dodaje gości (pojedynczo albo wklejoną listą) i ustawia wydarzenie.
- Każdy gość ma krótki link `https://rsvp.shroomdev.pl/<8 znaków>` (alias: `/r/<token>`). Otwarcie linku niczego nie potwierdza, odpowiedź to osobne kliknięcie (POST).
- Zakładka „Wyślij zaproszenia”: szablon, obowiązkowe sprawdzenie listy (składnia, duplikaty, DNS MX/A), test do siebie, wysyłka po wpisaniu `WYŚLIJ`.
- Gość może zmieniać odpowiedź do terminu. Eksport CSV (UTF-8 z BOM, separator `;`) w panelu.

## Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `ADMIN_PASSWORD` | wymagane, hasło do panelu |
| `PORT` | domyślnie 3001 |
| `DATA_DIR` | katalog z `db.json` (domyślnie `./data`) |
| `SESSION_SECRET` | sekret podpisu sesji; bez niego generowany i zapisany w `DATA_DIR/session-secret` |
| `PUBLIC_URL` | adres w linkach, np. `https://rsvp.shroomdev.pl`; bez niego z nagłówka Host |
| `EVENT_TZ` | strefa terminów, domyślnie `Europe/Warsaw` |
| `MAIL_TRANSPORT` | `gmail` (domyślnie), `smtp` albo `json` (próbny: nic nie wychodzi z serwera) |
| `PUBLIC_BASE_URL` | adres publiczny, np. `https://rsvp.shroomdev.pl`; z niego powstaje adres przekierowania OAuth |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | klient OAuth z Google Cloud (Gmail) |
| `MAIL_FROM_NAME` | opcjonalna nazwa nadawcy dla Gmaila |
| `MAIL_REPLY_TO` | opcjonalny adres odpowiedzi |
| `MAIL_DELAY_MS` | przerwa między wiadomościami, domyślnie 2000 |
| `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_SECURE` (true dla 465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | tylko dla `MAIL_TRANSPORT=smtp` |

### Gmail (Google OAuth)

1. W Google Cloud utwórz klienta OAuth typu „Aplikacja internetowa”, włącz Gmail API.
2. W „Authorized redirect URIs” wpisz `PUBLIC_BASE_URL/admin/google/callback` (panel pokazuje dokładny adres w zakładce „Wyślij zaproszenia”).
3. Ustaw `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `PUBLIC_BASE_URL`.
4. W panelu kliknij „Połącz konto Gmail”. Zgoda obejmuje tylko wysyłanie (`gmail.send`) i adres e-mail konta. Token odświeżania trafia do `DATA_DIR/google-token.json` (tryb 600) i nigdy do przeglądarki.

Konto szkolne może wymagać zgody administratora domeny na zewnętrzne aplikacje. Gdy zgoda wygaśnie (`invalid_grant`), panel poprosi o ponowne połączenie.

Dopóki konto nie jest połączone (albo SMTP skonfigurowany), wysyłka jest wyłączona, a panel pokazuje, czego brakuje.

## Import z pliku

```bash
DATA_DIR=./data node scripts/import.js lista.tsv [--plus-one]
```

Format: wiersze `email<TAB>Imię<TAB>Nazwisko` albo `Imię Nazwisko, email`; nagłówek jest pomijany, duplikaty adresów też. Plik z prawdziwą listą trzymaj poza repozytorium.

## Za reverse proxy

Aplikacja ufa `X-Forwarded-*` tylko z loopbacka (Cloudflare Tunnel). Za HTTPS ciasteczko sesji dostaje flagę `Secure`.

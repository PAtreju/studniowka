# Teleturniej Studniówkowy 🎉

Aplikacja do prowadzenia zabaw na studniówce. Prowadzący wyświetla ekran na projektorze, a publiczność dołącza telefonami: skanuje kod QR i wpisuje imię.

Dwa tryby gry:

- **⚡ Quiz na czas.** Pytania mają 2–4 odpowiedzi i limit czasu. Za poprawną odpowiedź dostaje się 500–1000 pkt, a szybsza odpowiedź daje więcej punktów. Po każdym pytaniu jest ranking, a na koniec podium.
- **🗳️ Plebiscyt klasowy.** Pytania typu „Kto zostanie milionerem?”. Każdy głosuje na jedną osobę z listy klasy (albo na własne opcje), a wygrywa większość głosów, z obsługą remisów. Na koniec pokazuje się lista zwycięzców wszystkich kategorii.

## Uruchomienie

Potrzebny jest Node.js w wersji 18 lub nowszej.

```bash
npm install
npm start
```

W konsoli pojawią się adresy:

- **Ekran prowadzącego**: `http://<IP>:3000/host?key=<klucz>`. Otwórz go na laptopie podłączonym do projektora, a klawiszem `F` włączysz pełny ekran.
- **Edytor pytań**: `http://<IP>:3000/editor?key=<klucz>`. Tu edytujesz quizy, plebiscyty i listę klasy.
- **Dołączanie**: `http://<IP>:3000/`. Ten adres jest zakodowany w QR na ekranie.

Klucz prowadzącego jest losowany przy każdym starcie. Żeby ustawić stały klucz:

```bash
HOST_KEY=tajne123 npm start
```

## Sterowanie (ekran prowadzącego)

| Klawisz / przycisk | Działanie |
|---|---|
| `Spacja` / `→` / `Enter` | dalej (start, zakończ czas, ranking, następne pytanie) |
| `F` | pełny ekran |
| klik w imię w lobby | usuń gracza (np. za głupi nick) |
| ⟲ Menu | przerwij grę i wróć do wyboru |

Pytanie kończy się samo, gdy upłynie czas albo gdy odpowiedzą wszyscy połączeni gracze.

## Sieć na sali – ważne!

Telefony muszą widzieć laptopa w sieci:

1. **Najprościej:** laptop i telefony w tej samej sieci Wi‑Fi. Szkolne i hotelowe Wi‑Fi często blokuje ruch między urządzeniami („client isolation”). Wtedy lepiej użyć własnego routera albo hotspotu z telefonu.
2. **Przez internet:** wystaw serwer tunelem (np. `cloudflared tunnel --url http://localhost:3000`) i podaj publiczny adres, żeby trafił do kodu QR:

   ```bash
   PUBLIC_URL=https://twoj-tunel.trycloudflare.com/ npm start
   ```

Aplikacja nie potrzebuje internetu: wszystko, łącznie z kodem QR, generuje się lokalnie.

## Treści

Pytania i lista klasy są w `data/content.json`. Najwygodniej edytować je w edytorze (`/editor`). Pytanie w plebiscycie bez własnych opcji oznacza głosowanie na osoby z listy klasy.

## Dla programistów

```bash
npm test        # testy silnika gry i serwera
npm run dev     # restart serwera po zmianach w kodzie
```

- `game.js`: silnik gry (fazy, punktacja, głosowanie), bez zależności od sieci
- `server.js`: Express + Socket.IO, API treści, kod QR
- `public/`: `host.*` (projektor), `play.*` (telefon), `editor.*` (edytor), `common.js`, `style.css`

Uwaga: gracz jest rozpoznawany po identyfikatorze zapisanym w telefonie. Po odświeżeniu strony wraca do gry z punktami. Ktoś uparty może jednak zagłosować kilka razy z trybu incognito, więc plebiscyt to zabawa, a nie wybory 😉

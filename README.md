# Serwer Gruz Client

Mały serwer Node.js, który łączy graczy Gruz Client:

- **znajomi**: zaproszenia, status (launcher, menu, singleplayer, serwer i jego adres),
- **wiadomości** między znajomymi, w launcherze i w grze (`.msg Nick tekst`, `.r tekst`),
- **party** do 8 osób, a lider jednym kliknięciem (albo `.warp` w grze) zabiera wszystkich na swój serwer,
- **profile**: kosmetyki, godziny w Gruz, od kiedy gra,
- **kosmetyki i emotki widoczne dla innych**: gracze Gruz na tym samym serwerze Minecraft widzą swoje peleryny, aureole, pety, ślady i emotki,
- **poziomy i odznaki** (XP za godziny gry, kille, znajomych i party) oraz **ranking znajomych**,
- **wiadomości głosowe** (do 20 s) i **naklejki**,
- **kody na ekskluzywne kosmetyki** (peleryny Zorza i Żar); bez kodu serwer nie pokazuje ich innym,
- **panel admina** pod `/admin`: statystyki, gracze, bany, kody, newsy.

Logowanie bez haseł: gracz potwierdza konto tym samym mechanizmem co przy wejściu na serwer Minecraft (Mojang `join` → `hasJoined`). Nikt nie podszyje się pod cudzy nick, a serwer nie dostaje tokenów konta.

## Uruchomienie

Potrzebny jest Node.js 20 lub nowszy.

```bash
npm install
npm start
```

Serwer startuje na porcie `8787` (zmienisz to przez `PORT`). Dane trzyma w folderze `data/` (zmienisz to przez `GRUZ_DATA`). Stan sprawdzisz pod adresem `/health`.

## Panel admina

Uruchom serwer z hasłem:

```bash
GRUZ_ADMIN_PASSWORD=twoje-tajne-haslo npm start
```

Na Windowsie: `set GRUZ_ADMIN_PASSWORD=twoje-tajne-haslo` i potem `npm start`.

Wejdź na `http://localhost:8787/admin` (albo `https://twoj-serwer/admin`). W panelu:

- **Przegląd**: liczba graczy, online, aktywni, godziny, najwięksi gracze.
- **Gracze**: wyszukiwanie, ban (gracz od razu jest rozłączany), oznaczenie jako „Ekipa” (odznaka).
- **Kody**: tworzysz kody na peleryny Zorza / Żar (pojedyncze albo hurtem, z limitem użyć). Gracz wpisuje kod w launcherze w Szafie.
- **Newsy**: to, co tu opublikujesz, launchery z Twoim serwerem pokażą na stronie Graj (`/news.json`).

Bez `GRUZ_ADMIN_PASSWORD` panel jest wyłączony.

W launcherze wpisz adres w **Ustawienia → Społeczność**, np. `wss://gruz.twojadomena.pl`. Do testów na swoim komputerze wystarczy `ws://localhost:8787`.

## Darmowy hosting: Render + Neon

1. **Baza (Neon)**: załóż konto na neon.tech, utwórz projekt i skopiuj *connection string* (zaczyna się od `postgresql://`).
2. **Serwer (Render)**: na render.com kliknij **New → Blueprint**, wybierz repozytorium z Gruz Client. Render sam znajdzie plik `render.yaml`.
3. Wpisz zmienne: `DATABASE_URL` (adres z Neon) i `GRUZ_ADMIN_PASSWORD` (hasło do panelu admina).
4. Po wdrożeniu dostaniesz adres `https://gruz-server-xxxx.onrender.com`. W launcherze adres serwera to ten sam z `wss://` zamiast `https://`.

Bez `DATABASE_URL` serwer trzyma dane w plikach (`data/`), co wystarcza na własnym komputerze albo VPS.

## Bot Discord (opcjonalny)

Bot działa razem z serwerem Gruz i daje komendy:
- `/gruz gracz nick`: profil gracza (poziom, godziny, kille, odznaki, czy gra teraz i gdzie),
- `/gruz online`: kto teraz gra na Gruz Client,
- `/gruz top`: ranking godzin,

oraz wiadomość na wybranym kanale z listą graczy online, odświeżaną co minutę.

1. https://discord.com/developers/applications → **New Application** → zakładka **Bot** → **Reset Token** → skopiuj token.
2. **OAuth2 → URL Generator**: zaznacz `bot` i `applications.commands`, w uprawnieniach `Send Messages`, `Embed Links`, `Read Message History`. Otwórz wygenerowany link i dodaj bota na swój serwer Discord.
3. W Discordzie włącz **Tryb dewelopera** (Ustawienia → Zaawansowane), potem prawy klik na serwer → **Kopiuj ID serwera** i prawy klik na kanał → **Kopiuj ID kanału**.
4. Na Renderze w **Environment** dodaj: `DISCORD_TOKEN`, `DISCORD_GUILD_ID` (ID serwera) i opcjonalnie `DISCORD_CHANNEL_ID` (kanał z listą graczy online).

Uwaga: darmowy Render usypia serwer po 15 minutach bez ruchu, a wtedy bot też znika. Żeby działał cały czas, ustaw darmowy monitoring (np. uptimerobot.com), który co 5 minut otwiera `https://twoj-serwer.onrender.com/health`.

## Hosting

Wystarczy dowolny hosting z Node.js i WebSocketami, np. Railway, Render, Fly.io albo VPS. Ważne, żeby był **HTTPS**, wtedy adres zaczyna się od `wss://`.

Przykład z Dockerem:

```bash
docker build -t gruz-server .
docker run -d -p 8787:8787 -v gruz-data:/app/data --name gruz gruz-server
```

Za reverse proxy (nginx, Caddy) przekieruj ruch WebSocket na port 8787.

## Skala

Dane są w plikach JSON, co wystarczy na setki, a nawet kilka tysięcy graczy. Przy większym ruchu warto podmienić magazyn w `server.js` (obiekt `db`) na bazę, np. PostgreSQL albo Redis.

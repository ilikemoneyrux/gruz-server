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
- **codzienne zadania** (3 dziennie za XP) i **serie dni** z kosmetykami za progi,
- **ranking tygodniowy** (XP z tygodnia, wyniki na Discordzie w poniedziałek, opcjonalna nagroda dla topki),
- **linki do party** (`/party?c=KOD` → `gruzclient://party/KOD`): każdy z linkiem dołącza jednym kliknięciem,
- **panel admina** pod `/admin`: statystyki, wykresy, gracze, bany, kody, newsy, zadania i ranking.

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
- **Wykresy**: nowi gracze dziennie z podziałem na źródło (sami / kod twórcy / zaproszenie znajomego), aktywni gracze i szczyt online,
  top kody twórców i zapraszający, wersje launchera, ilu nowych wróciło po co najmniej dniu.
- **Zadania i ranking**: XP za każde zadanie, nagrody za serię dni, nagroda tygodniowa dla topki, podgląd rankingu tygodnia.
- **Bot Discord → Role za poziom**: rola od wybranego poziomu Gruz (tylko najwyższa albo wszystkie zdobyte).

Bez `GRUZ_ADMIN_PASSWORD` panel jest wyłączony.

W launcherze wpisz adres w **Ustawienia → Społeczność**, np. `wss://gruz.twojadomena.pl`. Do testów na swoim komputerze wystarczy `ws://localhost:8787`.

## Własne peleryny (od 1.7.0)

Panel → **Peleryny**: wgrywasz PNG (proporcje 2:1, np. 1024x512, układ zwykłej peleryny Minecrafta), wpisujesz nazwę PL/EN
i wybierasz, kto ją dostaje: **za darmo**, **za kod / giveaway / nagrodę** (pojawia się wtedy w Kodach, giveawayach i nagrodach)
albo **od poziomu N** (gracz dostaje ją sam). Launcher (0.6.2+) i mod (0.5.2+) pobierają listę z `/capes.json`,
a obrazki z `/capes/<id>.png` – bez nowej wersji. Obrazki są w bazie (klucz `capes:<id>`) albo w `data/capes/`.

## Sklep (Tebex, od 1.7.0)

Panel → **Sklep**: wklejasz *Public Token* sklepu Tebex i przypisujesz pakiety do kosmetyk. Gracz klika „Kup” w Szafie,
serwer tworzy koszyk w Tebex Headless API (nick + uuid gracza), płatność jest na stronie Tebexa, a webhook
`POST /tebex/webhook` (podpis `X-Signature` sprawdzany sekretem) odblokowuje kosmetykę. Zwrot / chargeback / przegrany spór ją zabiera.

| Zmienna | Opis |
|---|---|
| `TEBEX_WEBHOOK_SECRET` | sekret webhooka z Tebexa (Developers → Webhooks) – **wymagany**, bez niego zakupy się nie odblokują |
| `TEBEX_PUBLIC_TOKEN` | opcjonalnie zamiast wpisywania tokenu w panelu |
| `PUBLIC_URL` | adres serwera do linków powrotnych (na Renderze nie trzeba – jest `RENDER_EXTERNAL_URL`) |
| `SHOP_SITE_URL` | strona sklepu, na którą Tebex wraca po zakupie ze strony (domyślnie `https://gruzclient.com/shop`) |
| `SHOP_ORIGINS` | dodatkowe adresy strony, które mogą tworzyć koszyki (po przecinku); gruzclient.com, www i podglądy `*.gruz-website.pages.dev` są dozwolone zawsze |

**Od 1.7.1 – sklep na stronie gruzclient.com/shop.** Gracz wpisuje nick (musi choć raz zalogować się w launcherze), serwer tworzy ten sam koszyk co dla launchera.
Publiczne API: `GET /shop/player?name=NICK` (nick, uuid, posiadane kosmetyki ze sklepu), `POST /shop/checkout` `{name, packageId}` → `{url}`
(tylko z dozwolonych adresów, limit 8 koszyków / 10 min z jednego IP), `GET /shop/cape/<id>.png` (podgląd wbudowanych peleryn).
Sklep typu *Universal (No Auth)* nie przyjmuje nicku w koszyku – serwer wysyła nick tylko, gdy sklep go obsługuje; gracza rozpoznaje po `uuid` w `custom`.

## Publiczne API strony (od 1.7.1, public.js)

Dla gruzclient.com/u/<nick> i gruzclient.com/top (CORS dla wszystkich, limit 90 zapytań/min z IP):
- `GET /api/profile?name=NICK` – nick, uuid, poziom i XP, godziny, od kiedy gra, online (bez adresu serwera), liczba znajomych, odznaki, pozycja w rankingu tygodnia, założone kosmetyki (tylko odblokowane) i adres skina,
- `GET /api/top?period=week|all&n=50` – ranking tygodnia (XP) albo wszech czasów (godziny),
- `GET /api/skin/<uuid>.png` – skin z Mojanga przez serwer (pamięć 1 h).

Zbanowani i gracze z ukrytym profilem (panel → Gracze → „Ukryj profil”) nie mają profilu ani miejsca w rankingu.

## Osiągnięcia, Gruz Pass i lista życzeń (od 1.8.0, progress.js)
- **Osiągnięcia** – 15 dodatkowych odznak z paskiem postępu i jednorazową nagrodą XP (launcher: Statystyki).
- **Gruz Pass** – co miesiąc 30 poziomów po 120 XP (XP zdobyte w danym miesiącu). Darmowe i Premium nagrody (kosmetyki) odblokowują się same.
  Premium daje kod na `pass:premium` (panel → Kody albo `/shop-codes cosmetic:pass:premium`) – działa do końca bieżącego miesiąca.
  Nagrody można zmienić w `promo.json` → `pass: { free: { "10": "name:fire" }, premium: { "30": "cape:galaxy" } }`.
- **Lista życzeń** – `wish.toggle`; widzą ją znajomi i profil na stronie.
- `GET /api/cosmetics` – katalog i sposoby zdobycia każdej rzeczy za darmo (wydarzenia, seria zadań, zaproszenia, ranking, Gruz Pass) – galeria gruzclient.com/cosmetics.
- `/api/profile` ma też `wishlist`, `achievements: { done, total }` i `pass: { tier, tiers, premium }`.

## Nagroda dnia, emotki we dwoje, bot (od 1.8.0)
- **Nagroda dnia** – `daily.claim`: dzień 1–7 w kółko (domyślnie 30/40/50/60/80/100/250 XP, zmiana: `promo.json` → `dailyXp: [7 liczb]`), pominięty dzień = od nowa; osiągnięcie „Stały bywalec” za 30 odbiorów.
- **Emotki we dwoje** (płatne) – kody `emote:highfive`, `emote:hug`, `emote:duodance` (panel → Kody albo `/shop-codes`). `duo.invite` (zaprasza właściciel emotki, drugi gracz musi być na tym samym serwerze Minecraft) → `duo.accept` → `duo.start` do wszystkich graczy Gruz na serwerze. Zaproszenie ważne 20 s.
- **Bot** – ogłoszenie nowej wersji bierze listę zmian z `https://gruzclient.com/changelog.json` (zmienna `GRUZ_CHANGELOG_URL`), gdy opis release na GitHubie jest pusty; `/gruz-admin config shop-channel` – posty o nowych pakietach i promocjach w Tebexie (co 15 min, przycisk BUY NOW; mapa pakietów w `codepkgs.js`); +200 XP za pierwsze `/gruz link`.

## Tryb zgodny z serwerami (od 1.9.0)

Panel → **Serwery MC**: adres serwera Minecraft (np. `hypixel.net`, pasuje też `mc.hypixel.net`) i lista modułów Gruz, które mod wyłącza na tym serwerze (np. `freelook, minimap`). Lista leży w `db.promo.serverRules`, gra dostaje ją po zalogowaniu (`{t:"serverRules", rules:[{match, block}]}`) i po każdej zmianie w panelu. Mod 0.5.4+ pamięta ją w configu i dopasowuje sam; zapisany wybór gracza nie znika – moduły wracają po wyjściu z serwera.

## Darmowy hosting: Render + Neon

1. **Baza (Neon)**: załóż konto na neon.tech, utwórz projekt i skopiuj *connection string* (zaczyna się od `postgresql://`).
2. **Serwer (Render)**: na render.com kliknij **New → Blueprint**, wybierz repozytorium z Gruz Client. Render sam znajdzie plik `render.yaml`.
3. Wpisz zmienne: `DATABASE_URL` (adres z Neon) i `GRUZ_ADMIN_PASSWORD` (hasło do panelu admina).
4. Po wdrożeniu dostaniesz adres `https://gruz-server-xxxx.onrender.com`. W launcherze adres serwera to ten sam z `wss://` zamiast `https://`.

Bez `DATABASE_URL` serwer trzyma dane w plikach (`data/`), co wystarcza na własnym komputerze albo VPS.

## Bot Discord (opcjonalny)

Bot działa razem z serwerem Gruz. Domyślnie mówi po angielsku (`/gruzadmin config language pl` przełącza na polski).

**Dla wszystkich (`/gruz`)**
- `player nick`: profil gracza (poziom, godziny, kille, odznaki, gdzie teraz gra),
- `online`: kto teraz gra, `top`: ranking godzin,
- `skin nick`: obrazek ze skinem z przodu i z tyłu, z peleryną Gruz,
- `server adres`: status serwera Minecraft (gracze, wersja, ping, MOTD, ikona, ilu graczy Gruz tam jest),
- `servers`: najczęściej grane serwery przez graczy Gruz,
- `top period:week`: ranking XP z tego tygodnia,
- `invite [message]`: wysyła na kanał link do Twojego party (przycisk „Join party” otwiera launcher; działa 30 minut, do 7 osób; trzeba mieć połączone konto i być online w Gruz).

**Dla adminów (`/gruzadmin`)**
- `giveaway start/end/reroll`: giveaway kosmetyki z przyciskiem „Join”; zwycięzca dostaje kod na priv (albo przyciskiem „Claim prize”),
- `code`: tworzy kod na kosmetykę i wysyła go wybranej osobie na priv,
- `tickets add-category / remove-category / staff-role / panel / list`: tickety z kategoriami; gracz wybiera kategorię, wpisuje nick MC i opis, bot tworzy prywatny kanał; po zamknięciu zapis rozmowy idzie na kanał logów i do gracza,
- `verify panel`: weryfikacja z obrazkiem (captcha) i opcjonalnym minimalnym wiekiem konta Discord,
- `config language / status-channel / updates-channel / logs-channel`: ustawienia; na kanale aktualizacji bot sam ogłasza nowe wydania z GitHuba (`ilikemoneyrux/gruz-client`, zmienna `GRUZ_RELEASES_REPO`),
- `levels set / remove / list / sync`: role na Discordzie za poziom Gruz (dla graczy z `/gruz link`),
- `config ranking-channel`: kanał, na który w każdy poniedziałek trafia ranking tygodnia; `ranking` wysyła obecny ranking od razu,
- `config crashes-channel`: raporty crashy z launchera; gracz może też kliknąć **„Poproś o pomoc”** – bot otwiera mu prywatny ticket z logiem (wymaga połączonego konta),
- `wipe`: usuwa wszystkie kanały poza kanałami bota.

**`/shop-codes cosmetic amount [note]`** (tylko admin): tworzy `amount` (1–1000) jednorazowych kodów na kosmetykę i wysyła Ci (widoczne tylko dla Ciebie) plik **.csv** w formacie kluczy licencyjnych Tebexa (`KOD,` w każdej linii, bez nagłówka) – do wgrania w pakiecie Tebexa. Kody mają w panelu notatkę z nazwą paczki (`shop-RRRR-MM-DD-xxxxxx`). Gracz wpisuje kod w launcherze (Szafa).

1. https://discord.com/developers/applications → **New Application** → zakładka **Bot** → **Reset Token** → skopiuj token.
2. **OAuth2 → URL Generator**: zaznacz `bot` i `applications.commands`, w uprawnieniach **Administrator** (najprościej) albo: `Manage Channels`, `Manage Roles`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `View Channels`. Otwórz link i dodaj bota na serwer.
3. W Discordzie włącz **Tryb dewelopera** (Ustawienia → Zaawansowane), potem prawy klik na serwer → **Kopiuj ID serwera**.
4. Na Renderze w **Environment** dodaj `DISCORD_TOKEN` i `DISCORD_GUILD_ID`. Kanały ustawisz potem komendami `/gruzadmin config …` (albo zmienną `DISCORD_CHANNEL_ID` dla listy graczy).
5. Rola bota musi być **nad** rolą, którą daje weryfikacja (Ustawienia serwera → Role, przeciągnij).

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

## Zmienne środowiskowe (nowe w 1.6.0)

- `GRUZ_PUBLIC_URL` – publiczny adres serwera do linków party (na Renderze nie trzeba, bierze `RENDER_EXTERNAL_URL`),
- `GRUZ_TZ` – strefa czasowa zadań dziennych i rankingu (domyślnie `Europe/Warsaw`).

Nowe pliki/klucze danych: `meta.json` (ranking tygodniowy) i `metrics.json` (aktywni dziennie) – w bazie tworzą się same.

# Bellas Bullet

Min digitala bullet journal, byggd på Ryder Carrolls metod: rapid logging med egen nyckel,
index, framtidslogg, månadsuppslag, veckor och dagar som sidor i en bok, migrering och
kvällsgenomgång. Dessutom rutiner för hemmet med roterande zoner, träning, vanor, mående,
tacksamhet, födelsedagar, samlingar (brain dump, inköp, önskelista, Lästa böcker) och sök i allt.

```
app/      statisk PWA, publiceras på GitHub Pages
worker/   Cloudflare Worker: synk mellan enheter och push-notiser 06:30 och 20:30
```

Data sparas i webbläsaren och synkas via Workern bakom en egen nyckel. Inget av det du skriver
hamnar i det här repot. Google Kalender läses bara, inget skrivs dit.

## Kom igång

1. **Publicera appen:** Settings → Pages → Source: *GitHub Actions*. Appen hamnar på
   `https://pulkakungen.github.io/bellas-bullet/`.

2. **Worker (synk och notiser)**
   ```sh
   cd worker
   npm install
   npx wrangler kv namespace create BULLET_KV   # klistra in id:t i wrangler.toml
   npm run vapid                                 # skapar ett nyckelpar för push
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT         # mailto:din@epost.se
   npx wrangler secret put JOURNAL_KEY           # hitta på en lång lösenfras
   npm run deploy
   ```
   Skriv samma lösenfras under Index → Inställningar → Synknyckel på mobil och dator, och
   tryck "Slå på på den här enheten" för notiser. Workerns adress är förifylld
   (`https://bellas-bullet.bella-sassibrass.workers.dev`) och kan ändras i inställningarna.
   På iPhone måste appen först läggas till på hemskärmen (Dela → Lägg till på hemskärmen).

3. **Google Kalender (bara läsning)**
   * console.cloud.google.com → nytt projekt → aktivera *Google Calendar API*.
   * OAuth consent screen: External, läge Testing, lägg till dig själv som testanvändare.
   * Credentials → OAuth client ID → Web application, *Authorized JavaScript origins*:
     `https://pulkakungen.github.io`.
   * Klistra in klient ID:t i Inställningar och tryck "Koppla och hämta".

## Sidorna

Index (s. 1) → Nyckel (s. 2) → Framtidslogg (s. 3) → varje månad börjar med sitt uppslag,
varje måndag med en veckosida, sedan en sida per dag. Pilarna och svep bläddrar i den ordningen.
Sök med fliken Sök, `/` eller Ctrl+K. Bara `?` listar allt du ska kolla upp, `!` alla deadlines.

## Snabbskrivning

| Först på raden | Betyder |
|---|---|
| `o` | event |
| `m` | möte |
| `.` `-` `~` | notering |
| `!` `*` `?` | deadline, viktigt, kolla upp |
| `14:00` | tid |

I kvällsgenomgången kan raden också börja med när: `imorgon`, `fre`, `12/10`, `2026-10-12`,
`v 42` eller `nov`. Utan datum hamnar den på imorgon.

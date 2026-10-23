# 🔥 Fireguard Rota

One-screen rota for a 5-person fireguard night shift, 19:00–07:00 in 30-minute blocks.

Live at **https://xxxenomus.github.io/fireguard-rota/**

## How it works

- **Jobs at the start**: tap 1–5. The night starts from a fixed timetable for that many jobs, so every
  phone shows the same thing. The five slots are Guy 1, Guy 2, …; the crew decides who takes which.
  Hours are at most 30 minutes apart. Whoever works more is 😬 Unlucky, whoever works less is 🍀 Lucky.

  | Jobs | Hours | How it rotates |
  |---|---|---|
  | 1 | 2h 30m each, Lucky 2h | 1h–1h30 stretches |
  | 2 | 5h each, 2 Lucky 4h 30m | 1h–1h30 stretches, one guy changes job once |
  | 3 | 7h each, 2 Unlucky 7h 30m | 1h30 on, 1h off, then the next job (1 → 2 → 3 → 1) |
  | 4 | 9h 30m each, Unlucky 10h | Guys 1–4 own a job; Unlucky is the relief who gives breaks |
  | 5 | 12h each | everyone on their own job all night |

- **Jobs change during the night**: ⛔ Ended, ▶ Back on, ➕ New job. The app re-generates the rest of
  the night on the phone. Past blocks stay as they happened, the night's hours stay as even as possible
  (leftovers go to Unlucky first, Lucky last), and it aims for 60–90 minute stretches, people staying
  on their own job, no 30-minute breaks, and as few changes to the old plan as possible.
- **Sync**: the 🔗 Invite link puts everyone on the same rota. Anyone can mark a job ended, and every
  phone updates within seconds. Phones keep their own copy, so the app works offline too.
- **📤 Send to the group** shares tonight's timetable as text.

## Sync details

Firebase Realtime Database (free Spark plan, europe-west1), project `fireguard-rota-caf41748`, at
`/crews/<crew code>`. Rules in `database.rules.json`: crews can't be listed, a crew can only be read or
written with its code, saves must have a higher `rev` than what's stored, and nothing can be deleted.
Anyone with the invite link can change the rota.

## Hosting

Static files on GitHub Pages: `index.html app.js style.css sw.js manifest.webmanifest icon.svg`.
Push to `main` and Pages redeploys in about a minute. Bump `CACHE` in `sw.js` when you ship changes.

# 🔥 Fireguard Rota

Shared night-shift fireguard rota with clean time blocks, a nightly jackpot roulette, and live
updates that sync between the whole crew's phones.

Live at **https://xxxenomus.github.io/fireguard-rota/**

## How it works

- **Crew**: one phone makes the crew, then sends the **invite link** (Crew tab → Send invite).
  Everyone who opens it shares the same rota, and **anyone can update it**. Changes show up on all
  phones within seconds. Each person taps their own name once so the app shows "You're on … until …".
- **New night**: pick who's in, shift times, the jobs at the start (0–5), block size and how often
  people swap. Then the **🎰 jackpot is spun** (every night, even with 0 or 1 jobs). Hours are split
  into clean blocks; anything that doesn't divide evenly goes to the jackpot winner first, then down a
  hidden order picked by the same spin.
  - ⚖️ *Fair*: the people with the fewest jackpots so far go on the wheel.
  - 🎲 *Pure luck*: random every time.
- **Tonight screen**: *Right now* (who's on each job, next change, your own next stretch), then each
  person's card (📍 main site, 🔨 work, ☕ break, time left, their stretches), then the jobs.
- **Own worksite**: everyone's first site of the night becomes their own. After a break they go back
  to it, and whoever was covering hands it back.
- **Jobs**: ➕ new job (now or later, optionally with an end time), ⛔ ended, ▶ back on, ✏️ edit times.
  The rest of the night is recalculated from the current block so totals stay fair. Earlier blocks
  stay as they happened.
- **History**: a night is saved into everyone's totals (nights, hours, 🎰) when the next night starts.

## Sync

The crew data lives in a Firebase Realtime Database (free Spark plan, region europe-west1), project
`fireguard-rota-caf41748`, at `/crews/<crew code>`. Phones stream changes live and keep their own
copy, so the app works offline and catches up once it's back online. No accounts are needed.

Security rules (`database.rules.json`):
- Nobody can list crews. You can only read or write a crew if you know its code (from the invite link).
- A save is only accepted if its `rev` is higher than what's stored, so an outdated phone can't
  overwrite newer data. If two people save at the same moment, the first one wins and the other is
  asked to redo their change.
- Crews can't be deleted from the app.

**Anyone with the invite link can see and change the rota**, so keep it in the crew chat.

Until 28 Oct 2026 the app also picks up anything an old copy of the app left on the previous relay
(ntfy.sh), so nothing is lost while phones update.

## Hosting

Plain static files on GitHub Pages: `index.html app.js style.css sw.js manifest.webmanifest icon.svg`.
Push to `main` and Pages redeploys in about a minute. Phones load the newest version whenever they're
online and fall back to the saved copy when offline. Bump `CACHE` in `sw.js` when you ship changes.

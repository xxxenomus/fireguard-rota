# 🔥 Fireguard Rota

Shared night-shift fireguard rota with clean time blocks, a nightly jackpot roulette, and live
updates that sync between the whole crew's phones.

Live at **https://xxxenomus.github.io/fireguard-rota/**

## How it works

- **Crew**: one phone makes the crew, then sends the **invite link** (Crew tab → Send invite).
  Everyone who opens it shares the same rota, and **anyone can update it**. Changes show up on all
  phones within seconds. Each person taps their own name once so the app shows "You're on … until …".
- **New night**: pick who's in, shift times, the jobs at the start (0–5), block size and how often
  people swap. Then the **🎰 jackpot is spun**. It's spun every night, even with 0 or 1 jobs, and gives
  tonight's *extra-time line*. Hours are split into clean blocks; anything that doesn't divide evenly
  goes to the front of the line, one block each.
  - ⚖️ *Fair*: the people with the fewest jackpots so far go on the wheel, and the rest of the line is
    ordered by fewest jackpots.
  - 🎲 *Pure luck*: random every time.
- **Everyone tonight**: for each person, where they're working, how much 🔨 work and ☕ break they
  have, and how much is still to do.
- **Own worksite**: everyone's first site of the night becomes their own (📍 on their card). After a
  break they go back to it, and whoever was covering hands it back. With more people than sites, a
  couple of people still have to float between sites.
- **Something changed?** These buttons work any time during the shift:
  - ➕ New job (now or later, optionally with an end time), ⛔ job ended, ▶ job back on, ✏️ edit times
  - ⏸ someone's away for a bit, 🏠 gone home, 👋 back / arrived
  
  The rest of the night is recalculated from the current block so totals stay fair (in proportion to
  how long each person is around), with leftovers going down the jackpot line. Earlier blocks stay as
  they happened. A log shows who changed what.
- **Swap**: tap two names in the same row of the timeline to swap them.
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

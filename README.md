# 🔥 Fireguard Rota

Night-shift fireguard rota with clean time blocks and a jackpot roulette for leftover hours.

## How it works

- **Crew tab**: add everyone once. Tap ✅/💤 to mark who's in tonight.
- **Tonight tab**: set shift times, number of jobs (0–5), block size (30 min / 1 h) and how often people swap.
  The app splits the watch hours into clean blocks. If they don't divide evenly, the leftover blocks
  go to the **🎰 jackpot roulette**, and each winner works one extra block.
  - ⚖️ *Fair mode*: only the people with the fewest jackpots so far go on the wheel.
  - 🎲 *Pure luck*: everyone is on the wheel every time.
- **Clean rotas**: the app tries a few hundred variations and keeps the tidiest one: few long stretches,
  no lone 30-minute pieces, proper breaks, and swaps on the hour where possible.
- **Swap people**: in the timeline, tap a name and then another name in the same row to swap them
  (two workers trade jobs, or someone on break takes over). Hours and totals update automatically.
- **Share with crew**: sends the rota as text plus a live link. Coworkers open the link, tap their name and
  see what they're on now, when their next stretch is, and who takes over at the next swap.
  The rota sits inside the link itself, so no server or accounts are needed.
  If you re-roll or make a new rota, share the new link.
- **History**: past rotas and everyone's totals (nights, hours, jackpots). Use backup/restore to move
  the data to another phone. Everything is stored on the planner's phone only.

## Hosting it (free)

These are plain static files with no build step. Upload the whole folder:

`index.html  app.js  style.css  sw.js  manifest.webmanifest  icon.svg`

**GitHub Pages**
1. Create a public repo on github.com, e.g. `fireguard-rota`.
2. Add file → Upload files → pick all files above → Commit.
3. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)` → Save.
4. After a minute it's live at `https://<your-username>.github.io/fireguard-rota/`.

**Netlify / Cloudflare Pages**: drag-and-drop the folder in their dashboard. You get a URL right away.

Once it's hosted, open it in Chrome and choose ⋮ → *Add to Home screen* / *Install app*. It then works offline like a normal app.

## Updating

Upload the changed files again. Phones pick up the new version on their next visit (the visit after that if they were offline).
To force it, bump `CACHE` in `sw.js` (e.g. `fireguard-v2`).

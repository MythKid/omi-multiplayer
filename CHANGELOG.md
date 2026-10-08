# Changelog

All notable changes to OMI are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org): a major version changes the client/server
protocol or stored data, a minor version adds features, a patch fixes bugs.

## 2.0.1 (2026-10-09)

### Fixes

- **Invite links and QR codes on the hosted site now work.** On omi.nodenull.org a
  table's invite pointed at the server's private internal address, so friends who
  scanned the code or opened the link could not reach the game. The invite now uses
  the address players actually came in on (for example
  `https://omi.nodenull.org/?table=2`), even when `PUBLIC_URL` is not set. Hosting at
  home still shares the Wi-Fi address.
- Online, the lobby now says "or share this link" instead of "open this on the same
  Wi-Fi", and the `.local` alternative link is only offered on a home network.
- On a home network the server now accepts its own `.local` name, so that alternative
  link actually opens the game instead of being refused.
- The lobby no longer sends the server's internal IP address and port to players.
- **New versions now load straight away, on every device.** Browsers (and the CDN in
  front of the site) could keep the old game for hours after an update. Every script
  and stylesheet now loads from a URL tied to its contents, the page itself is never
  cached, and a tab left open across an update reloads itself onto the new version.
  Nobody needs to clear their cache or use a private window.


### Small touches

- The version number now sits quietly in the top corner of the menu screens.
- Something new is hiding near the **?** button.

## 2.0.0 (2026-10-09)

The biggest update since launch: several games at once, table chat, two traditional
table rules, and a leaderboard that ranks players properly.

### New

- **Tables.** The server now runs several independent games side by side (4 by
  default). After entering your name you pick an open table from the tables screen;
  each table has its own lobby, deck, chat, and invite link (`/?table=N`). A table
  locks as soon as its game starts, so a match is never interrupted by newcomers.
- **Rematches.** When a match ends, everyone chooses **BACK TO TABLE** to play again
  with the same group, or **LEAVE TABLE**.
- **Table chat.** Tap 💬 to talk to your table. The panel never covers your hand,
  new messages pop up next to the speaker's seat, and there are quick phrases and a
  per-player mute. Chat is public table talk: there is no private team channel.
- **Rated leaderboard.** Players are ranked individually by an Elo-style rating that
  rises when you beat strong opponents and falls when you lose. Every 4-player match
  gives each player a grade (S, A, B, C, D, E) based on the result, the team's tokens,
  their tricks, the trump calls they made, and the calls their team broke.
- **Match history.** The leaderboard shows each player's recent matches (partner,
  opponents, score, grade, rating change) and a round-by-round story of any match:
  who called trump, which suit, how the tricks split, and what each round scored.
- **Your result on the results screen.** After a 4-player match you see your grade
  and your new rating straight away.

### Rule changes

- **Partner waits for trump.** While the trump caller chooses, their partner may not
  look at any cards. Their hand stays face-down under a red cross and "WAIT" until
  trump is called. The opponents can look at their own 4 cards as usual.
- **Redeal on a trump shortage.** If either team holds fewer than 2 trumps between its
  two players, the hand cannot be played. It is thrown in automatically, nothing is
  scored, and the same dealer reshuffles, the same player cuts, and the same player
  calls trump again.

### Leaderboard rules

- Only 4-player matches are ranked. Bots count as a fixed rating of 1000, so beating
  them pays less as you climb.
- Ending a match early by agreement only counts once the leader has 5 or more tokens.
- Leaving a match after two rounds counts as a loss for your team.
- Use your own name: generic names such as "Player" are not ranked, and a ranked name
  stays yours on the browser that first played with it.
- The previous best-score board is kept on the server but no longer shown; the rated
  board starts fresh.

### Fixes and improvements

- Leaving from the home button now frees your seat at once instead of making the
  table wait out the reconnect window.
- Idle games and lobbies are closed after a warning, so nobody can hold a table.
- Shuffle animations and disconnect notices no longer reach players at other tables.
- Refreshing on the results screen no longer ends the results for everyone else.
- Bots no longer take the same name as a human at the table.
- The app now always loads the latest version when online, and an outdated page
  reloads itself instead of failing to join.

### For server operators

- New settings: `MAX_SLOTS` (tables, default 4), `GAME_IDLE_MIN` (default 5),
  `LOBBY_IDLE_MIN` (default 15).
- `MAX_SOCKETS` now defaults to `MAX_SLOTS * 4 + 16`, and is never lower than
  `MAX_SLOTS * 4 + 4`: a smaller value (such as `MAX_SOCKETS=16` kept from 1.x) is
  raised to that minimum with a warning, so no setting change is needed to upgrade.
  The production startup line reports the cap in effect.
- New read-only API endpoints: `GET /api/tables`, `GET /api/matches`,
  `GET /api/matches/:id`, `GET /api/players/:name/matches`. `GET /api/leaderboard`
  now returns rated players, and `GET /api/health` reports the version.
- Storage gains `players`, `matches`, and `match_players` tables (SQLite) or
  `leaderboard-v2.json` (JSON). Existing data is left untouched.
- Breaking: the socket protocol changed (version 2). Clients from 1.x are asked to
  refresh.

## 1.0.0 (2026-07-12)

First production release.

- 2, 3, and 4 player Omi with bots filling empty seats.
- A persistent physical deck for 4 players: wash, shuffle, and cut by hand, with a
  realistic shuffle model.
- Team selection, Kapothi announcements, draw carry-over, and ending a match early by
  agreement.
- Leaderboard of winning teams' best scores.
- Reconnect within a grace window, installable PWA, QR code and invite link joining.
- Security hardening: host and origin checks, strict Content-Security-Policy, rate
  limiting, and input sanitization.
- Later in July: a home button that returns to nodenull.org with a confirmation.

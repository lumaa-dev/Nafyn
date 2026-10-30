<div align="center">
    <img src="./.github/NafynBg.png" width=200 />
    <hr />
</div>

**Nafyn** - self-hosted music service. Download music from Soulseek, then play it through the built-in web player, any Subsonic-compatible app, or a third-party app via the Nafyn API.

Multi-user: separate libraries and separate permissions per user. Users request songs (matched via MusicBrainz), Nafyn fetches them through Soulseek (via [slskd](https://github.com/slskd/slskd)), checks that the file really is the requested song, tags it, and adds it to the requester's library.

## Features

- **Search and request** albums and tracks from MusicBrainz, with a search engine that understands accents, aliases, non-Latin scripts and "artist + title" typed in one box.
- **Verified downloads**: every file is fingerprinted and checked against the requested recording before it enters a library.
- **Web player** with queue, history, lyrics, crossfade and an immersive Now Playing view; **playlists** (shared or private); manual import of audio files you already own (**Import music**, with your own metadata and cover).
- **Playlist imports** from other services (for example Apple Music, through the [iOS app](https://github.com/lumaa-dev/NafynApp)): a whole playlist is resolved and requested in the background.
- **Upcoming releases**: unreleased albums show a countdown and a "Notify me" toggle instead of a Request button.
- **[Nafyn Unity](#nafyn-unity)**: control playback on one device from another.
- **[Subsonic API](#subsonic-api)** for third-party players, and a documented REST API for everything else.
- **[Notifications](#notifications)**: webhooks (Discord, Slack, ntfy, Gotify, generic JSON) and Apple push notifications, Live Activities included, through the [Nafyn iOS app](https://github.com/lumaa-dev/NafynApp).
- **Listening insights** ("Your Music Year"): opt-in weekly, monthly and yearly summaries, a Replay Mix and a year-end story.
- **[Passkeys](#passkeys)**, revocable sessions, and the tooling to run the instance within the GDPR (see [Privacy & GDPR](#privacy--gdpr)).
- English and French interface.

## Contents

- [How it works](#how-it-works)
- [How to setup](#how-to-setup)
- [Settings](#settings)
- [Permissions](#permissions)
- [Search](#search)
- [Playlist imports](#playlist-imports)
- [Notifications](#notifications)
- [Passkeys](#passkeys)
- [Privacy & GDPR](#privacy--gdpr)
- [Nafyn Unity](#nafyn-unity)
- [Subsonic API](#subsonic-api)
- [Nafyn API](#nafyn-api)
- [Tech stack](#tech-stack)
- [Development](#development)
- [License](#license)

## How it works

1. User requests a track/album via MusicBrainz search (title, artist, etc).
2. Nafyn finds match on Soulseek network through [slskd](https://github.com/slskd/slskd) (self-hosted Soulseek client with HTTP API).
3. Download queued and tracked, with progress streamed to the browser over a WebSocket (`/ws/downloads`).
4. Finished file verified against the requested MusicBrainz recording — makes sure the download actually matches, not a mislabeled file. Verification never trusts anything stored or supplied: any existing AcoustID UUID, tag or reported length is ignored. Nafyn always regenerates a Chromaprint fingerprint (`fpcalc`) and measures the duration from the audio itself, queries the AcoustID API with exactly those two values, then filters and scores *all* the returned candidates — score threshold, duration tolerance against the measured length, ranking, and recording-ID comparison that understands merged MusicBrainz IDs and the same song entered twice — instead of looking for one ID. A file is refused when AcoustID confidently names a different song, or when it doesn't match and its measured length is off from MusicBrainz'. A refused or failed download is removed everywhere: the temp copy, the file in slskd's downloads folder, its transfer record and the folders that empties.
5. The file is retagged with the MusicBrainz metadata (remuxed with ffmpeg, no re-encode), stored once under `music/`, and added to that user's library. A track downloaded by one user is shared with the others as a single physical file: each user's access is their own library entry, and the file is only deleted when nobody references it any more.

The same song is never downloaded twice for the same person: a request for something already in the library (matched by MusicBrainz ID, ISRC, or title + artist + length, so merged or duplicated MusicBrainz entries and manual imports count) is refused, and an album that is only partly owned fetches just its missing tracks.

Auth: JWT-based (`jsonwebtoken`), passwords hashed with `bcrypt`, or [passkeys](#passkeys) instead of a password entirely. Each user has own library + permission set ([`server/entity/Permission.ts`](server/entity/Permission.ts)).

Storage: MySQL (`mysql2`). The database is created on first boot and every table is created automatically; later versions upgrade an existing database through ordered migrations in [`server/core/migrations.ts`](server/core/migrations.ts).

Note: slskd itself only exposes its own local downloads folder, not file bytes over HTTP — so `SOULSEEK_DOWNLOADS_PATH` must be a path Nafyn can read directly (local disk, or mounted SMB/NFS share if slskd runs elsewhere).

## How to setup

Requires:

- a **MySQL** (or MariaDB) server - the database itself is created on first boot
- a running [slskd](https://github.com/slskd/slskd) instance, with a dedicated Soulseek account
- an **AcoustID API key** (free, at [acoustid.org/my-applications](https://acoustid.org/my-applications))
- when not using Docker: Node 22+ or Bun, plus `fpcalc` (Chromaprint) on the `PATH`. `ffmpeg` is bundled (`ffmpeg-static`).

### Docker (recommended)

The image is built from the [`Dockerfile`](Dockerfile) and published to `ghcr.io/lumaa-dev/nafyn` (`latest` follows `main`, release tags follow `v*`). It already contains `fpcalc`.

```bash
docker run -d --name nafyn -p 3000:3000 \
  --env-file .env \
  -v ./music:/app/music \
  -v ./data:/app/.data \
  -v /path/to/slskd/downloads:/slskd-downloads:ro \
  ghcr.io/lumaa-dev/nafyn:latest
```

- `MYSQL_HOST` must be reachable from inside the container, and `SOULSEEK_DOWNLOADS_PATH` must be the path of slskd's downloads folder *as seen inside the container* (`/slskd-downloads` above).
- The container runs as the `node` user (uid 1000): the `music` and `data` folders must be writable by it. If a folder was created earlier by another user and Nafyn complains about it, delete that folder and let Nafyn recreate it.
- The image listens on port 3000 and has a health check on `/`.

### From source

1. Copy env template and fill in values:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
# bun (recommended, lockfile committed)
bun install

# npm
npm install
```

3. Check the configuration (prints what is missing or wrong, never a value):

```bash
bun run check:env
```

4. Run dev server (`http://localhost:3000`):

```bash
bun run dev
# or
npm run dev
```

5. Production build:

```bash
bun run build
node .output/server/index.mjs   # or: bun run preview, for a local preview
```

### First login

The first account to register becomes the administrator. After that, registration is either open or by invitation link, which an administrator switches under **Settings**. Nafyn also logs configuration problems at every boot (silence with `NAFYN_ENV_CHECK=false`).

## Settings

Configured via environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs/verifies auth JWTs. Long, random, private. |
| `SOULSEEK_HOST` | URL of slskd instance (default `http://127.0.0.1:5030`). |
| `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` | Login for slskd web UI — use dedicated/throwaway account, never personal Soulseek login. |
| `SOULSEEK_DOWNLOADS_PATH` | Local, readable path to slskd's downloads directory. |
| `ACOUSTID_API_KEY` | Verifies downloaded audio matches requested MusicBrainz recording. |
| `NAFYN_ACOUSTID_MIN_SCORE` | Minimum AcoustID score (0–1) for a candidate to count. Default `0.7`. |
| `NAFYN_ACOUSTID_DURATION_TOLERANCE` | Seconds a candidate's length may differ from the measured audio. Default `5`. |
| `NAFYN_ACOUSTID_MAX_ALIAS_LOOKUPS` | Merged-away MusicBrainz IDs looked up per file. Default `3`. |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | MySQL connection. The database is created on first boot if it doesn't exist. |
| `NAFYN_SLSKD_MAX_CONCURRENT_SEARCHES` / `NAFYN_SLSKD_SEARCH_INTERVAL_MS` | Soulseek search pacing: searches in flight (default `3`) and the minimum gap between starts (default `1000` ms). Bursts get throttled by the Soulseek server, and a throttled search looks exactly like "nobody shares this". |
| `NAFYN_MAX_ACTIVE_REQUESTS_PER_USER` | Requests one account may have waiting or in the pipeline at once. Default `500`; past it, requests answer `429`. |
| `LASTFM_API_KEY` | Artist bios/images on the artist page, search results, and Subsonic's `getArtistInfo2`. Optional — those surfaces just show less without it. |
| `DOMAINS_WHITELIST` | Comma-separated hostnames exempt from the login/register rate limits. Leave empty unless you specifically need it — every entry is an IP that can brute-force passwords freely. |
| `TRUST_PROXY` | Number of reverse proxies in front of Nafyn (nginx/Caddy/Traefik/Cloudflare). `0` (default) when Nafyn is directly exposed. Gates whether `X-Forwarded-For` is trusted at all — wrong in either direction breaks or defeats rate limiting, see [`server/utils/clientIp.ts`](server/utils/clientIp.ts). |
| `NAFYN_PUBLIC_OPENAPI` | Set `true` to publish the auto-generated [OpenAPI](#nafyn-api) spec + Scalar docs UI in production. Off by default — the spec enumerates every endpoint, parameter and auth requirement to anonymous visitors. |
| `NAFYN_PRIVACY_CONTROLLER` | Name of the person/organisation running the instance — the data controller. Shown on `/privacy`. Optional, but see [Privacy & GDPR](#privacy--gdpr): leaving it empty means the notice tells visitors nobody was named. |
| `NAFYN_PRIVACY_CONTACT` | How to reach that person about data requests (email, URL, anything actionable). Shown on `/privacy`. |
| `NAFYN_RETENTION_SCHEDULER` | Set `false` to stop this replica running the data-retention sweeps. At least one replica must run them — they are what stops data being kept longer than it is needed. |
| `NAFYN_IMPORT_WORKER` | Set `false` to stop this replica resuming interrupted [playlist imports](#playlist-imports) at boot. |
| `NAFYN_PUBLIC_URL` | Public URL of the instance (`https://music.example.com`). Used for "Open in Nafyn" links in webhooks and push notifications; without it they carry no link. |
| `NAFYN_WEBHOOK_ALLOW_PRIVATE` | Set `true` to let *instance* webhooks (never personal ones) target LAN addresses and plain `http`. See [Notifications](#notifications). |
| `APN_KEY_ID` / `APN_TEAM_ID` / `APN_BUNDLE_ID` / `APN_KEY_DIR` / `APN_PRODUCTION` | Apple Push Notifications for the [iOS app](https://github.com/lumaa-dev/NafynApp). Leave key and team ids empty to switch APNs off. See [Notifications](#notifications). |
| `NAFYN_NOTIFICATION_SCHEDULER` | Set `false` to stop this replica running the release-countdown scheduler. Safe on several replicas. |
| `NAFYN_ENV_CHECK` | Set `false` to silence the configuration report logged at boot. `bun run check:env` prints it on demand. |
| `NAFYN_SEARCH_*` | Tunables of the [search engine](#search) (relevance floor, best-result margin, candidate pool, ...), all optional. Listed in [`.env.example`](.env.example). |
| `NAFYN_UNITY_ENABLED` | Set `false` to turn [Nafyn Unity](#nafyn-unity) off outright. Needed when running more than one replica behind a load balancer — the live registry is in-process. |
| `NAFYN_UNITY_SCHEDULER` | Set `false` to stop this replica running the session-cleanup job. |
| `NAFYN_INSIGHTS_SCHEDULER` | Set `false` to stop this replica running the listening-insights rollup/snapshot/reel jobs. |

Some behaviour is tuned per install from the `app_settings` table instead of the environment, so it can change without a redeploy. Relevant to data retention: `insights.rawEventRetentionDays` (default `1095` — three years of raw play events; `0` keeps them forever) and `retention.recentlyPlayedDays` (default `180`). The listening-insights ranking weights live there too — see [`server/core/insightsConfig.ts`](server/core/insightsConfig.ts).

## Permissions

Each user has a set of permissions (a bitfield stored on the account, [`server/entity/Permission.ts`](server/entity/Permission.ts)), not a role:

| Permission | Allows |
|---|---|
| `REQUEST_ALBUMS` / `REQUEST_TRACKS` | Request albums / single tracks. New accounts get both. |
| `AUTOACCEPT_ALBUMS` / `AUTOACCEPT_TRACKS` | Requests start downloading at once instead of waiting for a manager. |
| `MANAGE_REQUESTS` | Accept or deny waiting requests, delete finished ones. |
| `MANAGE_ACCOUNTS` | Edit accounts strictly below this level (never another account manager, never an admin). |
| `MANAGE_MUSIC` | Edit any track's metadata, and see everyone's library and file sizes. |
| `MANAGE_WEBHOOKS` | Create and edit instance-wide webhooks. |
| `ADMIN` | Everything. Always the highest bit. |

Nobody edits their own account through the account-management screen, admin included: your own profile is under **Settings → Profile**. Nothing that is not released yet can be requested, by anyone.

## Search

`GET /api/v1/search` ([`server/utils/search/`](server/utils/search/)) normalizes the query (accents, full-width forms, `feat.` credits, edition words like *Deluxe* / *Remastered 2011*, track numbers, YouTube noise; CJK is never transliterated), recalls candidates from several MusicBrainz searches (phrase, loose terms, artist aliases), then filters and ranks them:

- **Only Official releases with a Digital Media edition** count. Bootlegs, promos, pseudo-releases, compilations / "best of" titles (multilingual) and Deluxe / Remaster editions are dropped — unless the query itself asks for a deluxe, a remaster or a "best of" title (a release-group typed *Compilation* is never returned).
- **Relevance** is a containment score: *Led Zeppelin* does not match *Led Zeppelin II*. Artists are compared with all their aliases and sort names, so `Utada Hikaru` finds `宇多田ヒカル`.
- **Ranking puts results with a front cover first**, then relevance, artist, title exactness, album > EP > single, earliest digital release date. A correct match without a cover therefore ranks below a covered, relevant one, on purpose.
- Every album/track result carries a `match` score breakdown and a `bestResult` flag. `bestResult` is true on **at most one** result: the top one, when it scores high enough, has a front cover (or an exact UPC/ISRC match) and clearly beats the runner-up. If the top results are too close, nobody is flagged and the consumer decides.
- Optional query parameters: `title`, `artist`, `upc` (UPC-A/EAN-13 of the album) and `isrc` (of the track). A valid code is strong evidence and boosts its result; an invalid one is ignored, and a code that finds nothing usable falls back to `title` + `artist`, which must accompany it. Tunables: see `NAFYN_SEARCH_*` in [`.env.example`](.env.example).

`bun run test` runs everything under `tests/` without network: the search unit and engine tests, a regression set replayed from recorded MusicBrainz responses, AcoustID candidate scoring, cover URLs, Soulseek ranking and the import track picking. `bun run search:record [case | fixture]` re-records the search fixtures from the live API.

## Playlist imports

A client can hand Nafyn a whole playlist from another service (Apple Music, through the [iOS app](https://github.com/lumaa-dev/NafynApp)) with `POST /api/v1/import`: up to 1000 tracks, each with title, artist and optionally ISRC, album and duration. It needs `REQUEST_TRACKS`, returns at once, and one import runs per user at a time.

Nafyn then works through the list in the background, item by item: the track is resolved to a MusicBrainz recording (by ISRC first, then by searching title + artist + length) and requested like any other. Each item ends as `requested`, `owned`, `already-requested`, `not-found`, `unreleased` or `error`; follow it with `GET /api/v1/import/{id}`. If MusicBrainz is unavailable the item is retried and finally reported as `error`, never as `not-found`. Finished imports are deleted after 30 days. (Importing a single audio file you already own is a different feature: the *Import music* page.)

## Notifications

Nafyn tells people when a request is created, accepted, denied, completed or failed, and when an album they follow comes out. Who is told: the requester and everyone with `MANAGE_REQUESTS`, minus whoever caused the event; a completed request pushes to the requester only, and an auto-accepted request sends managers no "new request".

**Webhooks**: Discord, Slack, ntfy, Gotify or generic JSON, detected from the URL. Anyone can add personal webhooks under **Settings → Notifications**; holders of `MANAGE_WEBHOOKS` add instance-wide ones under **Settings → Webhooks**. A webhook that fails 10 times in a row is disabled and shows its last error.

- Any account can make the server call a URL, so webhooks must be `https` on the default port and must resolve to a public address. The address is checked when saved and resolved again at send time, and the connection goes to that checked address. `NAFYN_WEBHOOK_ALLOW_PRIVATE=true` lifts the restriction for instance webhooks only (a local ntfy, Home Assistant, ...).
- The URL is a credential: listings show only the scheme and host, and the data export only the host.

**Apple push** (the [Nafyn iOS app](https://github.com/lumaa-dev/NafynApp)): alerts, a Live Activity following a download, a release countdown Live Activity, and Now Playing remote sessions. Create an APNs auth key (`.p8`) in your Apple Developer account, put it in `APN_KEY_DIR`, and set `APN_KEY_ID`, `APN_TEAM_ID` and `APN_BUNDLE_ID`; without them APNs stays off silently. `bun run apn:test <deviceToken>` sends a real test push and prints Apple's answer. Devices are listed (one entry per login) and removable under **Settings → Notifications**.

**Upcoming releases**: an album or track that is not released yet cannot be requested. It shows a countdown and a *Notify me* toggle; the notification is sent at local midnight of the release day in the subscriber's own timezone, with a countdown Live Activity three hours before.

## Passkeys

Sign in with a fingerprint, face unlock or security key instead of typing a password. Standard WebAuthn, via `@simplewebauthn`.

**For users**

- Add one under **Settings → Privacy & Security → Passkeys**, give it a label (`iPhone`, `work laptop`, ...), and the **Sign in with a passkey** button on the login page starts working.
- Several per account is fine — one per device is the point. Each row shows when it was added and last used, and can be removed on its own.
- Your password still works. A passkey is an additional way in, not a replacement, so losing a device doesn't lock you out.
- Passkeys need a **secure context**: HTTPS, or `localhost`. Over plain `http://` on a LAN IP, browsers hide the whole WebAuthn API and the buttons tell you so rather than failing silently.

**For developers**

- No env var to set: `rpID`/`origin` are derived per request from the hostname ([`server/utils/webauthn.ts`](server/utils/webauthn.ts)), because a self-hosted app can live on any domain. They must stay in lockstep — WebAuthn verification rejects a mismatch.
- Credentials are rows in `passkeys` ([`server/core/passkeys.ts`](server/core/passkeys.ts)); the stored public key is not a secret, unlike an API token.
- Challenges live in memory for a few minutes ([`server/utils/passkeyChallenges.ts`](server/utils/passkeyChallenges.ts)) — two maps, since registration is keyed by an already-authenticated user while login is anonymous until the credential comes back. Losing them on a restart is harmless.
- Routes: `POST /api/v1/auth/passkey/login-options` + `/login` (anonymous), and `/api/v1/user/passkeys/*` (register-options, register, list, delete). A passkey login mints the same session row and JWT as a password login.

## Privacy & GDPR

Nafyn is self-hosted, so **you** are the data controller — Nafyn's job is to make the GDPR obligations implementable, and this section is the part you have to act on.

**Set up**

1. Fill in `NAFYN_PRIVACY_CONTROLLER` and `NAFYN_PRIVACY_CONTACT`. The privacy notice at `/privacy` ships with Nafyn, but only you know who runs the instance and how to be reached — with both empty, the page tells visitors plainly that nobody was named, which is not a good look for a notice.
2. Read [`content/en/privacy.md`](content/en/privacy.md) and amend it if your deployment processes anything Nafyn itself doesn't: extra analytics, a reverse proxy that logs requests, off-site backups, an account-provisioning process that collects an email address. The notice is markdown, one file per locale (`content/<code>/privacy.md`, English + French shipped, English used as fallback), parsed at build time — **edits need a rebuild**. Don't put your name in it; that comes from the env vars above so it stays correct without one. The page reads it through `GET /api/v1/privacy` rather than querying `@nuxt/content` in the browser, because the app's CSP blocks the WASM SQLite that a client-side Content query needs.
3. Leave `NAFYN_RETENTION_SCHEDULER` alone unless you run replicas. The retention sweeps are what keeps data from piling up forever.

**What users can do themselves**, all under **Settings → Privacy & Security**:

- **Download everything held about them** (art. 15 + 20) — one JSON file: profile, settings, logins including the IP addresses they came from, library, playlists, requests, recently played, all listening data. Never any secret. `GET /api/v1/user/export`.
- **Delete their account** (art. 17) — permanent, password re-auth required, no administrator involved. `DELETE /api/v1/user/me`.
- **Turn listening history on/off** (art. 7(3)) — off by default, opt-in only, and turning it off stops recording immediately.
- **Delete their listening history** on its own, without deleting the account.
- Read the notice, and manage passkeys and sessions.

**Retention**: sessions (with their IP + user agent) go when they expire after 7 days, or a minute after being revoked. The recently-played shelf is pruned after 180 days. Raw play events are pruned after 3 years — the statistics built from them are not, so no screen changes at that boundary. All three are tunable, see [Settings](#settings).

**What leaves your server**: MusicBrainz, AcoustID (an audio fingerprint), Cover Art Archive, and your own slskd instance. These carry what is being searched for or downloaded — never a username, account id or listening history.

**One accepted weak point, worth knowing before you deploy**: Subsonic API tokens are stored in readable form, because the Subsonic protocol's token challenge requires a secret the server can re-hash. Account passwords are bcrypt-hashed as normal. This is disclosed in the notice rather than hidden, but it means your database dump contains working app passwords — treat it accordingly.

**For developers**: account deletion is `eraseAccount()` in [`server/core/accountErasure.ts`](server/core/accountErasure.ts) and nothing else may delete an account. No table has a foreign key to `users`, so nothing cascades and that function names every table by hand. **Adding a table with a `userId` column means adding it there** — no constraint will remind you. Export is [`server/core/accountExport.ts`](server/core/accountExport.ts).

## Nafyn Unity

Unity lets the devices on your account control each other's playback. One device plays the music (the **master**); any other device logged into the same account (a browser or a third-party app) becomes a **slave** and can change the track, queue, volume, seek position, and see the lyrics in sync.

**For users**

- It is on by default. Turn it off account-wide in **Settings → Privacy & Security**, or only for the current browser session with the "this device" option there.
- The first device to press play becomes the master. Any device can press **Play here** to take control.
- If the master drops off, other devices are told straight away and it has 30 seconds to reconnect before playback is released.
- **Settings → Privacy & Security** also lists every login on your account. Revoke any device there to sign it out immediately.

**For developers**

- Server: [`server/routes/ws/unity.ts`](server/routes/ws/unity.ts) (WebSocket at `/ws/unity?token=`) and [`server/utils/unityRegistry.ts`](server/utils/unityRegistry.ts). The server only relays commands and tracks who is master. It never runs playback itself.
- Client: [`app/composables/useUnity.ts`](app/composables/useUnity.ts) is a drop-in replacement for `usePlayer()`. On a slave, mutators send commands instead of changing local audio.
- Sessions: each login is a row in `sessions`, and its id is the JWT `jti` claim. Revocation is checked through a short in-memory cache in [`server/utils/sessionCache.ts`](server/utils/sessionCache.ts).
- Single instance only. The live registry is in memory, so run with `NAFYN_UNITY_ENABLED=false` if you run more than one replica behind a load balancer.
- `NAFYN_UNITY_SCHEDULER=false` stops the session-cleanup job on a given replica.

## Subsonic API

Nafyn exposes a [Subsonic API](http://www.subsonic.org/pages/api.jsp)-compatible endpoint at `/rest`, so any Subsonic client (Navidrome's own apps, [Sound Room](https://apps.apple.com/app/sound-room) on iOS, DSub, Substreamer, Arpeggi, ...) can browse and stream a Nafyn library directly — point the app at your bare Nafyn server URL (the client appends `/rest/...` itself). Each user's Subsonic connection details are shown in-app under **Settings → Subsonic**.

Covers authentication, ID3-mode browsing (artists/albums/songs), search, playlists, cover art, streaming, and scrobbling. Not covered: folder/index browsing (non-ID3 clients), podcasts, radio, jukebox, shares, bookmarks, chat, starring/ratings, transcoding.

Both password-based login (`p=`) and token-based login (`t=`/`s=`) work, but not with the same secret. Nafyn stores account passwords as one-way bcrypt hashes, which a token challenge can never be verified against — so `t=`/`s=` only works against an **API token** (Settings → Subsonic → API tokens), a separate revocable app password each user generates themselves. An API token also works as a plain `p=` password. The real account password only ever works with `p=`. See [`server/utils/subsonicAuth.ts`](server/utils/subsonicAuth.ts) and [`server/core/apiTokens.ts`](server/core/apiTokens.ts) for details, and [`server/routes/rest/[method].ts`](server/routes/rest/%5Bmethod%5D.ts) for the endpoint implementations.

## Nafyn API

Everything the web app does goes through a versioned JSON API under `/api/v1` (authenticated with the JWT returned by `POST /api/v1/auth/login`, sent as a bearer token). List endpoints are paginated with `?page=&limit=` and answer `{ items, page, limit, total, hasMore }`; download progress is streamed over the `/ws/downloads` WebSocket.

An OpenAPI 3.1 description is generated from the routes: `bun run openapi` writes it to `openapi/nafyn.openapi.json` (`--out <file>`, `--server <url>`). It is served live, with a Scalar docs UI, in development, and in production only when `NAFYN_PUBLIC_OPENAPI=true`.

Clients built on it: 
- [Safyn](https://github.com/lumaa-dev/Safyn) - Swift package, which wraps every endpoint, and the [Nafyn iOS app](https://github.com/lumaa-dev/NafynApp).

## Tech stack

- [Nuxt 4](https://nuxt.com/) (Vue 3) — frontend + server API routes (Nitro)
- `mysql2` — database
- `musicbrainz-api` — TypeScript types for MusicBrainz payloads only; all requests go through Nafyn's own rate-limited [`MusicBrainzRepository`](server/utils/musicbrainzRepository.ts)
- Last.fm API — artist bios/images (optional, `LASTFM_API_KEY`)
- `slskd` (external, self-hosted) — Soulseek network access
- `fpcalc` + AcoustID — audio fingerprint verification (fingerprint and duration always regenerated from the file, candidates scored — see [How it works](#how-it-works))
- `music-metadata` — tag reading/writing
- `fluent-ffmpeg` / `ffmpeg-static` — audio processing
- `jsonwebtoken` + `bcrypt` — auth
- `@parse/node-apn` — Apple push notifications
- `@simplewebauthn/server` + `/browser` — passkey registration and login
- `@nuxt/content` — the privacy notice, as markdown under `content/`
- `@nuxtjs/i18n` — English + French locales

## Development

```bash
bun run dev       # dev server, --host
bun run build     # production build
bun run generate  # static generation
bun run preview   # preview production build
bun run test      # tests, no network needed
bun run check:env # configuration report (exits 1 on errors)
bun run openapi   # write the OpenAPI spec to openapi/nafyn.openapi.json (--out <file>, --server <url>)
```

Tests (`bun run test`) need no network. Lint with `bunx eslint .` (the config is generated: run `nuxt prepare` first if it is missing). The server layout and the conventions behind it are written down in [`CLAUDE.md`](CLAUDE.md); page route prefixes in [`app/pages/README.md`](app/pages/README.md).

Built on Nuxt 4.4.8. See [Nuxt docs](https://nuxt.com/docs/getting-started/introduction) for framework details.

## License

Nafyn is released under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source to the people using it.

<div align="center">
    <img src="./.github/NafynBg.png" width=200 />
    <hr />
</div>

Self-hosted web service. Download music from Soulseek, play through web player, a Subsonic-compatible app, or third-party app via Nafyn API.

Multi-user: separate libraries, separate permissions per user. Users request songs (matched via MusicBrainz), Nafyn fetches through Soulseek (via slskd).

## Contents

- [How it works](#how-it-works)
- [How to setup](#how-to-setup)
- [Settings](#settings)
- [Song metadata providers](#song-metadata-providers)
- [Passkeys](#passkeys)
- [Privacy & GDPR](#privacy--gdpr)
- [Nafyn Unity](#nafyn-unity)
- [Subsonic API](#subsonic-api)
- [Tech stack](#tech-stack)
- [Development](#development)

## How it works

1. User requests a track/album via MusicBrainz search (title, artist, etc).
2. Nafyn finds match on Soulseek network through [slskd](https://github.com/slskd/slskd) (self-hosted Soulseek client with HTTP API).
3. Download queued and tracked, with progress streamed to the browser over a WebSocket (`/ws/downloads`).
4. Finished file verified against requested MusicBrainz recording via audio fingerprint (`fpcalc` + AcoustID API) — makes sure download actually matches, not a mislabeled file.
5. Track added to that user's library, tagged with metadata (`music-metadata`), transcodable/playable through built-in web player or Nafyn API endpoints.

Auth: JWT-based (`jsonwebtoken`), passwords hashed with `bcrypt`, or [passkeys](#passkeys) instead of a password entirely. Each user has own library + permission set ([`server/entity/Permission.ts`](server/entity/Permission.ts)).

Storage: MySQL (`mysql2`).

Note: slskd itself only exposes its own local downloads folder, not file bytes over HTTP — so `SOULSEEK_DOWNLOADS_PATH` must be a path Nafyn can read directly (local disk, or mounted SMB/NFS share if slskd runs elsewhere).

## How to setup

Requires: Node/Bun, running [slskd](https://github.com/slskd/slskd) instance, AcoustID API key (free, at [acoustid.org/my-applications](https://acoustid.org/my-applications)).

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

3. Run dev server (`http://localhost:3000`):

```bash
bun run dev
# or
npm run dev
```

4. Production build:

```bash
bun run build
bun run preview   # local preview of production build
```

Docker: a `Dockerfile` is in the repo and Docker is the intended primary distribution method, but it isn't fully wired up yet.

## Settings

Configured via environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs/verifies auth JWTs. Long, random, private. |
| `SOULSEEK_HOST` | URL of slskd instance (default `http://127.0.0.1:5030`). |
| `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` | Login for slskd web UI — use dedicated/throwaway account, never personal Soulseek login. |
| `SOULSEEK_DOWNLOADS_PATH` | Local, readable path to slskd's downloads directory. |
| `ACOUSTID_API_KEY` | Verifies downloaded audio matches requested MusicBrainz recording. |
| `LASTFM_API_KEY` | Artist bios/images on the artist page, search results, and Subsonic's `getArtistInfo2`. Optional — those surfaces just show less without it. |
| `DISCOGS_TOKEN` | Discogs personal access token (free, [discogs.com/settings/developers](https://www.discogs.com/settings/developers)). Optional — Discogs is skipped when empty. See [Song metadata providers](#song-metadata-providers). |
| `THEAUDIODB_API_KEY` | TheAudioDB API key — `123` is the free public test key. Optional — skipped when empty. |
| `GENIUS_ACCESS_TOKEN` | Genius client access token (free, [genius.com/api-clients](https://genius.com/api-clients)). Optional — skipped when empty. |
| `DOMAINS_WHITELIST` | Comma-separated hostnames exempt from the login/register rate limits. Leave empty unless you specifically need it — every entry is an IP that can brute-force passwords freely. |
| `TRUST_PROXY` | Number of reverse proxies in front of Nafyn (nginx/Caddy/Traefik/Cloudflare). `0` (default) when Nafyn is directly exposed. Gates whether `X-Forwarded-For` is trusted at all — wrong in either direction breaks or defeats rate limiting, see [`server/utils/clientIp.ts`](server/utils/clientIp.ts). |
| `NAFYN_PUBLIC_OPENAPI` | Set `true` to publish the auto-generated OpenAPI spec + Scalar docs UI in production. Off by default — the spec enumerates every endpoint, parameter and auth requirement to anonymous visitors. |
| `NAFYN_PRIVACY_CONTROLLER` | Name of the person/organisation running the instance — the data controller. Shown on `/privacy`. Optional, but see [Privacy & GDPR](#privacy--gdpr): leaving it empty means the notice tells visitors nobody was named. |
| `NAFYN_PRIVACY_CONTACT` | How to reach that person about data requests (email, URL, anything actionable). Shown on `/privacy`. |
| `NAFYN_RETENTION_SCHEDULER` | Set `false` to stop this replica running the data-retention sweeps. At least one replica must run them — they are what stops data being kept longer than it is needed. |
| `NAFYN_UNITY_ENABLED` | Set `false` to turn [Nafyn Unity](#nafyn-unity) off outright. Needed when running more than one replica behind a load balancer — the live registry is in-process. |
| `NAFYN_UNITY_SCHEDULER` | Set `false` to stop this replica running the session-cleanup job. |
| `NAFYN_INSIGHTS_SCHEDULER` | Set `false` to stop this replica running the listening-insights rollup/snapshot/reel jobs. |

Some behaviour is tuned per install from the `app_settings` table instead of the environment, so it can change without a redeploy. Relevant to data retention: `insights.rawEventRetentionDays` (default `1095` — three years of raw play events; `0` keeps them forever) and `retention.recentlyPlayedDays` (default `180`). The listening-insights ranking weights live there too — see [`server/core/insightsConfig.ts`](server/core/insightsConfig.ts).

## Song metadata providers

Besides MusicBrainz (which stays the source of truth for requests), the search bar also queries free music metadata services for richer song data — artwork, 30-second previews, genres, ISRCs, BPM/audio features, credits, descriptions:

| Provider | Key | Text search | ISRC | Platform ID / link | Notable data |
|---|---|---|---|---|---|
| Deezer | none | ✓ | ✓ | `deezer:track:<id>`, `deezer:album:<id>`, deezer.com links | ISRC, previews, BPM, gain, genres |
| iTunes | none | ✓ | | `itunes:<id>`, music.apple.com / itunes.apple.com links | artwork up to 1000px, previews, genre |
| ReccoBeats | none | | | `spotify:track:<id>`, `reccobeats:<id>`, open.spotify.com links | ISRC, audio features (tempo, energy, valence...) |
| TheAudioDB | `THEAUDIODB_API_KEY` | `Artist - Title` only | | `theaudiodb:track:<id>` | MusicBrainz IDs, mood, theme, description |
| Discogs | `DISCOGS_TOKEN` | ✓ | | `discogs:release:<id>`, `discogs:master:<id>`, discogs.com links | genres/styles, labels, tracklist, credits (release-level) |
| Genius | `GENIUS_ACCESS_TOKEN` | ✓ | | `genius:song:<id>`, genius.com/songs/<id> links | producers/writers, description, media links (never lyrics) |

What can go in the search bar:

- **Free text** — MusicBrainz results as before, plus a "From other services" row. Write it as `Artist - Title` to let providers that need separate fields (TheAudioDB) join in.
- **An ISRC** (`GBAYE0601498`, dashes allowed) — or **a platform ID / pasted link** from the table above. These skip the MusicBrainz text search: the record is fetched from its provider, matched against MusicBrainz (by ISRC, else a strict title + artist search), and enriched with the other providers' best match. The first card then opens the MusicBrainz track in Nafyn, ready to request.

Leave a key empty and that provider is skipped silently — the keyless ones (Deezer, iTunes, ReccoBeats) are always on. Each provider is called with a Nafyn `User-Agent`, results are cached in memory for 10 minutes, and a provider that answers with a rate limit (`429`, iTunes' `403`, Deezer's quota error, or a `Retry-After` / `X-RateLimit-Remaining: 0` / `X-Discogs-Ratelimit-Remaining: 0` header) is backed off until its window resets. Also available directly over the API: `GET /api/v1/metadata/search?q=` and `GET /api/v1/metadata/providers`.

To add a provider, write one file under [`server/utils/metadata/providers/`](server/utils/metadata/providers/) implementing `MetadataProvider` ([`types.ts`](server/utils/metadata/types.ts)) and add it to `PROVIDERS` in [`server/utils/metadata/index.ts`](server/utils/metadata/index.ts).

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

**What leaves your server**: MusicBrainz, AcoustID (an audio fingerprint), the configured metadata providers, Cover Art Archive, and your own slskd instance. These carry what is being searched for or downloaded — never a username, account id or listening history.

**One accepted weak point, worth knowing before you deploy**: Subsonic API tokens are stored in readable form, because the Subsonic protocol's token challenge requires a secret the server can re-hash. Account passwords are bcrypt-hashed as normal. This is disclosed in the notice rather than hidden, but it means your database dump contains working app passwords — treat it accordingly.

**For developers**: account deletion is `eraseAccount()` in [`server/core/accountErasure.ts`](server/core/accountErasure.ts) and nothing else may delete an account. No table has a foreign key to `users`, so nothing cascades and that function names every table by hand. **Adding a table with a `userId` column means adding it there** — no constraint will remind you. Export is [`server/core/accountExport.ts`](server/core/accountExport.ts).

## Nafyn Unity

Unity lets the devices on your account control each other's playback, like Spotify Connect. One device plays the music (the **master**); any other device logged into the same account (a browser or a third-party app) becomes a **slave** and can change the track, queue, volume, seek position, and see the lyrics in sync.

**For users**

- It is on by default. Turn it off account-wide in **Settings → Sessions**, or only for the current browser session with the "this device" option there.
- The first device to press play becomes the master. Any device can press **Play here** to take control.
- If the master drops off, other devices are told straight away and it has 30 seconds to reconnect before playback is released.
- **Settings → Sessions** also lists every login on your account. Revoke any device there to sign it out immediately.

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

## Tech stack

- [Nuxt 4](https://nuxt.com/) (Vue 3) — frontend + server API routes (Nitro)
- `mysql2` — database
- `musicbrainz-api` — track/album metadata search
- Last.fm API — artist bios/images (optional, `LASTFM_API_KEY`)
- Deezer, iTunes, ReccoBeats, TheAudioDB, Discogs, Genius — song metadata (plain HTTP, keyed ones optional)
- `slskd` (external, self-hosted) — Soulseek network access
- `fpcalc` + AcoustID — audio fingerprint verification
- `music-metadata` — tag reading/writing
- `fluent-ffmpeg` / `ffmpeg-static` — audio processing
- `jsonwebtoken` + `bcrypt` — auth
- `@simplewebauthn/server` + `/browser` — passkey registration and login
- `@nuxt/content` — the privacy notice, as markdown under `content/`
- `@nuxtjs/i18n` — English + French locales

## Development

```bash
bun run dev       # dev server, --host
bun run build     # production build
bun run generate  # static generation
bun run preview   # preview production build
```

Built on Nuxt 4.4.8. See [Nuxt docs](https://nuxt.com/docs/getting-started/introduction) for framework details.

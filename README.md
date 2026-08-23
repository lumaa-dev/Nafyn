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
- [Subsonic API](#subsonic-api)
- [Tech stack](#tech-stack)
- [Development](#development)

## How it works

1. User requests a track/album via MusicBrainz search (title, artist, etc).
2. Nafyn finds match on Soulseek network through [slskd](https://github.com/slskd/slskd) (self-hosted Soulseek client with HTTP API).
3. Download queued and tracked (`bullmq` job queue).
4. Finished file verified against requested MusicBrainz recording via audio fingerprint (`fpcalc` + AcoustID API) — makes sure download actually matches, not a mislabeled file.
5. Track added to that user's library, tagged with metadata (`music-metadata`), transcodable/playable through built-in web player or Nafyn API endpoints.

Auth: JWT-based (`jsonwebtoken`), passwords hashed with `bcrypt`. Each user has own library + permission set ([`server/entity/Permission.ts`](server/entity/Permission.ts)).

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

Docker deployment: planned as primary distribution method, not yet included in this repo.

## Settings

Configured via environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs/verifies auth JWTs. Long, random, private. |
| `SOULSEEK_HOST` | URL of slskd instance (default `http://127.0.0.1:5030`). |
| `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` | Login for slskd web UI — use dedicated/throwaway account, never personal Soulseek login. |
| `SOULSEEK_DOWNLOADS_PATH` | Local, readable path to slskd's downloads directory. |
| `ACOUSTID_API_KEY` | Verifies downloaded audio matches requested MusicBrainz recording. |
| `DOMAIN_WHITELIST` | Allow some domains to never be rate limited |
| `LASTFM_API_KEY` | Artist bios/images on the artist page, search results, and Subsonic's `getArtistInfo2`. Optional — those surfaces just show less without it. |

<!-- More settings (in-app, user-facing) to be documented here as they land. -->

## Subsonic API

Nafyn exposes a [Subsonic API](http://www.subsonic.org/pages/api.jsp)-compatible endpoint at `/rest`, so any Subsonic client (Navidrome's own apps, [Sound Room](https://apps.apple.com/app/sound-room) on iOS, DSub, Substreamer, Arpeggi, ...) can browse and stream a Nafyn library directly — point the app at your bare Nafyn server URL (the client appends `/rest/...` itself). Each user's Subsonic connection details are shown in-app under **Settings → Subsonic**.

Covers authentication, ID3-mode browsing (artists/albums/songs), search, playlists, cover art, streaming, and scrobbling. Not covered: folder/index browsing (non-ID3 clients), podcasts, radio, jukebox, shares, bookmarks, chat, starring/ratings, transcoding.

Both password-based login (`p=`) and token-based login (`t=`/`s=`) work, but not with the same secret. Nafyn stores account passwords as one-way bcrypt hashes, which a token challenge can never be verified against — so `t=`/`s=` only works against an **API token** (Settings → Subsonic → API tokens), a separate revocable app password each user generates themselves. An API token also works as a plain `p=` password. The real account password only ever works with `p=`. See [`server/utils/subsonicAuth.ts`](server/utils/subsonicAuth.ts) and [`server/core/apiTokens.ts`](server/core/apiTokens.ts) for details, and [`server/routes/rest/[method].ts`](server/routes/rest/%5Bmethod%5D.ts) for the endpoint implementations.

## Tech stack

- [Nuxt 4](https://nuxt.com/) (Vue 3) — frontend + server API routes (Nitro)
- `mysql2` — database
- `bullmq` — download job queue
- `musicbrainz-api` — track/album metadata search
- Last.fm API — artist bios/images (optional, `LASTFM_API_KEY`)
- `slskd` (external, self-hosted) — Soulseek network access
- `fpcalc` + AcoustID — audio fingerprint verification
- `music-metadata` — tag reading/writing
- `fluent-ffmpeg` / `ffmpeg-static` — audio processing
- `jsonwebtoken` + `bcrypt` — auth
- `@nuxtjs/i18n` — English + French locales

## Development

```bash
bun run dev       # dev server, --host
bun run build     # production build
bun run generate  # static generation
bun run preview   # preview production build
```

Built on Nuxt 4.4.8. See [Nuxt docs](https://nuxt.com/docs/getting-started/introduction) for framework details.

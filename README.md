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
| `LASTFM_API_KEY` | Artist bios/images on the artist page, search results, and Subsonic's `getArtistInfo2`. Optional — those surfaces just show less without it. |
| `DISCOGS_TOKEN` | Discogs personal access token (free, [discogs.com/settings/developers](https://www.discogs.com/settings/developers)). Optional — Discogs is skipped when empty. See [Song metadata providers](#song-metadata-providers). |
| `THEAUDIODB_API_KEY` | TheAudioDB API key — `123` is the free public test key. Optional — skipped when empty. |
| `GENIUS_ACCESS_TOKEN` | Genius client access token (free, [genius.com/api-clients](https://genius.com/api-clients)). Optional — skipped when empty. |
| `DOMAINS_WHITELIST` | Comma-separated hostnames exempt from the login/register rate limits. Leave empty unless you specifically need it — every entry is an IP that can brute-force passwords freely. |
| `TRUST_PROXY` | Number of reverse proxies in front of Nafyn (nginx/Caddy/Traefik/Cloudflare). `0` (default) when Nafyn is directly exposed. Gates whether `X-Forwarded-For` is trusted at all — wrong in either direction breaks or defeats rate limiting, see [`server/utils/clientIp.ts`](server/utils/clientIp.ts). |
| `NAFYN_PUBLIC_OPENAPI` | Set `true` to publish the auto-generated OpenAPI spec + Scalar docs UI in production. Off by default — the spec enumerates every endpoint, parameter and auth requirement to anonymous visitors. |

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
- Deezer, iTunes, ReccoBeats, TheAudioDB, Discogs, Genius — song metadata (plain HTTP, keyed ones optional)
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

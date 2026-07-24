<div align="center">
    <img src="./.github/DiscyBg.png" width=200 />
    <hr />
</div>

Self-hosted web service. Download music from Soulseek, play through web player or third-party app via Discy API.

Multi-user: separate libraries, separate permissions per user. Users request songs (matched via MusicBrainz), Discy fetches through Soulseek (via slskd).

## Contents

- [How it works](#how-it-works)
- [How to setup](#how-to-setup)
- [Settings](#settings)
- [Tech stack](#tech-stack)
- [Development](#development)

## How it works

1. User requests a track/album via MusicBrainz search (title, artist, etc).
2. Discy finds match on Soulseek network through [slskd](https://github.com/slskd/slskd) (self-hosted Soulseek client with HTTP API).
3. Download queued and tracked (`bullmq` job queue).
4. Finished file verified against requested MusicBrainz recording via audio fingerprint (`fpcalc` + AcoustID API) — makes sure download actually matches, not a mislabeled file.
5. Track added to that user's library, tagged with metadata (`music-metadata`), transcodable/playable through built-in web player or Discy API endpoints.

Auth: JWT-based (`jsonwebtoken`), passwords hashed with `bcrypt`. Each user has own library + permission set ([`server/entity/Permission.ts`](server/entity/Permission.ts)).

Storage: SQLite (`better-sqlite3`).

Note: slskd itself only exposes its own local downloads folder, not file bytes over HTTP — so `SOULSEEK_DOWNLOADS_PATH` must be a path Discy can read directly (local disk, or mounted SMB/NFS share if slskd runs elsewhere).

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

<!-- More settings (in-app, user-facing) to be documented here as they land. -->

## Tech stack

- [Nuxt 4](https://nuxt.com/) (Vue 3) — frontend + server API routes (Nitro)
- `better-sqlite3` — database
- `bullmq` — download job queue
- `musicbrainz-api` — track/album metadata search
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

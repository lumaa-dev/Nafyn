# Nafyn Pages
- `a` is for albums
- `ar` is for artists
- `l` is for library content (albums/tracks) - `l/a` and `l/t` are library-scoped album/track views (owned tracks only, Play/Shuffle instead of Request)
- `t` is for track content
- `insights` is for personal listening insights - `insights` is the weekly/monthly/yearly hub, `insights/{year}` is the year-end package (reel + share cards + full ranked lists), and `insights/replay/{year}` is the Replay Mix (`current` and `all-time` are accepted in place of a year)
- `transfer` is for importing a library from another streaming service - `transfer/callback` receives every OAuth redirect, `transfer/select` picks what to import from a connected account, and `transfer/{id}` follows one import (progress + failure report). It starts from Settings -> Import

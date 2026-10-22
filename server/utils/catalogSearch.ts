import { getMusicBrainzRepository } from "./musicbrainz";
import { searchConfigFromEnv } from "./search/config";
import { CoverArtChecker } from "./search/coverArt";
import type { SearchDeps } from "./search/engine";

let deps: SearchDeps | null = null;

// The wiring of the search engine for the running server: the shared MusicBrainz repository, one process-wide
// cover-art cache and the operator's configuration (env overrides, see `searchConfigFromEnv`).
export function getSearchDeps(): SearchDeps {
    if (!deps) {
        const config = searchConfigFromEnv();
        deps = {
            repo: getMusicBrainzRepository(),
            cover: new CoverArtChecker(undefined, config.coverArtTimeoutMs),
            config,
            log: (message) => console.log(message)
        };
    }
    return deps;
}

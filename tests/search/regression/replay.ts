// Replays recorded MusicBrainz / Cover Art Archive responses, and records them (scripts/record-search-fixtures.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MusicBrainzRepository, type Transport } from "../../../server/utils/musicbrainzRepository";
import { DEFAULT_SEARCH_CONFIG, type SearchConfig } from "../../../server/utils/search/config";
import { CoverArtChecker, type HeadFetch } from "../../../server/utils/search/coverArt";
import type { SearchDeps } from "../../../server/utils/search/engine";

export interface Fixture {
    /** Full request URL -> response body, as the repository builds it. */
    requests: Record<string, unknown>,
    /** Cover Art Archive URL -> HTTP status of the HEAD request. */
    covers: Record<string, number>
}

export const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function loadFixture(name: string): Fixture {
    return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8")) as Fixture;
}

export function replayTransport(fixture: Fixture): Transport {
    return async (url) => {
        if (!(url in fixture.requests)) throw new Error(`no recorded response for ${url} - re-record the fixture (bun run search:record)`);
        return { status: 200, body: structuredClone(fixture.requests[url]) };
    };
}

export function replayHead(fixture: Fixture, overrides: Record<string, number> = {}): HeadFetch {
    return async (url) => {
        if (url in overrides) return overrides[url]!;
        if (!(url in fixture.covers)) throw new Error(`no recorded cover-art response for ${url} - re-record the fixture`);
        return fixture.covers[url]!;
    };
}

export function replayDeps(fixture: Fixture, options: { config?: Partial<SearchConfig>, coverOverrides?: Record<string, number> } = {}): SearchDeps {
    return {
        repo: new MusicBrainzRepository({
            userAgent: "Nafyn-test",
            transport: replayTransport(fixture),
            minIntervalMs: 0,
            sleep: async () => {}
        }),
        cover: new CoverArtChecker(replayHead(fixture, options.coverOverrides)),
        config: { ...DEFAULT_SEARCH_CONFIG, ...options.config }
    };
}

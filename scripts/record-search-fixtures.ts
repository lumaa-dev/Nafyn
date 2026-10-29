// Records the live MusicBrainz and Cover Art Archive responses behind the search regression set
// (tests/search/regression/cases.ts) into tests/search/regression/fixtures/. Run it only when a case changes or MusicBrainz data has
// moved enough to matter - the tests themselves never touch the network.
//
//   bun scripts/record-search-fixtures.ts [caseName | fixtureName ...]
//
// Responses are trimmed to the fields the engine reads (tags, genres, relations... are dropped), which keeps the
// fixtures reviewable. It takes a while: the repository's 1 request/second limiter applies.

import { mkdirSync, writeFileSync } from "node:fs";
import { APP_GITHUB, APP_NAME, APP_VERSION } from "../server/utils/app";
import { MusicBrainzRepository, defaultTransport, type Transport } from "../server/utils/musicbrainzRepository";
import { DEFAULT_SEARCH_CONFIG } from "../server/utils/search/config";
import { CoverArtChecker, defaultHeadFetch, type HeadFetch } from "../server/utils/search/coverArt";
import { searchAlbums, searchTracks } from "../server/utils/search/engine";
import { CASES } from "../tests/search/regression/cases";
import { FIXTURE_DIR, type Fixture } from "../tests/search/regression/replay";

const DROP = new Set([
    "tags", "genres", "annotation", "relations", "life-span", "area", "begin-area", "end-area", "ipis", "isnis",
    "rating", "type-id", "primary-type-id", "secondary-type-ids", "status-id", "packaging-id", "artist-credit-id",
    "text-representation", "release-events", "label-info", "country", "quality", "packaging", "begin-date",
    "end-date", "ended", "locale", "primary", "disambiguation-id", "country-codes", "gender", "gender-id",
    "type", "format-id", "media-id", "title-id", "video", "count", "track-offset", "format-count", "discs", "disc-count"
]);

function prune(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(prune);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([key]) => !DROP.has(key)).map(([key, inner]) => [key, prune(inner)]));
    }
    return value;
}

const wanted = new Set(process.argv.slice(2));
mkdirSync(FIXTURE_DIR, { recursive: true });

// one recording per fixture file: its cases run against the same repository, so a request they share is
// recorded once. Naming a case (or a fixture) re-records the whole fixture it belongs to.
const fixtures = new Map<string, typeof CASES>();
for (const testCase of CASES) fixtures.set(testCase.fixture, [...(fixtures.get(testCase.fixture) ?? []), testCase]);

for (const [name, cases] of fixtures) {
    if (wanted.size > 0 && !wanted.has(name) && !cases.some((testCase) => wanted.has(testCase.name))) continue;
    const fixture: Fixture = { requests: {}, covers: {} };

    const transport: Transport = async (url, init) => {
        const response = await defaultTransport(url, init);
        if (response.status === 200) fixture.requests[url] = prune(response.body);
        return response;
    };
    const head: HeadFetch = async (url, timeout) => {
        const status = await defaultHeadFetch(url, timeout);
        if (status !== null) fixture.covers[url] = status;
        return status;
    };

    // the repository caches responses, so a case that repeats an earlier case's request does not hit the transport
    // again - which is why its answer is already in `fixture`
    const deps = {
        repo: new MusicBrainzRepository({ userAgent: `${APP_NAME}/${APP_VERSION} ( ${APP_GITHUB} )`, transport }),
        cover: new CoverArtChecker(head),
        config: DEFAULT_SEARCH_CONFIG,
        log: (message: string) => console.log(`  ${message}`)
    };

    console.log(`recording ${name} ...`);
    for (const testCase of cases) {
        console.log(` ${testCase.name}`);
        const page = await (testCase.kind === "album" ? searchAlbums : searchTracks)(testCase.input, deps, 50);
        console.log(`  ${page.total} result(s)`);
    }
    console.log(`  ${Object.keys(fixture.requests).length} MusicBrainz + ${Object.keys(fixture.covers).length} cover-art responses`);
    writeFileSync(`${FIXTURE_DIR}${name}.json`, JSON.stringify(fixture, null, 1) + "\n");
}

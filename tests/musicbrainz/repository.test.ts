import { describe, expect, test } from "bun:test";
import {
    MusicBrainzError, MusicBrainzRepository, escapeLucene, luceneQuote, luceneTerms, withMusicBrainzContext,
    type Transport, type TransportResponse
} from "../../server/utils/musicbrainzRepository";

// `sleep` records the wait. With `realTime: false` it does not move the clock, which is what a burst of
// concurrent callers looks like to the limiter: everyone arrives at the same instant.
function harness(responses: Array<TransportResponse | Error>, options: Partial<ConstructorParameters<typeof MusicBrainzRepository>[0]> = {}, realTime = true) {
    let clock = 0;
    const urls: string[] = [];
    const sleeps: number[] = [];
    let next = 0;
    const transport: Transport = async (url) => {
        urls.push(url);
        const response = responses[Math.min(next++, responses.length - 1)]!;
        if (response instanceof Error) throw response;
        return response;
    };
    const repo = new MusicBrainzRepository({
        userAgent: "test/1.0 ( test@example.com )",
        transport,
        now: () => clock,
        sleep: async (ms) => { sleeps.push(ms); if (realTime) clock += ms; },
        ...options
    });
    return { repo, urls, sleeps, advance: (ms: number) => { clock += ms; }, get clock() { return clock; } };
}

const ok = (body: unknown = { ok: true }): TransportResponse => ({ status: 200, body });
const busy = (): TransportResponse => ({ status: 503, body: { error: "The MusicBrainz web server is currently busy." } });

describe("Lucene escaping", () => {
    test("every special character is escaped", () => {
        expect(escapeLucene('AC/DC (live) [x] {y} + - ! ^ ~ * ? : \\ "q" && ||')).toBe('AC\\/DC \\(live\\) \\[x\\] \\{y\\} \\+ \\- \\! \\^ \\~ \\* \\? \\: \\\\ \\"q\\" \\&\\& \\|\\|');
    });

    test("phrases only need quote and backslash escaped", () => {
        expect(luceneQuote('say "hi" (now)')).toBe('"say \\"hi\\" (now)"');
        expect(luceneQuote("a\\b")).toBe('"a\\\\b"');
    });

    test("terms are required individually", () => {
        expect(luceneTerms("rock (and) roll")).toBe("rock AND \\(and\\) AND roll");
    });
});

describe("MusicBrainzRepository", () => {
    test("one global limiter spaces requests", async () => {
        const h = harness([ok()], { minIntervalMs: 1000 }, false);
        await Promise.all([h.repo.request("/a"), h.repo.request("/b"), h.repo.request("/c")]);
        expect(h.sleeps).toEqual([1000, 2000]);
        expect(h.urls).toHaveLength(3);
    });

    test("the request URL is stable (sorted params, json format) and carries the query", async () => {
        const h = harness([ok()]);
        await h.repo.request("/release-group", { query: 'artist:"x"', limit: 5 });
        expect(h.urls[0]).toBe("https://musicbrainz.org/ws/2/release-group?fmt=json&limit=5&query=artist%3A%22x%22");
    });

    test("a descriptive User-Agent is sent", async () => {
        let seen = "";
        const repo = new MusicBrainzRepository({ userAgent: "Nafyn/1 ( me@x.org )", transport: async (_url, init) => { seen = init.userAgent; return ok(); }, minIntervalMs: 0 });
        await repo.request("/x");
        expect(seen).toBe("Nafyn/1 ( me@x.org )");
    });

    test("retries 503 with exponential backoff, then succeeds", async () => {
        const h = harness([busy(), busy(), ok({ done: true })], { minIntervalMs: 0, retryBaseMs: 1000 });
        expect(await h.repo.request("/x")).toEqual({ done: true });
        expect(h.urls).toHaveLength(3);
        expect(h.sleeps).toEqual([1000, 2000]);
    });

    test("honours Retry-After when it is longer than the backoff", async () => {
        const h = harness([{ status: 429, retryAfter: 7, body: { error: "slow down" } }, ok()], { minIntervalMs: 0, retryBaseMs: 1000 });
        await h.repo.request("/x");
        expect(h.sleeps).toEqual([7000]);
    });

    test("network errors are retried, 404 and 400 are not", async () => {
        const net = harness([new Error("socket hang up"), ok()], { minIntervalMs: 0 });
        await net.repo.request("/x");
        expect(net.urls).toHaveLength(2);

        const missing = harness([{ status: 404, body: { error: "Not Found" } }], { minIntervalMs: 0 });
        await expect(missing.repo.request("/recording/x")).rejects.toMatchObject({ name: "MusicBrainzError", status: 404 });
        expect(missing.urls).toHaveLength(1);

        const invalid = harness([{ status: 400, body: { error: "Invalid mbid." } }], { minIntervalMs: 0 });
        await expect(invalid.repo.request("/recording/x")).rejects.toMatchObject({ status: 400 });
    });

    test("gives up after maxRetries with a 503 error", async () => {
        const h = harness([busy()], { minIntervalMs: 0, maxRetries: 2 });
        await expect(h.repo.request("/x")).rejects.toMatchObject({ status: 503 });
        expect(h.urls).toHaveLength(3);
    });

    test("responses are cached for the TTL, per URL", async () => {
        const h = harness([ok({ n: 1 }), ok({ n: 2 })], { minIntervalMs: 0, searchTtlMs: 1000 });
        expect(await h.repo.request("/x", { query: "a" })).toEqual({ n: 1 });
        expect(await h.repo.request("/x", { query: "a" })).toEqual({ n: 1 });
        expect(h.urls).toHaveLength(1);
        h.advance(1500);
        expect(await h.repo.request("/x", { query: "a" })).toEqual({ n: 2 });
        expect(await h.repo.request("/x", { query: "b" })).toEqual({ n: 2 });
    });

    test("callers get their own copy of a cached response", async () => {
        const h = harness([ok({ list: [1] })], { minIntervalMs: 0 });
        const first = await h.repo.request<{ list: number[] }>("/x");
        first.list.push(99);
        expect(await h.repo.request("/x")).toEqual({ list: [1] });
    });

    test("identical in-flight requests share one HTTP call", async () => {
        const h = harness([ok()], { minIntervalMs: 0 });
        await Promise.all([h.repo.request("/x"), h.repo.request("/x"), h.repo.request("/x")]);
        expect(h.urls).toHaveLength(1);
    });

    test("a 404 is cached negatively", async () => {
        const h = harness([{ status: 404, body: { error: "Not Found" } }], { minIntervalMs: 0 });
        await expect(h.repo.request("/recording/z")).rejects.toBeInstanceOf(MusicBrainzError);
        await expect(h.repo.request("/recording/z")).rejects.toMatchObject({ status: 404 });
        expect(h.urls).toHaveLength(1);
    });

    test("circuit breaker: opens after consecutive failures, fails fast, recovers after the cooldown", async () => {
        const h = harness([busy()], { minIntervalMs: 0, maxRetries: 0, breakerThreshold: 3, breakerCooldownMs: 30_000 });
        for (let i = 0; i < 3; i++) await expect(h.repo.request(`/x${i}`)).rejects.toMatchObject({ status: 503 });
        expect(h.urls).toHaveLength(3);

        await expect(h.repo.request("/y")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("circuit") });
        expect(h.urls).toHaveLength(3); // fast failure: no HTTP call

        h.advance(31_000);
        const recovered = harness([busy(), ok()], { minIntervalMs: 0, maxRetries: 0, breakerThreshold: 1, breakerCooldownMs: 1000 });
        await expect(recovered.repo.request("/a")).rejects.toBeDefined();
        recovered.advance(1500);
        expect(await recovered.repo.request("/b")).toEqual({ ok: true });
        expect(await recovered.repo.request("/c")).toEqual({ ok: true });
    });

    test("a request that would wait too long for its turn is refused", async () => {
        const h = harness([ok()], { minIntervalMs: 1000, maxQueueWaitMs: 2500 }, false);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => h.repo.request(`/x${n}`)));
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    });

    test("lookup/browse/search keep the musicbrainz-api call shapes callers use", async () => {
        const h = harness([ok({ id: "1" })], { minIntervalMs: 0 });
        await h.repo.lookup("recording", "abc", ["artist-credits", "releases"]);
        await h.repo.browse("release", { "release-group": "def" }, ["media"]);
        await h.repo.search("recording", { query: "isrc:X", limit: 1 });
        expect(h.urls).toEqual([
            "https://musicbrainz.org/ws/2/recording/abc?fmt=json&inc=artist-credits%20releases",
            "https://musicbrainz.org/ws/2/release?fmt=json&inc=media&release-group=def",
            "https://musicbrainz.org/ws/2/recording?fmt=json&limit=1&query=isrc%3AX"
        ]);
    });

    test("interactive requests go before queued bulk ones", async () => {
        const h = harness([ok()], { minIntervalMs: 1000 }, false);
        const first = h.repo.request("/first");
        const bulk = [1, 2, 3].map((n) => withMusicBrainzContext({ lane: "bulk", key: "importer" }, () => h.repo.request(`/bulk${n}`)));
        const page = withMusicBrainzContext({ lane: "interactive", key: "browser" }, () => h.repo.request("/page"));
        await Promise.all([first, page, ...bulk]);
        expect(h.urls.map((url) => url.split("?")[0]!.split("/").pop())).toEqual(["first", "page", "bulk1", "bulk2", "bulk3"]);
    });

    test("inside a lane, keys take turns", async () => {
        const h = harness([ok()], { minIntervalMs: 1000 }, false);
        const first = h.repo.request("/first");
        const a = [1, 2, 3].map((n) => withMusicBrainzContext({ lane: "bulk", key: "a" }, () => h.repo.request(`/a${n}`)));
        const b = [1, 2].map((n) => withMusicBrainzContext({ lane: "bulk", key: "b" }, () => h.repo.request(`/b${n}`)));
        await Promise.all([first, ...a, ...b]);
        expect(h.urls.map((url) => url.split("?")[0]!.split("/").pop())).toEqual(["first", "a1", "b1", "a2", "b2", "a3"]);
    });

    test("the bulk lane may queue far longer than the interactive one", async () => {
        const h = harness([ok()], { minIntervalMs: 1000, maxQueueWaitMs: 2500, maxBulkQueueWaitMs: 60_000 }, false);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => withMusicBrainzContext({ lane: "bulk", key: "k" }, () => h.repo.request(`/x${n}`))));
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });

    test("an interactive caller joining a queued bulk fetch moves it to the front", async () => {
        const h = harness([ok()], { minIntervalMs: 1000 }, false);
        const first = h.repo.request("/first");
        const bulk = [1, 2].map((n) => withMusicBrainzContext({ lane: "bulk", key: "importer" }, () => h.repo.request(`/bulk${n}`)));
        const shared = withMusicBrainzContext({ lane: "bulk", key: "importer" }, () => h.repo.request("/shared"));
        const joined = withMusicBrainzContext({ lane: "interactive", key: "browser" }, () => h.repo.request("/shared"));
        await Promise.all([first, ...bulk, shared, joined]);
        expect(h.urls.map((url) => url.split("?")[0]!.split("/").pop())).toEqual(["first", "shared", "bulk1", "bulk2"]);
    });

    test("a 503 from MusicBrainz holds the whole queue back, not just the caller", async () => {
        const h = harness([busy(), ok(), ok()], { minIntervalMs: 1000, retryBaseMs: 100, maxRetries: 1 });
        await Promise.all([h.repo.request("/a"), h.repo.request("/b")]);
        // /a got the 503 at t=0: nobody leaves before t=2000 (two intervals), /b included
        expect(h.clock).toBeGreaterThanOrEqual(3000);
    });
});


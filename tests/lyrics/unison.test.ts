import { afterEach, describe, expect, test } from "bun:test";
import { fetchUnison } from "../../server/utils/lyrics/unison";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const LRC = "[00:01.00]First line\n[00:05.00]Second line\n[00:09.00]Third line";

function entry(extra: Record<string, unknown> = {}) {
	return {
		id: 7,
		videoId: "Ugr4KKK_SqY",
		song: "Explorer",
		artist: "Justice, Connan Mockasin",
		isrc: "FR8EU2300090",
		duration: 249,
		format: "lrc",
		lyrics: LRC,
		submitter: { displayName: "boidu", keyId: "abc123" },
		...extra,
	};
}

/** Answers each call from `answers` in order (null = 404) and records the URLs asked. */
function mockUnison(answers: (Record<string, unknown> | null)[]) {
	const urls: URL[] = [];
	globalThis.fetch = (async (input: URL | string) => {
		urls.push(new URL(String(input)));
		const answer = answers.shift() ?? null;
		return answer
			? new Response(JSON.stringify({ success: true, data: answer }), { status: 200 })
			: new Response(JSON.stringify({ success: false, code: "NOT_FOUND" }), { status: 404 });
	}) as unknown as typeof fetch;
	return urls;
}

const lookup = { trackName: "Explorer", artistName: "Justice", duration: 249 };

describe("fetchUnison", () => {
	test("asks the new host, by title + artist + length, never by video id", async () => {
		const urls = mockUnison([entry({ matchedBy: "song_artist" })]);
		await fetchUnison({ ...lookup, albumName: "Hyperdrama" });

		expect(urls).toHaveLength(1);
		expect(urls[0]!.origin).toBe("https://unison.betterlyrics.org");
		expect(urls[0]!.searchParams.get("song")).toBe("Explorer");
		expect(urls[0]!.searchParams.get("artist")).toBe("Justice");
		expect(urls[0]!.searchParams.get("album")).toBe("Hyperdrama");
		expect(urls[0]!.searchParams.get("duration")).toBe("249");
		expect(urls[0]!.searchParams.has("v")).toBe(false);
	});

	test("an ISRC is asked first, hyphens and case ignored, and its answer needs no name match", async () => {
		const urls = mockUnison([entry({ matchedBy: "isrc", song: "Explorer (Official Audio)", artist: "JUSTICE" })]);
		const found = await fetchUnison({ ...lookup, isrc: "fr-8eu2300090" });

		expect(urls).toHaveLength(1);
		expect(urls[0]!.searchParams.get("isrc")).toBe("FR8EU2300090");
		expect(urls[0]!.searchParams.has("song")).toBe(false);
		expect(found?.paragraphs.length).toBeGreaterThan(0);
	});

	test("an ISRC with nothing behind it falls back to title + artist", async () => {
		const urls = mockUnison([null, entry({ matchedBy: "song_artist" })]);
		const found = await fetchUnison({ ...lookup, isrc: "FR8EU2300090" });

		expect(urls).toHaveLength(2);
		expect(urls[0]!.searchParams.has("isrc")).toBe(true);
		expect(urls[1]!.searchParams.has("song")).toBe(true);
		expect(found).not.toBeNull();
	});

	test("a malformed ISRC is not sent", async () => {
		const urls = mockUnison([entry({ matchedBy: "song_artist" })]);
		await fetchUnison({ ...lookup, isrc: "ZZ" });
		expect(urls).toHaveLength(1);
		expect(urls[0]!.searchParams.has("isrc")).toBe(false);
	});

	test("a linked_video match (another release's timing) is refused", async () => {
		mockUnison([entry({ matchedBy: "linked_video" })]);
		expect(await fetchUnison({ ...lookup, isrc: "FR8EU2300090" })).toBeNull();
	});

	test("a title + artist lookup needs the track's length, an ISRC one does not", async () => {
		const urls = mockUnison([entry({ matchedBy: "song_artist" })]);
		expect(await fetchUnison({ trackName: "Explorer", artistName: "Justice" })).toBeNull();
		expect(urls).toHaveLength(0);

		mockUnison([entry({ matchedBy: "isrc" })]);
		expect(await fetchUnison({ trackName: "Explorer", artistName: "Justice", isrc: "FR8EU2300090" })).not.toBeNull();
	});

	test("another song, another version or another length is refused", async () => {
		mockUnison([entry({ matchedBy: "song_artist", song: "Explorer (Live)" })]);
		expect(await fetchUnison(lookup)).toBeNull();

		mockUnison([entry({ matchedBy: "song_artist", artist: "Someone Else" })]);
		expect(await fetchUnison(lookup)).toBeNull();

		mockUnison([entry({ matchedBy: "song_artist", duration: 300 })]);
		expect(await fetchUnison(lookup)).toBeNull();
	});

	test("the credit names Unison and the submitter, linked to their pages", async () => {
		mockUnison([entry({ matchedBy: "song_artist" })]);
		const found = await fetchUnison(lookup);

		expect(found?.credit).toEqual({
			text: "Lyrics from Unison",
			url: "https://unison.betterlyrics.org/song/Ugr4KKK_SqY",
			submitter: { name: "boidu", url: "https://unison.betterlyrics.org/curator/abc123" },
		});
	});

	test("an entry with no submitter still credits Unison", async () => {
		mockUnison([entry({ matchedBy: "song_artist", submitter: null })]);
		const found = await fetchUnison(lookup);
		expect(found?.credit.submitter).toBeNull();
		expect(found?.credit.text).toBe("Lyrics from Unison");
	});

	test("unsynced text and failures are no lyrics", async () => {
		mockUnison([entry({ matchedBy: "song_artist", format: "plain" })]);
		expect(await fetchUnison(lookup)).toBeNull();

		globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
		expect(await fetchUnison(lookup)).toBeNull();
	});
});

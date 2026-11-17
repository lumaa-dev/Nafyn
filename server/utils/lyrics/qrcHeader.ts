// The song a QRC file names in its `[ti:]` / `[ar:]` / `[al:]` header tags - read only to check that Better Lyrics
// Portato answered for the right song (the lyrics themselves are parsed by `@braccato/parsers`, see parse.ts).
// Pure, runs under bun test.

function decodeXmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

/** The QRC body out of QQ Music's XML envelope; a bare QRC body is returned as is. */
function extractQrcBody(input: string): string {
	if (!/<\s*(?:QrcInfos|LyricInfo|Lyric_\d+)\b/i.test(input)) return input;

	// the attribute value can hold raw `"` (lyrics with quotes), so it ends at the first `"/>`, not the first `"`
	const match = /LyricContent="([\s\S]*?)"\s*\/>/.exec(input);
	return match ? decodeXmlEntities(match[1]!) : "";
}

/** The `[ti:]` / `[ar:]` / `[al:]` header tags of a QRC file (empty ones are left out). */
export function qrcHeader(input: string): { title?: string; artist?: string; album?: string } {
	const result: { title?: string; artist?: string; album?: string } = {};
	for (const raw of extractQrcBody(input).split(/\r?\n/)) {
		const match = /^\s*\[(ti|ar|al):(.*)\]\s*$/i.exec(raw);
		const value = match?.[2]?.trim();
		if (!match || !value) continue;
		const key = ({ ti: "title", ar: "artist", al: "album" } as const)[match[1]!.toLowerCase() as "ti" | "ar" | "al"];
		result[key] ??= value;
	}
	return result;
}

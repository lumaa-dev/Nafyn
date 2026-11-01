// the `?q=` and `?sort=` every library list (tracks, albums) takes. Pure, so the SQL builders and the tests can
// share it.

export const LIBRARY_SORTS = ["added", "title", "artist", "released"] as const;
export type LibrarySort = typeof LIBRARY_SORTS[number];

export interface LibraryListOptions {
    /** Free text; every word has to be found (in the title, artist or album). */
    query?: string,
    sort?: LibrarySort
}

const MAX_QUERY_LENGTH = 100;
const MAX_QUERY_WORDS = 8;

export function isLibrarySort(value: unknown): value is LibrarySort {
    return typeof value === "string" && (LIBRARY_SORTS as readonly string[]).includes(value);
}

/** The words of a search text, deduplicated and capped (a hostile 100-word query is 100 LIKEs). */
export function searchWords(query: string | undefined): string[] {
    if (!query) return [];
    const words = query.normalize("NFC").slice(0, MAX_QUERY_LENGTH).split(/\s+/).filter(Boolean);
    return [...new Set(words.map((word) => word.toLowerCase()))].slice(0, MAX_QUERY_WORDS);
}

/** `%word%` with LIKE's own wildcards neutralised (MySQL's default escape character is a backslash). */
export function likePattern(word: string): string {
    return `%${word.replace(/[\\%_]/g, "\\$&")}%`;
}

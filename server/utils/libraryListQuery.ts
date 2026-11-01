import type { H3Event } from "h3";
import { isLibrarySort, LIBRARY_SORTS, type LibraryListOptions } from "./libraryList";

// reads `?q=` and `?sort=` off the query string of a library list (tracks, albums)
export function parseLibraryListQuery(event: H3Event): LibraryListOptions {
    const query = getQuery(event);

    const sort = query.sort;
    if (sort !== undefined && sort !== "" && !isLibrarySort(sort)) {
        throw createError({ statusCode: 400, statusMessage: `\`sort\` must be one of: ${LIBRARY_SORTS.join(", ")}` });
    }

    const text = typeof query.q === "string" ? query.q.trim() : "";
    return { query: text || undefined, sort: isLibrarySort(sort) ? sort : undefined };
}

export const libraryListQueryParams = [
    { name: "q", in: "query", required: false, description: "Search text: every word has to be found in the title, artist or album", schema: { type: "string", maxLength: 100 } },
    { name: "sort", in: "query", required: false, description: "`added` (recently added, default), `title` (A-Z), `artist` (A-Z) or `released` (newest release first)", schema: { type: "string", enum: [...LIBRARY_SORTS], default: "added" } }
];

// What the tags inside a downloaded file say about whether it is the requested song. AcoustID has no entry for plenty
// of correct recordings (small artists, new releases, other scripts), so "AcoustID did not contradict it" is the only
// check such a file got - and that let through the wrong song of the right length. The file's own title and artist
// tags are independent evidence: peers tag their copies, and a tag naming another artist, another title, or the live /
// Japanese / acoustic version of the title is the wrong file whatever its length. A file with no tags says nothing.
// Pure (no Nitro auto-imports, no filesystem), so it runs under `bun test`.

import { keyContains, matchKey, nameMatchesAnyTitle } from "./soulseekText";
import { titleForms } from "./soulseekRank";
import { differentVersion } from "./versionMarkers";

export interface FileTags {
    title?: string | null,
    artist?: string | null
}

export interface TagTarget {
    title: string,
    altTitles?: string[],
    disambiguation?: string | null,
    album?: string | null,
    artistName: string,
    artistAliases?: string[]
}

export interface TagVerdict {
    conflict: "title" | "artist" | "version" | null,
    /** For the log. */
    detail: string
}

type Script = "latin" | "kana" | "hangul" | "han" | "cyrillic" | "other";

function scriptsOf(text: string): Set<Script> {
    const scripts = new Set<Script>();
    for (const char of text) {
        if (/[\p{Script=Latin}\p{N}]/u.test(char)) scripts.add("latin");
        else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) scripts.add("kana");
        else if (/\p{Script=Hangul}/u.test(char)) scripts.add("hangul");
        else if (/\p{Script=Han}/u.test(char)) scripts.add("han");
        else if (/\p{Script=Cyrillic}/u.test(char)) scripts.add("cyrillic");
        else if (/\p{L}/u.test(char)) scripts.add("other");
    }
    return scripts;
}

// two names can only be compared when they are written in one script: a Hangul tag against a Latin title says
// nothing (the artist may be tagged 방탄소년단 for a file requested as "BTS")
function comparable(tag: string, forms: string[]): boolean {
    const tagScripts = scriptsOf(tag);
    if (tagScripts.size === 0) return false;
    const formScripts = scriptsOf(forms.join(" "));
    return [...tagScripts].some((script) => formScripts.has(script));
}

function clean(tag: string | null | undefined): string {
    return (tag ?? "").replace(/\s+/g, " ").trim();
}

function artistMatches(tag: string, forms: string[]): boolean {
    const tagKey = matchKey(tag);
    return forms.map(matchKey).filter((key) => key.length >= 2).some((key) => keyContains(tagKey, key) || keyContains(key, tagKey));
}

export function judgeTags(tags: FileTags, target: TagTarget): TagVerdict {
    const title = clean(tags.title);
    const artist = clean(tags.artist);

    if (title) {
        const forms = titleForms(target);
        if (comparable(title, forms) && !nameMatchesAnyTitle(title, forms)) {
            return { conflict: "title", detail: `its title tag is "${title}"` };
        }
        // right words, wrong version: "(Live)", "(Japanese ver.)" ... in the tag, or the tag lacking what was asked for
        const requested = [target.title, ...(target.altTitles ?? [])].map((form, index) => (index === 0 ? [form, target.disambiguation, target.album].filter(Boolean).join(" ") : form));
        if (requested.length > 0 && requested.every((form) => differentVersion(title, form))) {
            return { conflict: "version", detail: `its title tag is "${title}", another version of the song` };
        }
    }

    if (artist) {
        const names = [target.artistName, ...(target.artistAliases ?? [])].filter(Boolean);
        if (names.length > 0 && comparable(artist, names) && !artistMatches(artist, names)) {
            return { conflict: "artist", detail: `its artist tag is "${artist}"` };
        }
    }
    return { conflict: null, detail: "" };
}

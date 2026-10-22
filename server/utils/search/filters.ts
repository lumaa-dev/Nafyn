// Hard filters: a result failing one of these is not returned, whatever its relevance.
//
//   * release status must be Official (no Bootleg, Promotion, Pseudo-Release)
//   * the work needs an Official release on "Digital Media" - the only format Nafyn can match on Soulseek
//   * Deluxe and Remaster editions are out unless the query asked for one
//   * Compilations and "Best of" / greatest-hits titles are out; a query that itself says "best of" lifts
//     the *title heuristic* only - a release-group typed Compilation stays out
//   * secondary types that are never the artist's own release (demo, interview, audiobook...)

import type { SearchConfig } from "./config";
import { containsPhrase, foldForKeywords } from "./normalize";
import type { RawRelease } from "./types";

export interface QueryIntent {
    wantsDeluxe: boolean,
    wantsRemaster: boolean,
    /** The query itself contains a best-of keyword: the title heuristic is not applied. */
    wantsCompilation: boolean
}

interface FoldedKeywords {
    compilation: string[],
    deluxe: string[],
    remaster: string[]
}

const keywordCache = new WeakMap<SearchConfig, FoldedKeywords>();

function folded(config: SearchConfig): FoldedKeywords {
    let cached = keywordCache.get(config);
    if (!cached) {
        const fold = (list: string[]) => [...new Set(list.map(foldForKeywords).filter(Boolean))];
        cached = {
            compilation: fold(config.compilationKeywords),
            deluxe: fold(config.deluxeKeywords),
            remaster: fold(config.remasterKeywords)
        };
        keywordCache.set(config, cached);
    }
    return cached;
}

// "remaster" must catch "remastered"/"remasterisée" too: a single-word latin keyword matches as a word prefix
function matchesKeyword(foldedText: string, keyword: string): boolean {
    if (containsPhrase(foldedText, keyword)) return true;
    if (/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(keyword)) return false;
    return foldedText.split(" ").some((word) => word.startsWith(keyword) && keyword.length >= 5);
}

function matchesAny(foldedText: string, keywords: string[]): boolean {
    return keywords.some((keyword) => matchesKeyword(foldedText, keyword));
}

export function hasCompilationKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).compilation);
}

export function hasDeluxeKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).deluxe);
}

export function hasRemasterKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).remaster);
}

export function detectIntent(texts: Array<string | null | undefined>, config: SearchConfig): QueryIntent {
    const joined = texts.filter(Boolean).join(" ");
    return {
        wantsDeluxe: hasDeluxeKeyword(joined, config),
        wantsRemaster: hasRemasterKeyword(joined, config),
        wantsCompilation: hasCompilationKeyword(joined, config)
    };
}

export function hasExcludedSecondaryType(secondaryTypes: string[] | undefined, config: SearchConfig): boolean {
    const excluded = new Set(config.excludedSecondaryTypes.map((type) => type.toLowerCase()));
    return (secondaryTypes ?? []).some((type) => excluded.has(type.toLowerCase()));
}

export interface WorkInfo {
    title: string,
    secondaryTypes?: string[]
}

/** Release-group / work level: does the work itself pass? (Needs no network.) */
export function workPasses(work: WorkInfo, intent: QueryIntent, config: SearchConfig): boolean {
    if (hasExcludedSecondaryType(work.secondaryTypes, config)) return false;
    if (!intent.wantsCompilation && hasCompilationKeyword(work.title, config)) return false;
    if (!intent.wantsDeluxe && hasDeluxeKeyword(work.title, config)) return false;
    if (!intent.wantsRemaster && hasRemasterKeyword(work.title, config)) return false;
    return true;
}

export function isOfficial(release: RawRelease): boolean {
    return release.status?.toLowerCase() === "official";
}

export function isDigital(release: RawRelease): boolean {
    return (release.media ?? []).some((medium) => medium.format === "Digital Media");
}

/**
 * Release level: Official + Digital Media + not a Deluxe/Remaster edition (unless asked for).
 * `work` is the release-group the release belongs to - its title and types apply too.
 */
export function releaseQualifies(release: RawRelease, work: WorkInfo, intent: QueryIntent, config: SearchConfig): boolean {
    if (!isOfficial(release) || !isDigital(release)) return false;
    if (!workPasses(work, intent, config)) return false;
    const label = `${release.title ?? ""} ${release.disambiguation ?? ""}`;
    if (!intent.wantsDeluxe && hasDeluxeKeyword(label, config)) return false;
    if (!intent.wantsRemaster && hasRemasterKeyword(label, config)) return false;
    return true;
}

/** "YYYY", "YYYY-MM" or "YYYY-MM-DD" padded so plain string comparison orders them; undated sorts last. */
export function sortableDate(date: string | undefined | null): string {
    if (!date) return "9999-99-99";
    const [year = "9999", month = "00", day = "00"] = date.split("-");
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

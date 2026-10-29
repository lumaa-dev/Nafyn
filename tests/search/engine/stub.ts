// A tiny in-memory MusicBrainz for engine tests that need payloads the live API won't hand out on demand
// (bootlegs, CD-only albums, compilations...). Shapes follow the live search responses recorded in fixtures/.

import { DEFAULT_SEARCH_CONFIG, type SearchConfig } from "../../../server/utils/search/config";
import type { SearchDeps } from "../../../server/utils/search/engine";
import type { RawArtist, RawArtistCredit, RawRecording, RawRelease, RawReleaseGroup } from "../../../server/utils/search/types";

export function artist(name: string, aliases: string[] = [], id = `artist-${name}`, sortName = name): RawArtist {
    return { id, name, "sort-name": sortName, aliases: aliases.map((alias) => ({ name: alias, "sort-name": alias })) };
}

export function credit(who: RawArtist | string): RawArtistCredit[] {
    const value = typeof who === "string" ? artist(who) : who;
    return [{ name: value.name, artist: value }];
}

export interface ReleaseSpec {
    id: string,
    title?: string,
    status?: string,
    format?: string,
    date?: string,
    barcode?: string,
    disambiguation?: string,
    cover?: boolean
}

export interface GroupSpec {
    id: string,
    title: string,
    artist?: RawArtist | string,
    primary?: string,
    secondary?: string[],
    date?: string,
    releases?: ReleaseSpec[]
}

export interface World {
    groups: GroupSpec[],
    recordings?: Array<{ id: string, title: string, disambiguation?: string, artist?: RawArtist | string, length?: number, isrcs?: string[], date?: string, on: Array<{ group: string, release: ReleaseSpec }> }>,
    artists?: Array<{ id: string, name: string, score?: number }>,
    /** Emulate MusicBrainz applying `status:official` / `format:"Digital Media"` itself (it does). */
    serverFilters?: boolean
}

function rawRelease(group: GroupSpec, spec: ReleaseSpec): RawRelease & { "artist-credit"?: RawArtistCredit[] } {
    return {
        id: spec.id,
        title: spec.title ?? group.title,
        status: spec.status ?? "Official",
        date: spec.date,
        barcode: spec.barcode ?? null,
        disambiguation: spec.disambiguation,
        media: [{ format: spec.format ?? "Digital Media" }],
        "release-group": { id: group.id, title: group.title, "primary-type": group.primary ?? "Album", "secondary-types": group.secondary ?? [] },
        "artist-credit": credit(group.artist ?? "Artist")
    };
}

export class StubRepo {
    readonly calls: Array<{ path: string, query: string }> = [];
    constructor(private readonly world: World) {}

    async request<T>(path: string, params: { query?: string | number }): Promise<T> {
        const query = String(params.query ?? "");
        this.calls.push({ path, query });
        const { world } = this;
        const filtered = world.serverFilters !== false;

        if (path === "/release-group") {
            return {
                "release-groups": world.groups.map((group): RawReleaseGroup => ({
                    id: group.id,
                    title: group.title,
                    "primary-type": group.primary ?? "Album",
                    "secondary-types": group.secondary ?? [],
                    "first-release-date": group.date,
                    "artist-credit": credit(group.artist ?? "Artist"),
                    releases: (group.releases ?? []).map((release) => ({ id: release.id, title: release.title ?? group.title, status: release.status ?? "Official" }))
                }))
            } as T;
        }

        if (path === "/release") {
            const releases = world.groups.flatMap((group) => (group.releases ?? []).map((spec) => ({ group, spec })));
            let hits = releases;
            const list = (field: string) => new RegExp(`${field}:\\(([^)]*)\\)`).exec(query)?.[1]?.split(" OR ").map((item) => item.trim());
            const rgids = list("rgid");
            const reids = list("reid");
            const barcodes = list("barcode");
            if (rgids) hits = hits.filter(({ group }) => rgids.includes(group.id));
            if (reids) hits = hits.filter(({ spec }) => reids.includes(spec.id));
            if (barcodes) hits = hits.filter(({ spec }) => spec.barcode !== undefined && barcodes.includes(spec.barcode));
            if (filtered && query.includes("status:official")) hits = hits.filter(({ spec }) => (spec.status ?? "Official") === "Official");
            if (filtered && query.includes('format:"Digital Media"')) hits = hits.filter(({ spec }) => (spec.format ?? "Digital Media") === "Digital Media");
            return { releases: hits.map(({ group, spec }) => rawRelease(group, spec)), count: hits.length } as T;
        }

        if (path === "/recording") {
            const isrc = /^isrc:(\S+)/.exec(query)?.[1];
            const recordings = (world.recordings ?? []).filter((recording) => !isrc || (recording.isrcs ?? []).includes(isrc));
            return {
                recordings: recordings.map((recording): RawRecording => ({
                    id: recording.id,
                    title: recording.title,
                    disambiguation: recording.disambiguation,
                    length: recording.length,
                    isrcs: recording.isrcs,
                    "first-release-date": recording.date,
                    "artist-credit": credit(recording.artist ?? "Artist"),
                    releases: recording.on.map(({ group, release }) => {
                        const spec = world.groups.find((candidate) => candidate.id === group)!;
                        return rawRelease(spec, release);
                    })
                }))
            } as T;
        }

        if (path === "/artist") return { artists: world.artists ?? [] } as T;
        throw new Error(`stub: unexpected request ${path}`);
    }
}

export function stubDeps(world: World, options: { covered?: string[], config?: Partial<SearchConfig>, log?: (message: string) => void } = {}): SearchDeps & { repo: StubRepo } {
    const covered = new Set(options.covered ?? []);
    return {
        repo: new StubRepo(world),
        cover: { hasFront: async ({ releaseId, releaseGroupId }) => covered.has(releaseId ?? "") || covered.has(releaseGroupId ?? "") },
        config: { ...DEFAULT_SEARCH_CONFIG, ...options.config },
        log: options.log
    };
}

/** A release-group with one Official digital release. */
export function album(id: string, title: string, who: RawArtist | string = "Artist", extra: Partial<GroupSpec> = {}): GroupSpec {
    return { id, title, artist: who, date: "2000-01-01", releases: [{ id: `${id}-r1`, date: "2000-01-01" }], ...extra };
}

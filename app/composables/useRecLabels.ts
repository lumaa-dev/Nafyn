// the words of the recommender, in the interface's language: mix titles from their structured label
// (the server only sends an English fallback), and why a card or a mix track is there.
import type { MixLabel } from "~~/server/utils/recommender/mixes/types";

export interface RecExplanation {
    kind: "none" | "because_artist" | "from_mix" | "new_release" | "rediscover" | "recently_played" | "similar_to_recent",
    subject?: string
}

export type MixTrackReason =
    | { kind: "familiar", plays: number, lastPlayedAt: number | null }
    | { kind: "novel", via: "collaborative" | "audio" | "text" | "graph", seedArtist: string | null, fit: number };

function capitalize(text: string): string {
    return text.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

export function useRecLabels() {
    const { t } = useI18n();

    function part(kind: MixLabel["kind"], value: string): string {
        switch (kind) {
            case "genre": return capitalize(value);
            case "decade": return value;
            case "mood": return t(`mix.mood.${value}`);
            case "time": return t(`mix.time.${value}`);
            case "artist": return value;
        }
    }

    function mixTitle(label: MixLabel | undefined | null, fallback = ""): string {
        if (!label) return fallback;
        const main = label.kind === "artist" ? t("mix.title.artist", { value: label.value }) : t("mix.title.default", { value: part(label.kind, label.value) });
        return label.qualifier ? t("mix.title.qualified", { main, qualifier: part(label.qualifier.kind, label.qualifier.value) }) : main;
    }

    function explanation(e: RecExplanation | null | undefined): string | null {
        if (!e || e.kind === "none") return null;
        return t(`forYou.why.${e.kind}`, { subject: e.subject ?? "" });
    }

    function trackReason(r: MixTrackReason): string {
        if (r.kind === "familiar") return r.plays > 0 ? t("mix.reason.familiarPlays", { n: r.plays }, r.plays) : t("mix.reason.familiar");
        if (r.seedArtist) return t("mix.reason.novelArtist", { artist: r.seedArtist });
        return t(`mix.reason.novel.${r.via}`);
    }

    return { mixTitle, explanation, trackReason };
}

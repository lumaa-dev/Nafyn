// Link previews of a public playlist: the Open Graph tags every crawler reads, and the Discord component embed
// (https://docs.discord.com/developers/link-previews/component-embeds) that replaces Discord's own card.
//
// Pure (no Nuxt auto-imports), so it runs under `bun test`. The page renders both server-side, because the
// crawlers do not run scripts.
import { parseCoverArtUrl, coverArchiveUrl } from "../../server/utils/coverUrl";

// Discord drops the whole embed past 3,000 bytes, escape sequences counted at their written length
export const DISCORD_EMBED_MAX_BYTES = 3000;

const MAX_LISTED_TRACKS = 5;
const MAX_DESCRIPTION = 300;

export interface PlaylistEmbedLabels {
    /** "By {owner}" */
    owner: string,
    /** "12 tracks" */
    trackCount: string,
    /** "and 7 more", given the number of tracks left out of the list */
    more: (count: number) => string,
    /** the link button's text */
    open: string
}

export interface PlaylistEmbedInput {
    id: string,
    title: string,
    description: string | null,
    /** the uploaded cover's version (`playlists.image`), null when there is none */
    image: string | null,
    ownerName: string | null,
    trackTotal: number,
    /** the first tracks, in playlist order */
    tracks: { title: string, artistName: string, coverArt: string | null }[],
    /** `https://host`, no trailing slash */
    origin: string,
    labels: PlaylistEmbedLabels
}

export interface PlaylistEmbed {
    url: string,
    title: string,
    description: string,
    /** absolute, reachable without a login; null when nothing public can stand in for a cover */
    image: string | null,
    /** the JSON for `<script id="discord:component-embed">`, already safe to put inside a script element */
    discordEmbed: string
}

// Discord reads markdown in a Text Display: a playlist called "*mix*" must not turn italic, and a track called
// "@everyone" must not look like a mention
export function escapeDiscordMarkdown(text: string): string {
    return text
        .replace(/[\\*_~`|>#[\]()-]/g, "\\$&")
        .replace(/@/g, "@\u200b")
        .replace(/\s+/g, " ")
        .trim();
}

export function embedClip(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// `<` must not be able to close the script element (`</script>`); written as an escape it still counts in full
export function embedScriptSafeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function embedByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

// a public image for the link preview: the uploaded cover, otherwise the first track's Cover Art Archive cover.
// Nafyn's own cover endpoints need a login, which a crawler does not have.
function previewImage(input: PlaylistEmbedInput): string | null {
    if (input.image) return `${input.origin}/api/v1/playlist/${encodeURIComponent(input.id)}/image?v=${encodeURIComponent(input.image)}`;

    for (const track of input.tracks) {
        const cover = track.coverArt ? parseCoverArtUrl(track.coverArt) : null;
        if (cover) return coverArchiveUrl(cover.kind, cover.id, 500);
    }
    return null;
}

function plainDescription(input: PlaylistEmbedInput): string {
    const facts = [input.ownerName ? input.labels.owner : null, input.labels.trackCount].filter(Boolean).join(" · ");
    const text = input.description?.replace(/\s+/g, " ").trim();
    return embedClip(text ? text : facts, MAX_DESCRIPTION);
}

function buildDiscordPayload(input: PlaylistEmbedInput, url: string, image: string | null, listed: number, descriptionMax: number): string {
    const { labels } = input;
    const facts = [input.ownerName ? labels.owner : null, labels.trackCount].filter(Boolean).join(" · ");
    const description = descriptionMax > 0 ? input.description?.replace(/\s+/g, " ").trim() : null;

    const heading = [
        `## ${escapeDiscordMarkdown(embedClip(input.title, 100))}`,
        description ? escapeDiscordMarkdown(embedClip(description, descriptionMax)) : null,
        `-# ${escapeDiscordMarkdown(facts)}`
    ].filter(Boolean).join("\n");

    const components: unknown[] = [
        image
            ? { type: 9, components: [{ type: 10, content: heading }], accessory: { type: 11, media: { url: image } } }
            : { type: 10, content: heading }
    ];

    if (listed > 0) {
        const lines = input.tracks.slice(0, listed).map((track, i) => {
            return `${i + 1}. **${escapeDiscordMarkdown(embedClip(track.title, 60))}** - ${escapeDiscordMarkdown(embedClip(track.artistName, 40))}`;
        });
        const left = input.trackTotal - lines.length;
        if (left > 0) lines.push(`-# ${escapeDiscordMarkdown(labels.more(left))}`);

        components.push({ type: 14, divider: true, spacing: 1 }, { type: 10, content: lines.join("\n") });
    }

    components.push({
        type: 1,
        components: [{ type: 2, style: 5, label: embedClip(labels.open, 80), url }]
    });

    return embedScriptSafeJson({ type: 17, components });
}

export function buildPlaylistEmbed(input: PlaylistEmbedInput): PlaylistEmbed {
    const url = `${input.origin}/l/playlist/${encodeURIComponent(input.id)}`;
    const image = previewImage(input);

    // shrink until it fits: fewer listed tracks first, then a shorter description, then no list at all
    const attempts: [number, number][] = [];
    for (let listed = Math.min(MAX_LISTED_TRACKS, input.tracks.length); listed >= 0; listed--) attempts.push([listed, MAX_DESCRIPTION]);
    attempts.push([0, 120], [0, 0]);

    let discordEmbed = "";
    for (const [listed, descriptionMax] of attempts) {
        discordEmbed = buildDiscordPayload(input, url, image, listed, descriptionMax);
        if (embedByteLength(discordEmbed) <= DISCORD_EMBED_MAX_BYTES) break;
    }

    return { url, title: input.title, description: plainDescription(input), image, discordEmbed };
}

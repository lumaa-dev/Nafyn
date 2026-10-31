// Link previews of a public profile page: the Open Graph tags crawlers read and the Discord component embed
// (https://docs.discord.com/developers/link-previews/component-embeds). Same shape and same rules as
// playlistEmbed.ts, which it borrows its escaping and size handling from.
//
// Pure (no Nuxt auto-imports), so it runs under `bun test`.
import { DISCORD_EMBED_MAX_BYTES, embedByteLength, embedClip, escapeDiscordMarkdown, embedScriptSafeJson } from "./playlistEmbed";

const MAX_LISTED_PLAYLISTS = 5;
const MAX_DESCRIPTION = 300;

export interface ProfileEmbedLabels {
    /** "1,204 tracks" */
    trackCount: string,
    /** "3 public playlists" */
    playlistCount: string,
    /** "and 2 more", given how many playlists were left out of the list */
    more: (count: number) => string,
    /** "12 tracks" for one playlist in the list */
    playlistTracks: (count: number) => string,
    /** the link button's text */
    open: string
}

export interface ProfileEmbedInput {
    username: string,
    displayName: string | null,
    /** the avatar's version token (`users.avatar`), null when there is none */
    avatar: string | null,
    userId: string,
    trackTotal: number,
    playlists: { id: string, title: string, trackCount: number, image: string | null }[],
    /** `https://host`, no trailing slash */
    origin: string,
    labels: ProfileEmbedLabels
}

export interface ProfileEmbed {
    url: string,
    title: string,
    description: string,
    /** absolute, reachable without a login; null when there is no picture to show */
    image: string | null,
    /** the JSON for `<script id="discord:component-embed">`, already safe to put inside a script element */
    discordEmbed: string
}

// the avatar if there is one, otherwise the cover of the first public playlist that has an uploaded one
function previewImage(input: ProfileEmbedInput): string | null {
    if (input.avatar) return `${input.origin}/api/v1/user/${encodeURIComponent(input.userId)}/avatar?v=${encodeURIComponent(input.avatar)}`;

    const withImage = input.playlists.find((playlist) => playlist.image);
    return withImage ? `${input.origin}/api/v1/playlist/${encodeURIComponent(withImage.id)}/image?v=${encodeURIComponent(withImage.image!)}` : null;
}

function facts(input: ProfileEmbedInput): string {
    return [`@${input.username}`, input.labels.trackCount, input.playlists.length > 0 ? input.labels.playlistCount : null].filter(Boolean).join(" · ");
}

function buildDiscordPayload(input: ProfileEmbedInput, url: string, image: string | null, listed: number): string {
    const { labels } = input;
    const name = input.displayName ?? input.username;

    const heading = [
        `## ${escapeDiscordMarkdown(embedClip(name, 100))}`,
        `-# ${escapeDiscordMarkdown(facts(input))}`
    ].join("\n");

    const components: unknown[] = [
        image
            ? { type: 9, components: [{ type: 10, content: heading }], accessory: { type: 11, media: { url: image } } }
            : { type: 10, content: heading }
    ];

    if (listed > 0) {
        const lines = input.playlists.slice(0, listed).map((playlist, i) => {
            return `${i + 1}. **${escapeDiscordMarkdown(embedClip(playlist.title, 60))}** - ${escapeDiscordMarkdown(labels.playlistTracks(playlist.trackCount))}`;
        });
        const left = input.playlists.length - lines.length;
        if (left > 0) lines.push(`-# ${escapeDiscordMarkdown(labels.more(left))}`);

        components.push({ type: 14, divider: true, spacing: 1 }, { type: 10, content: lines.join("\n") });
    }

    components.push({
        type: 1,
        components: [{ type: 2, style: 5, label: embedClip(labels.open, 80), url }]
    });

    return embedScriptSafeJson({ type: 17, components });
}

export function buildProfileEmbed(input: ProfileEmbedInput): ProfileEmbed {
    const url = `${input.origin}/u/${encodeURIComponent(input.username)}`;
    const image = previewImage(input);

    // shrink until it fits: fewer listed playlists first, then none at all
    let discordEmbed = "";
    for (let listed = Math.min(MAX_LISTED_PLAYLISTS, input.playlists.length); listed >= 0; listed--) {
        discordEmbed = buildDiscordPayload(input, url, image, listed);
        if (embedByteLength(discordEmbed) <= DISCORD_EMBED_MAX_BYTES) break;
    }

    return {
        url,
        title: input.displayName ?? input.username,
        description: embedClip(facts(input), MAX_DESCRIPTION),
        image,
        discordEmbed
    };
}

import { describe, expect, test } from "bun:test";
import { buildPlaylistEmbed, DISCORD_EMBED_MAX_BYTES, escapeDiscordMarkdown, type PlaylistEmbedInput } from "../app/utils/playlistEmbed";

const ID = "57d337a3-b4d2-4936-8daf-bb19c2ccbf14";

function input(patch: Partial<PlaylistEmbedInput> = {}): PlaylistEmbedInput {
    return {
        id: "p1",
        title: "Road trip",
        description: "Windows down",
        image: null,
        ownerName: "Lumaa",
        trackTotal: 2,
        tracks: [
            { title: "One", artistName: "A", coverArt: `https://coverartarchive.org/release/${ID}/front-250` },
            { title: "Two", artistName: "B", coverArt: null }
        ],
        origin: "https://nafyn.example",
        labels: { owner: "By Lumaa", trackCount: "2 tracks", more: (n) => `and ${n} more`, open: "Open in Nafyn" },
        ...patch
    };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("playlist link preview", () => {
    test("url, and the cover falls back to a public archive cover", () => {
        const embed = buildPlaylistEmbed(input());
        expect(embed.url).toBe("https://nafyn.example/l/playlist/p1");
        expect(embed.image).toBe(`https://coverartarchive.org/release/${ID}/front-500`);
        expect(embed.description).toBe("Windows down");
    });

    test("an uploaded cover wins and carries its version", () => {
        expect(buildPlaylistEmbed(input({ image: "abc" })).image).toBe("https://nafyn.example/api/v1/playlist/p1/image?v=abc");
    });

    test("no public cover, no image, and the embed has no thumbnail", () => {
        const embed = buildPlaylistEmbed(input({ tracks: [{ title: "One", artistName: "A", coverArt: null }] }));
        expect(embed.image).toBeNull();
        expect(JSON.parse(embed.discordEmbed).components[0].type).toBe(10);
    });

    test("payload is one container with only allowed components, a link button", () => {
        const root = JSON.parse(buildPlaylistEmbed(input()).discordEmbed);
        expect(root.type).toBe(17);
        const types = (list: { type: number, components?: unknown[], accessory?: { type: number } }[]): number[] => list.flatMap((c) => [c.type, ...types((c.components ?? []) as never), ...(c.accessory ? [c.accessory.type] : [])]);
        for (const t of types(root.components)) expect([1, 2, 9, 10, 11, 12, 14]).toContain(t);
        const button = root.components.at(-1).components[0];
        expect(button).toEqual({ type: 2, style: 5, label: "Open in Nafyn", url: "https://nafyn.example/l/playlist/p1" });
    });

    test("stays within Discord's limit however long the text", () => {
        const long = "é".repeat(500);
        const embed = buildPlaylistEmbed(input({
            title: long, description: long, trackTotal: 900,
            tracks: Array.from({ length: 20 }, () => ({ title: long, artistName: long, coverArt: null }))
        }));
        expect(bytes(embed.discordEmbed)).toBeLessThanOrEqual(DISCORD_EMBED_MAX_BYTES);
        expect(() => JSON.parse(embed.discordEmbed)).not.toThrow();
    });

    test("cannot close the script element", () => {
        const embed = buildPlaylistEmbed(input({ title: "</script><b>" }));
        expect(embed.discordEmbed).not.toContain("<");
        expect(JSON.parse(embed.discordEmbed).components[0].components[0].content).toContain("</script");
    });

    test("markdown and mentions are neutralised", () => {
        expect(escapeDiscordMarkdown("*mix* _1_ [x](y)")).toBe("\\*mix\\* \\_1\\_ \\[x\\]\\(y\\)");
        expect(escapeDiscordMarkdown("@everyone")).not.toBe("@everyone");
    });
});

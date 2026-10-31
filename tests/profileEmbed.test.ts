import { describe, expect, test } from "bun:test";
import { DISCORD_EMBED_MAX_BYTES } from "../app/utils/playlistEmbed";
import { buildProfileEmbed, type ProfileEmbedInput } from "../app/utils/profileEmbed";

function input(patch: Partial<ProfileEmbedInput> = {}): ProfileEmbedInput {
    return {
        username: "lumaa",
        displayName: "Lumaa",
        avatar: "123",
        userId: "u-1",
        trackTotal: 42,
        playlists: [
            { id: "p1", title: "Road trip", trackCount: 12, image: null },
            { id: "p2", title: "Night", trackCount: 3, image: "v9" }
        ],
        origin: "https://nafyn.example",
        labels: {
            trackCount: "42 tracks",
            playlistCount: "2 public playlists",
            more: (n) => `and ${n} more`,
            playlistTracks: (n) => `${n} tracks`,
            open: "Open profile"
        },
        ...patch
    };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("profile link preview", () => {
    test("url, title and a description made of the facts", () => {
        const embed = buildProfileEmbed(input());
        expect(embed.url).toBe("https://nafyn.example/u/lumaa");
        expect(embed.title).toBe("Lumaa");
        expect(embed.description).toBe("@lumaa · 42 tracks · 2 public playlists");
    });

    test("the avatar is the image, carrying its version", () => {
        expect(buildProfileEmbed(input()).image).toBe("https://nafyn.example/api/v1/user/u-1/avatar?v=123");
    });

    test("no avatar: the first uploaded playlist cover stands in, and none means no image", () => {
        expect(buildProfileEmbed(input({ avatar: null })).image).toBe("https://nafyn.example/api/v1/playlist/p2/image?v=v9");
        expect(buildProfileEmbed(input({ avatar: null, playlists: [] })).image).toBeNull();
    });

    test("without a display name the username is the title", () => {
        expect(buildProfileEmbed(input({ displayName: null })).title).toBe("lumaa");
    });

    test("the discord payload is a container with a link button, safe inside a script element", () => {
        const payload = JSON.parse(buildProfileEmbed(input({ displayName: "</script><b>" })).discordEmbed);
        expect(payload.type).toBe(17);
        const last = payload.components.at(-1);
        expect(last.components[0]).toMatchObject({ type: 2, style: 5, url: "https://nafyn.example/u/lumaa" });
        expect(buildProfileEmbed(input({ displayName: "</script>" })).discordEmbed).not.toContain("</script>");
    });

    test("markdown in a name cannot style or mention", () => {
        const text = buildProfileEmbed(input({ displayName: "*@everyone*" })).discordEmbed;
        expect(text).not.toContain("@everyone");
    });

    test("a profile with dozens of long playlists still fits Discord's limit", () => {
        const playlists = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, title: "x".repeat(200), trackCount: i, image: null }));
        const embed = buildProfileEmbed(input({ playlists }));
        expect(bytes(embed.discordEmbed)).toBeLessThanOrEqual(DISCORD_EMBED_MAX_BYTES);
    });
});

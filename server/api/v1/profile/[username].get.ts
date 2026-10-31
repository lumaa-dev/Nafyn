// a user's public profile: who they are, how many tracks their library holds and the public playlists they own.
// Readable without a login, like a public playlist. Nothing here that identifies anything beyond what the user
// put on their own profile (permissions, e-mail-like data and private playlists never leave).
import { getUserByUsername } from "~~/server/core/users";
import { countMediaOfUser } from "~~/server/core/library";
import { listPublicPlaylistsOwnedBy } from "~~/server/core/playlists";
import { assertValidUsername } from "~~/server/utils/validation";

defineRouteMeta({
    openAPI: {
        description: "Public profile of a user, by username: display name, avatar version, Last.fm / Discogs handles, the total number of tracks in their library and their public playlists. No authentication needed",
        tags: ["users"],
        operationId: "getProfile",
        parameters: [
            { name: "username", in: "path", required: true, description: "Username (not the display name)", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["id", "username", "displayName", "avatar", "trackCount", "playlists"],
                            properties: {
                                id: { type: "string" },
                                username: { type: "string" },
                                displayName: { type: "string", nullable: true },
                                avatar: { type: "string", nullable: true, description: "Avatar version token; the image is at /api/v1/user/{id}/avatar" },
                                lastFm: { type: "string", nullable: true },
                                discogs: { type: "string", nullable: true },
                                trackCount: { type: "number", description: "Tracks in their library" },
                                playlists: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        required: ["id", "title", "trackCount"],
                                        properties: {
                                            id: { type: "string" },
                                            title: { type: "string" },
                                            description: { type: "string", nullable: true },
                                            image: { type: "string", nullable: true, description: "Cover version token" },
                                            trackCount: { type: "number" },
                                            updatedAt: { type: "number" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "400": { description: "Not a valid username", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such user", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const username = getRouterParam(event, "username") ?? "";
    assertValidUsername(username);

    const user = await getUserByUsername(username);
    if (!user) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    const [trackCount, playlists] = await Promise.all([
        countMediaOfUser(user.id),
        listPublicPlaylistsOwnedBy(user.id)
    ]);

    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        lastFm: user.lastFm,
        discogs: user.discogs,
        trackCount,
        playlists
    };
});

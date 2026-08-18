// manual reorder, owner-only
import { getPlaylistById, getEntries, reorderEntries } from "~~/server/core/playlists";

defineRouteMeta({
    openAPI: {
        description: "Manually reorder a playlist's entries. Owner only",
        tags: ["playlist"],
        operationId: "reorderPlaylist",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["order"],
                        properties: {
                            order: {
                                type: "array",
                                description: "Every entry ID currently in the playlist, in the desired order",
                                items: { type: "string" }
                            }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["reordered"],
                            properties: {
                                reordered: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing playlist ID, or `order` doesn't exactly match the playlist's current entry IDs",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "403": {
                description: "Only the playlist owner can reorder tracks",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    if (playlist.ownerId !== userId) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can reorder tracks" });
    }

    const body = await readBody(event);
    const order: unknown = body?.order;
    if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
        throw createError({ statusCode: 400, statusMessage: "`order` must be an array of entry IDs" });
    }

    const existingIds = new Set((await getEntries(pid)).map((e) => e.entryId));
    if (order.length !== existingIds.size || !order.every((id) => existingIds.has(id))) {
        throw createError({ statusCode: 400, statusMessage: "`order` must contain exactly the playlist's current entry IDs" });
    }

    await reorderEntries(pid, order);

    return { reordered: true };
});

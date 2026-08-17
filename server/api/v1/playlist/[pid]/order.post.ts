// manual reorder, owner-only
import { getPlaylistById, getEntries, reorderEntries } from "~~/server/core/playlists";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = getPlaylistById(pid);
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

    const existingIds = new Set(getEntries(pid).map((e) => e.entryId));
    if (order.length !== existingIds.size || !order.every((id) => existingIds.has(id))) {
        throw createError({ statusCode: 400, statusMessage: "`order` must contain exactly the playlist's current entry IDs" });
    }

    reorderEntries(pid, order);

    return { reordered: true };
});

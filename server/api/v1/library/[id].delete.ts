import { deleteLibraryEntryForUser } from "~~/server/core/library";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    const { removed, fileDeleted } = await deleteLibraryEntryForUser(userId, mediaId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    return { removed, fileDeleted };
});

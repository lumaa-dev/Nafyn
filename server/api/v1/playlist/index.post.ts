import { createPlaylist } from "~~/server/core/playlists";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const body = await readBody(event);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const privacy = body?.privacy === "public" ? "public" : "private";

    if (title.length < 1 || title.length > 100) {
        throw createError({ statusCode: 400, statusMessage: "Title must be between 1 and 100 characters" });
    }

    return createPlaylist(userId, title, description || null, privacy);
});

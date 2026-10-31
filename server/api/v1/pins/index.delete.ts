import { isPinKind, removePin } from "~~/server/core/pins";
import { requireAuthToken } from "~~/server/utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "Unpin an album, playlist or track. Idempotent",
        tags: ["pins"],
        operationId: "unpin",
        parameters: [
            { name: "kind", in: "query", required: true, description: "album, playlist or track", schema: { type: "string", enum: ["album", "playlist", "track"] } },
            { name: "refId", in: "query", required: true, description: "Media ID (track), release-group MBID (album) or playlist ID", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", properties: { pinned: { type: "boolean" } } } } } },
            "400": { description: "Missing or invalid kind / refId", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const { kind, refId } = getQuery(event);
    if (!isPinKind(kind) || typeof refId !== "string" || refId.length === 0 || refId.length > 64) {
        throw createError({ statusCode: 400, statusMessage: "`kind` (album, playlist or track) and `refId` are required" });
    }

    await removePin(userId, kind, refId);
    return { pinned: false };
});

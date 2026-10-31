import { addPin, canPin, isPinKind } from "~~/server/core/pins";
import { requireAuthToken } from "~~/server/utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "Pin an album, playlist or track. Idempotent. The caller must be able to see the target: a track or album in their library, a playlist they own, were invited to, or that is public",
        tags: ["pins"],
        operationId: "pin",
        requestBody: {
            required: true,
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["kind", "refId"],
                        properties: {
                            kind: { type: "string", enum: ["album", "playlist", "track"] },
                            refId: { type: "string", description: "Media ID (track), release-group MBID (album) or playlist ID" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", properties: { pinned: { type: "boolean" } } } } } },
            "400": { description: "Missing or invalid kind / refId", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Nothing like that in the caller's library", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const body = await readBody(event).catch(() => null);
    const kind: unknown = body?.kind;
    const refId: unknown = body?.refId;
    if (!isPinKind(kind) || typeof refId !== "string" || refId.length === 0 || refId.length > 64) {
        throw createError({ statusCode: 400, statusMessage: "`kind` (album, playlist or track) and `refId` are required" });
    }

    if (!await canPin(userId, kind, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Nothing to pin: it is not in your library" });
    }

    await addPin(userId, kind, refId);
    return { pinned: true };
});

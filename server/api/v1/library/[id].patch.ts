// PATCH /api/v1/library/{id} - rewrite a track's metadata by hand (works on Soulseek downloads and manual
// imports alike). The `media` row is shared between every user who owns the track, so an edit is visible to
// all of them - which is why MANAGE_MUSIC can edit any row while an ordinary user can only edit their own.
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { findLibraryEntry, getMediaId } from "~~/server/core/library";
import { applyMediaEdit, type MediaEdit } from "~~/server/core/mediaEdit";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { isAllowedCoverArtUrl } from "~~/server/utils/coverArt";

defineRouteMeta({
    openAPI: {
        description: "Edit the metadata of a track in the requesting user's library",
        tags: ["library"],
        operationId: "editTrackMetadata",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        requestBody: {
            required: true,
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            title: { type: "string" },
                            artistName: { type: "string" },
                            album: { type: "string", nullable: true },
                            albumType: { type: "string", enum: ["album", "ep"], nullable: true },
                            releaseDate: { type: "number", nullable: true, description: "Unix seconds" },
                            duration: { type: "number", description: "Seconds" },
                            label: { type: "string", nullable: true },
                            trackNumber: { type: "number", nullable: true },
                            coverArt: { type: "string", nullable: true, description: "Cover Art Archive URL; uploaded covers go through PUT /library/{id}/cover" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "The updated media row",
                content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRow" } } }
            },
            "400": {
                description: "Invalid field value",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "401": {
                description: "Not authenticated",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "404": {
                description: "Track not found in your library",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

function text(value: unknown, field: string, max: number = 500): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw createError({ statusCode: 400, statusMessage: `\`${field}\` must be a non-empty string` });
    }
    return value.trim().slice(0, max);
}

function nullableText(value: unknown, field: string, max: number = 500): string | null {
    if (value === null) return null;
    return text(value, field, max);
}

function number(value: unknown, field: string): number {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num) || num < 0) {
        throw createError({ statusCode: 400, statusMessage: `\`${field}\` must be a positive number` });
    }
    return Math.round(num);
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    const media = await getMediaId(mediaId);
    if (!media) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    const owns = await findLibraryEntry(userId, mediaId) != null;
    if (!owns) {
        // SECURITY: a media row the caller neither owns nor manages is reported as absent, same as every
        // other /library route, so this can't be used to probe which media IDs exist
        if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
            throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
        }
    }

    const body = await readBody(event).catch(() => null);
    if (!body || typeof body !== "object") {
        throw createError({ statusCode: 400, statusMessage: "Expected a JSON body" });
    }

    const edit: MediaEdit = {};
    if (body.title !== undefined) edit.title = text(body.title, "title");
    if (body.artistName !== undefined) edit.artistName = text(body.artistName, "artistName");
    if (body.album !== undefined) edit.album = nullableText(body.album, "album");
    if (body.label !== undefined) edit.label = nullableText(body.label, "label");
    if (body.duration !== undefined) edit.duration = number(body.duration, "duration");
    if (body.trackNumber !== undefined) edit.trackNumber = body.trackNumber === null ? null : number(body.trackNumber, "trackNumber");
    if (body.releaseDate !== undefined) edit.releaseDate = body.releaseDate === null ? null : number(body.releaseDate, "releaseDate");

    if (body.albumType !== undefined) {
        const albumType = body.albumType === null ? null : String(body.albumType).toLowerCase();
        if (albumType !== null && albumType !== "album" && albumType !== "ep") {
            throw createError({ statusCode: 400, statusMessage: "`albumType` must be \"album\", \"ep\" or null" });
        }
        edit.albumType = albumType;
    }

    if (body.coverArt !== undefined) {
        // SECURITY: `coverArt` is fetched server-side by Subsonic's getCoverArt, so a user-writable value
        // here is an SSRF sink. Only URLs the proxy is already allowed to reach may be stored; a cover of
        // the user's own goes to PUT /library/{id}/cover, which never touches this column.
        if (body.coverArt === null) {
            edit.coverArt = null;
        } else {
            const url = text(body.coverArt, "coverArt", 2000);
            if (!isAllowedCoverArtUrl(url)) {
                throw createError({ statusCode: 400, statusMessage: "`coverArt` must be a Cover Art Archive URL - upload your own cover instead" });
            }
            edit.coverArt = url;
        }
    }

    const updated = await applyMediaEdit(mediaId, edit);
    if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    return updated;
});

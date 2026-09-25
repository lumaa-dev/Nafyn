// who may change a shared `media` row (metadata, uploaded cover, lyrics).
import { findLibraryEntry, getMediaId, isMediaSharedWithOthers, type MediaRow } from "../core/library";
import { getPermissionsById } from "../core/users";
import { hasPermission, Permission } from "../entity/Permission";

// SECURITY: a `media` row - and the file behind it - is one copy shared by every user who has the track, so
// an edit made through one library shows up in all of them. Letting any co-owner edit meant any account
// could rename, re-cover or re-lyric a track sitting in someone else's library just by adding it to its own
// first. An ordinary user may therefore only change a track nobody else has; a shared one takes
// MANAGE_MUSIC, which already edits any row.
//
// A row the caller neither owns nor manages is reported as absent (404), same as every other /library route,
// so this can't be used to probe which media IDs exist.
export async function requireEditableMedia(userId: string, mediaId: string | undefined): Promise<MediaRow> {
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    const media = await getMediaId(mediaId);
    if (!media) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    if (hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        return media;
    }

    if (!await findLibraryEntry(userId, mediaId)) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    if (await isMediaSharedWithOthers(userId, mediaId)) {
        throw createError({ statusCode: 403, statusMessage: "This track is shared with other users - only a music manager can edit it" });
    }

    return media;
}

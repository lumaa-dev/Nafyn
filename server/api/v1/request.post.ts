import type { UUID } from "crypto";
import { processDownloadRequest } from "~~/server/core/downloads";
import { createRequest } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { DiscyRequest } from "~~/server/entity/DiscyRequest";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const body = await readBody(event);
    const mbId: string | null = typeof body?.id == "string" ? body?.id : null;
    const type: string | null = typeof body?.type == "string" ? body?.type : null

    if (!mbId) {
        throw createError({ statusCode: 400, message: "Incorrect MusicBrainz ID" })
    }

    if (type !== "album" && type !== "track") {
        throw createError({ statusCode: 400, message: "Incorrect media type" })
    }

    let permcount: number = getPermissionsById(userId) ?? 0
    let autoAccept: boolean = hasPermission(permcount, type == "album" ? Permission.AUTOACCEPT_ALBUMS : Permission.AUTOACCEPT_TRACKS);

    let newRequest: DiscyRequest = await createRequest(mbId as UUID, type, userId as UUID, autoAccept ? "searching" : "waiting");
    if (autoAccept) {
        processDownloadRequest(newRequest);
    }

    return newRequest
})
// removes a specific user's library entry for a track; only MANAGE_MUSIC (managing someone else) or the owner themselves
import { deleteLibraryEntryForUser } from "~~/server/core/library";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Remove a track from a specific user's library. Only that user themselves, or a MANAGE_MUSIC user, may do this",
        tags: ["library"],
        operationId: "removeUserLibraryTrack",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Media ID",
                schema: { type: "string" }
            },
            {
                name: "userId",
                in: "path",
                required: true,
                description: "ID of the user whose library entry is being removed",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["removed", "fileDeleted"],
                            properties: {
                                removed: { type: "boolean" },
                                fileDeleted: { type: "boolean", description: "Whether the underlying file was deleted (no other user referenced it anymore)" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing media or user ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_MUSIC permission",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Track not found in that user's library",
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
    const { sub: actorId } = requireAuthToken(event);

    const mediaId = getRouterParam(event, "id");
    const targetUserId = getRouterParam(event, "userId");
    if (!mediaId || !targetUserId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media or user ID" });
    }

    if (targetUserId !== actorId && !hasPermission(await getPermissionsById(actorId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const { removed, fileDeleted } = await deleteLibraryEntryForUser(targetUserId, mediaId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in that user's library" });
    }

    return { removed, fileDeleted };
});

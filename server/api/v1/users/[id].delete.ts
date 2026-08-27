import { getUserById, deleteUser, getPermissionsById } from "~~/server/core/users";
import { deleteAllLibraryEntriesForUser } from "~~/server/core/library";
import { canManageUser } from "~~/server/entity/Permission";
import { deleteUserHistory } from "~~/server/core/playEvents";
import { deleteInsightSettings } from "~~/server/core/insightsSettings";
import { listYearSnapshots } from "~~/server/core/insightsSnapshot";
import { deleteReelsForUser } from "~~/server/core/insightsReel";

defineRouteMeta({
    openAPI: {
        description: "Delete a user account and revoke all their library entries. Requires ADMIN, or MANAGE_ACCOUNTS against a non-privileged target (see canManageUser)",
        tags: ["users"],
        operationId: "deleteUser",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Target user ID",
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
                            required: ["removed"],
                            properties: {
                                removed: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing user ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or insufficient permissions to manage this user",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "User not found",
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
    const actorPerms = await getPermissionsById(actorId) ?? 0;

    const targetId = getRouterParam(event, "id");
    if (!targetId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const target = await getUserById(targetId);
    if (!target) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    if (!canManageUser(actorId, actorPerms, targetId, target.permissions as unknown as number)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    await deleteAllLibraryEntriesForUser(targetId);

    // listening history is keyed on user_id with no foreign key (deliberately - see insightsSchema.ts), so
    // deleting the account would otherwise leave a full play history behind with nobody to own it
    const snapshots = await listYearSnapshots(targetId);
    await deleteReelsForUser(targetId, snapshots.map((s) => s.year));
    await deleteUserHistory(targetId);
    await deleteInsightSettings(targetId);

    const removed = await deleteUser(targetId);

    return { removed };
});

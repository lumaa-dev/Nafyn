import { getUserById, getPermissionsById } from "~~/server/core/users";
import { canManageUser } from "~~/server/entity/Permission";
import { eraseAccount } from "~~/server/core/accountErasure";

defineRouteMeta({
    openAPI: {
        description: "Permanently erase a user account and every piece of data attached to it: sessions, API tokens, passkeys, invites they issued, settings, library entries, their playlists, recently played and all listening data; download requests they made are kept as operational records with the requester removed. Requires ADMIN, or MANAGE_ACCOUNTS against a non-privileged target (see canManageUser)",
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
                                removed: { type: "boolean" },
                                erased: { type: "object", description: "Per-area count of what was removed" }
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
    const { sub: actorId } = await requireAuthToken(event);
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

    // every table that references a user does so without a foreign key (see the comments in db.ts), so
    // nothing cascades and the deletion has to name every one of them. That list lives in exactly one place
    // - eraseAccount() - shared with the self-service route, so the two can't drift on what "deleted" means
    const erased = await eraseAccount(targetId);

    return { removed: erased.removed, erased };
});

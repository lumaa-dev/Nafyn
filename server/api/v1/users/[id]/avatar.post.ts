import { getUserById, updateUser, getPermissionsById } from "~~/server/core/users";
import { canManageUser } from "~~/server/entity/Permission";
import { saveAvatar } from "~~/server/utils/avatar";

defineRouteMeta({
    openAPI: {
        description: "Upload/replace another user's avatar. Requires ADMIN, or MANAGE_ACCOUNTS against a non-privileged target (see canManageUser)",
        tags: ["users"],
        operationId: "setUserAvatar",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Target user ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        required: ["avatar"],
                        properties: {
                            avatar: { type: "string", format: "binary" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NafynUser" }
                    }
                }
            },
            "400": {
                description: "Missing user ID or `avatar` file",
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

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "avatar");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `avatar` file" });
    }

    await saveAvatar(targetId, file.data);

    return await updateUser(targetId, { avatar: Date.now().toString() });
});

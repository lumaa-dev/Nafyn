import { getUserById, updateUser } from "~~/server/core/users";
import { deleteAvatar } from "~~/server/utils/avatar";

defineRouteMeta({
    openAPI: {
        description: "Remove the currently authenticated user's own avatar",
        tags: ["user"],
        operationId: "deleteMyAvatar",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NafynUser" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
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
    const { sub } = requireAuthToken(event);

    if (!await getUserById(sub)) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    await deleteAvatar(sub);

    return await updateUser(sub, { avatar: null });
});

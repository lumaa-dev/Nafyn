import { getUserById, updateUser } from "~~/server/core/users";
import { saveAvatar } from "~~/server/utils/avatar";

defineRouteMeta({
    openAPI: {
        description: "Upload/replace the currently authenticated user's own avatar",
        tags: ["user"],
        operationId: "setMyAvatar",
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
                description: "Missing `avatar` file",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
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

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "avatar");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `avatar` file" });
    }

    await saveAvatar(sub, file.data);

    // cache-busting token for clients building the avatar URL, actual bytes are always at the same path
    return await updateUser(sub, { avatar: Date.now().toString() });
});

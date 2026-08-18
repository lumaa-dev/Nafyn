import { getUserById } from "../../../core/users";
import { requireAuthToken } from "../../../utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "Get the currently authenticated user's own profile",
        tags: ["user"],
        operationId: "getMe",
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
    const user = await getUserById(sub);
    
    if (!user) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    return user;
});

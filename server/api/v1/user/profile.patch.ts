import { getUserById, updateUser } from "~~/server/core/users";
import type { NafynUser } from "~~/server/entity/NafynUser";

defineRouteMeta({
    openAPI: {
        description: "Update the currently authenticated user's own profile fields",
        tags: ["user"],
        operationId: "updateMyProfile",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            displayName: { type: "string", description: "1-20 characters" },
                            lastFm: { type: "string", nullable: true, description: "Up to 50 characters" },
                            discogs: { type: "string", nullable: true, description: "Up to 50 characters" }
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
                description: "Invalid field value, or no changes provided",
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

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Must be a string or null" });
    }

    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw createError({ statusCode: 400, statusMessage: `Must be ${maxLength} characters or fewer` });
    }

    return trimmed.length ? trimmed : null;
}

export default defineEventHandler(async (event) => {
    const { sub } = requireAuthToken(event);
    const body = await readBody(event);

    const changes: Partial<Pick<NafynUser, "displayName" | "lastFm" | "discogs">> = {};

    if ("displayName" in body) {
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (displayName.length < 1 || displayName.length > 20) {
            throw createError({ statusCode: 400, statusMessage: "displayName must be between 1 and 20 characters" });
        }
        changes.displayName = displayName;
    }

    if ("lastFm" in body) {
        changes.lastFm = normalizeOptionalText(body.lastFm, 50);
    }

    if ("discogs" in body) {
        changes.discogs = normalizeOptionalText(body.discogs, 50);
    }

    if (Object.keys(changes).length === 0) {
        throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    }

    if (!await getUserById(sub)) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    return await updateUser(sub, changes);
});

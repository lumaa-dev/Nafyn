import { createApiToken, listApiTokensForUser } from "~~/server/core/apiTokens";

const MAX_NAME_LENGTH = 100;
// Subsonic token auth (t=/s=) re-hashes every one of a user's tokens on each request, so an unbounded list is
// both a storage and a per-request CPU cost
const MAX_TOKENS_PER_USER = 25;

defineRouteMeta({
    openAPI: {
        description: "Create a new API token (app password) for the currently authenticated user - currently used for Subsonic auth (server/utils/subsonicAuth.ts). The token's plaintext value is only ever returned in this response; it can't be retrieved again afterward",
        tags: ["user"],
        operationId: "createMyApiToken",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            name: { type: "string", nullable: true, description: `Optional label (e.g. the client app's name), up to ${MAX_NAME_LENGTH} characters` }
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
                        schema: {
                            type: "object",
                            required: ["id", "userId", "name", "token", "createdAt", "lastUsedAt"],
                            properties: {
                                id: { type: "string" },
                                userId: { type: "string" },
                                name: { type: "string", nullable: true },
                                token: { type: "string", description: "Plaintext token value - shown only this once" },
                                createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                                lastUsedAt: { type: "number", nullable: true }
                            }
                        }
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
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const body = await readBody(event).catch(() => null);
    const rawName = typeof body?.name === "string" ? body.name.trim() : "";
    const name = rawName ? rawName.slice(0, MAX_NAME_LENGTH) : null;

    if ((await listApiTokensForUser(userId)).length >= MAX_TOKENS_PER_USER) {
        throw createError({ statusCode: 400, statusMessage: `At most ${MAX_TOKENS_PER_USER} tokens - revoke one first` });
    }

    return await createApiToken(userId, name);
});

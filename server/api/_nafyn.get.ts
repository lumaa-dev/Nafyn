import { randomUUID } from "crypto"
import { isWhitelisted } from "~~/server/utils/rateLimit";

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Verify a URL to check if it's a valid Nafyn website",
        tags: ["Internal"],
        operationId: "checkNafynUrl",
        responses: {
            "200": {
                description: "A working Nafyn URL response",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: {
                                nafyn: {
                                    type: "boolean",
                                    description: "Whether the URL is a valid Nafyn website"
                                },
                                response: {
                                    type: "object",
                                    properties: {
                                        id: {
                                            type: "string",
                                            format: "uuid",
                                            example: "0a31c50b-a400-46d7-b4d6-20ebca3b0b5b"
                                        },
                                        date: {
                                            type: "integer",
                                            format: "int64",
                                            description: "Unix timestamp",
                                            example: 1786462521
                                        }
                                    },
                                    required: ["id", "date"]
                                }
                            },
                            required: ["nafyn", "response"]
                        },
                        example: {
                            nafyn: true,
                            response: {
                                id: "0a31c50b-a400-46d7-b4d6-20ebca3b0b5b",
                                date: 1786462521
                            }
                        }
                    }
                }
            },
            "429": {
                description: "Rate limit error",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/NuxtError"
                        }
                    }
                }
            }
        },
        $global: {
            components: {
                schemas: {
                    NuxtError: {
                        type: "object",
                        required: ["error", "stack", "statusCode", "statusMessage", "url"],
                        properties: {
                            error: {
                                type: "boolean",
                                description: "Always `true`"
                            },
                            message: {
                                type: "string"
                            },
                            stack: {
                                type: "array",
                                description: "Error stack trace"
                            },
                            statusCode: {
                                type: "number"
                            },
                            statusMessage: {
                                type: "string"
                            },
                            url: {
                                type: "string"
                            },
                        },
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
    if (!isWhitelisted(ip)) {
        const rateLimit = consumeRateLimit(`verify:${ip}`, MAX_ATTEMPTS, WINDOW_MS);

        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }


    return {
        nafyn: true,
        response: {
            id: randomUUID(),
            date: Math.floor(Date.now() / 1000)
        }
    }
})
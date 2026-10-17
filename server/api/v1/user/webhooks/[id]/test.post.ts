import { sendTestWebhook } from "~~/server/utils/webhook";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Send a sample message to one of the currently authenticated user's own webhooks, whatever its enabled flag and event filter, and report what the receiving service answered",
        tags: ["user"],
        operationId: "testMyWebhook",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["ok", "error"],
                            properties: { ok: { type: "boolean" }, error: { type: "string", nullable: true } }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No webhook with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many test sends", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

// a test send is an outbound request on demand - keep it from being turned into a request cannon
const MAX_TESTS = 10;
const TEST_WINDOW_MS = 60 * 1000;

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing webhook ID" });
    }

    const rateLimit = consumeRateLimit(`webhook-test:${userId}`, MAX_TESTS, TEST_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many test sends, try again later" });
    }

    const result = await sendTestWebhook(userId, id);
    if (!result.found) {
        throw createError({ statusCode: 404, statusMessage: "No webhook with that ID" });
    }
    return { ok: result.error === null, error: result.error };
});

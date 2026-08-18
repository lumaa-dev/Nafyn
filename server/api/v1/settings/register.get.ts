// public: tells the client (settings page + /register) whether open registration is currently allowed
import { isRegistrationOpen } from "~~/server/core/appSettings";

defineRouteMeta({
    openAPI: {
        description: "Public: whether open registration is currently allowed (no token required at /register)",
        tags: ["settings"],
        operationId: "getRegistrationOpen",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["open"],
                            properties: {
                                open: { type: "boolean" }
                            }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async () => {
    return { open: await isRegistrationOpen() };
});

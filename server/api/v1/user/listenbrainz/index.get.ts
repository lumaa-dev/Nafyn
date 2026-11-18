import { getListenBrainzAccount } from "~~/server/core/listenbrainzAccounts";

defineRouteMeta({
    openAPI: {
        description: "The current user's ListenBrainz connection. `username` is null while no account is connected",
        tags: ["user"],
        operationId: "getListenBrainzConnection",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/ListenBrainzConnection"
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    ListenBrainzConnection: {
                        type: "object",
                        required: ["username", "scrobbling"],
                        properties: {
                            username: { type: "string", nullable: true, description: "The connected ListenBrainz account, null when none" },
                            scrobbling: { type: "boolean", description: "Plays are submitted to ListenBrainz (false when not connected or paused)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const account = await getListenBrainzAccount(userId);
    return { username: account?.username ?? null, scrobbling: !!account?.scrobbling };
});

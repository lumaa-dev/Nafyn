import { getLastfmAccount, lastfmCredentials } from "~~/server/core/lastfmAccounts";

defineRouteMeta({
    openAPI: {
        description: "The current user's Last.fm connection. `available` is false when the instance has no Last.fm API key + secret (scrobbling can't be turned on); `username` is null while no account is connected",
        tags: ["user"],
        operationId: "getLastfmConnection",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/LastfmConnection"
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    LastfmConnection: {
                        type: "object",
                        required: ["available", "username", "scrobbling"],
                        properties: {
                            available: { type: "boolean", description: "The instance can scrobble (LASTFM_API_KEY and LASTFM_API_SECRET set)" },
                            username: { type: "string", nullable: true, description: "The connected Last.fm account, null when none" },
                            scrobbling: { type: "boolean", description: "Plays are scrobbled (false when not connected)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const account = await getLastfmAccount(userId);
    return {
        available: lastfmCredentials() !== null,
        username: account?.username ?? null,
        scrobbling: !!account?.scrobbling && lastfmCredentials() !== null
    };
});

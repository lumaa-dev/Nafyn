import { revokeSession } from "~~/server/core/sessions";
import { markSessionRevoked } from "~~/server/utils/sessionCache";
import { closeUnityConnectionsForSession } from "~~/server/utils/unityRegistry";
import { deleteApnDataForSession } from "~~/server/utils/apn";

defineRouteMeta({
    openAPI: {
        description: "Revoke the currently authenticated session (the one making this request), signing this device out server-side",
        tags: ["auth"],
        operationId: "logout",
        responses: {
            "200": {
                description: ""
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
    const { sub: userId, jti } = await requireAuthToken(event);

    await revokeSession(userId, jti);
    markSessionRevoked(jti);
    closeUnityConnectionsForSession(userId, jti);
    // the Apple device behind this login stops receiving pushes with it
    await deleteApnDataForSession(jti);

    return { loggedOut: true };
});

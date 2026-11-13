import { exchangeLastfmToken, saveLastfmAccount } from "~~/server/core/lastfmAccounts";
import { getUserById } from "~~/server/core/users";
import { verifyPurposeToken } from "~~/server/utils/jwt";

defineRouteMeta({
    openAPI: {
        description: "Where last.fm sends the browser back after the user allowed Nafyn (see POST /api/v1/user/lastfm/connect). Not called by clients. Authenticated by its signed `state`, not by a token. Redirects to `/settings?lastfm=connected|error` or `nafyn://lastfm?status=connected|error`",
        tags: ["user"],
        operationId: "lastfmCallback",
        parameters: [
            { name: "state", in: "query", required: true, schema: { type: "string" } },
            { name: "token", in: "query", required: true, description: "The token last.fm adds", schema: { type: "string" } }
        ],
        responses: { "302": { description: "Back to the settings" } }
    },
});

export default defineEventHandler(async (event) => {
    const query = getQuery(event);
    const state = typeof query.state === "string" ? verifyPurposeToken("lastfm", query.state) : null;
    const client = state?.client === "app" ? "app" : "web";
    const back = (status: "connected" | "error") => client === "app"
        ? `nafyn://lastfm?status=${status}`
        : `/settings?lastfm=${status}`;

    const userId = typeof state?.sub === "string" ? state.sub : null;
    const token = typeof query.token === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(query.token) ? query.token : null;
    if (!userId || !token || !(await getUserById(userId))) {
        return sendRedirect(event, back("error"), 302);
    }

    try {
        const { username, sessionKey } = await exchangeLastfmToken(token);
        await saveLastfmAccount(userId, username, sessionKey);
        return sendRedirect(event, back("connected"), 302);
    } catch (error) {
        console.error("[lastfm] connecting failed:", error instanceof Error ? error.message : error);
        return sendRedirect(event, back("error"), 302);
    }
});

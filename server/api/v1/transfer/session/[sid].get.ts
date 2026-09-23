import { getTransferProvider } from "~~/server/utils/transfer/providers";
import { getTransferSession } from "~~/server/utils/transfer/sessions";
import type { TransferOverview } from "~~/server/entity/Transfer";

defineRouteMeta({
    openAPI: {
        description: "What a connected streaming account holds (liked songs, albums, followed artists and playlists, with counts where the service gives them), so the user can pick what to import",
        tags: ["transfer"],
        operationId: "getTransferOverview",
        parameters: [{ name: "sid", in: "path", required: true, description: "Import session ID", schema: { type: "string" } }],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such session (they expire after 30 minutes)", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "502": { description: "The service couldn't be read", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event): Promise<TransferOverview> => {
    const { sub: userId } = requireAuthToken(event);

    const session = getTransferSession(getRouterParam(event, "sid"), userId);
    const provider = session ? getTransferProvider(session.provider) : null;
    if (!session || !provider) {
        throw createError({ statusCode: 404, statusMessage: "This connection has expired, please connect again" });
    }

    let overview;
    try {
        overview = await provider.overview(session);
    } catch (err) {
        console.error(`[transfer] reading ${provider.id} overview failed:`, err);
        throw createError({ statusCode: 502, statusMessage: "Your library couldn't be read, please try again" });
    }

    session.playlists = new Map(overview.playlists.map((p) => [p.id, p.title]));

    return {
        sessionId: session.id,
        provider: session.provider,
        capabilities: provider.capabilities,
        ...overview
    };
});

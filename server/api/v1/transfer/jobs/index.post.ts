import { getTransferProvider } from "~~/server/utils/transfer/providers";
import { getTransferSession } from "~~/server/utils/transfer/sessions";
import { requireImportPermission, requireNoActiveImport } from "~~/server/utils/transfer/access";
import { createTransferJob, getTransferJob } from "~~/server/core/transfer";
import { runTransferFetch } from "~~/server/core/transferWorker";
import type { TransferSelection } from "~~/server/entity/Transfer";

defineRouteMeta({
    openAPI: {
        description: "Start importing the selected parts of a connected account. Everything found is matched against MusicBrainz and then downloaded straight away - imported items skip the approval queue, as if the account had the AUTOACCEPT permissions",
        tags: ["transfer"],
        operationId: "createTransferJob",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["sessionId", "selection"],
                        properties: {
                            sessionId: { type: "string" },
                            selection: {
                                type: "object",
                                properties: {
                                    likedTracks: { type: "boolean" },
                                    albums: { type: "boolean" },
                                    artists: { type: "boolean" },
                                    playlists: { type: "array", items: { type: "string" } }
                                }
                            }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "400": { description: "Nothing selected, or an unknown playlist", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "The connection expired", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "An import is already running for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);
    await requireNoActiveImport(userId);

    const body = await readBody(event);
    const session = getTransferSession(body?.sessionId, userId);
    const provider = session ? getTransferProvider(session.provider) : null;
    if (!session || !provider) {
        throw createError({ statusCode: 404, statusMessage: "This connection has expired, please connect again" });
    }

    const raw = body?.selection ?? {};
    const playlists: unknown[] = Array.isArray(raw.playlists) ? raw.playlists : [];

    // SECURITY: only playlist ids the overview itself listed - each one ends up in an upstream URL path
    if (playlists.some((id) => typeof id !== "string" || !session.playlists.has(id))) {
        throw createError({ statusCode: 400, statusMessage: "Unknown playlist" });
    }

    const selection: TransferSelection = {
        likedTracks: raw.likedTracks === true && provider.capabilities.likedTracks,
        albums: raw.albums === true && provider.capabilities.albums,
        artists: raw.artists === true && provider.capabilities.artists,
        playlists: [...new Set(playlists as string[])]
    };
    if (!selection.likedTracks && !selection.albums && !selection.artists && selection.playlists.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "Nothing selected to import" });
    }

    const job = await createTransferJob(userId, provider.id, "fetching");
    // reading a big library takes a while - the job page follows its progress
    void runTransferFetch(job.id, provider, session, selection, session.playlists);

    return await getTransferJob(job.id);
});

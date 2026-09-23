import { deleteTransferJob } from "~~/server/core/transfer";
import { requireOwnedTransferJob } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "Remove a finished import from the history. Tracks it already added to the library and playlists it created stay",
        tags: ["transfer"],
        operationId: "deleteTransferJob",
        parameters: [{ name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } }],
        responses: {
            "200": { description: "" },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No import with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The import is still running - cancel it first", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const job = await requireOwnedTransferJob(event, userId);
    if (job.status === "fetching" || job.status === "matching" || job.status === "downloading") {
        throw createError({ statusCode: 409, statusMessage: "This import is still running" });
    }
    await deleteTransferJob(job.id);
    return { removed: true };
});

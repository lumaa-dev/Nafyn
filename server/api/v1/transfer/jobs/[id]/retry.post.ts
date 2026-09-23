import { getTransferJob, retryFailedTransferDownloads, setTransferJobStatus } from "~~/server/core/transfer";
import { requireNoActiveImport, requireOwnedTransferJob } from "~~/server/utils/transfer/access";
import { wakeTransferWorker } from "~~/server/core/transferWorker";

defineRouteMeta({
    openAPI: {
        description: "Queue a finished import's failed downloads again (what's shared on Soulseek changes over time). Items that couldn't be matched on MusicBrainz aren't retried - they would fail the same way",
        tags: ["transfer"],
        operationId: "retryTransferJob",
        parameters: [{ name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } }],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "400": { description: "Nothing to retry", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No import with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "An import is already running for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const job = await requireOwnedTransferJob(event, userId);
    await requireNoActiveImport(userId);

    if (job.status !== "completed" && job.status !== "cancelled") {
        throw createError({ statusCode: 400, statusMessage: "Nothing to retry" });
    }
    const requeued = await retryFailedTransferDownloads(job.id);
    if (requeued === 0) {
        throw createError({ statusCode: 400, statusMessage: "Nothing to retry" });
    }

    await setTransferJobStatus(job.id, "downloading");
    wakeTransferWorker();
    return await getTransferJob(job.id);
});

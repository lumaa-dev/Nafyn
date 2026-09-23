import { cancelTransferJobItems, getTransferJob, transitionTransferJob } from "~~/server/core/transfer";
import { requireOwnedTransferJob } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "Stop a running library import. Whatever is downloading right now finishes; nothing after it starts",
        tags: ["transfer"],
        operationId: "cancelTransferJob",
        parameters: [{ name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } }],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No import with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The import already finished", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const job = await requireOwnedTransferJob(event, userId);

    if (job.status !== "fetching" && job.status !== "matching" && job.status !== "downloading") {
        throw createError({ statusCode: 409, statusMessage: "This import already finished" });
    }
    if (!await transitionTransferJob(job.id, job.status, "cancelled")) {
        throw createError({ statusCode: 409, statusMessage: "This import changed state, please try again" });
    }
    await cancelTransferJobItems(job.id);
    return await getTransferJob(job.id);
});

import { getTransferJob } from "~~/server/core/transfer";
import { requireOwnedTransferJob } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "One library import: its stage, how many items are done, and how many failed, broken down by reason (missing ISRC, not found on MusicBrainz, download failed...)",
        tags: ["transfer"],
        operationId: "getTransferJob",
        parameters: [{ name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } }],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No import with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const job = await requireOwnedTransferJob(event, userId);
    return await getTransferJob(job.id);
});

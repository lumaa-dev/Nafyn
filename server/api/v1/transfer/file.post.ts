import { requireImportPermission, requireNoActiveImport } from "~~/server/utils/transfer/access";
import { parseImportFile } from "~~/server/utils/transfer/fileImport";
import { createTransferJob, getTransferJob, setTransferJobStatus } from "~~/server/core/transfer";
import { insertFileImport, wakeTransferWorker } from "~~/server/core/transferWorker";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

defineRouteMeta({
    openAPI: {
        description: "Import a library from an exported file: CSV (Exportify, TuneMyMusic, Soundiiz...), JSON (Spotify or Apple Music account data exports) or plain text, one \"Artist - Title\" per line. Works for any service, including those without a public API (Qobuz...)",
        tags: ["transfer"],
        operationId: "importTransferFile",
        requestBody: {
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        required: ["file"],
                        properties: {
                            file: { type: "string", format: "binary" },
                            playlist: { type: "string", description: "Group the file's tracks into a new playlist with this name" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "400": { description: "Missing, oversized or unreadable file", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "An import is already running for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);
    await requireNoActiveImport(userId);

    const length = Number(getHeader(event, "content-length") ?? 0);
    if (length > MAX_FILE_BYTES + 64 * 1024) {
        throw createError({ statusCode: 400, statusMessage: "That file is too big (5 MB at most)" });
    }

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "file" && part.filename);
    if (!file || file.data.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "Missing file" });
    }
    if (file.data.length > MAX_FILE_BYTES) {
        throw createError({ statusCode: 400, statusMessage: "That file is too big (5 MB at most)" });
    }

    const playlistPart = form?.find((part) => part.name === "playlist" && !part.filename);
    const playlist = playlistPart ? playlistPart.data.toString("utf8").trim().slice(0, 200) || null : null;

    const parsed = parseImportFile(file.filename ?? "import.csv", file.data.toString("utf8"), playlist);
    const found = parsed.tracks.length + parsed.albums.length + parsed.playlists.reduce((n, p) => n + p.tracks.length, 0);
    if (found === 0) {
        throw createError({ statusCode: 400, statusMessage: "No tracks found in that file" });
    }

    const job = await createTransferJob(userId, "file", "fetching");
    try {
        await insertFileImport(job.id, parsed);
        await setTransferJobStatus(job.id, "matching");
    } catch (err) {
        await setTransferJobStatus(job.id, "failed", "The file couldn't be imported");
        throw err;
    }
    wakeTransferWorker();

    return await getTransferJob(job.id);
});

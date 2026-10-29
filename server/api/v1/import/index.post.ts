import { createImport, hasRunningImport, MAX_IMPORT_TRACKS, type ImportTrackInput } from "~~/server/core/imports";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: `Import a playlist from another service: every track (ISRC when known, plus title, artist and length) is resolved to a MusicBrainz recording and requested, in the background, with the same checks as POST /api/v1/request - tracks already in the caller's library or already requested are reported as such, not requested again. Returns at once; poll GET /api/v1/import/{id} for progress. Needs REQUEST_TRACKS. At most ${MAX_IMPORT_TRACKS} tracks, one running import per user.`,
        tags: ["import"],
        operationId: "createImport",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["tracks"],
                        properties: {
                            source: { type: "string", description: "Where the list comes from, e.g. `apple-music` (letters, digits, dashes; informational)" },
                            name: { type: "string", description: "The playlist's name (informational)" },
                            tracks: {
                                type: "array",
                                maxItems: MAX_IMPORT_TRACKS,
                                items: {
                                    type: "object",
                                    required: ["title", "artist"],
                                    properties: {
                                        isrc: { type: "string", nullable: true },
                                        title: { type: "string" },
                                        artist: { type: "string", description: "The artist as the other service displays it (\"A & B\" is fine)" },
                                        album: { type: "string", nullable: true },
                                        duration: { type: "number", nullable: true, description: "Length in seconds" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "The import, just started", content: { "application/json": { schema: { $ref: "#/components/schemas/PlaylistImport" } } } },
            "400": { description: "No tracks, too many, or a track without title/artist", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Missing REQUEST_TRACKS", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The caller already has an import running", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    PlaylistImport: {
                        type: "object",
                        required: ["id", "source", "name", "status", "total", "processed", "counts", "createdAt", "updatedAt"],
                        properties: {
                            id: { type: "string" },
                            source: { type: "string", nullable: true },
                            name: { type: "string", nullable: true },
                            status: { type: "string", enum: ["running", "completed"] },
                            total: { type: "integer" },
                            processed: { type: "integer", description: "Tracks no longer pending" },
                            counts: {
                                type: "object",
                                description: "Tracks per item status",
                                properties: Object.fromEntries(["pending", "requested", "owned", "already-requested", "not-found", "unreleased", "error"].map((status) => [status, { type: "integer" }]))
                            },
                            createdAt: { type: "integer", description: "Unix seconds" },
                            updatedAt: { type: "integer", description: "Unix seconds" }
                        }
                    },
                    PlaylistImportItem: {
                        type: "object",
                        required: ["position", "isrc", "title", "artist", "album", "duration", "status", "musicbrainzId", "requestId", "via", "message"],
                        properties: {
                            position: { type: "integer", description: "0-based index in the submitted list" },
                            isrc: { type: "string", nullable: true },
                            title: { type: "string" },
                            artist: { type: "string" },
                            album: { type: "string", nullable: true },
                            duration: { type: "integer", nullable: true },
                            status: {
                                type: "string",
                                enum: ["pending", "requested", "owned", "already-requested", "not-found", "unreleased", "error"],
                                description: "`requested`: a request was created (`requestId`). `owned`: already in the library. `already-requested`: a request for it is waiting or running. `not-found`: no convincing MusicBrainz match. `error`: something else went wrong (`message`), MusicBrainz being unreachable after retries included"
                            },
                            musicbrainzId: { type: "string", nullable: true, description: "The recording it was matched to" },
                            requestId: { type: "string", nullable: true },
                            via: { type: "string", enum: ["isrc", "search"], nullable: true, description: "Matched by ISRC, or by searching title + artist" },
                            message: { type: "string", nullable: true }
                        }
                    }
                }
            }
        }
    },
});

const SOURCE_PATTERN = /^[a-z0-9-]{1,32}$/i;
const MAX_TEXT = 300;

function text(value: unknown, max = MAX_TEXT): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const permissions = await getPermissionsById(userId) ?? 0;
    if (!hasPermission(permissions, Permission.REQUEST_TRACKS)) {
        throw createError({ statusCode: 403, message: "Unsufficient permissions" });
    }

    const body = await readBody(event);
    const raw: unknown[] = Array.isArray(body?.tracks) ? body.tracks : [];
    if (raw.length === 0) throw createError({ statusCode: 400, message: "No tracks to import" });
    if (raw.length > MAX_IMPORT_TRACKS) throw createError({ statusCode: 400, message: `At most ${MAX_IMPORT_TRACKS} tracks per import` });

    const tracks: ImportTrackInput[] = [];
    for (const [index, entry] of raw.entries()) {
        const track = (entry ?? {}) as Record<string, unknown>;
        const title = text(track.title);
        const artist = text(track.artist);
        if (!title || !artist) throw createError({ statusCode: 400, message: `Track ${index} needs a title and an artist` });
        const duration = Number(track.duration);
        tracks.push({
            isrc: text(track.isrc, 15) || null,
            title,
            artist,
            album: text(track.album) || null,
            duration: Number.isFinite(duration) && duration > 0 && duration < 24 * 3600 ? Math.round(duration) : null
        });
    }

    const source = text(body?.source, 32);
    const name = text(body?.name, 200);

    if (await hasRunningImport(userId)) {
        throw createError({ statusCode: 409, message: "An import is already running" });
    }

    return await createImport(userId, {
        source: SOURCE_PATTERN.test(source) ? source.toLowerCase() : null,
        name: name || null,
        tracks
    });
});

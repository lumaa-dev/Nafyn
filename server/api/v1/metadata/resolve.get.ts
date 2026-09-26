import { resolveMetadataRef } from "../../../utils/metadata";
import { requireAuthToken } from "../../../utils/requireAuth";
import { enforceUpstreamLookupLimit } from "../../../utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Resolve one song metadata search result (its `ref`, e.g. `deezer:track:3135556`) to the MusicBrainz recording or release-group it opens as in Nafyn (`/t/{id}` for a track, `/a/{id}` for an album) - used to open a text-search hit, since GET /api/v1/metadata/search only resolves ISRC/ID lookups up front",
        tags: ["search"],
        operationId: "resolveMetadataRef",
        parameters: [
            { name: "ref", in: "query", required: true, description: "A result's `ref`, as returned by GET /api/v1/metadata/search", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["kind", "musicbrainzId"],
                            properties: {
                                kind: { type: "string", enum: ["track", "album"] },
                                musicbrainzId: { type: "string" }
                            }
                        }
                    }
                }
            },
            "400": { description: "Missing or invalid `ref`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No matching MusicBrainz entity found", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many lookups", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    const query = getQuery(event);
    const ref = (typeof query?.ref === "string" ? query.ref : "").trim().slice(0, 200);
    if (!ref) {
        throw createError({ statusCode: 400, statusMessage: "Missing `ref`" });
    }

    const resolved = await resolveMetadataRef(ref);
    if (!resolved) {
        throw createError({ statusCode: 404, statusMessage: "No matching MusicBrainz entity found" });
    }

    return resolved;
});

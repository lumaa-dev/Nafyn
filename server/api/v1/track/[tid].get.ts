import { getMusicBrainzClient } from "~~/server/utils/musicbrainz";

export default defineEventHandler(async (event) => {
    requireAuthToken(event);

    const tid = getRouterParam(event, "tid");
    if (!tid) {
        throw createError({ statusCode: 400, message: "Missing track ID" });
    }

    const client = getMusicBrainzClient();

    const recording = await client.lookup("recording", tid, ["releases", "release-groups"]).catch(() => {
        throw createError({ statusCode: 404, message: "No track with ID " + tid });
    });

    const albumId = recording.releases?.[0]?.["release-group"]?.id;
    if (!albumId) {
        throw createError({ statusCode: 404, message: "No album found for track " + tid });
    }

    return { albumId };
});

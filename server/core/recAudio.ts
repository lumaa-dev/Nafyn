// measured audio descriptors for the recommender: one analysis per media file Nafyn holds (shared by every
// user, like the file), and one per catalogue recording from its iTunes preview when it is shortlisted as a
// suggestion. Stored in rec_audio_features; never personal data.
import { getLibrariesDb, sqlInt } from "./db";
import { type AudioFeatures, analyzePcm } from "../utils/recommender/mixes/audio";
import { decodeFile, decodePreview } from "../utils/recAudioDecode";
import { getPreviewAudio } from "../utils/trackPreview";

// how long "no preview / nothing analysable" is believed before trying again
const NONE_RETRY_MS = 30 * 86_400_000;

function parse(features: unknown): AudioFeatures | null {
    if (!features) return null;
    const f = (typeof features === "string" ? JSON.parse(features) : features) as AudioFeatures;
    return typeof f.energy === "number" ? f : null;
}

export async function getAudioFeatures(subjects: readonly string[]): Promise<Map<string, AudioFeatures>> {
    const out = new Map<string, AudioFeatures>();
    if (subjects.length === 0) return out;
    for (let i = 0; i < subjects.length; i += 500) {
        const chunk = subjects.slice(i, i + 500);
        const rows = await getLibrariesDb().prepare(`
            SELECT subject, features FROM rec_audio_features WHERE status = 'ok' AND subject IN (${chunk.map(() => "?").join(", ")})
        `).all<{ subject: string, features: unknown }>(...chunk);
        for (const r of rows) {
            const f = parse(r.features);
            if (f) out.set(r.subject, f);
        }
    }
    return out;
}

async function store(subject: string, features: AudioFeatures | null, status: "ok" | "none" | "failed"): Promise<void> {
    await getLibrariesDb().prepare(`
        INSERT INTO rec_audio_features (subject, features, status, analyzed_at) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE features = VALUES(features), status = VALUES(status), analyzed_at = VALUES(analyzed_at)
    `).run(subject, features ? JSON.stringify(features) : null, status, Date.now());
}

/** analyses up to `limit` media files that have no features yet; returns how many were done */
export async function analyzePendingMedia(limit: number): Promise<number> {
    const rows = await getLibrariesDb().prepare(`
        SELECT m.id, m.duration, (SELECT le.filePath FROM library_entries le WHERE le.mediaId = m.id LIMIT 1) AS filePath
        FROM media m
        LEFT JOIN rec_audio_features f ON f.subject = CONCAT('media:', m.id)
        WHERE f.subject IS NULL OR (f.status <> 'ok' AND f.analyzed_at < ?)
        ORDER BY m.addedAt DESC
        LIMIT ${sqlInt(limit)}
    `).all<{ id: string, duration: number, filePath: string | null }>(Date.now() - NONE_RETRY_MS);
    let done = 0;
    for (const row of rows) {
        const subject = `media:${row.id}`;
        if (!row.filePath) {
            await store(subject, null, "none");
            continue;
        }
        try {
            const pcm = await decodeFile(row.filePath, row.duration || null);
            const features = pcm ? analyzePcm(pcm) : null;
            await store(subject, features, features ? "ok" : "none");
            done++;
        } catch (error) {
            console.warn(`[recommendations] audio analysis of media ${row.id} failed:`, error);
            await store(subject, null, "failed");
        }
    }
    return done;
}

/**
 * The features of a catalogue recording, from its iTunes preview; cached forever once measured, a missing
 * preview remembered for a month. Throws only on a MusicBrainz outage (the caller skips audio then).
 */
export async function previewFeatures(recordingId: string): Promise<AudioFeatures | null> {
    const subject = `rec:${recordingId.toLowerCase()}`;
    const row = await getLibrariesDb().prepare(`SELECT features, status, analyzed_at FROM rec_audio_features WHERE subject = ?`)
        .get<{ features: unknown, status: string, analyzed_at: number | string }>(subject);
    if (row?.status === "ok") return parse(row.features);
    if (row && Date.now() - Number(row.analyzed_at) < NONE_RETRY_MS) return null;
    const audio = await getPreviewAudio(recordingId);
    if (!audio) {
        await store(subject, null, "none");
        return null;
    }
    const pcm = await decodePreview(audio.bytes);
    const features = pcm ? analyzePcm(pcm) : null;
    await store(subject, features, features ? "ok" : "none");
    return features;
}

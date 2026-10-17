// full account data export - GDPR art. 15 ("right of access") and art. 20 ("right to data portability").
//
// Nafyn already shipped an insights-only export (GET /api/v1/insights/export), which covers listening data
// and nothing else. Access and portability are account-wide: the profile, the login metadata Nafyn keeps
// (IP and user agent per session), credentials *metadata*, library entries, playlists, download requests
// and the recently-played shelf all have to be disclosable too. This module builds that one document.
//
// Two rules it must keep:
//   * never include a secret. Password hashes, api_tokens.token values and passkey public keys are either
//     not the user's data to receive back or would turn a downloaded file into a credential. Their
//     existence and metadata are disclosed; the secret itself is not.
//   * always scope to the caller. There is no parameter for whose data to export.
import { getLibrariesDb } from "./db";
import { getUserById } from "./users";
import { listAllSessionsForUser } from "./sessions";
import { listApiTokensForUser } from "./apiTokens";
import { listPasskeysForUser } from "./passkeys";
import { getAppearanceSettings } from "./appearanceSettings";
import { getPlaybackSettings } from "./playbackSettings";
import { getUnitySettings } from "./unitySettings";
import { getInsightSettings } from "./insightsSettings";
import { getEventsForExport, countEventsForUser } from "./playEvents";
import { listYearSnapshots } from "./insightsSnapshot";
import { listReplayYears, getReplayMix } from "./replayMix";
import { listPlaylistsOwnedBy, listMembershipsOfUser } from "./playlists";
import { listRequestsByUser } from "./requests";
import { listSubscriptionExportForUser } from "./releaseSubscriptions";
import { listWebhookExportForUser } from "../utils/webhook";
import { listDeviceExportForUser } from "../utils/apn";

// raw play events are read in pages so a heavy listener's export doesn't materialize every row at once;
// same caps as the insights-only export, which this supersedes
const PAGE_SIZE = 5_000;
const MAX_EVENTS = 500_000;

export const ACCOUNT_EXPORT_FORMAT = "nafyn-account-export/1";

async function rowsByUserId(table: string, userId: string): Promise<unknown[]> {
    // table names come from the hard-coded lists below, never from a request
    return await getLibrariesDb().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId);
}

export async function buildAccountExport(userId: string): Promise<Record<string, unknown>> {
    const user = await getUserById(userId);
    if (!user) throw createError({ statusCode: 404, statusMessage: "User not found" });

    const [sessions, apiTokens, passkeys] = await Promise.all([
        listAllSessionsForUser(userId),
        listApiTokensForUser(userId),
        listPasskeysForUser(userId)
    ]);

    const [appearance, playback, unity, insightSettings] = await Promise.all([
        getAppearanceSettings(userId, user.permissions as unknown as number),
        getPlaybackSettings(userId),
        getUnitySettings(userId),
        getInsightSettings(userId)
    ]);

    // library: the entry rows plus the metadata of the tracks they point at. filePath is included because
    // it is this account's row, and it is what makes the export actually useful next to the audio files
    const library = await getLibrariesDb().prepare(`
        SELECT
            library_entries.id AS entryId,
            library_entries.filePath AS filePath,
            library_entries.addedAt AS addedAt,
            media.*
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
        ORDER BY library_entries.addedAt ASC
    `).all(userId);

    const ownedPlaylists = await listPlaylistsOwnedBy(userId);
    const playlistsWithEntries = [];
    for (const playlist of ownedPlaylists) {
        const entries = await getLibrariesDb().prepare(`
            SELECT id, mediaId, addedBy, position, addedAt FROM playlist_entries
            WHERE playlistId = ? ORDER BY position ASC
        `).all(playlist.id);
        playlistsWithEntries.push({ ...playlist, entries });
    }

    // entries this account added to playlists owned by somebody else - still its data, so still disclosed
    const entriesAddedElsewhere = await getLibrariesDb().prepare(`
        SELECT playlist_entries.* FROM playlist_entries
        JOIN playlists ON playlists.id = playlist_entries.playlistId
        WHERE playlist_entries.addedBy = ? AND playlists.ownerId <> ?
    `).all(userId, userId);

    const memberships = await listMembershipsOfUser(userId);
    const requests = await listRequestsByUser(userId);

    const recentlyPlayed = await getLibrariesDb().prepare(`
        SELECT * FROM recently_played WHERE userId = ? ORDER BY playedAt DESC
    `).all(userId);

    // ---- listening insights (same content as GET /api/v1/insights/export) ----
    const totalEvents = await countEventsForUser(userId);
    const playEvents: unknown[] = [];
    for (let offset = 0; offset < Math.min(totalEvents, MAX_EVENTS); offset += PAGE_SIZE) {
        playEvents.push(...await getEventsForExport(userId, PAGE_SIZE, offset));
    }

    // notifications: webhook URLs and APNs tokens are credentials (anyone holding one can post to that
    // channel / push to that device), so like app passwords only their metadata is disclosed
    const [webhooks, appleDevices, releaseSubscriptions] = await Promise.all([
        listWebhookExportForUser(userId),
        listDeviceExportForUser(userId),
        listSubscriptionExportForUser(userId)
    ]);

    const [snapshots, replayYears, daily, hourly, monthly, yearly] = await Promise.all([
        listYearSnapshots(userId),
        listReplayYears(userId),
        rowsByUserId("user_entity_stats_daily", userId),
        rowsByUserId("user_hour_stats_daily", userId),
        rowsByUserId("user_entity_stats_monthly", userId),
        rowsByUserId("user_entity_stats_yearly", userId)
    ]);

    const replayMixes = await Promise.all(replayYears.map((r) => getReplayMix(userId, r.year)));

    return {
        format: ACCOUNT_EXPORT_FORMAT,
        exportedAt: Date.now(),
        // plain-language account of what each section is and why it is held, so the export doubles as the
        // art. 15 disclosure rather than being a bare dump the reader has to interpret
        about: {
            notice: "Everything this Nafyn instance holds about your account. Secrets (your password hash, your app-password values, your passkey public keys, your webhook URLs and Apple push tokens) are deliberately excluded - their existence and metadata are listed instead.",
            privacyPolicy: "/privacy"
        },
        account: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            hasAvatar: !!user.avatar,
            permissions: user.permissions,
            linkedLastFm: user.lastFm,
            linkedDiscogs: user.discogs
        },
        settings: {
            appearance,
            playback,
            unity,
            listeningHistory: insightSettings
        },
        // login metadata. Disclosed in full, IP included: it is held about this account, so it is the
        // account's to see
        sessions,
        credentials: {
            apiTokens,
            passkeys
        },
        library,
        playlists: {
            owned: playlistsWithEntries,
            memberships,
            entriesAddedToOthersPlaylists: entriesAddedElsewhere
        },
        requests,
        notifications: {
            webhooks,
            appleDevices,
            releaseSubscriptions
        },
        recentlyPlayed,
        listening: {
            counts: {
                playEvents: totalEvents,
                playEventsIncluded: playEvents.length,
                truncated: totalEvents > MAX_EVENTS
            },
            playEvents,
            aggregates: { daily, hourly, monthly, yearly },
            replayMixes,
            yearSnapshots: snapshots
        }
    };
}

// complete account erasure - GDPR art. 17 ("right to erasure").
//
// This is the single place that knows every table, file and in-memory cache an account touches. Both the
// admin route (DELETE /api/v1/users/{id}) and the self-service route (DELETE /api/v1/user/me) go through
// it, so the two can never drift apart on what "deleted" means.
//
// Why it has to be exhaustive: no table in Nafyn has a foreign key to `users` (every per-user table uses
// the informal userId-reference convention - see the comments in db.ts), so nothing cascades. Deleting the
// `users` row alone used to leave live sessions, app passwords, passkeys, playlists, requests, the
// recently-played shelf, every per-user settings row and the avatar file on disk behind - a full profile of
// a person whose account no longer exists.
//
// Order matters in two places:
//   * sessions go first, and their jtis are evicted from the in-memory session cache. Otherwise a token
//     already issued to this account keeps authenticating for up to the cache TTL (sessionCache.ts) against
//     a user row that is about to vanish.
//   * reel files must be listed (via the snapshot rows that name them) before those rows are deleted.
import { deleteAllSessionsForUser } from "./sessions";
import { markSessionRevoked } from "../utils/sessionCache";
import { deleteAllApiTokensForUser } from "./apiTokens";
import { deleteAllPasskeysForUser } from "./passkeys";
import { deleteRegisterTokensCreatedBy } from "./registerTokens";
import { deleteAppearanceSettings } from "./appearanceSettings";
import { deletePlaybackSettings } from "./playbackSettings";
import { deleteUnitySettings } from "./unitySettings";
import { deleteAllLibraryEntriesForUser } from "./library";
import {
    listPlaylistsOwnedBy,
    deletePlaylist,
    removeAllMembershipsOfUser,
    anonymizeEntriesAddedBy
} from "./playlists";
import { deleteRecentlyPlayedForUser } from "./recentlyPlayed";
import { anonymizeRequestsOfUser } from "./requests";
import { deleteUserHistory } from "./playEvents";
import { deleteInsightSettings } from "./insightsSettings";
import { listYearSnapshots } from "./insightsSnapshot";
import { deleteReelsForUser } from "./insightsReel";
import { deleteUser } from "./users";
import { deleteAvatar } from "../utils/avatar";
import { deletePlaylistImage } from "../utils/playlistImage";
import { dropUnitySession } from "../utils/unityRegistry";
import { deleteApnDataForUser } from "../utils/apn";
import { deleteWebhooksForUser } from "../utils/webhook";
import { deleteReleaseSubscriptionsForUser } from "./releaseSubscriptions";
import { deleteImportsForUser } from "./imports";

export interface ErasureReport {
    removed: boolean,
    sessions: number,
    apiTokens: number,
    passkeys: number,
    registerTokens: number,
    appleDevices: number,
    webhooks: number,
    releaseSubscriptions: number,
    playlistImports: number,
    playlistsDeleted: number,
    membershipsRemoved: number,
    playlistEntriesAnonymized: number,
    requestsAnonymized: number,
    recentlyPlayed: number
}

/**
 * Erases everything Nafyn holds about `userId` and returns what was removed.
 *
 * Best-effort on the filesystem side (an avatar or playlist image that is already gone is not an error),
 * but never on the database side: a failure there propagates so the caller reports a failed deletion rather
 * than claiming an account is gone while half its rows remain.
 */
export async function eraseAccount(userId: string): Promise<ErasureReport> {
    // 1. kill every credential first, so nothing can act as this account while the rest runs
    const jtis = await deleteAllSessionsForUser(userId);
    for (const jti of jtis) markSessionRevoked(jti);
    dropUnitySession(userId);

    const apiTokens = await deleteAllApiTokensForUser(userId);
    const passkeys = await deleteAllPasskeysForUser(userId);
    const registerTokens = await deleteRegisterTokensCreatedBy(userId);
    // push tokens address this person's devices; webhook URLs are credentials to their channels
    const appleDevices = await deleteApnDataForUser(userId);
    const webhooks = await deleteWebhooksForUser(userId);

    // 2. per-user preferences
    await deleteAppearanceSettings(userId);
    await deletePlaybackSettings(userId);
    await deleteUnitySettings(userId);
    const releaseSubscriptions = await deleteReleaseSubscriptionsForUser(userId);
    // playlist imports name the tracks someone had in another service's playlists (a running one stops: its
    // worker finds no item left)
    const playlistImports = await deleteImportsForUser(userId);

    // 3. listening data. Snapshots name the rendered reel files, so those are listed before the rows go
    const snapshots = await listYearSnapshots(userId);
    await deleteReelsForUser(userId, snapshots.map((s) => s.year));
    await deleteUserHistory(userId);
    await deleteInsightSettings(userId);
    const recentlyPlayed = await deleteRecentlyPlayedForUser(userId);

    // 4. library. Revokes every entry and deletes the underlying file when no other user still holds it
    await deleteAllLibraryEntriesForUser(userId);

    // 5. playlists: owned ones are deleted outright (image included), memberships in other people's are
    // dropped, and entries this account added to playlists it does not own are anonymized - deleting them
    // would remove tracks from a playlist that still belongs to somebody else
    const owned = await listPlaylistsOwnedBy(userId);
    for (const playlist of owned) {
        await deletePlaylistImage(playlist.id).catch(() => {});
        await deletePlaylist(playlist.id);
    }
    const membershipsRemoved = await removeAllMembershipsOfUser(userId);
    const playlistEntriesAnonymized = await anonymizeEntriesAddedBy(userId);

    // 6. download requests stay as operational records of what this instance fetched, minus the requester
    const requestsAnonymized = await anonymizeRequestsOfUser(userId);

    // 7. files outside the database
    await deleteAvatar(userId).catch(() => {});

    // 8. the account itself, last - if anything above threw, the row is still there to retry against
    const removed = await deleteUser(userId);

    return {
        removed,
        sessions: jtis.length,
        apiTokens,
        passkeys,
        registerTokens,
        appleDevices,
        webhooks,
        releaseSubscriptions,
        playlistImports,
        playlistsDeleted: owned.length,
        membershipsRemoved,
        playlistEntriesAnonymized,
        requestsAnonymized,
        recentlyPlayed
    };
}

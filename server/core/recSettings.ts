// per-user switch for personalized recommendations (mixes, the For You page). On by default - the user can
// turn it off under Settings -> Privacy & Security, which also deletes everything the recommender holds about
// them (deleteRecommendationData) - an objection to profiling (GDPR art. 21) has to stop it, not just hide it.
import { getUsersDb, withTransaction } from "./db";

export interface RecSettings {
    enabled: boolean,
    updatedAt: number | null
}

export async function getRecSettings(userId: string): Promise<RecSettings> {
    const row = await getUsersDb()
        .prepare(`SELECT enabled, updated_at FROM rec_user_settings WHERE user_id = ?`)
        .get<{ enabled: number, updated_at: number | string }>(userId);
    return row ? { enabled: row.enabled === 1, updatedAt: Number(row.updated_at) } : { enabled: true, updatedAt: null };
}

export async function isPersonalizationEnabled(userId: string): Promise<boolean> {
    return (await getRecSettings(userId)).enabled;
}

export async function setPersonalizationEnabled(userId: string, enabled: boolean): Promise<RecSettings> {
    await getUsersDb().prepare(`
        INSERT INTO rec_user_settings (user_id, enabled, updated_at) VALUES (:userId, :enabled, :now)
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = VALUES(updated_at)
    `).run({ userId, enabled: enabled ? 1 : 0, now: Date.now() });
    if (!enabled) await deleteRecommendationData(userId);
    return await getRecSettings(userId);
}

/**
 * Everything the recommender derived from or logged about one user: mixes, refresh state and embedding,
 * ranking decisions and feedback. The settings row itself is kept (it is the record of the objection).
 */
export async function deleteRecommendationData(userId: string): Promise<{ mixes: number, decisions: number }> {
    return await withTransaction(async (conn) => {
        await conn.execute(`DELETE t FROM rec_mix_tracks t JOIN rec_mixes m ON m.id = t.mix_id WHERE m.user_id = ?`, [userId]);
        const [mixes] = await conn.execute(`DELETE FROM rec_mixes WHERE user_id = ?`, [userId]);
        await conn.execute(`DELETE FROM rec_user_state WHERE user_id = ?`, [userId]);
        await conn.execute(`DELETE FROM rec_feedback WHERE user_id = ?`, [userId]);
        const [decisions] = await conn.execute(`DELETE FROM rec_decisions WHERE user_id = ?`, [userId]);
        return {
            mixes: (mixes as { affectedRows?: number }).affectedRows ?? 0,
            decisions: (decisions as { affectedRows?: number }).affectedRows ?? 0
        };
    });
}

/** account erasure: the recommendation data and the settings row */
export async function eraseRecommendationAccount(userId: string): Promise<number> {
    const removed = await deleteRecommendationData(userId);
    await getUsersDb().prepare(`DELETE FROM rec_user_settings WHERE user_id = ?`).run(userId);
    return removed.mixes + removed.decisions;
}

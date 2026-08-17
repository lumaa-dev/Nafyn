import { getRecentlyPlayed } from "~~/server/core/recentlyPlayed";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    return getRecentlyPlayed(userId);
});

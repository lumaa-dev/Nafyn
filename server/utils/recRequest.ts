// helpers shared by the /api/v1/recommendations routes
import type { H3Event } from "h3";
import { isPersonalizationEnabled } from "~~/server/core/recSettings";
import { getRecConfig } from "~~/server/utils/recConfig";
import { DEVICES, type Device } from "~~/server/utils/recommender/bandit/features";

/** 404 when the operator turned the recommender off, 403 when this user objected to personalization */
export async function requirePersonalization(userId: string): Promise<void> {
    if (!getRecConfig().enabled) throw createError({ statusCode: 404, statusMessage: "Recommendations are disabled on this instance" });
    if (!await isPersonalizationEnabled(userId)) throw createError({ statusCode: 403, statusMessage: "Personalized recommendations are turned off" });
}

/** the client's device class and UTC offset, as it reports them (both only shape the ranking context) */
export function requestContext(event: H3Event): { device: Device, tzOffsetMinutes: number } {
    const query = getQuery(event);
    const device = DEVICES.includes(query.device as Device) ? (query.device as Device) : "other";
    const tz = Number(query.tz);
    return { device, tzOffsetMinutes: Number.isFinite(tz) ? Math.max(-720, Math.min(840, Math.trunc(tz))) : 0 };
}

import { randomUUID } from "crypto"

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

export default defineEventHandler(async (event) => {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
    const rateLimitKey = `verify:${ip}`;
    const rateLimit = consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);

    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
    }

    return {
        discy: true,
        response: {
            id: randomUUID(),
            date: Math.floor(Date.now() / 1000)
        }
    }
})
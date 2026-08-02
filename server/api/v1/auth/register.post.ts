import { promises as dns } from "node:dns";
import { createUser, isUsernameTaken, listUsers } from "../../../core/users";
import { consumeRateLimit, isWhitelisted } from "../../../utils/rateLimit";
import { signAuthToken } from "../../../utils/jwt";
import { Permission } from "../../../entity/Permission";

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 60 * 1000;

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;

export default defineEventHandler(async (event) => {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";    
    if (!isWhitelisted(ip)) {
        const rateLimit = consumeRateLimit(`register:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
    
        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }

    const body = await readBody(event);
    const username: string = typeof body?.username === "string" ? body.username.trim() : "";
    const password: string = typeof body?.password === "string" ? body.password : "";

    if (!USERNAME_RE.test(username)) {
        throw createError({ statusCode: 400, statusMessage: "Username must be 3-20 characters (letters, numbers, _ . -)" });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        throw createError({ statusCode: 400, statusMessage: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    if (isUsernameTaken(username)) {
        throw createError({ statusCode: 409, statusMessage: "Username is already taken" });
    }

    let defaultPerms: Permission = listUsers().length <= 0 ? Permission.ADMIN : Permission.NONE;

    const user = createUser({
        username,
        displayName: null,
        avatar: null,
        permissions: defaultPerms,
        lastFm: null,
        discogs: null
    }, password);

    const token = signAuthToken(user.id);

    return { user, token };
});

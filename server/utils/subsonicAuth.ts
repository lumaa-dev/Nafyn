// Subsonic auth over Nafyn accounts: the protocol supports both a plaintext `p=` password and a
// token/salt pair (`t`/`s`, token = md5(password + salt)) so the server never has to see the raw password.
// Token auth is impossible here - passwords are stored as bcrypt hashes (one-way), and verifying a token
// would require the plaintext to hash against, which bcrypt deliberately never gives back. So only `p=`
// (plain, or hex-encoded as `enc:...` per the spec) is supported; clients must be configured for password
// auth rather than token auth against Nafyn.
import type { H3Event } from "h3";
import bcrypt from "bcrypt";
import { getUserByUsername, getPasswordHash } from "../core/users";
import type { NafynUser } from "../entity/NafynUser";
import { consumeRateLimit, isWhitelisted, resetRateLimit } from "./rateLimit";
import { SubsonicErrors, SubsonicApiError } from "./subsonicResponse";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

// anti account-revealer, same purpose as login.post.ts's DUMMY_HASH
const DUMMY_HASH = bcrypt.hashSync("LumaaDev-Nafyn-Password", 12);

function decodePassword(raw: string): string {
    if (!raw.startsWith("enc:")) return raw;
    return Buffer.from(raw.slice(4), "hex").toString("utf8");
}

export async function authenticateSubsonic(event: H3Event, query: Record<string, unknown>): Promise<NafynUser> {
    const username = typeof query.u === "string" ? query.u.trim() : "";
    const rawPassword = typeof query.p === "string" ? query.p : undefined;
    const hasTokenAuth = typeof query.t === "string";

    if (!username || (!rawPassword && !hasTokenAuth)) {
        throw new SubsonicApiError(SubsonicErrors.missingParameter);
    }
    if (!rawPassword) {
        throw new SubsonicApiError(SubsonicErrors.tokenAuthNotSupported);
    }

    const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
    const rateLimitKey = `subsonic:${ip}:${username.toLowerCase()}`;

    if (!(await isWhitelisted(ip))) {
        const rateLimit = consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);
        if (!rateLimit.allowed) {
            throw new SubsonicApiError(SubsonicErrors.generic("Too many attempts, try again later"));
        }
    }

    const password = decodePassword(rawPassword);
    const passwordHash = await getPasswordHash(username);

    // always run bcrypt.compare, even for an unknown username, so early/late response timing can't leak account existence
    const valid = await bcrypt.compare(password, passwordHash ?? DUMMY_HASH);
    if (!passwordHash || !valid) {
        throw new SubsonicApiError(SubsonicErrors.wrongCredentials);
    }

    const user = await getUserByUsername(username);
    if (!user) {
        throw new SubsonicApiError(SubsonicErrors.wrongCredentials);
    }

    resetRateLimit(rateLimitKey);
    return user;
}

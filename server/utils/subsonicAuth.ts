// Subsonic auth over Nafyn accounts: the protocol supports both a plaintext `p=` password and a
// token/salt pair (`t`/`s`, token = md5(secret + salt)) so the server never has to see the raw secret over
// the wire. The real Nafyn account password is bcrypt-hashed (one-way) and can never support the t/s
// challenge - verifying a token needs a secret the server can re-hash and compare, which a one-way hash
// deliberately never allows. So:
//   - `p=` (plain, or hex-encoded as `enc:...`) works against either the real account password, or one of
//     the user's own API tokens (server/core/apiTokens.ts) used directly as the password.
//   - `t=`/`s=` only works against an API token, never the real account password. Users generate tokens
//     themselves in Settings and use one as the client's "password" instead of their real one.
import type { H3Event } from "h3";
import bcrypt from "bcrypt";
import { createHash, timingSafeEqual } from "node:crypto";
import { getUserByUsername, getPasswordHash } from "../core/users";
import { listApiTokenSecretsForUser, touchApiToken } from "../core/apiTokens";
import type { NafynUser } from "../entity/NafynUser";
import { consumeRateLimit, isWhitelisted, resetRateLimit } from "./rateLimit";
import { getClientIP } from "./clientIp";
import { SubsonicErrors, SubsonicApiError } from "./subsonicResponse";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

// anti account-revealer, same purpose as login.post.ts's DUMMY_HASH
const DUMMY_HASH = bcrypt.hashSync("LumaaDev-Nafyn-Password", 12);

function decodePassword(raw: string): string {
    if (!raw.startsWith("enc:")) return raw;
    return Buffer.from(raw.slice(4), "hex").toString("utf8");
}

function md5(value: string): string {
    return createHash("md5").update(value).digest("hex");
}

// constant-time string compare, so an attacker can't recover a token byte-by-byte from how long the
// comparison takes. Hashing both sides first keeps the compared buffers the same length (timingSafeEqual
// throws on a length mismatch, and the length itself would otherwise leak).
function secretEquals(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
}

export async function authenticateSubsonic(event: H3Event, query: Record<string, unknown>): Promise<NafynUser> {
    const username = typeof query.u === "string" ? query.u.trim() : "";
    const rawPassword = typeof query.p === "string" ? query.p : undefined;
    const t = typeof query.t === "string" ? query.t.toLowerCase() : undefined;
    const s = typeof query.s === "string" ? query.s : undefined;
    const hasChallenge = !!t && !!s;

    if (!username || (!rawPassword && !hasChallenge)) {
        throw new SubsonicApiError(SubsonicErrors.missingParameter);
    }

    const ip = getClientIP(event);
    const rateLimitKey = `subsonic:${ip}:${username.toLowerCase()}`;

    if (!(await isWhitelisted(ip))) {
        const rateLimit = consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);
        if (!rateLimit.allowed) {
            throw new SubsonicApiError(SubsonicErrors.generic("Too many attempts, try again later"));
        }
    }

    const user = await getUserByUsername(username);

    if (hasChallenge) {
        // no real password path can ever satisfy this - only API tokens are stored in a form the
        // server can re-hash. An unknown username still checks against an empty token list rather
        // than short-circuiting, so response timing doesn't reveal whether the account exists.
        const tokens = user ? await listApiTokenSecretsForUser(user.id) : [];
        const match = tokens.find((row) => secretEquals(md5(`${row.token}${s}`), t!));

        if (!match || !user) {
            throw new SubsonicApiError(SubsonicErrors.wrongCredentials);
        }

        resetRateLimit(rateLimitKey);
        touchApiToken(match.id).catch(() => {});
        return user;
    }

    const password = decodePassword(rawPassword!);
    const passwordHash = user ? await getPasswordHash(username) : null;

    // always run bcrypt.compare, even for an unknown username, so early/late response timing can't leak account existence
    const passwordValid = await bcrypt.compare(password, passwordHash ?? DUMMY_HASH);

    if (passwordValid && user && passwordHash) {
        resetRateLimit(rateLimitKey);
        return user;
    }

    // not the real account password - maybe it's an API token used directly as the password instead
    if (user) {
        const tokens = await listApiTokenSecretsForUser(user.id);
        const match = tokens.find((row) => secretEquals(row.token, password));
        if (match) {
            resetRateLimit(rateLimitKey);
            touchApiToken(match.id).catch(() => {});
            return user;
        }
    }

    throw new SubsonicApiError(SubsonicErrors.wrongCredentials);
}

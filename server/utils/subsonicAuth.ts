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
import { consumeRateLimit, isWhitelisted, peekRateLimit, resetRateLimit } from "./rateLimit";
import { getClientIP } from "./clientIp";
import { SubsonicErrors, SubsonicApiError } from "./subsonicResponse";

const MAX_ATTEMPTS = 10;
// SECURITY: without a per-IP bucket, the per-(IP, username) one above hands out a fresh budget for every
// username an attacker makes up - and every attempt costs a cost-12 bcrypt comparison on the libuv
// threadpool - the same pool that serves the file reads behind streaming. Rotating usernames was an
// unauthenticated way to pin the CPU and stall playback for everyone.
const MAX_ATTEMPTS_PER_IP = 30;
const WINDOW_MS = 15 * 60 * 1000;

// anti account-revealer, same purpose as login.post.ts's DUMMY_HASH
const DUMMY_HASH = bcrypt.hashSync("LumaaDev-Nafyn-Password", 12);

// Subsonic clients send credentials on *every* request (each cover, each stream, each list), so a p= client
// used to run a full bcrypt per request and burn through the rate-limit budget with a burst of parallel cover
// fetches. Credentials that already passed bcrypt are remembered for a short while, keyed by a hash of
// username + password so the plaintext itself is never kept. An entry is only honoured while the account's
// stored password hash is still the one it was verified against.
const VERIFIED_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFIED_ENTRIES = 1_000;
const verified = new Map<string, { passwordHash: string, expiresAtMs: number }>();

function verifiedKey(username: string, password: string): string {
    return createHash("sha256").update(`${username.toLowerCase()}\0${password}`).digest("hex");
}

function rememberVerified(key: string, passwordHash: string): void {
    if (verified.size >= MAX_VERIFIED_ENTRIES) {
        const oldest = verified.keys().next().value;
        if (oldest !== undefined) verified.delete(oldest);
    }
    verified.set(key, { passwordHash, expiresAtMs: Date.now() + VERIFIED_TTL_MS });
}

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
    const ipRateLimitKey = `subsonic-ip:${ip}`;
    const whitelisted = await isWhitelisted(ip);

    const rejectIfLimited = (check: (key: string, max: number) => { allowed: boolean }) => {
        if (whitelisted) return;
        if (!check(ipRateLimitKey, MAX_ATTEMPTS_PER_IP).allowed || !check(rateLimitKey, MAX_ATTEMPTS).allowed) {
            throw new SubsonicApiError(SubsonicErrors.generic("Too many attempts, try again later"));
        }
    };
    const recordFailure = () => {
        if (whitelisted) return;
        consumeRateLimit(ipRateLimitKey, MAX_ATTEMPTS_PER_IP, WINDOW_MS);
        consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);
    };

    if (hasChallenge) {
        // an md5 per stored token is cheap, so this path checks first and only counts *failures* - which is
        // what lets a client fire parallel requests without tripping the limiter on its own valid token
        rejectIfLimited((key, max) => peekRateLimit(key, max));

        // no real password path can ever satisfy this - only API tokens are stored in a form the
        // server can re-hash. An unknown username still checks against an empty token list rather
        // than short-circuiting, so response timing doesn't reveal whether the account exists.
        const user = await getUserByUsername(username);
        const tokens = user ? await listApiTokenSecretsForUser(user.id) : [];
        const match = tokens.find((row) => secretEquals(md5(`${row.token}${s}`), t!));

        if (!match || !user) {
            recordFailure();
            throw new SubsonicApiError(SubsonicErrors.wrongCredentials);
        }

        touchApiToken(match.id).catch(() => {});
        return user;
    }

    const password = decodePassword(rawPassword!);
    const cacheKey = verifiedKey(username, password);

    // fast path: these exact credentials already passed bcrypt recently and the password hasn't changed since
    const cached = verified.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
        const currentHash = await getPasswordHash(username);
        const user = currentHash === cached.passwordHash ? await getUserByUsername(username) : null;
        if (user) return user;
        verified.delete(cacheKey);
    }

    // everything past here is a bcrypt comparison, so the attempt is spent *before* running it - counting only
    // failures would let a burst of parallel guesses all reach bcrypt before the first one was recorded
    rejectIfLimited((key, max) => consumeRateLimit(key, max, WINDOW_MS));

    const user = await getUserByUsername(username);
    const passwordHash = user ? await getPasswordHash(username) : null;

    // always run bcrypt.compare, even for an unknown username, so early/late response timing can't leak account existence
    const passwordValid = await bcrypt.compare(password, passwordHash ?? DUMMY_HASH);

    if (passwordValid && user && passwordHash) {
        resetRateLimit(rateLimitKey);
        rememberVerified(cacheKey, passwordHash);
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

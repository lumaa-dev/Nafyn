// in-memory WebAuthn challenge store, modeled on rateLimit.ts's bucket map - a challenge only needs to
// survive the few seconds between "server hands out options" and "browser posts back a signed response", so
// losing it on a restart is harmless and a DB round-trip would be pure overhead.
//
// Two separate maps because the two flows key differently: registration happens to an already-authenticated
// user (keyed by userId, one in-flight registration at a time per account), while login is anonymous until
// the credential comes back (keyed by a random id the client carries between the two requests).
interface ChallengeEntry {
    challenge: string,
    expiresAt: number
}

const REGISTRATION_TTL_MS = 5 * 60 * 1000;
const LOGIN_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();

function sweep(map: Map<string, ChallengeEntry>): void {
    const now = Date.now();
    if (map.size < MAX_ENTRIES) return;
    for (const [key, entry] of map) {
        if (entry.expiresAt <= now) map.delete(key);
    }
}

export function putRegistrationChallenge(userId: string, challenge: string): void {
    sweep(registrationChallenges);
    registrationChallenges.set(userId, { challenge, expiresAt: Date.now() + REGISTRATION_TTL_MS });
}

// one-shot: consumed whether or not verification against it succeeds, so a stolen/replayed response can
// never be checked against the same challenge twice
export function takeRegistrationChallenge(userId: string): string | null {
    const entry = registrationChallenges.get(userId);
    registrationChallenges.delete(userId);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.challenge;
}

export function putLoginChallenge(id: string, challenge: string): void {
    sweep(loginChallenges);
    loginChallenges.set(id, { challenge, expiresAt: Date.now() + LOGIN_TTL_MS });
}

export function takeLoginChallenge(id: string): string | null {
    const entry = loginChallenges.get(id);
    loginChallenges.delete(id);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.challenge;
}

// AcoustID verification: makes sure a downloaded file is actually the requested MusicBrainz recording.
//
// Nothing stored is trusted. Every call regenerates a Chromaprint fingerprint and measures the duration from the
// audio itself, queries AcoustID with exactly those two values, and then scores *all* the candidates it returns
// (utils/acoustidMatch.ts: score threshold, duration tolerance, ranking, merged-MBID and title/artist handling)
// instead of looking for one ID in the answer. No AcoustID UUID, tag, database column or user-supplied length is
// an input - AcoustID IDs in particular are routinely stale or wrong.
import fpcalc from "fpcalc";
import type { FpcalcResult } from "fpcalc";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getMusicBrainzRepository } from "./musicbrainz";
import {
    aliasLookupCandidates,
    judge,
    rankCandidates,
    readMatchConfig,
    type AcoustIdResult,
    type Candidate,
    type ExpectedRecording
} from "./acoustidMatch";

export type { ExpectedRecording } from "./acoustidMatch";

const ACOUSTID_URL = "https://api.acoustid.org/v2/lookup";
const ACOUSTID_TIMEOUT_MS = 15_000;
// fpcalc and the container header disagreeing by more than this is worth a log line (a VBR mp3 without a Xing
// header is the usual cause), never a failure
const DURATION_DISAGREEMENT_SECONDS = 2;

// prefer the project-local static binary (vendor/fpcalc/fpcalc) over a system-wide install,
// so this project doesn't depend on chromaprint being installed globally on the host
const VENDORED_FPCALC = join(process.cwd(), "vendor", "fpcalc", "fpcalc");
const FPCALC_COMMAND = process.env.FPCALC_PATH || (existsSync(VENDORED_FPCALC) ? VENDORED_FPCALC : "fpcalc");

// the `fpcalc` package doesn't attach an `error` listener to its child process, so a
// missing binary (ENOENT) surfaces as an unhandled event instead of a rejected promise.
// Probe with `execFile`, which reports ENOENT through its callback, before ever calling it.
let fpcalcAvailable: Promise<boolean> | null = null;

function checkFpcalcAvailable(): Promise<boolean> {
    if (!fpcalcAvailable) {
        fpcalcAvailable = new Promise((resolve) => {
            execFile(FPCALC_COMMAND, ["-version"], (err) => resolve(!err));
        });
    }
    return fpcalcAvailable;
}

interface AcoustIdResponse {
    status: string,
    results?: AcoustIdResult[]
}

export async function computeFingerprint(filePath: string): Promise<FpcalcResult> {
    const available = await checkFpcalcAvailable();
    if (!available) {
        throw new Error("fpcalc binary not found (install chromaprint / libchromaprint-tools)");
    }

    return new Promise((resolve, reject) => {
        fpcalc(filePath, { command: FPCALC_COMMAND }, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// the length of the audio as measured from the file: fpcalc decodes the whole stream, so its DURATION is the
// real one; the container header (music-metadata) is only the fallback when fpcalc reports nothing
async function measureDuration(filePath: string, fpcalcDuration: number): Promise<number> {
    let headerDuration = 0;
    try {
        const { parseFile } = await import("music-metadata");
        headerDuration = (await parseFile(filePath, { duration: true })).format.duration ?? 0;
    } catch {
        // unreadable header: fpcalc alone decides
    }

    if (fpcalcDuration > 0 && headerDuration > 0 && Math.abs(fpcalcDuration - headerDuration) > DURATION_DISAGREEMENT_SECONDS) {
        console.warn(`[fingerprint] measured ${fpcalcDuration.toFixed(1)}s but the header says ${headerDuration.toFixed(1)}s for ${filePath} - trusting the decoded length`);
    }
    return fpcalcDuration > 0 ? fpcalcDuration : headerDuration;
}

function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

async function lookupAcoustId(fingerprint: string, duration: number): Promise<AcoustIdResult[]> {
    const config = useRuntimeConfig();
    if (!config.acoustidApiKey) {
        throw createError({ statusCode: 500, statusMessage: "AcoustID API key is not configured" });
    }

    const body = new URLSearchParams({
        client: config.acoustidApiKey,
        // `recordings` carries each candidate's title, artists and duration, which is what lets the answer be
        // scored instead of just searched for one ID
        meta: "recordings",
        duration: String(Math.round(duration)),
        fingerprint
    });

    // transient DNS/TLS hiccups (common on flaky ARM/home-router links, e.g. `getaddrinfo EAI_AGAIN` when
    // the container's resolver is momentarily unreachable) surface as a bare "TypeError: fetch failed" that
    // hides the real cause and kills an otherwise-good candidate - retry with backoff before giving up, and
    // log `cause` so a genuine failure is diagnosable. A 4xx other than 429 is our mistake and never retried.
    const ATTEMPTS = 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            const res = await fetch(ACOUSTID_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
                signal: AbortSignal.timeout(ACOUSTID_TIMEOUT_MS)
            });

            if (!res.ok && !isRetryable(res.status)) {
                throw Object.assign(new Error(`AcoustID answered ${res.status}`), { retryable: false });
            }
            if (!res.ok) throw new Error(`AcoustID answered ${res.status}`);

            const data = await res.json() as AcoustIdResponse;
            if (data.status !== "ok") {
                throw Object.assign(new Error("AcoustID lookup failed"), { retryable: false });
            }

            return data.results ?? [];
        } catch (error) {
            lastError = error;
            const cause = error instanceof Error && error.cause ? ` (cause: ${error.cause})` : "";
            console.error(`[fingerprint] AcoustID lookup attempt ${attempt}/${ATTEMPTS} failed: ${error}${cause}`);
            if ((error as { retryable?: boolean }).retryable === false) break;
            if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt + Math.random() * 500));
        }
    }
    throw lastError;
}

// MusicBrainz keeps a merged-away recording resolvable, answering with the surviving entity (a different `id`),
// so a candidate AcoustID still lists under the old MBID can be the requested recording. Bounded and cached by
// the repository; any failure just means "no alias found".
async function resolveCanonicalIds(ids: string[]): Promise<Map<string, string>> {
    const canonical = new Map<string, string>();
    if (ids.length === 0) return canonical;

    const client = getMusicBrainzRepository();
    for (const id of ids) {
        try {
            const recording = await client.lookup("recording", id);
            if (recording?.id) canonical.set(id, recording.id.toLowerCase());
        } catch {
            // 404 / busy / breaker open: no verdict from this candidate
        }
    }
    return canonical;
}

export interface FingerprintCheck {
    matched: boolean,
    // how it matched: the requested MBID, a merged/alias MBID, or the same title + artist under another recording
    via: "mbid" | "alias" | "identity" | null,
    fingerprint: string,
    // measured from the audio itself, never taken from tags or the request
    duration: number,
    // false when AcoustID itself couldn't be reached (network/DNS) after retries - fpcalc ran fine locally,
    // there's just no verdict to trust either way. Callers should accept the download rather than fail the
    // whole request over a network blip that has nothing to do with whether the file is correct.
    verified: boolean,
    // top candidates after score/duration filtering, best first (for logs and the caller's verdict)
    candidates: Candidate[],
    bestScore: number,
    // a confident candidate that is a different song, when there is one
    confidentOther: Candidate | null
}

// fingerprints `filePath` and checks whether AcoustID's candidates for that audio include `expected`
export async function verifyRecordingMatch(filePath: string, expected: ExpectedRecording): Promise<FingerprintCheck> {
    const fp = await computeFingerprint(filePath);
    const duration = await measureDuration(filePath, fp.duration);
    const config = readMatchConfig();

    let results: AcoustIdResult[];
    try {
        results = await lookupAcoustId(fp.fingerprint, duration);
    } catch (error) {
        console.error(`[fingerprint] AcoustID unreachable, skipping verification: ${error}`);
        return { matched: false, via: null, fingerprint: fp.fingerprint, duration, verified: false, candidates: [], bestScore: 0, confidentOther: null };
    }

    const candidates = rankCandidates(results, duration, config);
    let verdict = judge(candidates, expected, config);

    if (!verdict.matched) {
        const canonical = await resolveCanonicalIds(aliasLookupCandidates(candidates, expected, config));
        if (canonical.size > 0) verdict = judge(candidates, expected, config, canonical);
    }

    return {
        matched: verdict.matched,
        via: verdict.via,
        fingerprint: fp.fingerprint,
        duration,
        verified: true,
        candidates: candidates.slice(0, 5),
        bestScore: verdict.best?.score ?? 0,
        confidentOther: verdict.confidentOther
    };
}

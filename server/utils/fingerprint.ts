// AcoustID fingerprint verification, makes sure a downloaded file is actually the requested MusicBrainz recording
import fpcalc from "fpcalc";
import type { FpcalcResult } from "fpcalc";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ACOUSTID_URL = "https://api.acoustid.org/v2/lookup";
const MIN_SCORE = 0.5;

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

interface AcoustIdRecording {
    id: string
}

interface AcoustIdResult {
    id: string,
    score: number,
    recordings?: AcoustIdRecording[]
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

async function lookupAcoustId(fingerprint: string, duration: number): Promise<AcoustIdResult[]> {
    const config = useRuntimeConfig();
    if (!config.acoustidApiKey) {
        throw createError({ statusCode: 500, statusMessage: "AcoustID API key is not configured" });
    }

    const body = new URLSearchParams({
        client: config.acoustidApiKey,
        meta: "recordingids",
        duration: String(Math.round(duration)),
        fingerprint
    });

    const res = await fetch(ACOUSTID_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });

    const data = await res.json() as AcoustIdResponse;
    if (data.status !== "ok") {
        throw new Error("AcoustID lookup failed");
    }

    return data.results ?? [];
}

export interface FingerprintCheck {
    matched: boolean,
    fingerprint: string,
    duration: number
}

// downloads a fingerprint for `filePath` and checks whether AcoustID links it to `expectedRecordingId`
export async function verifyRecordingMatch(filePath: string, expectedRecordingId: string): Promise<FingerprintCheck> {
    const fp = await computeFingerprint(filePath);
    const results = await lookupAcoustId(fp.fingerprint, fp.duration);

    const matched = results.some((result) =>
        result.score >= MIN_SCORE && result.recordings?.some((recording) => recording.id === expectedRecordingId)
    );

    return { matched, fingerprint: fp.fingerprint, duration: fp.duration };
}

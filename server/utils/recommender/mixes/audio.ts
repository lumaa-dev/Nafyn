// Audio content analysis: descriptors computed from decoded PCM (mono, 22.05 kHz), for the tracks Nafyn holds
// and for the 30-second previews of suggested recordings.
//
// Nothing upstream gives Nafyn audio features (MusicBrainz has none, and the Spotify-style descriptors are
// proprietary), so they are measured here, frame by frame:
//
//   tempo         onset-strength (spectral flux) autocorrelation over 60-200 BPM, with a log-normal prior
//                 around 120 BPM against octave errors
//   key, mode     12-bin chroma correlated with the Krumhansl-Kessler major/minor profiles (24 keys)
//   loudness      mean RMS in dBFS
//   brightness    spectral centroid / 4 kHz
//   timbre        MFCC 1-8 (26 mel bands, DCT-II), averaged
//   danceability  beat regularity (strength of the tempo autocorrelation peak) x tempo suitability
//   energy        loudness, onset density and brightness combined
//   valence       an ESTIMATE from mode, brightness, danceability and tempo - acoustic correlates of
//                 musical positivity, not a model of it
//   acousticness  an ESTIMATE from low brightness and low spectral flatness
//
// The two estimates are labelled as such everywhere they surface; they are useful for ordering tracks
// against each other inside one library, not as absolute truths.
export const SAMPLE_RATE = 22_050;
const FRAME = 2048;
const HOP = 512;
const MEL_BANDS = 26;
export const TIMBRE_DIM = 8;

export interface AudioFeatures {
    tempo: number,
    /** pitch class 0 (C) - 11 (B) */
    key: number,
    /** 1 major, 0 minor */
    mode: number,
    loudness: number,
    energy: number,
    valence: number,
    danceability: number,
    acousticness: number,
    brightness: number,
    timbre: number[]
}

// ---------------------------------------------------------------- FFT

/** in-place iterative radix-2 FFT; re/im length must be a power of two */
export function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j]!, re[i]!];
            [im[i], im[j]] = [im[j]!, im[i]!];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b]! * cr - im[b]! * ci;
                const ti = re[b]! * ci + im[b]! * cr;
                re[b] = re[a]! - tr;
                im[b] = im[a]! - ti;
                re[a]! += tr;
                im[a]! += ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

// ---------------------------------------------------------------- helpers

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const n = a.length;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < n; i++) {
        ma += a[i]!;
        mb += b[i]!;
    }
    ma /= n;
    mb /= n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
        num += (a[i]! - ma) * (b[i]! - mb);
        da += (a[i]! - ma) ** 2;
        db += (b[i]! - mb) ** 2;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** best of the 24 major/minor keys for a chroma vector */
export function estimateKey(chroma: ArrayLike<number>): { key: number, mode: number, strength: number } {
    let best = { key: 0, mode: 1, strength: -Infinity };
    for (let k = 0; k < 12; k++) {
        const rotatedMajor = Array.from({ length: 12 }, (_, i) => KRUMHANSL_MAJOR[(i - k + 12) % 12]!);
        const rotatedMinor = Array.from({ length: 12 }, (_, i) => KRUMHANSL_MINOR[(i - k + 12) % 12]!);
        const maj = pearson(chroma, rotatedMajor);
        const min = pearson(chroma, rotatedMinor);
        if (maj > best.strength) best = { key: k, mode: 1, strength: maj };
        if (min > best.strength) best = { key: k, mode: 0, strength: min };
    }
    return best;
}

function hzToMel(f: number): number {
    return 2595 * Math.log10(1 + f / 700);
}

function melToHz(m: number): number {
    return 700 * (10 ** (m / 2595) - 1);
}

function melFilterbank(nBins: number, sr: number, bands: number, fmin = 30, fmax = 8000): Float64Array[] {
    const mmin = hzToMel(fmin);
    const mmax = hzToMel(Math.min(fmax, sr / 2));
    const points = Array.from({ length: bands + 2 }, (_, i) => melToHz(mmin + ((mmax - mmin) * i) / (bands + 1)));
    const binHz = sr / (2 * (nBins - 1));
    return Array.from({ length: bands }, (_, b) => {
        const filter = new Float64Array(nBins);
        const [lo, mid, hi] = [points[b]!, points[b + 1]!, points[b + 2]!];
        for (let k = 0; k < nBins; k++) {
            const f = k * binHz;
            if (f > lo && f < mid) filter[k] = (f - lo) / (mid - lo);
            else if (f >= mid && f < hi) filter[k] = (hi - f) / (hi - mid);
        }
        return filter;
    });
}

let cachedFilters: Float64Array[] | null = null;
let cachedWindow: Float64Array | null = null;

function window(): Float64Array {
    if (!cachedWindow) cachedWindow = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
    return cachedWindow;
}

// ---------------------------------------------------------------- analysis

/**
 * Features of a mono PCM signal at SAMPLE_RATE. Returns null when the signal is too short (< 6 s) or silent:
 * nothing reliable can be said about it, and a made-up default would be worse than "unknown".
 */
export function analyzePcm(samples: Float32Array | Float64Array, sr = SAMPLE_RATE): AudioFeatures | null {
    if (samples.length < sr * 6) return null;
    const nBins = FRAME / 2 + 1;
    const filters = cachedFilters ??= melFilterbank(nBins, sr, MEL_BANDS);
    const win = window();
    const frames = Math.floor((samples.length - FRAME) / HOP) + 1;
    const re = new Float64Array(FRAME);
    const im = new Float64Array(FRAME);
    let prevLog: Float64Array | null = null;
    const flux = new Float64Array(frames);
    const chroma = new Float64Array(12);
    const mfccSum = new Float64Array(TIMBRE_DIM);
    let rmsSum = 0;
    let centroidSum = 0;
    let flatnessSum = 0;
    let voiced = 0;
    const binHz = sr / FRAME;

    for (let f = 0; f < frames; f++) {
        const o = f * HOP;
        let energy = 0;
        for (let i = 0; i < FRAME; i++) {
            const s = samples[o + i]!;
            energy += s * s;
            re[i] = s * win[i]!;
            im[i] = 0;
        }
        const rms = Math.sqrt(energy / FRAME);
        rmsSum += rms;
        fft(re, im);
        const mag = new Float64Array(nBins);
        let magSum = 0;
        let weighted = 0;
        let logSum = 0;
        for (let k = 0; k < nBins; k++) {
            const m = Math.hypot(re[k]!, im[k]!);
            mag[k] = m;
            magSum += m;
            weighted += m * k * binHz;
            logSum += Math.log(m + 1e-10);
        }
        const logMag = Float64Array.from(mag, (m) => Math.log1p(100 * m));
        if (prevLog) {
            let s = 0;
            for (let k = 0; k < nBins; k++) {
                const d = logMag[k]! - prevLog[k]!;
                if (d > 0) s += d;
            }
            flux[f] = s;
        }
        prevLog = logMag;
        if (rms < 1e-4) continue; // silence says nothing about pitch or timbre
        voiced++;
        centroidSum += magSum > 0 ? weighted / magSum : 0;
        flatnessSum += magSum > 0 ? Math.exp(logSum / nBins) / (magSum / nBins) : 0;
        // chroma over 55 Hz - 4.2 kHz
        for (let k = 1; k < nBins; k++) {
            const hz = k * binHz;
            if (hz < 55 || hz > 4200) continue;
            const pitch = 12 * Math.log2(hz / 440) + 69;
            const pc = ((Math.round(pitch) % 12) + 12) % 12;
            chroma[pc]! += mag[k]! * mag[k]!;
        }
        // MFCC: log mel energies, DCT-II, coefficients 1..TIMBRE_DIM (0 is overall level, already in loudness)
        const mel = filters.map((filt) => {
            let s = 0;
            for (let k = 0; k < nBins; k++) if (filt[k]) s += filt[k]! * mag[k]! * mag[k]!;
            return Math.log(s + 1e-10);
        });
        for (let c = 1; c <= TIMBRE_DIM; c++) {
            let s = 0;
            for (let b = 0; b < MEL_BANDS; b++) s += mel[b]! * Math.cos((Math.PI * c * (b + 0.5)) / MEL_BANDS);
            mfccSum[c - 1]! += s;
        }
    }
    if (voiced < frames * 0.2) return null;

    const rmsMean = rmsSum / frames;
    const loudness = 20 * Math.log10(Math.max(rmsMean, 1e-6));
    const brightness = Math.min(1, centroidSum / voiced / 4000);
    const flatness = flatnessSum / voiced;
    const { key, mode } = estimateKey(chroma);
    const tempoInfo = estimateTempo(flux, sr / HOP);
    const onsetDensity = Math.min(1, onsetRate(flux, sr / HOP) / 6);

    const danceability = clamp01(0.65 * tempoInfo.regularity + 0.35 * Math.exp(-(((tempoInfo.bpm - 120) / 35) ** 2)));
    const loudNorm = clamp01((loudness + 35) / 30);
    const energy = clamp01(0.5 * loudNorm + 0.3 * onsetDensity + 0.2 * brightness);
    const tempoNorm = clamp01((tempoInfo.bpm - 60) / 120);
    const valence = clamp01(0.35 * mode + 0.25 * brightness + 0.25 * danceability + 0.15 * tempoNorm);
    const acousticness = clamp01(1 - 1.4 * brightness - 2 * flatness + 0.2);

    return {
        tempo: Math.round(tempoInfo.bpm * 10) / 10,
        key,
        mode,
        loudness: Math.round(loudness * 100) / 100,
        energy,
        valence,
        danceability,
        acousticness,
        brightness,
        timbre: Array.from(mfccSum, (s) => s / voiced / 50)
    };
}

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** onsets per second: flux peaks above a moving threshold */
function onsetRate(flux: Float64Array, frameRate: number): number {
    let count = 0;
    const w = 8;
    for (let i = w; i < flux.length - w; i++) {
        let local = 0;
        for (let j = i - w; j <= i + w; j++) local += flux[j]!;
        local /= 2 * w + 1;
        if (flux[i]! > 1.5 * local && flux[i]! >= flux[i - 1]! && flux[i]! >= flux[i + 1]!) count++;
    }
    return count / (flux.length / frameRate);
}

/** tempo from the onset envelope's autocorrelation, with a log-normal prior around 120 BPM */
export function estimateTempo(flux: Float64Array, frameRate: number): { bpm: number, regularity: number } {
    const n = flux.length;
    // remove the mean so a constant envelope has no "periodicity"
    let m = 0;
    for (let i = 0; i < n; i++) m += flux[i]!;
    m /= n;
    const env = Float64Array.from(flux, (x) => x - m);
    let zero = 0;
    for (let i = 0; i < n; i++) zero += env[i]! * env[i]!;
    if (!(zero > 0)) return { bpm: 120, regularity: 0 };
    const minLag = Math.max(1, Math.floor((60 / 200) * frameRate));
    const maxLag = Math.min(n - 1, Math.ceil((60 / 60) * frameRate));
    let bestLag = minLag;
    let bestScore = -Infinity;
    let bestAc = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let ac = 0;
        for (let i = 0; i + lag < n; i++) ac += env[i]! * env[i + lag]!;
        ac /= zero;
        const bpm = (60 * frameRate) / lag;
        const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
        const score = ac * prior;
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
            bestAc = ac;
        }
    }
    // parabolic interpolation around the peak for sub-frame precision
    const ac = (lag: number) => {
        let s = 0;
        for (let i = 0; i + lag < n; i++) s += env[i]! * env[i + lag]!;
        return s / zero;
    };
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
        const [a, b, c] = [ac(bestLag - 1), ac(bestLag), ac(bestLag + 1)];
        const denom = a - 2 * b + c;
        if (denom !== 0) lag = bestLag + 0.5 * (a - c) / denom;
    }
    return { bpm: (60 * frameRate) / lag, regularity: clamp01(bestAc * 2) };
}

/** the six numbers the bandit's features use (features.ts AUDIO_SUMMARY_DIM), each in [0, 1] */
export function audioSummary(f: AudioFeatures): number[] {
    return [f.energy, f.valence, clamp01((f.tempo - 60) / 120), f.danceability, f.acousticness, f.brightness];
}

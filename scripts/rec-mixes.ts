// bun run rec:mixes [--user N] [--seed S] [--json]
//
// Generates a synthetic music world (catalogue with audio features, users with known listening modes and four
// months of history), runs the real mixes pipeline for one user and prints what it built, with how well the
// suggestions fit that user's true taste. No database, no network.
import { generateMixes } from "../server/utils/recommender/mixes/pipeline";
import { DEFAULT_REC_CONFIG } from "../server/utils/recommender/config";
import { generateWorld, syntheticProvider, trulyFits, userTracks } from "../server/utils/recommender/synthetic";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
};
const seed = flag("--seed", 7);
const userIndex = flag("--user", 0);
const asJson = args.includes("--json");

const world = generateWorld(seed, { users: Math.max(userIndex + 1, 8) });
const user = world.users[userIndex]!;
const c = DEFAULT_REC_CONFIG;
const started = performance.now();
const result = await generateMixes(
    { now: world.now, tracks: userTracks(world, user), engagements: world.engagements.get(user.id)!, previous: [] },
    syntheticProvider(world),
    {
        modes: { minMixes: 1, maxMixes: c.maxMixes, minTracksPerMode: c.minTracksPerMode, minModeShare: c.minModeShare, restarts: 4, recencyHalfLifeDays: c.recencyHalfLifeDays, seed },
        assemble: { mixLength: c.mixLength, familiarRatio: c.familiarRatio, maxTracksPerArtist: c.maxTracksPerArtist, sequence: { arc: c.energyArc, artistSeparation: c.artistSeparation, maxNovelRun: c.maxNovelRun, twoOptPasses: 3 } },
        sourceWeights: c.sourceWeights,
        audioShortlist: c.audioShortlist,
        minSimilarityToKeepId: 0.5
    }
);
const elapsed = performance.now() - started;

if (asJson) {
    console.log(JSON.stringify(result.mixes.map((m) => ({
        title: m.title,
        label: m.label,
        share: m.share,
        tracks: m.tracks.map((t) => ({ ...t, title: m.info.get(t.key)!.title, artist: m.info.get(t.key)!.artists[0] }))
    })), null, 2));
    process.exit(0);
}

const genres = ["ambient", "techno", "jazz", "metal", "pop", "folk", "hip hop", "classical"];
console.log(`user ${user.id}: true modes ${user.modes.map((m) => `${genres[m.genre]}${m.decade ? ` ${m.decade}s` : ""} (${Math.round(m.weight * 100)} %)`).join(", ")}`);
console.log(`${result.mixes.length} mixes in ${elapsed.toFixed(0)} ms, ${result.candidatesScored} candidates scored\n`);
for (const mix of result.mixes) {
    const novel = mix.tracks.filter((t) => !t.familiar);
    const fit = novel.filter((t) => trulyFits(world, user, mix.info.get(t.key)!)).length;
    console.log(`== ${mix.title}  (${Math.round(mix.share * 100)} % of the listening, ${mix.tracks.length} tracks, ${novel.length} suggestions, ${fit}/${novel.length} truly fit)`);
    for (const t of mix.tracks.slice(0, 12)) {
        const info = mix.info.get(t.key)!;
        const why = t.reason.kind === "familiar"
            ? `familiar, ${t.reason.plays} plays`
            : `novel via ${t.reason.via}${t.reason.seedArtist ? `, because of ${t.reason.seedArtist}` : ""}`;
        const audio = info.audio ? `${info.audio.tempo.toFixed(0)} BPM, energy ${info.audio.energy.toFixed(2)}` : "no audio";
        console.log(`  ${String(t.position + 1).padStart(2)}. ${t.familiar ? " " : "+"} ${info.title} - ${info.artists[0]}  [${info.genres[0]}, ${info.releaseYear}; ${audio}]  ${why} (${t.confidence.toFixed(2)})`);
    }
    if (mix.tracks.length > 12) console.log(`  ... ${mix.tracks.length - 12} more`);
    console.log();
}

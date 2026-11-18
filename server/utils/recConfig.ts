// the recommender's configuration for this process, read once from the environment (NAFYN_REC_*).
// Values it had to ignore are reported by envCheck.ts at boot; here they simply fall back to the defaults.
import { type RecConfig, readRecConfig } from "./recommender/config";

let cached: RecConfig | null = null;

export function getRecConfig(): RecConfig {
    cached ??= readRecConfig(process.env).config;
    return cached;
}

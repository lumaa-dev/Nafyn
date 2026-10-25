// logs configuration problems (missing or wrong environment variables) at boot, so a half-finished setup
// shows up in the first screen of logs instead of as a confusing failure on the first download or login.
// The checks live in server/utils/envCheck.ts, shared with `bun run check:env`.
//
// Never stops the server: a problem here is reported, not enforced. NAFYN_ENV_CHECK=false silences it.
import { checkEnvironment, logEnvironmentReport } from "~~/server/utils/envCheck";

export default defineNitroPlugin(async () => {
    if (process.env.NAFYN_ENV_CHECK === "false") return;

    try {
        const config = useRuntimeConfig();
        logEnvironmentReport(await checkEnvironment({
            jwtSecret: config.jwtSecret,
            soulseekHost: config.soulseekHost,
            soulseekUsername: config.soulseekUsername,
            soulseekPassword: config.soulseekPassword,
            soulseekDownloadsPath: config.soulseekDownloadsPath,
            acoustidApiKey: config.acoustidApiKey,
            lastfmApiKey: config.lastfmApiKey,
            domainsWhitelist: config.domainsWhitelist
        }));
    } catch (error) {
        console.error("[env] configuration check failed to run:", error);
    }
});

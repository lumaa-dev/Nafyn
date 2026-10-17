// `bun run check:env` - full configuration report, without starting the server.
// Exits 1 when something is broken (errors), 0 otherwise, so it can gate a deploy or run in CI.
// bun loads .env from the working directory on its own, same file `bun run dev` uses.
import { checkEnvironment, formatReport } from "../server/utils/envCheck";

const issues = await checkEnvironment();
console.log(formatReport(issues).join("\n"));
process.exit(issues.some((issue) => issue.severity === "error") ? 1 : 0);

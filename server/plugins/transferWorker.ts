// starts the library-import worker (server/core/transferWorker.ts)
import { startTransferWorker } from "~~/server/core/transferWorker";

export default defineNitroPlugin(() => {
    // lets a second replica stand down; item claims keep concurrent workers correct, but only one of them
    // should be talking to Soulseek on the imports' behalf
    if (process.env.NAFYN_TRANSFER_WORKER === "false") {
        console.info("[transfer] import worker disabled by NAFYN_TRANSFER_WORKER=false");
        return;
    }

    // prerendering / `nuxt build` also evaluates plugins; only a running server should process imports
    if (import.meta.prerender) return;

    void startTransferWorker();
});

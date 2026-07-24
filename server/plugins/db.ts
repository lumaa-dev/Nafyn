import { initDatabases } from "../core/db";

export default defineNitroPlugin(() => {
    initDatabases();
});

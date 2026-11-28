// the commit this build was made from, for the bottom of Settings on every client. Public on purpose: it names
// a build, nothing about the instance's data, and a client can show it before it is logged in.
export default defineEventHandler(() => {
    const commit = String(useRuntimeConfig().buildSha || "");
    return { commit, shortCommit: commit.slice(0, 7) };
});

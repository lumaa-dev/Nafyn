import dns from "node:dns";

// on musl libc (Alpine, used by our Docker image) + ARM boards with flaky/absent IPv6 routes (e.g. an
// OrangePi behind a typical home router), Node's fetch (undici) can pick an AAAA record first, fail to
// connect, and surface it as a bare "TypeError: fetch failed" with no useful detail - this is a long-standing
// Node/undici issue on Docker/Alpine. Forcing IPv4-first resolution for every outbound fetch (AcoustID,
// MusicBrainz, Last.fm, slskd) avoids it without needing IPv6 to work at all.
dns.setDefaultResultOrder("ipv4first");

export default defineNitroPlugin(() => {});

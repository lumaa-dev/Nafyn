import { describe, expect, test } from "bun:test";
import { acquireDownloadSlot, downloadCooldownMs } from "../server/core/downloadQueue";

describe("download cooldown", () => {
    test("defaults to 7 seconds and reads NAFYN_DOWNLOAD_COOLDOWN_SECONDS", () => {
        expect(downloadCooldownMs({})).toBe(7000);
        expect(downloadCooldownMs({ NAFYN_DOWNLOAD_COOLDOWN_SECONDS: "" })).toBe(7000);
        expect(downloadCooldownMs({ NAFYN_DOWNLOAD_COOLDOWN_SECONDS: "2.5" })).toBe(2500);
        expect(downloadCooldownMs({ NAFYN_DOWNLOAD_COOLDOWN_SECONDS: "0" })).toBe(0);
    });

    test("garbage and negative values fall back to the default", () => {
        expect(downloadCooldownMs({ NAFYN_DOWNLOAD_COOLDOWN_SECONDS: "soon" })).toBe(7000);
        expect(downloadCooldownMs({ NAFYN_DOWNLOAD_COOLDOWN_SECONDS: "-3" })).toBe(7000);
    });
});

describe("download queue pause", () => {
    test("the next request waits the cooldown after the previous one is released", async () => {
        process.env.NAFYN_DOWNLOAD_COOLDOWN_SECONDS = "0.2";
        try {
            const first = await acquireDownloadSlot("a");
            let secondStartedAt = 0;
            const second = acquireDownloadSlot("b").then((release) => {
                secondStartedAt = Date.now();
                return release;
            });
            const releasedAt = Date.now();
            first();
            const release = await second;
            expect(secondStartedAt - releasedAt).toBeGreaterThanOrEqual(150);
            release();
        } finally {
            delete process.env.NAFYN_DOWNLOAD_COOLDOWN_SECONDS;
        }
    });

    test("nobody waiting means no pause", async () => {
        process.env.NAFYN_DOWNLOAD_COOLDOWN_SECONDS = "5";
        try {
            const release = await acquireDownloadSlot("c");
            release();
            const startedAt = Date.now();
            const next = await acquireDownloadSlot("d");
            expect(Date.now() - startedAt).toBeLessThan(500);
            next();
        } finally {
            delete process.env.NAFYN_DOWNLOAD_COOLDOWN_SECONDS;
        }
    });
});

import { describe, expect, test } from "bun:test";
import { appLinkFor, isMobileDevice, requestedPath } from "../app/utils/appLink";

const MBID = "f8ecd693-2c62-4fc0-98f3-e2c8a5f70f6b";

describe("app links", () => {
    test("the screens the app's scheme knows", () => {
        expect(appLinkFor(`/a/${MBID}`)).toBe(`nafyn://album/${MBID}`);
        expect(appLinkFor(`/t/${MBID.toUpperCase()}/`)).toBe(`nafyn://track/${MBID}`);
        expect(appLinkFor(`/a/${MBID}?release=x#top`)).toBe(`nafyn://album/${MBID}`);
        expect(appLinkFor("/requests")).toBe("nafyn://requests");
    });

    test("every other page stays on the web", () => {
        expect(appLinkFor("/")).toBeNull();
        expect(appLinkFor("/a/not-an-id")).toBeNull();
        expect(appLinkFor(`/l/a/${MBID}`)).toBeNull();
        expect(appLinkFor(`/ar/${MBID}`)).toBeNull();
        expect(appLinkFor(`/a/${MBID}/extra`)).toBeNull();
        expect(appLinkFor("/requests/abc")).toBeNull();
        expect(appLinkFor("/privacy")).toBeNull();
    });

    test("the page a logged-out visitor was sent away from", () => {
        expect(requestedPath("/login", `/t/${MBID}`)).toBe(`/t/${MBID}`);
        expect(requestedPath("/login", "//evil.example/t/x")).toBe("/login");
        expect(requestedPath("/login", "https://evil.example")).toBe("/login");
        expect(requestedPath("/login", null)).toBe("/login");
        expect(requestedPath("/requests", "/t/x")).toBe("/requests");
    });

    test("phones and tablets only", () => {
        expect(isMobileDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)", 5)).toBe(true);
        expect(isMobileDevice("Mozilla/5.0 (Linux; Android 16; Pixel 9)", 5)).toBe(true);
        expect(isMobileDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
        expect(isMobileDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
        expect(isMobileDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe(false);
    });
});

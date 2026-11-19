// A Nafyn page opened on a phone or tablet hands over to the app (`nafyn://`, see app/utils/appLink.ts), logged in
// or not, whenever the app has that screen. Only the page the browser was opened on, never a navigation inside the
// web app (that person chose the web), once per tab, and never with `?web` in the address.
//
// A custom scheme cannot tell whether the app is installed: without it, iOS shows "address is invalid". So when the
// page is still in front a few seconds after the attempt, the app is taken to be absent and not asked for again on
// this browser for a week - and as soon as the app does take over (the page goes to the background), that is
// forgotten.
import { appLinkFor, isMobileDevice, requestedPath } from "~/utils/appLink";

const TRIED_KEY = "nafyn.appHandoff.tried";
const ABSENT_KEY = "nafyn.appHandoff.absentUntil";
const ABSENT_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENT_WITHIN_MS = 2500;

function storage(kind: "local" | "session"): Storage | null {
    try {
        return kind === "local" ? window.localStorage : window.sessionStorage;
    } catch {
        return null; // site data blocked
    }
}

export default defineNuxtPlugin(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("web")) {
        storage("session")?.setItem(TRIED_KEY, "1");
        return;
    }
    if (!isMobileDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0)) return;

    const session = storage("session");
    const local = storage("local");
    if (session?.getItem(TRIED_KEY)) return;
    if (Number(local?.getItem(ABSENT_KEY) ?? 0) > Date.now()) return;

    const target = appLinkFor(requestedPath(url.pathname, url.searchParams.get("from")));
    if (!target) return;
    session?.setItem(TRIED_KEY, "1");

    let tookOver = false;
    const onHidden = () => {
        if (document.visibilityState !== "hidden") return;
        tookOver = true;
        local?.removeItem(ABSENT_KEY);
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", () => { tookOver = true; local?.removeItem(ABSENT_KEY); }, { once: true });

    window.setTimeout(() => {
        if (!tookOver) local?.setItem(ABSENT_KEY, String(Date.now() + ABSENT_FOR_MS));
    }, PRESENT_WITHIN_MS);
    // a late "Open" tap on the system's confirmation still counts: listen a while longer before letting go
    window.setTimeout(() => document.removeEventListener("visibilitychange", onHidden), 30_000);

    window.location.href = target;
});

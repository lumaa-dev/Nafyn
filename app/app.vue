<template>
	<div>
		<Header :toggleSidebar="toggleSidebar" :class="`hd ${hasToken ? '' : 'out'}`" :sidebarActive="showSidebar && isMobileWidth()" />
		<Sidebar :class="`sb ${showSidebar ? '' : 'hide'}`" @click="toggleSidebar" />
		<NuxtPage class="view" />
		<TransitionGroup tag="span" name="pill" class="toasts">
			<ToastPill v-for="(toast, index) in tState.toasts.slice(0, 3)" :key="toast.id" :toast="toast" :underLast="tState.lastToast?.id !== toast.id" :style="`top: ${index * -40}px; scale: ${index * -0.2 + 1}; z-index: ${-index + 3}`" />
		</TransitionGroup>
		<NowPlaying v-if="hasToken && route.path !== '/now-playing'" />
	</div>
</template>

<style>
@font-face {
	font-family: "Instrument-Serif";
	src: url("./assets/fonts/InstrumentSerif-Regular.ttf");
}

@font-face {
	font-family: "Instrument-Italic";
	src: url("./assets/fonts/InstrumentSerif-Italic.ttf");
}

/* "Discy" is the UI sans (inputs, numbers, small print): SF Pro where the device has it, then Arial, then
   whatever sans-serif the system has. It used to be an @font-face with no url(), which browsers drop whole -
   so it silently fell back to the default serif on devices that were meant to get a system font. Use the
   variable; there is no "Discy" family to ask for. */
:root {
	--font-discy: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", Arial, "Helvetica Neue", sans-serif;
}

html {
	/* the page scrollbar is always there (body is overflow-y: scroll); this stops the layout from shifting
	   when a modal or panel briefly takes it away */
	scrollbar-gutter: stable;
}

* {
	padding: 0;
	margin: 0;
	box-sizing: border-box;
}

body {
	background: #2a2a27;
	color: #ffffffae;
	font-family: "Instrument-Serif";
	font-size: 1.5em;
	max-width: 100%;
	overflow: hidden scroll;
}

a {
	color: inherit;
	text-decoration: underline;
}

a, h1, h2, h3, h4, h5, h6 {
	font-family: "Instrument-Italic";
}

code {
    font-family: monospace;
}

input[type="text"], input[type="password"] {
	background: #00000050;
	padding: 15px 30px;
	border-radius: 250px;
	outline: none;
	border: none;
	font-family: var(--font-discy);
	font-size: 0.8em;
	color: inherit;
}

textarea {
	background: #00000050;
	padding: 15px 30px;
	border-radius: 20px;
	outline: none;
	border: none;
	font-family: var(--font-discy);
	font-size: 0.8em;
	color: inherit;
	resize: none !important;
}

select {
	background: #1a1a1a;
	border: 1px solid #333333;
	border-radius: 50vw;
	outline: none;
	padding: 0.6em 1em;
	font-family: var(--font-discy);
	font-size: 0.8em;
	color: inherit;
	cursor: pointer;
	/* appearance: none; */
}

select:hover {
	background: #232323;
}

select option {
	background: #1a1a1a;
	color: inherit;
}

button {
	cursor: pointer;
	background: #00000000;
	border: none;
	outline: none;
	font-size: inherit;
}

button[filled], a[filled], p[filled] {
	background: #ffffffae;
	border: #ffffffae 1px solid;
	outline: none;
	border-radius: 250px;
	color: #000;
	font-family: "Instrument-Serif";
	text-decoration: none;
	font-size: inherit;
	/* a label is one line, always, and has to fit its frame: the side padding gives way first (down to
	   0.9em, from 3em), so a button in a narrow column loses air, not text. If it still doesn't fit, the
	   label is cut with an ellipsis rather than spilling out of the button. */
	padding: 0.6em clamp(0.9em, 3vw, 3em);
	white-space: nowrap;
	max-width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	transition: background 0.25s ease-out, opacity 0.15s ease-out, color 0.15s ease-out;
}

button[filled="hollow"], p[filled="hollow"] {
	background: #ffffff00;
	color: #ffffffae;
}

button[filled]:hover:not(:disabled), a[filled]:hover:not(:disabled) {
	background: #ffffffd0;
	border: #ffffffd0 1px solid;
}

button[filled="hollow"]:hover:not(:disabled), a[filled="hollow"]:hover:not(:disabled) {
	color: #000000;
}

/* destructive: white on this red is ~10:1 (AAA). The hover rule has to restate `color`: the hollow hover
   above is more specific than a plain `.danger` and would turn the label black. */
button[filled].danger, a[filled].danger {
	background: #b3261e;
	border: #b3261e 1px solid;
	color: #ffffff;
}

button[filled].danger:hover:not(:disabled), a[filled].danger:hover:not(:disabled) {
	background: #8c1d18;
	border: #8c1d18 1px solid;
	color: #ffffff;
}

/* icon-only buttons (a symbol instead of a label, where a row of text buttons would not fit): a 44px circle
   (WCAG 2.5.5), the icon SVGs are black so they are inverted to white until the hover fills the button.
   Always give one an aria-label - there is no text to name it. */
button.icon-only {
	width: 44px;
	height: 44px;
	padding: 0;
	border-radius: 50%;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

button.icon-only img {
	width: 1.1em;
	height: 1.1em;
	filter: invert(1);
	transition: filter 0.15s ease-out;
}

button.icon-only:hover:not(:disabled) img,
button.icon-only[filled]:not([filled="hollow"]) img {
	filter: none;
}

/* keyboard focus is always visible (the resets above remove the browser's own ring) */
:where(button, a, select, summary):focus-visible {
	outline: 2px solid #ffffff;
	outline-offset: 2px;
}

input:focus-visible, textarea:focus-visible {
	outline: 2px solid #ffffff;
	outline-offset: 2px;
}

*:disabled {
	cursor: not-allowed !important;
	opacity: 0.7;
}

.hd.out button {
	cursor: default !important;
}

.sb {
	transition: left 0.25s ease-out, opacity 0.25s ease-out;
}

.sb.hide {
	/* position: fixed */
	opacity: 0;
	left: -50px;
	pointer-events: none;
}

.view {
	margin: calc(15vh - 10px) 1.2em;
	/* sidebar is a permanent column above 800px (see Sidebar.vue), so content shifts right to sit clear of it */
	margin-left: calc(220px + 1.2em);
	padding-bottom: 6em;
}

.toasts {
	display: flex;
	flex-direction: column;
	width: 100%;
	align-items: center;
	position: fixed;
	bottom: 100px;
	left: 0;
	height: 10vh;
	pointer-events: none !important;
	user-select: none !important;
}

.toasts > * {
	width: fit-content;
}

.toasts > *:not(:first-child) {
	filter: brightness(0.8);
}

.pill-enter-active {
  animation: appearPill 0.35s ease-out forwards;
}

.pill-leave-active {
  animation: disappearPill 0s ease-in forwards;
}

@keyframes appearPill {
	0% {
		opacity: 0;
	}
	100% {
		opacity: 1;
	}
}

@keyframes disappearPill {
  0% { 
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@media screen and (max-width: 800px) {
	/* sidebar is a toggled full-screen overlay below 800px (see Sidebar.vue), not a permanent column,
	   so content isn't shifted here - back to the plain default margin */
	.view {
		margin: calc(20vh - 10px) 1.2em;
		padding-bottom: 6em;
	}
}

@media (prefers-reduced-motion: reduce) {
	.sb {
		transition: none !important;
	}
}
</style>

<script setup lang="ts">
import Header from "./components/Header.vue";
import Sidebar from "./components/Sidebar.vue";
import ToastPill from "./components/ToastPill.vue";
import NowPlaying from "./components/NowPlaying.vue";
import { useAuthToken, isTokenExpired } from "./composables/useAuthToken";

const route = useRoute();
const showSidebar = ref(false);

const { token: tokenCookie } = useAuthToken();

const { state: tState } = useToast();

const hasToken = ref(await checkTokenValidity(tokenCookie.value ?? ""));

function redirectIfLoggedOut() {
	// /privacy sits with login/register: GDPR art. 13 means the notice has to be readable *before* anyone
	// hands over data, so bouncing a logged-out visitor off it would defeat its whole purpose
	const isNotLogging = route.path !== "/login" && route.path !== "/register" && route.path !== "/privacy";
	const isViewingPlaylist = route.path.includes("/l/playlist");
	if (isNotLogging && !isViewingPlaylist && !hasToken.value) {
		useRouter().push(`/login`);
	}
}
redirectIfLoggedOut();

// login/register/logout set the cookie via client-side navigateTo (no app.vue remount), so hasToken
// must be re-derived reactively here or the Header/Sidebar/NowPlaying stay stuck in their initial state
watch(tokenCookie, async (val) => {
	hasToken.value = await checkTokenValidity(val ?? "");
	redirectIfLoggedOut();
});

// matches the server's sessionCache TTL (server/utils/sessionCache.ts) - catches a session revoked from
// another device within that same window, since a revocation alone never touches this device's cookie
const REVALIDATE_INTERVAL_MS = 30_000;
if (import.meta.client) {
	const revalidate = async () => {
		hasToken.value = await checkTokenValidity(tokenCookie.value ?? "");
		redirectIfLoggedOut();
	};
	// a hidden tab has nothing to show for it and wakes the radio on a phone: skip the tick, and check once the
	// moment the tab comes back instead
	const revalidateInterval = setInterval(() => {
		if (!document.hidden) revalidate();
	}, REVALIDATE_INTERVAL_MS);
	const onVisible = () => { if (!document.hidden) revalidate(); };
	document.addEventListener("visibilitychange", onVisible);
	onUnmounted(() => {
		clearInterval(revalidateInterval);
		document.removeEventListener("visibilitychange", onVisible);
	});
}

const isMobileWidth = () => window.matchMedia("(max-width: 800px)").matches;

// Logging in (or back in, after a revoked session) never remounts this component, so the one-time sync in
// onMounted below doesn't run again - the desktop sidebar would stay hidden until a refresh. Follow the login
// state itself: on desktop the sidebar is permanently on while logged in and gone otherwise.
watch(hasToken, (loggedIn) => {
	if (!import.meta.client) return;
	if (isMobileWidth()) {
		if (!loggedIn) {
			showSidebar.value = false;
			lockScroll(false);
		}
		return;
	}
	showSidebar.value = loggedIn;
});

function toggleSidebar() {
	if (!hasToken.value) return;
	// sidebar is permanently visible above 800px (see Sidebar.vue) - nothing to toggle there, and
	// flipping showSidebar anyway would still trigger lockScroll and leave the page stuck unscrollable
	if (!isMobileWidth()) return;
	showSidebar.value = !showSidebar.value;
	lockScroll(showSidebar.value);
}

// keeps the desktop sidebar shown (once logged in) without going through the toggle/lockScroll path above,
// and re-syncs if the viewport crosses the 800px breakpoint (e.g. rotating a tablet, resizing a window)
onMounted(() => {
	const mq = window.matchMedia("(max-width: 800px)");
	const sync = () => {
		// desktop: permanently on once logged in. mobile: back to closed-by-default (toggled via Wordmark),
		// since it was only ever forced open here because of the desktop rule, not because the user toggled it
		showSidebar.value = !mq.matches && hasToken.value;
		// this can flip showSidebar to false without ever going through toggleSidebar's lockScroll(false) -
		// without this, a scroll lock left over from a mobile-open sidebar can survive a resize/rotation
		// past the breakpoint and keep fighting the page's own scroll (incl. on navigation) indefinitely
		if (!showSidebar.value) lockScroll(false);
	};
	sync();
	mq.addEventListener("change", sync);
	onUnmounted(() => mq.removeEventListener("change", sync));

	// belt-and-braces: never let a stuck scroll lock survive a navigation, regardless of how it got stuck
	const router = useRouter();
	const stopGuard = router.afterEach(() => lockScroll(false));
	onUnmounted(stopGuard);
});

let scrollLockHandler: (() => void) | null = null;

function lockScroll(lock: boolean = true) {
	if (scrollLockHandler) {
		window.removeEventListener("scroll", scrollLockHandler);
		scrollLockHandler = null;
	}

	if (lock) {
		const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
		const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

		scrollLockHandler = () => window.scrollTo(scrollLeft, scrollTop);
		window.addEventListener("scroll", scrollLockHandler);
	}
}

async function checkTokenValidity(token: string): Promise<boolean> {
	if (!token || isTokenExpired(token)) return false;

	try {
		await $fetch("/api/v1/user/me", {
			headers: { Authorization: token }
		});
		return true;
	} catch (e) {
		return false;
	}
}
</script>

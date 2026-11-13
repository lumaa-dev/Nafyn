<template>
	<div>
		<Header :toggleSidebar="toggleSidebar" :class="`hd ${hasToken ? '' : 'out'}`" :sidebarActive="showSidebar && isMobileWidth()" :loggedIn="hasToken" />
		<Sidebar :class="`sb ${showSidebar ? '' : 'hide'}`" @click="toggleSidebar" />
		<NuxtPage class="view" />
		<TransitionGroup tag="span" name="pill" class="toasts">
			<ToastPill v-for="(toast, index) in tState.toasts.slice(0, 3)" :key="toast.id" :toast="toast" :underLast="tState.lastToast?.id !== toast.id" :style="`top: ${index * -40}px; scale: ${index * -0.2 + 1}; z-index: ${-index + 3}`" />
		</TransitionGroup>
		<NowPlaying v-if="hasToken && route.path !== '/now-playing'" />
		<MediaMenuHost v-if="hasToken" />
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

/* OpenDyslexic: only fetched when the Appearance setting turns it on (see .dyslexic-font below).
   Its glyphs are far larger than the fonts it replaces at the same font-size (cap height 0.85 em against
   0.72 for Instrument Serif and ~0.71 for SF Pro, and much wider letters), so every face is scaled down with
   size-adjust: layouts keep the sizes they were designed with instead of overflowing. */
@font-face {
	font-family: "OpenDyslexic";
	font-style: normal;
	font-weight: 400;
	font-display: swap;
	size-adjust: 72%;
	src: url("./assets/fonts/OpenDyslexic-Regular.otf") format("opentype");
}

@font-face {
	font-family: "OpenDyslexic";
	font-style: italic;
	font-weight: 400;
	font-display: swap;
	size-adjust: 72%;
	src: url("./assets/fonts/OpenDyslexic-Italic.otf") format("opentype");
}

@font-face {
	font-family: "OpenDyslexic";
	font-style: normal;
	font-weight: 700;
	font-display: swap;
	size-adjust: 72%;
	src: url("./assets/fonts/OpenDyslexic-Bold.otf") format("opentype");
}

@font-face {
	font-family: "OpenDyslexic";
	font-style: italic;
	font-weight: 700;
	font-display: swap;
	size-adjust: 72%;
	src: url("./assets/fonts/OpenDyslexic-BoldItalic.otf") format("opentype");
}

/* "Discy" is the UI sans (inputs, numbers, small print): SF Pro where the device has it, then Arial, then
   whatever sans-serif the system has. It used to be an @font-face with no url(), which browsers drop whole -
   so it silently fell back to the default serif on devices that were meant to get a system font. Use the
   variable; there is no "Discy" family to ask for. */
:root {
	--font-discy: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "SF Pro", Arial, "Helvetica Neue", sans-serif;
	/* DESIGN.md "Contrast" (WCAG AAA): the palette red #e06666ae cannot carry text at 7:1 either way round, so
	   destructive UI uses a deeper red of the same hue as a fill (white label: 7.2:1, 8:1 hovered) and a light
	   red for red text, symbols and borders on dark surfaces (7.2:1 on #2a2a27). */
	--danger-fill: #a02c2e;
	--danger-fill-hover: #8f2527;
	--danger-text: #ff9e9e;
}

/* Settings -> Appearance -> OpenDyslexic: every font on the page, whatever its place or purpose (serif
   headings, UI sans, inputs, monospace, SVG chart labels, pseudo-elements), becomes OpenDyslexic. The
   !important is the point - the app sets font-family on dozens of selectors and this must beat all of them. */
html.dyslexic-font,
html.dyslexic-font *,
html.dyslexic-font *::before,
html.dyslexic-font *::after {
	font-family: "OpenDyslexic", var(--font-discy) !important;
}

html {
	/* the page scrollbar is always there (body is overflow-y: scroll); this stops the layout from shifting
	   when a modal or panel briefly takes it away */
	scrollbar-gutter: stable;
	/* DESIGN.md "Layout of pages and views": nothing ever scrolls sideways, whatever sticks out of the viewport */
	overflow-x: clip;
	max-width: 100%;
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
	overflow-x: hidden;
	overflow-y: scroll;
	/* micro-animation between states (DESIGN.md "Interface"): a detail screen tints the body with its cover's colour */
	transition: background 0.4s ease-out, color 0.4s ease-out;
}

/* the permanent sidebar column (above 800px, while the sidebar is shown): the pages sit in what is left of the
   width, centred, instead of every page restating the clearance in its own margin */
@media screen and (min-width: 801px) {
	body:has(.sidebar:not(.hide)) {
		padding-left: 220px;
	}
}

/* Now Playing never scrolls, on any axis (DESIGN.md "Now Playing") - not even the page's own scrollbar */
body:has(.npp:not(.empty)) {
	overflow: hidden;
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

/* DESIGN.md "Text fields": every field is Nafyn's own, none uses the browser's default style. They share the header's
   search field: a translucent background over a slightly blurred backdrop, rounded, the app's sans, a visible focus. */
input:where(:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="submit"], [type="button"], [type="reset"], [type="image"], [type="hidden"])),
textarea,
select {
	background: #ffffff20;
	-webkit-backdrop-filter: blur(12px);
	backdrop-filter: blur(12px);
	border: 1px solid transparent;
	outline: none;
	font-family: var(--font-discy);
	font-size: 0.8em;
	color: inherit;
	max-width: 100%;
	min-width: 0;
	transition: background 0.2s ease-out, border-color 0.2s ease-out, box-shadow 0.2s ease-out;
}

input:where(:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="submit"], [type="button"], [type="reset"], [type="image"], [type="hidden"])) {
	padding: 0.8em 1.6em;
	border-radius: 250px;
}

textarea {
	padding: 0.8em 1.6em;
	border-radius: 20px;
	resize: none !important;
}

select {
	padding: 0.6em 1em;
	border-radius: 50vw;
	cursor: pointer;
}

input:where(:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="submit"], [type="button"], [type="reset"], [type="image"], [type="hidden"])):hover:not(:disabled),
textarea:hover:not(:disabled),
select:hover:not(:disabled) {
	background: #ffffff2e;
}

input:where(:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="submit"], [type="button"], [type="reset"], [type="image"], [type="hidden"])):focus,
textarea:focus,
select:focus {
	background: #ffffff2e;
	border-color: #ffffffae;
}

input::placeholder,
textarea::placeholder {
	color: #ffffffae;
	opacity: 1;
}

input[type="search"]::-webkit-search-cancel-button {
	-webkit-appearance: none;
	appearance: none;
}

input[type="number"] {
	-moz-appearance: textfield;
	appearance: textfield;
}

select option {
	background: #1a1a1a;
	color: #ffffffae;
}

button {
	cursor: pointer;
	background: #00000000;
	border: none;
	outline: none;
	font-size: inherit;
}

/* a detail screen tinted with its cover (useCoverTint, DESIGN.md "Track/Album Detail view" + "Contrast"): the
   translucent white fill vanished on a light cover, so there a filled button is solid, in the label colour, with
   the page's background as its label. Only inside the page: a sheet teleported over it keeps its own look. When
   the page is not tinted, the --page-tint-* are unset and every rule below falls back to the default colours. */
.view {
	--tint-fill: var(--page-tint-fill);
	--tint-fill-hover: color-mix(in srgb, var(--page-tint-fill) 82%, var(--page-tint-label));
	--tint-fill-label: var(--page-tint-label);
	--tint-fill-icon: var(--page-tint-fill-icon);
}

button[filled], a[filled], p[filled] {
	background: var(--tint-fill, #ffffffae);
	border: var(--tint-fill, #ffffffae) 1px solid;
	outline: none;
	border-radius: 250px;
	color: var(--tint-fill-label, #000);
	font-family: "Instrument-Serif";
	text-decoration: none;
	font-size: inherit;
	/* a label is one line, always, and has to fit its frame: the side padding gives way first (down to
	   0.9em, from 3em), so a button in a narrow column loses air, not text. If it still doesn't fit, the
	   label is cut with an ellipsis rather than spilling out of the button. */
	padding: 0.6em clamp(0.9em, 3vw, 3em);
	/* DESIGN.md "Filled & Hollow": the content is centred in the frame, both ways, and never clips out of it
	   (`align-content` centres a block's lines vertically, so a button stretched taller than its text still
	   shows the label in the middle, and the ellipsis below keeps working) */
	display: inline-block;
	text-align: center;
	align-content: center;
	line-height: 1.25;
	white-space: nowrap;
	max-width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	transition: background 0.25s ease-out, opacity 0.15s ease-out, color 0.15s ease-out;
}

button[filled="hollow"], p[filled="hollow"] {
	background: #ffffff00;
	/* --tint-fg is set while a detail screen is tinted with its cover (useCoverTint): black or white for contrast */
	color: var(--tint-fg, #ffffffae);
	border-color: var(--tint-fg, #ffffffae);
}

button[filled]:hover:not(:disabled), a[filled]:hover:not(:disabled) {
	background: var(--tint-fill-hover, #ffffffd0);
	border: var(--tint-fill-hover, #ffffffd0) 1px solid;
}

button[filled="hollow"]:hover:not(:disabled), a[filled="hollow"]:hover:not(:disabled) {
	color: var(--tint-fill-label, #000000);
}

/* destructive (DESIGN.md "Colors" + "Contrast"). A destructive button is either filled (deep red fill, white label,
   a darker fill on hover) or hollow (light red border and label, a faint red wash on hover) - never one that turns
   into the other. The label on a red fill is white (the hover rule above is
   more specific than a plain `.danger`, so every state restates `color`). */
button[filled].danger, a[filled].danger {
	background: var(--danger-fill);
	border: var(--danger-fill) 1px solid;
	color: #ffffff;
}

button[filled="hollow"].danger, a[filled="hollow"].danger {
	background: transparent;
	border-color: var(--danger-text);
	color: var(--danger-text);
}

button[filled].danger:hover:not(:disabled), a[filled].danger:hover:not(:disabled) {
	background: var(--danger-fill-hover);
	border: var(--danger-fill-hover) 1px solid;
	color: #ffffff;
}

/* a hollow destructive button stays hollow on hover: a faint wash of the red, the border and label do not change */
button[filled="hollow"].danger:hover:not(:disabled), a[filled="hollow"].danger:hover:not(:disabled) {
	background: color-mix(in srgb, var(--danger-text) 20%, transparent);
	border: var(--danger-text) 1px solid;
	color: var(--danger-text);
}

/* "over" buttons: a translucent grey pill with a blurred backdrop, for controls that float over content (the
   bulk-select button at the bottom corner of a page, and whatever floats next). Not a `filled` button on
   purpose - it has to let what scrolls beneath it show through. The grey is dark enough (and the blur flattens
   the content under it) for white text to stay at AAA contrast on any cover or page background. */
button.over, a.over {
	background: rgba(58, 58, 54, 0.72);
	-webkit-backdrop-filter: blur(16px) saturate(140%);
	backdrop-filter: blur(16px) saturate(140%);
	border: 1px solid rgba(255, 255, 255, 0.28);
	border-radius: 250px;
	color: #ffffff;
	font-family: var(--font-discy);
	font-size: 0.7em;
	text-decoration: none;
	padding: 0.7em clamp(0.9em, 2.4vw, 1.6em);
	white-space: nowrap;
	max-width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
	transition: background 0.2s ease-out, border-color 0.2s ease-out, transform 0.15s ease-out;
}

button.over:hover:not(:disabled), a.over:hover:not(:disabled) {
	background: rgba(84, 84, 78, 0.82);
	border-color: rgba(255, 255, 255, 0.5);
}

button.over:active:not(:disabled) {
	transform: scale(0.97);
}

/* a pressed/active toggle (select mode on) reads by more than colour: the border thickens too */
button.over[aria-pressed="true"] {
	background: rgba(255, 255, 255, 0.9);
	border-color: #ffffff;
	color: #000000;
}

@media (prefers-reduced-motion: reduce) {
	button.over, a.over {
		transition: none;
	}
}

/* icon-only buttons (a symbol instead of a label, where a row of text buttons would not fit): a 44px circle
   (WCAG 2.5.5), the icon SVGs are black so they are inverted to white until the hover fills the button.
   Always give one an aria-label - there is no text to name it. */
button.icon-only {
	/* a circle, always (DESIGN.md "Icon-only buttons"): a fixed square the height of a text button beside it
	   (0.6em of padding twice + a 1.25 line + the border), never less than 44px. It must not stretch with its row:
	   `align-self: center` keeps a flex row's `align-items: stretch` from making it taller than wide. */
	width: max(44px, calc(2.45em + 2px));
	height: max(44px, calc(2.45em + 2px));
	min-width: 0;
	min-height: 0;
	align-self: center;
	aspect-ratio: 1 / 1;
	padding: 0;
	border-radius: 50%;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

/* DESIGN.md "Icon-only buttons": the symbol takes at least 90% of the button's width */
button.icon-only img,
button.icon-only svg {
	width: 70%;
	height: 70%;
}

/* the icon FILES are black: white by default, and black again on a page whose labels are black (useCoverTint).
   An inline <svg> draws in `currentColor` already (the ellipsis buttons), so inverting it too made it black. */
button.icon-only img {
	filter: var(--icon-filter, invert(1));
	transition: filter 0.15s ease-out;
}

button.icon-only svg {
	color: inherit;
}

button.icon-only:hover:not(:disabled) img,
button.icon-only[filled]:not([filled="hollow"]) img {
	/* on the fill: black on the default white fill, white on a black one (a light cover's page) */
	filter: var(--tint-fill-icon, none);
}

/* DESIGN.md "Animations": no state of any control jumps. Hover, focus, pressed, selected and disabled all
   blend (the more specific rules above restate their own, longer, transitions where they have one). */
:where(button, a, summary, select, textarea, input, label, li, [role="option"], [role="menuitem"]) {
	transition-property: background-color, color, border-color, opacity, box-shadow, transform, filter, outline-color;
	transition-duration: 0.2s;
	transition-timing-function: ease-out;
}

:where(button:not(:disabled), [role="button"]):active {
	transform: scale(0.97);
}

/* sheets and menus fade and move slightly in; the sheets' backdrop darkens progressively */
.modal-backdrop {
	animation: fade-in 0.2s ease-out;
}

.modal {
	animation: sheet-pop 0.22s ease-out;
}

@keyframes fade-in {
	from { opacity: 0; }
	to { opacity: 1; }
}

@keyframes sheet-pop {
	from { opacity: 0; transform: translateY(12px) scale(0.98); }
	to { opacity: 1; transform: none; }
}

/* keyboard focus is always visible (the resets above remove the browser's own ring) */
:where(button, a, select, summary):focus-visible {
	outline: 2px solid var(--tint-fill, #ffffff);
	outline-offset: 2px;
}

input:focus-visible, textarea:focus-visible {
	outline: 2px solid var(--tint-fill, #ffffff);
	outline-offset: 2px;
}

/* DESIGN.md "Buttons": a disabled control is at 174/255 opacity. A filled / hollow button already carries 174 in its
   own colour (#ffffffae), so the two add up on top of each other (118/255 in all) - no special case needed. */
*:disabled {
	cursor: not-allowed !important;
	opacity: calc(174 / 255);
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

/* Every page's root IS `.view`: the margin is the clearance below the fixed Header (and its gradient), the side
   padding is the gutter that keeps content off the edges of the display (DESIGN.md "Layout of pages and views"),
   and the sidebar column is the body's own padding (above). `div.view` is more specific than a page's own
   `.page {}` rule on purpose: a page sets `max-width` and `padding`, never its margin, so it can no longer slide
   under the Header or the sidebar, nor touch the edges. */
div.view {
	margin: calc(15vh - 10px) auto 0;
	padding: 0 1.2em 6em;
	width: 100%;
	min-width: 0;
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
	div.view {
		margin-top: calc(20vh - 10px);
	}
}

@media (prefers-reduced-motion: reduce) {
	body, button, a, input, textarea, select, label, li {
		transition: none !important;
	}

	.modal-backdrop {
		animation: fade-in 0.01s linear;
	}

	.modal {
		animation: none !important;
	}

	button:active {
		transform: none !important;
	}

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

applyDyslexicFont();

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
	// a user's profile (/u/<username>) is public, like a public playlist
	const isViewingProfile = route.path.startsWith("/u/");
	if (isNotLogging && !isViewingPlaylist && !isViewingProfile && !hasToken.value) {
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

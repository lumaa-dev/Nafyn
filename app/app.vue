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

@font-face {
	font-family: "Discy";
	src: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
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
	font-family: "Discy";
	font-size: 0.8em;
	color: inherit;
}

textarea {
	background: #00000050;
	padding: 15px 30px;
	border-radius: 20px;
	outline: none;
	border: none;
	font-family: "Discy";
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
	font-family: "Discy";
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
	padding: 0.6em 3.0em;
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

button[filled].danger, a[filled].danger {
	background: #e06666ae;
	border: #e06666ae 1px solid;
	color: #ffffffae;
}

button[filled].danger:hover, a[filled].danger:hover {
	background: #e06666d0;
	border: #e06666d0 1px solid;
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
	width: 100vw;
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

const route = useRoute();
const showSidebar = ref(false);

const tokenCookie = useCookie("nafynToken");

const { state: tState } = useToast();

const hasToken = ref(await checkTokenValidity(tokenCookie.value ?? ""));

function redirectIfLoggedOut() {
	const isNotLogging = route.path !== "/login" && route.path !== "/register";
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

const isMobileWidth = () => window.matchMedia("(max-width: 800px)").matches;

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
	if (!token) return false;

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

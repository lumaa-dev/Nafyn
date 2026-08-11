<template>
	<div>
		<Header :toggleSidebar="toggleSidebar" :class="`hd ${hasToken ? '' : 'out'}`" :sidebarActive="showSidebar" />
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
	font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
	font-size: 0.8em;
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

const token = useCookie("nafynToken").value;

const { state: tState } = useToast();

const hasToken = ref(await checkTokenValidity(token ?? ""));
if (route.path !== "/login" && route.path !== "/register" && !hasToken.value) {
	useRouter().push(`/login`);
}

function toggleSidebar() {
	if (!hasToken.value) return;
	showSidebar.value = !showSidebar.value;
	lockScroll(showSidebar.value);
}

function lockScroll(lock: boolean = true) {
	if (lock) {
		let scrollTop = window.pageYOffset || document.documentElement.scrollTop;
		let scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

		window.onscroll = () => {
		window.scrollTo(scrollLeft, scrollTop);
		}
	} else {
		window.onscroll = () => {}
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

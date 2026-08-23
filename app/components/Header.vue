<template>
  <header ref="headerRef">
    <ProgressiveBlur class="backblur" height="80%" fade-color="#00000050" />
    <span>
      <button v-show="!mobileSearchActive" @click="props.toggleSidebar()">
        <Wordmark />
      </button>
      <button class="search-toggle" :class="{ active: mobileSearchActive }" @click="mobileSearchActive = !mobileSearchActive">
        <img src="../assets/icons/search.svg" draggable="false" />
      </button>
      <input v-model="searchText" type="text" name="search" id="search" :class="{ 'mobile-active': mobileSearchActive }" :placeholder="$t('common.search')" :disabled="sidebarActive" @keydown.enter="navigateTo(`/search?q=${encodeURIComponent(searchText)}`)">
    </span>
  </header>
</template>

<script lang="ts" setup>
import ProgressiveBlur from './TopProgressiveBlur.vue';
import Wordmark from './Wordmark.vue';

const searchText = ref("");
const mobileSearchActive = ref(false);
const headerRef = ref<HTMLElement | null>(null);

const props = defineProps({
  toggleSidebar: { type: Function, default: () => { } },
  sidebarActive: { type: Boolean, default: false }
})

function onClickOutside(event: MouseEvent) {
  if (mobileSearchActive.value && headerRef.value && !headerRef.value.contains(event.target as Node)) {
    mobileSearchActive.value = false;
  }
}

onMounted(() => document.addEventListener('click', onClickOutside));
onUnmounted(() => document.removeEventListener('click', onClickOutside));
</script>

<style>
header {
  position: fixed;
  top: 0;
  left: 0;
  padding: 20px 60px;
  background: linear-gradient(180deg, #000000cc, #00000000);
  width: 100%;
  height: 15vh;
  display: flex;
  flex-direction: row;
  align-items: center;
  z-index: 100;
}

header > span {
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  margin-bottom: 30px;
}

header input[type="text"] {
  background: #ffffff20;
  z-index: 100;
}

header input[type="text"]:disabled {
  z-index: 1;
  pointer-events: none;
  cursor: default;
}

header button {
  padding: 0 !important;
  cursor: pointer;
  height: fit-content;
  width: fit-content;
  z-index: 999;
  filter: none;
}

header img, header video {
  transition: filter 0.15s ease-out;
  margin: calc(0.6em + 5px) 2.0em 0.6em 2.0em !important;
  width: fit-content;
  height: 40px;
}

header .backblur {
  position: absolute;
  top: 0;
  left: 0;
  width: 100vw;
  height: 15vh;
  z-index: 99;
}

header .search-toggle {
  display: none;
}

@media screen and (max-width: 800px) {
  header {
    height: 20vh;
    justify-content: center;
  }

  header > span {
    justify-content: center;
    align-items: center;
    gap: 12px;
  }

  header img {
    width: fit-content;
    height: 40px;
  }

  header button {
    padding: 0.2em 1.0em !important;
    /* margin-bottom: 20px; */
  }

  header input {
    display: none !important;
  }

  header input.mobile-active {
    display: block !important;
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    max-width: 400px;
  }

  header .search-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 !important;
    background: #ffffff20;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    aspect-ratio: 1 / 1;
    flex-shrink: 0;
    z-index: 100;
  }

  header .search-toggle.active {
    background: #ffffff40;
    flex-shrink: 0;
  }

  header .search-toggle img {
    width: 20px;
    height: 20px;
    margin: 0 !important;
  }
}
</style>
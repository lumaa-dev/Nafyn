<template>
  <header>
    <ProgressiveBlur class="backblur" height="80%" fade-color="#00000050" />
    <span>
      <button filled="hollow" @click="props.toggleSidebar()">
        <img src="../assets/brand/Wordmark.svg" draggable="false" />
      </button>
      <input v-model="searchText" type="text" name="search" id="search" :placeholder="$t('common.search')" :disabled="sidebarActive" @keydown.enter="navigateTo(`/search?q=${encodeURIComponent(searchText)}`)">
    </span>
  </header>
</template>

<script lang="ts" setup>
import ProgressiveBlur from './TopProgressiveBlur.vue';

const searchText = ref("");

const props = defineProps({
  toggleSidebar: { type: Function, default: () => { } },
  sidebarActive: { type: Boolean, default: false }
})
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
  padding: 0.6em 2.0em !important;
  cursor: pointer;
  height: fit-content;
  width: fit-content;
  z-index: 999;
  filter: none;
}

header button:hover img {
  filter: invert();
}

header img {
  transition: filter 0.15s ease-out;
  width: fit-content;
  height: 40px;
  margin-top: 8px;
}

header .backblur {
  position: absolute;
  top: 0;
  left: 0;
  width: 100vw;
  height: 15vh;
  z-index: 99;
}

@media screen and (max-width: 800px) {
  header {
    height: 20vh;
    justify-content: center;
  }

  header > span {
    justify-content: center;
  }

  header img {
    width: fit-content;
    height: 40px;
  }

  header button {
    padding: 0.2em 1.0em !important;
    margin-bottom: 20px;
  }

  header input {
    display: none !important;
  }
}
</style>
<template>
  <div class="sidebar">
    <div class="actions">
      <NuxtLink to="/">{{ $t('sidebar.home') }}</NuxtLink>
      <NuxtLink to="/library" class="s">{{ $t('sidebar.library') }}</NuxtLink>
      <NuxtLink to="/l/albums" class="b">{{ $t('sidebar.albums') }}</NuxtLink>
      <NuxtLink to="/l/tracks" class="b">{{ $t('sidebar.tracks') }}</NuxtLink>
      <NuxtLink to="/requests">{{ $t('sidebar.requests') }}</NuxtLink>
      <NuxtLink to="/settings">{{ $t('sidebar.settings') }}</NuxtLink>
    </div>
    <SidebarProgressiveBlur fade-color="#000000" height="100%" />
  </div>
</template>

<script lang="ts" setup>
import SidebarProgressiveBlur from './SidebarProgressiveBlur.vue';
</script>

<style>
.s {
  display: none;
}

.b {
  display: initial;
}

.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  font-size: 2.2em;
  z-index: 50;
}

.sidebar .actions {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: start;
  justify-content: center;
  z-index: 51;
  gap: 20px;
  width: 45%;
  height: 80%;
}

.sidebar .actions > * {
  text-decoration: none;
  margin: 0 0 0 35px;
}

@media screen and (max-width: 800px) {
  .sidebar .actions {
    font-size: 0.8em;
    width: 90%;
    top: 50px;
  }

  .s {
    display: initial;
  }

  .b {
    display: none;
  }
}
</style>
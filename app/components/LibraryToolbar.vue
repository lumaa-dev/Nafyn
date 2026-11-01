<template>
  <div class="lib-toolbar">
    <label class="lib-search">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input v-model="text" type="search" maxlength="100" autocomplete="off" spellcheck="false" :placeholder="placeholder" :aria-label="placeholder">
    </label>
    <button type="button" class="lib-sort-btn" :class="{ active: sort !== 'added' }" aria-haspopup="menu" :title="$t('library.sort.label')" :aria-label="sortLabel" @click="openSort">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" /></svg>
    </button>
    <ContextMenu ref="sortMenu" :items="sortItems" />
  </div>
</template>

<script lang="ts" setup>
// The search field and the sort menu above a library list (Tracks, Albums). The search text is debounced before
// it reaches the page, which re-queries the server; the sort menu is a ContextMenu like the Requests filter.
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import { LIBRARY_SORTS, type LibrarySort } from '~~/server/utils/libraryList';

defineProps<{ placeholder: string }>();

const query = defineModel<string>("query", { default: "" });
const sort = defineModel<LibrarySort>("sort", { default: "added" });

// what is typed right now; `query` follows it after a pause so every keystroke is not a request
const text = ref(query.value);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(text, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { query.value = value.trim(); }, 300);
});
// the page may clear the search itself
watch(query, (value) => { if (value !== text.value.trim()) text.value = value; });
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });

const sortMenu = ref<InstanceType<typeof ContextMenu> | null>(null);

const sortItems = computed<ContextMenuItem[]>(() => LIBRARY_SORTS.map((option) => ({
  label: $t(`library.sort.${option}`),
  checked: sort.value === option,
  action: () => { sort.value = option; }
})));

const sortLabel = computed(() => `${$t('library.sort.label')}: ${$t(`library.sort.${sort.value}`)}`);

function openSort(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  sortMenu.value?.openAt(rect.left, rect.bottom + 4);
}
</script>

<style>
.lib-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  min-width: 0;
}

.lib-toolbar .lib-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border: 1px solid #ffffffae;
  border-radius: 18px;
  color: #ffffff;
  min-width: 0;
}

.lib-toolbar .lib-search:focus-within {
  border-color: #ffffff;
}

.lib-toolbar .lib-search input {
  width: 220px;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #ffffff;
  font: inherit;
  font-size: 0.9em;
}

.lib-toolbar .lib-search input::placeholder {
  color: #ffffff;
  opacity: 1;
}

.lib-toolbar .lib-sort-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid #ffffffae;
  border-radius: 50%;
  color: #ffffffae;
  transition: background 0.2s ease-out, color 0.2s ease-out;
}

.lib-toolbar .lib-sort-btn:hover,
.lib-toolbar .lib-sort-btn.active {
  background: #ffffffae;
  color: #000;
}

@media screen and (max-width: 800px) {
  .lib-toolbar {
    flex: 1 1 100%;
    margin-left: 0;
  }

  .lib-toolbar .lib-search {
    flex: 1;
  }

  .lib-toolbar .lib-search input {
    width: 100%;
  }
}
</style>

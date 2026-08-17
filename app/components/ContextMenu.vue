<template>
  <Teleport to="body">
    <div v-if="open" class="ctxmenu-backdrop" @click="close" @contextmenu.prevent="close">
      <ul ref="menuEl" class="ctxmenu" :style="{ top: `${y}px`, left: `${x}px` }" @click.stop>
        <li
          v-for="(item, i) in items"
          :key="i"
          :class="{ danger: item.danger }"
          @click="trigger(item)"
        >
          {{ item.label }}
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

defineProps<{ items: ContextMenuItem[] }>();

const open = ref(false);
const x = ref(0);
const y = ref(0);
const menuEl = ref<HTMLUListElement | null>(null);

async function openAt(clientX: number, clientY: number) {
  x.value = clientX;
  y.value = clientY;
  open.value = true;

  await nextTick();
  const el = menuEl.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const margin = 8;
  if (rect.right > window.innerWidth - margin) {
    x.value = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (rect.bottom > window.innerHeight - margin) {
    y.value = Math.max(margin, window.innerHeight - rect.height - margin);
  }
}

function close() {
  open.value = false;
}

function trigger(item: ContextMenuItem) {
  close();
  item.action();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onUnmounted(() => document.removeEventListener("keydown", onKeydown));

defineExpose({ openAt, close });
</script>

<style>
.ctxmenu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.ctxmenu {
  position: fixed;
  min-width: 180px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 6px;
  background: #1a1a1a;
  border: 1px solid #333333;
  border-radius: 10px;
  box-shadow: 0 8px 24px #00000080;
}

.ctxmenu li {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85em;
  white-space: nowrap;
}

.ctxmenu li:hover {
  background: #ffffff1a;
}

.ctxmenu li.danger {
  color: #e06666;
}
</style>

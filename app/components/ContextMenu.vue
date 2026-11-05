<template>
  <Teleport to="body">
    <div v-if="open" class="ctxmenu-backdrop" @click="close" @contextmenu.prevent="close">
      <ul
        ref="menuEl"
        class="ctxmenu"
        role="menu"
        :style="{ top: `${y}px`, left: `${x}px` }"
        @click.stop
        @contextmenu.prevent.stop
        @keydown="onMenuKeydown"
      >
        <template v-for="(item, i) in items" :key="i">
          <li v-if="item.separator" class="sep" role="separator" />
          <li
            v-else
            tabindex="0"
            :class="{ danger: item.danger, checked: item.checked, disabled: item.disabled, nested: !!item.children, expanded: subIndex === i }"
            :role="item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'"
            :aria-checked="item.checked !== undefined ? item.checked : undefined"
            :aria-disabled="item.disabled || undefined"
            :aria-haspopup="item.children ? 'menu' : undefined"
            :aria-expanded="item.children ? subIndex === i : undefined"
            @click="onItemClick(item, i, $event)"
            @mouseenter="onItemHover(item, i, $event)"
            @focus="onItemFocus(item, i)"
          >
            <span v-if="item.checked !== undefined" class="tick" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
            <span class="label">{{ item.label }}</span>
            <span v-if="item.children" class="arrow" aria-hidden="true">›</span>
          </li>
        </template>
      </ul>

      <ul
        v-if="subItems"
        ref="subEl"
        class="ctxmenu sub"
        role="menu"
        :style="{ top: `${subY}px`, left: `${subX}px` }"
        @click.stop
        @contextmenu.prevent.stop
        @keydown="onSubKeydown"
      >
        <template v-for="(child, j) in subItems" :key="j">
          <li v-if="child.separator" class="sep" role="separator" />
          <li
            v-else
            tabindex="0"
            :class="{ danger: child.danger, checked: child.checked, disabled: child.disabled }"
            :role="child.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'"
            :aria-checked="child.checked !== undefined ? child.checked : undefined"
            :aria-disabled="child.disabled || undefined"
            @click="trigger(child)"
          >
            <span v-if="child.checked !== undefined" class="tick" aria-hidden="true">{{ child.checked ? '✓' : '' }}</span>
            <span class="label">{{ child.label }}</span>
          </li>
        </template>
      </ul>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
// The Nafyn context menu. Looks and behaves as DESIGN.md (Interactions -> Context Menus) describes: text in the
// Instrument font, destructive actions in red, nested menus marked with an arrow, categories separated by a thin
// divider line (no headers), opening to the right of the click unless that would clip out of the window.
export interface ContextMenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  /** a thin line between categories of items; no label or action */
  separator?: boolean;
  /** shown greyed out and ignored on click */
  disabled?: boolean;
  /** makes it a check item: true shows a tick */
  checked?: boolean;
  /** a check item that leaves the menu open, so several can be toggled in a row (filters) */
  keepOpen?: boolean;
  /** a nested menu, drawn beside this item and marked with an arrow (one level deep) */
  children?: ContextMenuItem[];
}

const props = defineProps<{ items: ContextMenuItem[] }>();

const MARGIN = 8;

const open = ref(false);
const x = ref(0);
const y = ref(0);
const menuEl = ref<HTMLUListElement | null>(null);

const subIndex = ref<number | null>(null);
const subItems = ref<ContextMenuItem[] | null>(null);
const subX = ref(0);
const subY = ref(0);
const subEl = ref<HTMLUListElement | null>(null);

/** Opens at the pointer: to its right and below it, or to its left / above it when that would clip. */
async function openAt(clientX: number, clientY: number) {
  closeSub();
  x.value = clientX;
  y.value = clientY;
  open.value = true;

  await nextTick();
  const el = menuEl.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth - MARGIN) {
    // flip to the left of the pointer, then keep it inside the window
    x.value = Math.max(MARGIN, clientX - rect.width);
  }
  if (rect.bottom > window.innerHeight - MARGIN) {
    y.value = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
  }
}

function close() {
  open.value = false;
  closeSub();
}

function closeSub() {
  subIndex.value = null;
  subItems.value = null;
}

async function openSub(item: ContextMenuItem, index: number, li: HTMLElement) {
  if (item.disabled || !item.children) return;
  subIndex.value = index;
  subItems.value = item.children;

  // beside the item, on its right
  const anchor = li.getBoundingClientRect();
  subX.value = anchor.right - 4;
  subY.value = anchor.top - 6;

  await nextTick();
  const el = subEl.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth - MARGIN) {
    // no room on the right: open on the item's left
    subX.value = Math.max(MARGIN, anchor.left - rect.width + 4);
  }
  if (rect.bottom > window.innerHeight - MARGIN) {
    subY.value = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
  }
}

function trigger(item: ContextMenuItem) {
  if (item.disabled || item.children) return;
  if (!item.keepOpen) close();
  item.action?.();
}

function onItemClick(item: ContextMenuItem, index: number, e: MouseEvent) {
  if (item.children) {
    // a tap has no hover: it opens (or closes) the nested menu
    if (subIndex.value === index) closeSub();
    else void openSub(item, index, e.currentTarget as HTMLElement);
    return;
  }
  trigger(item);
}

function onItemHover(item: ContextMenuItem, index: number, e: MouseEvent) {
  if (item.children) void openSub(item, index, e.currentTarget as HTMLElement);
  else closeSub();
}

function onItemFocus(item: ContextMenuItem, index: number) {
  // moving focus onto a plain item folds the nested menu away; a nested item opens only on click / arrow
  if (!item.children && subIndex.value !== index) closeSub();
}

function focusSibling(list: HTMLElement | null, from: Element | null, step: 1 | -1) {
  if (!list) return;
  const entries = Array.from(list.querySelectorAll<HTMLElement>("li[tabindex]:not(.disabled)"));
  if (entries.length === 0) return;
  const at = from ? entries.indexOf(from as HTMLElement) : -1;
  const next = at === -1 ? (step === 1 ? 0 : entries.length - 1) : (at + step + entries.length) % entries.length;
  entries[next]?.focus();
}

function onMenuKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusSibling(menuEl.value, document.activeElement, e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
    const index = Array.from(menuEl.value?.children ?? []).indexOf(target);
    const item = props.items[index];
    if (!item || item.separator) return;
    if (item.children) {
      e.preventDefault();
      void openSub(item, index, target).then(() => subEl.value?.querySelector<HTMLElement>("li[tabindex]")?.focus());
    } else if (e.key !== "ArrowRight") {
      e.preventDefault();
      trigger(item);
    }
  }
}

function onSubKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusSibling(subEl.value, document.activeElement, e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    const parent = menuEl.value?.children[subIndex.value ?? -1] as HTMLElement | undefined;
    closeSub();
    parent?.focus();
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const index = Array.from(subEl.value?.children ?? []).indexOf(target);
    const child = subItems.value?.[index];
    if (child && !child.separator) trigger(child);
  }
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
  min-width: 200px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  scrollbar-width: none;
  list-style: none;
  margin: 0;
  padding: 6px;
  background: #1a1a1a;
  border: 1px solid #333333;
  border-radius: 14px;
  box-shadow: 0 8px 24px #00000080;
  color: #ffffff;
  font-family: "Instrument-Serif";
}

.ctxmenu.sub {
  z-index: 1;
}

.ctxmenu li {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-family: "Instrument-Serif";
  font-size: 0.9em;
  white-space: nowrap;
  outline: none;
}

.ctxmenu li .label {
  flex: 1;
}

.ctxmenu li:hover,
.ctxmenu li.expanded {
  background: #ffffff1a;
}

.ctxmenu li:focus-visible {
  background: #ffffff1a;
  outline: 2px solid #ffffff;
  outline-offset: -2px;
}

/* destructive actions: red text that still clears 7:1 on the dark menu */
.ctxmenu li.danger {
  color: #ff9a9a;
}

.ctxmenu li.sep {
  display: block;
  height: 1px;
  padding: 0;
  margin: 5px 6px;
  border-radius: 0;
  background: #333333;
  cursor: default;
}

.ctxmenu li.sep:hover {
  background: #333333;
}

.ctxmenu li.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ctxmenu li.disabled:hover {
  background: none;
}

.ctxmenu li .tick {
  display: inline-block;
  width: 1.2em;
}

/* a nested menu is marked with an arrow at the end of its item */
.ctxmenu li .arrow {
  margin-left: 1.2em;
  font-size: 1.2em;
  line-height: 1;
}

@media (forced-colors: active) {
  .ctxmenu li:focus-visible {
    outline-color: Highlight;
  }
}
</style>

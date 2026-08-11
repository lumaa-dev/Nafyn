<template>
  <div :class="underLast ? `toast under` : `toast`" :nafyn-tint="props.toast.tint" :id="props.toast.id">
    <img class="icon" v-if="props.toast.icon" :src="props.toast.icon" />
    <p class="title" v-if="props.toast.title">{{ props.toast.title }}</p>
    <p>{{ props.toast.content }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { Toast } from '~/composables/useToast';

const props = defineProps<{ toast: Toast, underLast: boolean; }>();
</script>

<style scoped>
.toast {
  position: relative;
  display: flex;
  flex-direction: row;
  gap: 15px;
  justify-content: center;
  align-items: center;
  background: #0000004d;
  border: 1px #ffffff22 solid;
  backdrop-filter: blur(15px);
  max-width: 60vw;
  padding: 0.5em 2em;
  border-radius: 50vw;
  left: 0;
  transition: top 0.35s ease-out, scale 0.35s ease-out;
}

.toast[nafyn-tint="green"] {
  background: #93c47d4d;
}

.toast[nafyn-tint="red"] {
  background: #e066664d;
}

.toast .title {
  font-family: "Instrument-Italic";
}

.toast * {
  cursor: default;
  pointer-events: none;
  user-select: none;
}

.toast.under p {
  color: #ffffff00;
}
</style>
<!-- ProgressiveBlur.vue -->
<template>
  <div class="progblur" :style="{ height }">
    <div class="blur" v-for="n in 7" :key="n"></div>
    <div v-if="fadeColor" class="fade" :style="{ background: fadeGradient }"></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  height: { type: String, default: '50%' },   // how tall the blur zone is
  fadeColor: { type: String, default: '' }     // e.g. '#ffffff' to blend into a solid bg
})

const fadeGradient = computed(() => `linear-gradient(to left, transparent, ${props.fadeColor})`)
</script>

<style scoped>
.progblur {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  pointer-events: none; /* fixed typo from the sample: was "pointer-event" */
}

.progblur .blur {
  position: absolute;
  inset: 0;
}

.progblur .blur:nth-child(1) {
  backdrop-filter: blur(1px);
  -webkit-backdrop-filter: blur(1px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 0%, rgba(0,0,0,1) 10%,
    rgba(0,0,0,1) 30%, rgba(0,0,0,0) 40%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 0%, rgba(0,0,0,1) 10%,
    rgba(0,0,0,1) 30%, rgba(0,0,0,0) 40%);
}

.progblur .blur:nth-child(2) {
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 10%, rgba(0,0,0,1) 20%,
    rgba(0,0,0,1) 40%, rgba(0,0,0,0) 50%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 10%, rgba(0,0,0,1) 20%,
    rgba(0,0,0,1) 40%, rgba(0,0,0,0) 50%);
}

.progblur .blur:nth-child(3) {
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 15%, rgba(0,0,0,1) 30%,
    rgba(0,0,0,1) 50%, rgba(0,0,0,0) 60%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 15%, rgba(0,0,0,1) 30%,
    rgba(0,0,0,1) 50%, rgba(0,0,0,0) 60%);
}

.progblur .blur:nth-child(4) {
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 20%, rgba(0,0,0,1) 40%,
    rgba(0,0,0,1) 60%, rgba(0,0,0,0) 70%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 20%, rgba(0,0,0,1) 40%,
    rgba(0,0,0,1) 60%, rgba(0,0,0,0) 70%);
}

.progblur .blur:nth-child(5) {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 40%, rgba(0,0,0,1) 60%,
    rgba(0,0,0,1) 80%, rgba(0,0,0,0) 90%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 40%, rgba(0,0,0,1) 60%,
    rgba(0,0,0,1) 80%, rgba(0,0,0,0) 90%);
}

.progblur .blur:nth-child(6) {
  backdrop-filter: blur(32px);
  -webkit-backdrop-filter: blur(32px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 60%, rgba(0,0,0,1) 80%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 60%, rgba(0,0,0,1) 80%);
}

.progblur .blur:nth-child(7) {
  z-index: 10;
  backdrop-filter: blur(64px); /* fixed typo from the sample: was "background-filter" */
  -webkit-backdrop-filter: blur(64px);
  mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 70%, rgba(0,0,0,1) 100%);
  -webkit-mask-image: linear-gradient(to left,
    rgba(0,0,0,0) 70%, rgba(0,0,0,1) 100%);
}

.fade {
  position: absolute;
  inset: 0;
  z-index: 11;
}
</style>
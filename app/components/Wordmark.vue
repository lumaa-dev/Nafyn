<!-- components/HoverVideoMedia.vue -->
<template>
  <div
    class="hover-media"
    @mouseenter="onHoverStart"
    @mouseleave="onHoverEnd"
  >
    <img
      v-show="!showVideo"
      src="../assets/brand/Wordmark.svg"
      class="hover-media__svg"
      draggable="false"
    />

    <video
      v-show="showVideo"
      ref="videoRef"
      src="../assets/brand/Wordmark_Anim.webm"
      class="hover-media__video"
      muted
      playsinline
      preload="auto"
      @ended="onVideoEnded"
      @contextmenu.prevent
    />
  </div>
</template>

<script setup lang="ts">
const videoRef = ref<HTMLVideoElement | null>(null)

const showVideo = ref(false)
const isHovered = ref(false)

function onHoverStart() {
  isHovered.value = true
  showVideo.value = true

  const video = videoRef.value
  if (!video) return

  video.loop = true
  if (video.currentTime > 0) return

  video.currentTime = 0
  video.play().catch(() => {})
}

function onHoverEnd() {
  isHovered.value = false

  const video = videoRef.value
  if (!video) return
  video.loop = false
}

function onVideoEnded() {
  if (isHovered.value) {
    const video = videoRef.value
    if (video) {
      video.loop = true
      video.currentTime = 0
      video.play().catch(() => {})
    }
    return
  } else {
    const video = videoRef.value;
    if (video) {
        video.loop = false;
        video.currentTime = 0;
        video.pause();
    }
  }

  showVideo.value = false
}
</script>

<style scoped>
.hover-media {
  position: relative;
  display: inline-block;
  line-height: 0;
}

.hover-media__svg,
.hover-media__video {
  display: block;
}
</style>
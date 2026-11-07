<!-- components/HoverVideoMedia.vue -->
<template>
  <div
    class="hover-media"
    @pointerenter="onHoverStart"
    @pointerleave="onHoverEnd"
  >
    <img
      v-show="!showVideo"
      src="../assets/brand/Wordmark.svg"
      class="hover-media__svg"
      alt="Nafyn"
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
      aria-hidden="true"
      @playing="showVideo = true"
      @error="showVideo = false"
      @ended="onVideoEnded"
      @contextmenu.prevent
    />
  </div>
</template>

<script setup lang="ts">
// DESIGN.md "Header and Sidebar": the wordmark never disappears. The animated version only replaces the still one
// once it is really playing (a browser that cannot play it, or has not loaded it, used to leave an empty header),
// and only for a mouse: a tap fires a pointerenter with no pointerleave, which kept the video up (and the still
// wordmark hidden) after tapping the wordmark or the search button.
const videoRef = ref<HTMLVideoElement | null>(null)

const showVideo = ref(false)
const isHovered = ref(false)

function onHoverStart(event: PointerEvent) {
  if (event.pointerType !== "mouse") return
  isHovered.value = true

  const video = videoRef.value
  if (!video) return

  video.loop = true
  if (video.currentTime > 0) return

  video.currentTime = 0
  video.play().catch(() => { showVideo.value = false })
}

function onHoverEnd() {
  isHovered.value = false

  const video = videoRef.value
  if (!video) return
  video.loop = false
}

function onVideoEnded() {
  const video = videoRef.value
  if (isHovered.value && video) {
    video.loop = true
    video.currentTime = 0
    video.play().catch(() => { showVideo.value = false })
    return
  }

  if (video) {
    video.loop = false
    video.currentTime = 0
    video.pause()
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
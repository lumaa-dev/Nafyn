<template>
    <div>
        <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp(null)">Toast</button>
        <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp('red')">Toast RED</button>
        <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp('green')">Toast GREEN</button>
        <p class="hugeasstext">W</p>
    </div>
</template>

<style scoped>
.hugeasstext {
  font-size: 90em;
  overflow: hidden !important;
}
</style>

<script lang="ts" setup>
import { type Toast, useToast } from '~/composables/useToast';

function rajouteMoiUnPetitToastViteFaitStp(tint: "green" | "red" | null) {
    let strs: string[] = ["Content", "More content", "Seemingly more content, but why?", "A", "Error: I don't know what happened :("]
    let str: string = strs[Math.floor(Math.random() * (strs.length - 1))] ?? "Unknown Content";

    const newToast: Omit<Toast, "id" | "timeout"> = {
        title: "Title",
        content: str,
        icon: null,
        tint: tint
    }

    useToast().sendToast(newToast);
    console.log("Nouveau toast");
}
</script>
<template>
    <div>
        <div>
            <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp(null)">Toast</button>
            <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp('red')">Toast RED</button>
            <button filled="hollow" @click="rajouteMoiUnPetitToastViteFaitStp('green')">Toast GREEN</button>
        </div>
        <div>
            <button filled="hollow" @click="unPeuDeLyricsPlease('4bb787c4-57dd-41cf-8dd6-1bae3e9775e3')">Lyrics AM (Snake Oil)</button>
        </div>
        <p class="hugeasstext">N</p>
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
import { Provider, type LyricParagraphs } from '~~/server/utils/lyrics/parser';

interface LyricsResponse {
    provider: Provider,
    paragraphs: LyricParagraphs
}

console.log(`---- env: ${process.env.NODE_ENV} -----`)
if (process.env.NODE_ENV == "production") {
    useRouter().back();
}

function rajouteMoiUnPetitToastViteFaitStp(tint: "green" | "red" | null, title: string = "Title", content: string | null = null) {
    let strs: string[] = ["Content", "More content", "Seemingly more content, but why?", "A", "Error: I don't know what happened :("]
    let str: string = strs[Math.floor(Math.random() * (strs.length - 1))] ?? "Unknown Content";

    const newToast: Omit<Toast, "id" | "timeout"> = {
        title,
        content: content ?? str,
        icon: null,
        tint: tint
    }

    useToast().sendToast(newToast);
    console.log("Nouveau toast");
}

async function unPeuDeLyricsPlease(mediaId: string) {
    const token = useCookie("nafynToken").value;

    try {
        const { error } = await useAsyncData<LyricsResponse>(`lyrics-${mediaId}`, () => {
            return token
                ? $fetch(`/api/v1/library/${mediaId}/lyrics`, { headers: { Authorization: token }, timeout: 120_000 })
                : Promise.resolve({ provider: Provider.AppleMusic, paragraphs: [] });
        });
        let isError: boolean = typeof error.value !== "undefined";

        rajouteMoiUnPetitToastViteFaitStp(isError ? "red" : "green", "Lyrics", isError ? "Fetching failed" : "Fetching succeeded")
    } catch (e) {
        console.error(e);
        rajouteMoiUnPetitToastViteFaitStp("red", "Lyrics", "Request failed")
    }
}
</script>
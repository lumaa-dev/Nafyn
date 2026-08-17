<template>
    <div>
        <h1>j'ai pas fini</h1>
        <p>donnez-moi quelques semaines voire quelques mois</p>
        <p>car c'est sympa Claude Code mais voilà jveux quand même un peu une touche humaine</p>
        <p>SURTOUT sur les assets</p>

        <h2>{{ $t("library.recentlyPlayed") }}</h2>
        <RecentlyPlayed variant="scroll" />
    </div>
</template>

<script lang="ts" setup>
import RecentlyPlayed from '~/components/RecentlyPlayed.vue';
</script>
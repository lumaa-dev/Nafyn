<template>
    <Header :toggle-sidebar="() => { navigateTo(`/`) }" />
    <div class="fp err">
        <span class="header">
            <h1>{{ $t("common.errorTitle", { status: error.status }) }}</h1>
            <p class="message">{{ error.message }}</p>
        </span>
        <button @click="navigateTo(`/`)" filled>{{ $t("common.returnHome") }}</button>
    </div>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
import Header from './components/Header.vue';

defineProps<{ error: NuxtError }>()
</script>

<style scoped>
.fp {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 50px;
}

.err .header {
    text-align: center;
}

.err .message {
    color: var(--tint-fg, #ffffffae);
    font-family: var(--font-discy);
    font-size: 0.85em;
}
</style>
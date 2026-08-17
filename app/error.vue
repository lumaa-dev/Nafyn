<template>
    <Header :toggle-sidebar="() => { navigateTo(`/`) }" />
    <div class="fp err">
        <span class="header">
            <h1>Error {{ error.status }}</h1>
            <p class="message">{{ error.message }}</p>
        </span>
        <button @click="navigateTo(`/`)" filled>Return home</button>
    </div>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
import Header from './components/Header.vue';

const props = defineProps<{ error: NuxtError }>()
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
    color: #666666;
    font-family: "Discy";
    font-size: 0.85em;
}
</style>
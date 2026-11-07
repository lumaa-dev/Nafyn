<template>
  <p v-if="message" class="load-error" role="alert">{{ message }}</p>
</template>

<script lang="ts" setup>
// DESIGN.md "Error messages": when something the person triggered should have changed the screen (a page that
// didn't load, a list that stopped, lyrics that never came) the error is written at the exact place where that
// change should have happened, in the secondary foreground colour - not as a toast. Toasts are for actions that
// change nothing on screen (deleting, editing, requesting...).
//
// Only a failure is shown: no error at all, a 404 (the normal "nothing there") and the "no token" rejection
// pages use to short-circuit (app.vue is already sending that person to /login) stay silent.
const props = defineProps<{ error: unknown }>();

const message = computed(() => {
  const e = props.error as { statusCode?: number, status?: number, response?: { status?: number }, message?: string } | null | undefined;
  if (!e) return null;
  if (e instanceof Error && e.message === "Not authenticated") return null;
  const code = e.statusCode ?? e.status ?? e.response?.status;
  if (code === 404) return null;
  return apiErrorMessage(e);
});
</script>

<style>
/* secondary foreground: the page text, dimmed (still AAA against the background) */
.load-error {
  color: currentColor;
  text-align: center;
  padding: 40px 1em 0;
}
</style>

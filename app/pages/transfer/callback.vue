<template>
  <div class="transfer-page">
    <h1>{{ $t('transfer.callback.title') }}</h1>
    <p v-if="!error" class="transfer-intro">{{ $t('transfer.connecting') }}</p>
    <template v-else>
      <p class="transfer-error">{{ error }}</p>
      <NuxtLink to="/settings?tab=import" class="transfer-link">{{ $t('transfer.callback.back') }}</NuxtLink>
    </template>
  </div>
</template>

<script lang="ts" setup>
import '~/assets/css/transfer.css';
// every OAuth provider sends the browser back here with ?code=&state= (or ?error=); the code is handed to
// the server, which exchanges it and keeps the resulting token to itself
const route = useRoute();
const error = ref<string | null>(null);

onMounted(async () => {
  const code = typeof route.query.code === "string" ? route.query.code : null;
  const state = typeof route.query.state === "string" ? route.query.state : null;
  const token = useCookie("nafynToken").value ?? "";

  if (route.query.error || route.query.error_reason || !code || !state) {
    error.value = $t('transfer.callback.denied');
    return;
  }

  try {
    const { sessionId } = await $fetch<{ sessionId: string }>("/api/v1/transfer/callback", {
      method: "POST",
      headers: { Authorization: token },
      body: { code, state }
    });
    // replace, so "back" from the selection page doesn't land on a spent callback URL
    await navigateTo({ path: "/transfer/select", query: { session: sessionId } }, { replace: true });
  } catch (e) {
    error.value = transferErrorMessage(e, $t('transfer.callback.error'));
  }
});
</script>


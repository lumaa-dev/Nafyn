<template>
  <div class="login" v-if="allowed">
    <span class="header">
      <h1>{{ $t('auth.register.title') }}</h1>
      <p class="description">{{ $t('auth.register.subtitle') }}</p>
    </span>
    <input v-model="username" type="text" name="username" id="username" :placeholder="$t('auth.login.usernamePlaceholder')">
    <input v-model="password" type="password" name="password" id="password" :placeholder="$t('auth.login.passwordPlaceholder')">
    <p class="register">{{ $t('auth.register.orPrefix') }} <NuxtLink to="/login">{{ $t('auth.register.loginLink') }}</NuxtLink>.</p>
    <button filled :disabled="username.length < 3 || password.length < 3" @click="register">{{ $t('auth.register.submit') }}</button>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';

const route = useRoute();
const registerToken = typeof route.query.token === "string" ? route.query.token : "";

const { data: status } = await useFetch<{ open: boolean }>("/api/v1/settings/register");
const allowed = computed(() => !!status.value?.open || !!registerToken);

if (!allowed.value) {
  throw createError({ statusCode: 404, statusMessage: "Not Found", fatal: true });
}

const username = ref("");
const password = ref("");

const hasError: globalThis.Ref<string | null, string | null> = ref(null);

interface RegisterResponse {
  user: NafynUser,
  token: string
}

async function register() {
  const result: RegisterResponse = await $fetch("/api/v1/auth/register", {
    method: "POST",
    body: { username: username.value, password: password.value, token: registerToken }
  }).catch(r => hasError.value = r)

  if (!result || hasError.value) return hasError.value = $t("auth.register.error");;

  // see login.vue: explicit maxAge so iOS Safari doesn't drop this as a session cookie before the JWT expires
  // `secure` over https so the token never rides a plain-http request; `sameSite: "lax"` keeps it off
  // cross-site requests. It deliberately isn't httpOnly - the app reads it to build the Authorization
  // header - which is exactly why the CSP in server/middleware/security-headers.ts matters: an XSS on this
  // origin is the only realistic way to reach this cookie.
  const tokenCookie = useCookie("nafynToken", {
    maxAge: 60 * 60 * 24 * 7,
    sameSite: "lax",
    secure: window.location.protocol === "https:",
    path: "/"
  });
  tokenCookie.value = `Bearer ${result.token}`;
  navigateTo(`/`);
}
</script>

<style>
.login {
  margin: 0 !important;
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
}

.login > *:not(input) {
  width: 350px;
}

.login > input {
  width: 352px;
}

.login .header, .login button {
  margin: 60px 0;
}

.login .register {
  font-size: 0.85em;
}

.login .header .description {
  color: #666666;
  font-family: "Instrument-Italic";
  font-size: 0.85em;
}
</style>

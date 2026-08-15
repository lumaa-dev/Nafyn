<template>
  <div class="login">
    <span class="header">
      <h1>{{ $t('auth.login.title') }}</h1>
      <p class="description">{{ $t('auth.login.subtitle') }}</p>
    </span>
    <input v-model="username" type="text" name="username" id="username" :placeholder="$t('auth.login.usernamePlaceholder')">
    <input v-model="password" type="password" name="password" id="password" :placeholder="$t('auth.login.passwordPlaceholder')">
    <p class="register">{{ $t('auth.login.orPrefix') }} <NuxtLink to="/register">{{ $t('auth.login.registerLink') }}</NuxtLink>.</p>
    <button filled :disabled="username.length < 3 || password.length < 3" @click="logIn">{{ $t('auth.login.submit') }}</button>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';

const username = ref("");
const password = ref("");

const hasError: globalThis.Ref<string | null, string | null> = ref(null);

interface LoginResponse {
  user: NafynUser,
  token: string
}

async function logIn() {
  const result: LoginResponse = await $fetch("/api/v1/auth/login", {
    method: "POST",
    body: { username: username.value, password: password.value }
  }).catch(r => hasError.value = r)

  if (!result || hasError.value) return hasError.value = $t("auth.login.error");

  const tokenCookie = useCookie("nafynToken");
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
<template>
  <div class="login">
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
import type { DiscyUser } from '~~/server/entity/DiscyUser';

const username = ref("");
const password = ref("");

interface RegisterResponse {
  user: DiscyUser,
  token: string
}

async function register() {
  const result: RegisterResponse = await $fetch("/api/v1/auth/register", {
    method: "POST",
    body: { username: username.value, password: password.value }
  })

  const tokenCookie = useCookie("discyToken");
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
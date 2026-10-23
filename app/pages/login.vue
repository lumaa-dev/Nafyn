<template>
  <div class="login">
    <span class="header">
      <h1>{{ $t('auth.login.title') }}</h1>
      <p class="description">{{ $t('auth.login.subtitle') }}</p>
    </span>
    <input v-model="username" type="text" name="username" id="username" :placeholder="$t('auth.login.usernamePlaceholder')">
    <input v-model="password" type="password" name="password" id="password" :placeholder="$t('auth.login.passwordPlaceholder')">
    <p class="register">{{ $t('auth.login.orPrefix') }} <NuxtLink to="/register">{{ $t('auth.login.registerLink') }}</NuxtLink>.</p>
    <!-- GDPR art. 13: the notice has to be reachable before an account exists, not after -->
    <p class="register">{{ $t('auth.privacyLoginPrefix') }} <NuxtLink to="/privacy">{{ $t('auth.privacyLink') }}</NuxtLink>.</p>
    <button filled :disabled="username.length < 3 || password.length < 3" @click="logIn">{{ $t('auth.login.submit') }}</button>
    <button v-if="passkeySupported" type="button" filled="hollow" :disabled="passkeyLoading" @click="logInWithPasskey">{{ $t('auth.login.passkeySubmit') }}</button>
    <p v-else-if="passkeyNeedsSecureContext" class="passkey-hint">{{ $t('auth.login.passkeyNeedsSecureContext') }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

const username = ref("");
const password = ref("");

interface LoginResponse {
  user: NafynUser,
  token: string
}

function applyLogin(token: string) {
  // no maxAge = session cookie, which iOS Safari can wipe on a tab relaunch well before the JWT's
  // own 7-day expiry (server/utils/jwt.ts) - keep the cookie's lifetime matching the token's
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
  tokenCookie.value = `Bearer ${token}`;
  navigateTo(`/`);
}

async function logIn() {
  try {
    const result = await $fetch<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      body: { username: username.value, password: password.value }
    });
    applyLogin(result.token);
  } catch (e) {
    // the server says why: wrong credentials, or too many attempts (429) - shown as-is
    useToast().sendError($t("auth.login.title"), e, $t("auth.login.error"));
  }
}

const passkeySupported = import.meta.client ? browserSupportsWebAuthn() : false;
// see the matching comment in settings.vue - a non-secure context (plain http:// on a LAN IP) hides the
// whole WebAuthn API in every browser, which isn't the same thing as "unsupported browser"
const passkeyNeedsSecureContext = import.meta.client && !passkeySupported && !window.isSecureContext;
const passkeyLoading = ref(false);

async function logInWithPasskey() {
  passkeyLoading.value = true;
  try {
    const { challengeId, options } = await $fetch<{ challengeId: string, options: object }>("/api/v1/auth/passkey/login-options", { method: "POST" });
    const response = await startAuthentication({ optionsJSON: options as never });
    const result = await $fetch<LoginResponse>("/api/v1/auth/passkey/login", {
      method: "POST",
      body: { challengeId, response }
    });
    applyLogin(result.token);
  } catch (e) {
    // covers both a $fetch error (server rejected it, so its message is shown) and the browser's own Error
    // (user cancelled the prompt, no matching passkey, ...), which has no message worth showing - that case
    // falls back to the generic one
    useToast().sendError($t("auth.login.title"), e, $t("auth.login.error"));
  } finally {
    passkeyLoading.value = false;
  }
}
</script>

<style>
.login {
  margin: 0 !important;
  width: 100%;
  /* as tall as its content, centred; only as tall as the viewport when the content is shorter. It used to be
     a fixed 100vh with 60px above and below each block, which made a two-field form a screen and a half. */
  min-height: 100dvh;
  padding: 24px 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
}

.login > *:not(input) {
  width: min(350px, 90vw);
}

.login > input {
  width: min(352px, 90vw);
}

.login .header {
  margin: 0 0 14px;
}

.login button {
  margin: 0;
}

.login button[filled] {
  margin-top: 6px;
}

.login .register {
  font-size: 0.85em;
}

.login .passkey-hint {
  color: #ffffff;
  font-size: 0.8em;
  text-align: center;
}

.login .header .description {
  color: #ffffff;
  font-family: "Instrument-Italic";
  font-size: 0.85em;
}
</style>
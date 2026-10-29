<template>
  <div class="settings">
    <nav class="settings-nav">
      <h2>{{ $t('settings.title') }}</h2>
      <button
        v-for="category in categories"
        :key="category.id"
        type="button"
        :class="{ active: activeCategory === category.id }"
        :aria-current="activeCategory === category.id ? 'page' : undefined"
        @click="selectCategory(category.id)"
      >
        {{ category.label }}
      </button>
    </nav>

    <section class="settings-content">
      <div v-if="activeCategory === 'profile'" class="panel">
        <h1>{{ $t('settings.profile.title') }}</h1>

        <div class="avatar-field">
          <div class="avatar-preview" :style="avatarPreviewStyle" @click="triggerAvatarPicker">
            <span v-if="!avatarPreviewUrl">{{ initial }}</span>
          </div>
          <input ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden-input" @change="onAvatarSelected">
          <div class="avatar-actions">
            <p>@{{ user?.username }}</p>
            <button type="button" filled="hollow" @click="triggerAvatarPicker">{{ $t('settings.profile.changeAvatar') }}</button>
            <button v-if="avatarPreviewUrl" type="button" filled="hollow" @click="removeAvatar">{{ $t('settings.profile.removeAvatar') }}</button>
          </div>
        </div>

        <label for="displayName">{{ $t('settings.profile.displayName') }}</label>
        <input id="displayName" v-model="displayName" type="text" maxlength="20" :placeholder="$t('settings.profile.displayNamePlaceholder')">

        <label for="lastFm">{{ $t('settings.profile.lastFm') }}</label>
        <input id="lastFm" v-model="lastFm" type="text" :placeholder="$t('settings.profile.lastFmPlaceholder')">

        <label for="discogs">{{ $t('settings.profile.discogs') }}</label>
        <input id="discogs" v-model="discogs" type="text" :placeholder="$t('settings.profile.discogsPlaceholder')">

        <button type="button" filled :disabled="!canSave || saving" @click="save">{{ $t('settings.profile.save') }}</button>

        <section class="subsection">
          <button type="button" filled="hollow" class="danger" @click="logout">{{ $t('settings.profile.logout') }}</button>
        </section>
      </div>

      <div v-else-if="activeCategory === 'appearance'" class="panel">
        <h1>{{ $t('settings.appearance.title') }}</h1>

        <section class="subsection">
          <label class="switch-row">
            <input type="checkbox" :checked="appearance.showFileSize" :disabled="!canManageMusic" @change="toggleFileSize">
            {{ $t('settings.appearance.fileSize') }}
          </label>
          <p v-if="!canManageMusic" class="subsonic-note">{{ $t('settings.appearance.fileSizeLocked') }}</p>
        </section>

        <section class="subsection">
          <label class="switch-row">
            <input type="checkbox" :checked="appearance.showDuration" @change="toggleDuration">
            {{ $t('settings.appearance.duration') }}
          </label>
        </section>

        <section class="subsection">
          <label class="switch-row">
            <input type="checkbox" v-model="dyslexicFont">
            {{ $t('settings.appearance.dyslexicFont') }}
          </label>
          <p class="subsonic-note">{{ $t('settings.appearance.dyslexicFontNote') }}</p>
        </section>
      </div>

      <div v-else-if="activeCategory === 'playback'" class="panel">
        <h1>{{ $t('settings.playback.title') }}</h1>

        <section class="subsection">
          <h2>{{ $t('settings.playback.crossfade.title') }}</h2>
          <label class="switch-row">
            <input type="checkbox" :checked="playback.crossfadeEnabled" @change="toggleCrossfade">
            {{ $t('settings.playback.crossfade.label') }}
          </label>
          <div class="range-row" :class="{ disabled: !playback.crossfadeEnabled }">
            <input v-model.number="crossfadeSeconds" type="range" min="0.5" max="12" step="0.5" :disabled="!playback.crossfadeEnabled" @change="saveCrossfadeLength">
            <span class="range-value">{{ $t('settings.playback.crossfade.seconds', { n: crossfadeSeconds }) }}</span>
          </div>
          <p class="subsonic-note">{{ $t('settings.playback.crossfade.note') }}</p>
        </section>
      </div>

      <div v-else-if="activeCategory === 'accounts'" class="panel">
        <h1>{{ $t('settings.accounts.title') }}</h1>

        <section class="subsection">
          <h2>{{ $t('settings.accounts.registerLock.title') }}</h2>
          <label class="switch-row">
            <input type="checkbox" v-model="registerOpen" @change="toggleRegisterOpen">
            {{ registerOpen ? $t('settings.accounts.registerLock.open') : $t('settings.accounts.registerLock.closed') }}
          </label>

          <div v-if="!registerOpen" class="token-generator">
            <button type="button" filled="hollow" :disabled="generatingToken" @click="generateToken">{{ $t('settings.accounts.registerLock.generate') }}</button>
            <ul v-if="activeTokens.length > 0" class="token-list">
              <li v-for="t in activeTokens" :key="t.id">
                <input type="text" readonly :value="tokenUrl(t.token)" @click="($event.target as HTMLInputElement).select()">
                <span class="expires">{{ $t('settings.accounts.registerLock.expires', { date: formatDate(t.expiresAt) }) }}</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.accounts.users.title') }}</h2>
          <ul class="user-list">
            <li v-for="u in users" :key="u.id" class="user-row">
              <div class="user-summary">
                <div class="avatar-preview small" :style="avatarStyleFor(u)"><span v-if="!u.avatar">{{ (u.displayName ?? u.username).charAt(0).toUpperCase() }}</span></div>
                <span class="col">
                  <span class="title">{{ u.displayName ?? u.username }}</span>
                  <span class="artist">@{{ u.username }}</span>
                </span>
                <button type="button" filled="hollow" :disabled="!canManage(u) || isSelf(u)" @click="toggleEdit(u)">{{ editingId === u.id ? $t('settings.accounts.users.cancel') : $t('settings.accounts.users.edit') }}</button>
              </div>

              <div v-if="editingId === u.id" class="edit-form">
                <label>{{ $t('settings.profile.displayName') }}</label>
                <input v-model="editDraft.displayName" type="text" maxlength="20" :disabled="isSelf(u)">
                <label>{{ $t('settings.accounts.users.username') }}</label>
                <input v-model="editDraft.username" type="text" :disabled="isSelf(u)">
                <label>{{ $t('settings.profile.lastFm') }}</label>
                <input v-model="editDraft.lastFm" type="text" :disabled="isSelf(u)">
                <label>{{ $t('settings.profile.discogs') }}</label>
                <input v-model="editDraft.discogs" type="text" :disabled="isSelf(u)">

                <label>{{ $t('settings.accounts.users.permissions') }}</label>
                <div class="perm-grid">
                  <label v-for="p in permOptions" :key="p" class="perm-option">
                    <input
                      type="checkbox"
                      :disabled="isSelf(u) || (isRestrictedBit(p) && !isAdmin)"
                      :checked="!!(editDraft.permissions & p)"
                      @change="togglePermBit(p, ($event.target as HTMLInputElement).checked)"
                    >
                    {{ $t(`settings.accounts.permissions.${Permission[p]}`) }}
                  </label>
                </div>

                <div class="edit-actions">
                  <button type="button" filled :disabled="savingUser || isSelf(u)" @click="saveUser(u)">{{ $t('settings.accounts.users.save') }}</button>
                  <button class="danger" type="button" filled="hollow" :disabled="savingUser || isSelf(u)" @click="removeUser(u)">{{ $t('settings.accounts.users.delete') }}</button>
                </div>
              </div>
            </li>
          </ul>
          <div ref="usersSentinel" class="scroll-sentinel" />
          <p class="loading-more" v-if="usersLoadingMore">{{ $t('common.loadingMore') }}</p>
        </section>
      </div>

      <div v-else-if="activeCategory === 'storage'" class="panel">
        <h1>{{ $t('settings.storage.title') }}</h1>

        <section class="subsection" v-if="storage">
          <h2>{{ $t('settings.storage.usage.title') }}</h2>
          <div class="bar">
            <div class="occupied" :style="{ width: `${occupiedPercent}%` }" />
            <div class="fill" :style="{ width: `${usedPercent}%` }" />
          </div>
          <p class="storage-stats">{{ $t('settings.storage.usage.stats', { used: formatBytes(storage.usedByNafynBytes), free: formatBytes(storage.freeBytes), total: formatBytes(storage.totalBytes) }) }}</p>
        </section>

        <section class="subsection" v-if="storage && storage.perUser.length > 0">
          <h2>{{ $t('settings.storage.perUser.title') }}</h2>
          <div class="pie-wrap">
            <div class="pie" :style="{ background: pieGradient }" @mousemove="onPieHover" @mouseleave="hoveredUserIndex = null" />
            <ul class="legend">
              <li
                v-for="(u, i) in storage.perUser"
                :key="u.userId"
                :class="{ active: hoveredUserIndex === i }"
                @mouseenter="hoveredUserIndex = i"
                @mouseleave="hoveredUserIndex = null"
              >
                <span class="swatch" :style="{ background: paletteColor(i) }" />
                {{ u.displayName ?? u.username }} — {{ formatBytes(u.bytes) }}
              </li>
            </ul>
          </div>
        </section>

        <NuxtLink to="/l/all" class="everyone-link">{{ $t('settings.storage.everyoneLibraryLink') }}</NuxtLink>
      </div>

      <div v-else-if="activeCategory === 'subsonic'" class="panel">
        <h1>{{ $t('settings.subsonic.title') }}</h1>
        <p class="subsonic-intro">{{ $t('settings.subsonic.intro') }}</p>

        <label>{{ $t('settings.subsonic.serverUrl') }}</label>
        <div class="copy-field">
          <input type="text" readonly :value="subsonicUrl" @click="($event.target as HTMLInputElement).select()">
          <button type="button" filled="hollow" @click="copyToClipboard(subsonicUrl)">{{ $t('settings.subsonic.copy') }}</button>
        </div>

        <label>{{ $t('settings.subsonic.username') }}</label>
        <div class="copy-field">
          <input type="text" readonly :value="user?.username ?? ''" @click="($event.target as HTMLInputElement).select()">
          <button type="button" filled="hollow" @click="copyToClipboard(user?.username ?? '')">{{ $t('settings.subsonic.copy') }}</button>
        </div>

        <p class="subsonic-note">{{ $t('settings.subsonic.passwordNote') }}</p>

        <section class="subsection">
          <h2>{{ $t('settings.subsonic.tokens.title') }}</h2>
          <p class="subsonic-intro">{{ $t('settings.subsonic.tokens.intro') }}</p>

          <div v-if="newToken" class="new-token-reveal">
            <p class="new-token-warning">{{ $t('settings.subsonic.tokens.revealWarning') }}</p>
            <div class="copy-field">
              <input type="text" readonly :value="newToken.token" @click="($event.target as HTMLInputElement).select()">
              <button type="button" filled="hollow" @click="copyToClipboard(newToken.token)">{{ $t('settings.subsonic.copy') }}</button>
            </div>
            <button type="button" filled="hollow" @click="newToken = null">{{ $t('settings.subsonic.tokens.dismiss') }}</button>
          </div>

          <ul v-if="apiTokens.length > 0" class="api-token-list">
            <li v-for="t in apiTokens" :key="t.id">
              <span class="col">
                <span class="title">{{ t.name || $t('settings.subsonic.tokens.unnamed') }}</span>
                <span class="artist">{{ $t('settings.subsonic.tokens.created', { date: formatDate(t.createdAt) }) }} &middot; {{ t.lastUsedAt ? $t('settings.subsonic.tokens.lastUsed', { date: formatDate(t.lastUsedAt) }) : $t('settings.subsonic.tokens.neverUsed') }}</span>
              </span>
              <button class="danger" type="button" filled="hollow" :disabled="deletingTokenId === t.id" @click="removeApiToken(t.id)">{{ $t('settings.subsonic.tokens.delete') }}</button>
            </li>
          </ul>
          <p v-else class="subsonic-note">{{ $t('settings.subsonic.tokens.empty') }}</p>

          <div class="token-generator">
            <input v-model="newTokenName" type="text" maxlength="100" :placeholder="$t('settings.subsonic.tokens.namePlaceholder')">
            <button type="button" filled="hollow" :disabled="generatingApiToken" @click="generateApiToken">{{ $t('settings.subsonic.tokens.generate') }}</button>
          </div>
        </section>
      </div>
      <div v-else-if="activeCategory === 'privacy'" class="panel">
        <h1>{{ $t('settings.privacy.title') }}</h1>

        <section class="subsection">
          <h2>{{ $t('settings.sessions.unityTitle') }}</h2>
          <label class="switch-row">
            <input type="checkbox" :checked="unitySettings.enabled" @change="toggleUnity">
            {{ $t('settings.sessions.unityToggleLabel') }}
          </label>
          <p class="subsonic-note">{{ $t('settings.sessions.unityToggleHint') }}</p>

          <label class="switch-row">
            <input type="checkbox" :checked="unitySessionOverride" @change="toggleUnitySessionOverride">
            {{ $t('settings.sessions.sessionOverrideLabel') }}
          </label>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.sessions.listTitle') }}</h2>
          <p class="subsonic-intro">{{ $t('settings.sessions.intro') }}</p>

          <ul v-if="sessions.length > 0" class="api-token-list">
            <li v-for="s in sessions" :key="s.id">
              <span class="col">
                <span class="title">{{ s.deviceLabel }}{{ s.isCurrent ? ` ${$t('settings.sessions.thisDevice')}` : '' }}</span>
                <span class="artist">{{ $t('settings.sessions.signedIn', { date: formatDate(s.createdAt) }) }} &middot; {{ $t('settings.sessions.lastActive', { date: formatDate(s.lastSeenAt) }) }}</span>
              </span>
              <button v-if="!s.isCurrent" class="danger" type="button" filled="hollow" :disabled="revokingSessionId === s.id" @click="revokeSession(s.id)">{{ $t('settings.sessions.revoke') }}</button>
            </li>
          </ul>
          <p v-else class="subsonic-note">{{ $t('settings.sessions.empty') }}</p>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.privacy.notice.title') }}</h2>
          <p class="subsonic-note">{{ $t('settings.privacy.notice.body') }}</p>
          <NuxtLink to="/privacy" class="everyone-link">{{ $t('settings.privacy.notice.link') }}</NuxtLink>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.privacy.passkeys.title') }}</h2>
          <p class="subsonic-intro">{{ $t('settings.privacy.passkeys.intro') }}</p>

          <ul v-if="passkeys.length > 0" class="api-token-list">
            <li v-for="p in passkeys" :key="p.id">
              <span class="col">
                <span class="title">{{ p.label || $t('settings.privacy.passkeys.unnamed') }}</span>
                <span class="artist">{{ $t('settings.privacy.passkeys.created', { date: formatDate(p.createdAt) }) }} &middot; {{ p.lastUsedAt ? $t('settings.privacy.passkeys.lastUsed', { date: formatDate(p.lastUsedAt) }) : $t('settings.privacy.passkeys.neverUsed') }}</span>
              </span>
              <button class="danger" type="button" filled="hollow" :disabled="deletingPasskeyId === p.id" @click="removePasskey(p.id)">{{ $t('settings.privacy.passkeys.delete') }}</button>
            </li>
          </ul>
          <p v-else class="subsonic-note">{{ $t('settings.privacy.passkeys.empty') }}</p>

          <p v-if="passkeyNeedsSecureContext" class="subsonic-note">{{ $t('settings.privacy.passkeys.needsSecureContext') }}</p>
          <p v-else-if="!passkeySupported" class="subsonic-note">{{ $t('settings.privacy.passkeys.unsupported') }}</p>
          <div v-else class="token-generator">
            <input v-model="newPasskeyLabel" type="text" maxlength="100" :placeholder="$t('settings.privacy.passkeys.labelPlaceholder')">
            <button type="button" filled="hollow" :disabled="addingPasskey" @click="addPasskey">{{ $t('settings.privacy.passkeys.add') }}</button>
          </div>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.privacy.history.title') }}</h2>
          <label class="switch-row">
            <input type="checkbox" v-model="historyEnabled" @change="toggleHistory">
            {{ $t('settings.privacy.history.label') }}
          </label>
          <p class="subsonic-note">{{ historyEnabled ? $t('settings.privacy.history.on') : $t('settings.privacy.history.off') }}</p>
          <p class="subsonic-note">{{ $t('settings.privacy.history.note') }}</p>
          <NuxtLink to="/insights" class="everyone-link">{{ $t('insights.title') }}</NuxtLink>
        </section>

        <!-- GDPR art. 15 + 20: the account-wide export. The listening-only one below it is the narrower
             tool for people who just want their play history -->
        <section class="subsection">
          <h2>{{ $t('settings.privacy.accountExport.title') }}</h2>
          <p class="subsonic-note">{{ $t('settings.privacy.accountExport.note') }}</p>
          <button type="button" filled="hollow" :disabled="exportingAccount" @click="exportAccount">{{ $t('settings.privacy.accountExport.button') }}</button>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.privacy.export.title') }}</h2>
          <p class="subsonic-note">{{ $t('settings.privacy.export.note') }}</p>
          <button type="button" filled="hollow" :disabled="exporting" @click="exportHistory">{{ $t('settings.privacy.export.button') }}</button>
        </section>

        <section class="subsection">
          <h2>{{ $t('settings.privacy.delete.title') }}</h2>
          <p class="subsonic-note">{{ $t('settings.privacy.delete.note') }}</p>
          <button type="button" filled="hollow" class="danger" :disabled="deletingHistory" @click="deleteHistory">{{ $t('settings.privacy.delete.button') }}</button>
        </section>

        <!-- GDPR art. 17: erasure without having to ask an administrator to do it for you -->
        <section class="subsection">
          <h2>{{ $t('settings.privacy.deleteAccount.title') }}</h2>
          <p class="subsonic-note">{{ $t('settings.privacy.deleteAccount.note') }}</p>
          <div class="token-generator">
            <input v-model="deleteAccountPassword" type="password" autocomplete="current-password" :placeholder="$t('settings.privacy.deleteAccount.passwordPlaceholder')">
            <button type="button" filled="hollow" class="danger" :disabled="deletingAccount || deleteAccountPassword.length < 1" @click="deleteOwnAccount">{{ $t('settings.privacy.deleteAccount.button') }}</button>
          </div>
        </section>
      </div>
      <div v-else-if="activeCategory === 'notifications'" class="panel">
        <h1>{{ $t('settings.notifications.title') }}</h1>
        <NotificationSettings />
      </div>
      <div v-else-if="activeCategory === 'webhooks'" class="panel">
        <h1>{{ $t('settings.webhooks.title') }}</h1>
        <p class="subsonic-note">{{ $t('settings.webhooks.intro') }}</p>
        <WebhookManager scope="global" />
      </div>
      <div v-else-if="activeCategory === 'developer'" class="panel">
        <h1>{{ $t('settings.developer.title') }}</h1>

        <section class="subsection">
          <h2>{{ $t('settings.developer.sampleData.title') }}</h2>
          <label class="switch-row">
            <input type="checkbox" v-model="sampleDataEnabled" :disabled="togglingSampleData" @change="toggleSampleData">
            {{ $t('settings.developer.sampleData.label') }}
          </label>
          <p class="subsonic-note">{{ $t('settings.developer.sampleData.note') }}</p>
        </section>
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';
import { canManageUser, hasPermission, Permission } from '~~/server/entity/Permission';
import type { RegisterTokenRow } from '~~/server/core/registerTokens';
import type { ApiTokenSummary, ApiTokenRow } from '~~/server/core/apiTokens';
import { syncHistorySetting, useHistoryEnabled, setHistoryEnabledState } from '~/composables/usePlayTracking';
import { useDyslexicFont } from '~/composables/useDyslexicFont';
import { useAppearanceSettings, syncAppearanceSettings, setAppearanceSetting } from '~/composables/useAppearanceSettings';
import { usePlaybackSettings, syncPlaybackSettings, setPlaybackSetting } from '~/composables/usePlaybackSettings';
import { useUnitySettings, syncUnitySettings, setUnitySetting, useUnitySessionOverride, setUnityDisabledThisSession } from '~/composables/useUnitySettings';
import { useAuthToken } from '~/composables/useAuthToken';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeySummary } from '~~/server/core/passkeys';
import NotificationSettings from '~/components/settings/NotificationSettings.vue';
import WebhookManager from '~/components/settings/WebhookManager.vue';

const { token: tokenRef, rawCookie: tokenCookie } = useAuthToken();
const token = tokenRef.value ?? "";

interface Category {
  id: "profile" | "accounts" | "storage" | "subsonic" | "privacy" | "appearance" | "playback" | "notifications" | "webhooks" | "developer",
  label: string
}

const activeCategory = ref<Category["id"]>('profile');

const user = ref<NafynUser | null>(null);
const displayName = ref("");
const lastFm = ref("");
const discogs = ref("");
const avatarVersion = ref<string | null>(null);
const avatarFile = ref<File | null>(null);
const avatarObjectUrl = ref<string | null>(null);
const avatarInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);

const perms = computed(() => typeof user.value?.permissions === "number" ? user.value.permissions : 0);
const canManageAccounts = computed(() => hasPermission(perms.value, Permission.MANAGE_ACCOUNTS));
const canManageMusic = computed(() => hasPermission(perms.value, Permission.MANAGE_MUSIC));
const isAdmin = computed(() => hasPermission(perms.value, Permission.ADMIN));
const canManageWebhooks = computed(() => hasPermission(perms.value, Permission.MANAGE_WEBHOOKS));

const categories = computed(() => {
  const cats: Category[] = [{ id: 'profile', label: $t('settings.categories.profile') }];
  cats.push({ id: 'appearance', label: $t('settings.categories.appearance') });
  cats.push({ id: 'playback', label: $t('settings.categories.playback') });
  cats.push({ id: 'notifications', label: $t('settings.categories.notifications') });
  cats.push({ id: 'privacy', label: $t('settings.categories.privacy') });
  if (canManageAccounts.value) cats.push({ id: 'accounts', label: $t('settings.categories.accounts') });
  if (canManageMusic.value) cats.push({ id: 'storage', label: $t('settings.categories.storage') });
  if (canManageWebhooks.value) cats.push({ id: 'webhooks', label: $t('settings.categories.webhooks') });
  cats.push({ id: 'subsonic', label: $t('settings.categories.subsonic') });
  // the sample-data toggle only exists in dev builds - import.meta.dev is compiled away entirely in a
  // production build, so this branch (and the panel it guards) doesn't even ship
  if (import.meta.dev) cats.push({ id: 'developer', label: $t('settings.categories.developer') });
  return cats;
});

// Subsonic-compatible clients want the bare server origin here -
// they append /rest/{method}.view themselves (server/routes/rest/[method].ts), so handing out a URL that
// already ends in /rest doubles up into /rest/rest/... and 404s (this bit a real user - keep it bare)
const subsonicUrl = computed(() => (import.meta.client ? location.origin : ""));

async function copyToClipboard(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    sendToast($t('settings.subsonic.title'), $t('settings.subsonic.copied'));
  } catch {
    // clipboard access denied (permissions, insecure context, ...) - the field is still selectable/copyable by hand
  }
}

// -- API tokens (app passwords, currently used for Subsonic auth - server/utils/subsonicAuth.ts) --

const apiTokens = ref<ApiTokenSummary[]>([]);
const newTokenName = ref("");
const newToken = ref<ApiTokenRow | null>(null);
const generatingApiToken = ref(false);
const deletingTokenId = ref<string | null>(null);

// a panel that fails to load would just sit empty; say why instead
function loadFailed(title: string, e: unknown) {
  useToast().sendError(title, e, $t('settings.profile.error'));
}

async function loadApiTokens() {
  try {
    apiTokens.value = await $fetch<ApiTokenSummary[]>("/api/v1/user/tokens", { headers: { Authorization: token } });
  } catch (e) {
    loadFailed($t('settings.subsonic.tokens.title'), e);
  }
}

async function generateApiToken() {
  generatingApiToken.value = true;
  try {
    const created = await $fetch<ApiTokenRow>("/api/v1/user/tokens", {
      method: "POST",
      headers: { Authorization: token },
      body: { name: newTokenName.value.trim() || null }
    });
    newToken.value = created;
    newTokenName.value = "";
    await loadApiTokens();
  } catch (e) {
    sendToast($t('settings.subsonic.tokens.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    generatingApiToken.value = false;
  }
}

async function removeApiToken(id: string) {
  deletingTokenId.value = id;
  try {
    await $fetch(`/api/v1/user/tokens/${id}`, { method: "DELETE", headers: { Authorization: token } });
    apiTokens.value = apiTokens.value.filter((t) => t.id !== id);
  } catch (e) {
    sendToast($t('settings.subsonic.tokens.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    deletingTokenId.value = null;
  }
}

const avatarPreviewUrl = computed(() => {
  if (avatarObjectUrl.value) return avatarObjectUrl.value;
  if (user.value && avatarVersion.value) {
    return `/api/v1/user/${user.value.id}/avatar?token=${encodeURIComponent(token)}&v=${avatarVersion.value}`;
  }
  return null;
});

const avatarPreviewStyle = computed(() => avatarPreviewUrl.value ? { backgroundImage: `url(${avatarPreviewUrl.value})` } : {});

const initial = computed(() => (displayName.value || user.value?.username || "?").charAt(0).toUpperCase());

const canSave = computed(() => displayName.value.trim().length >= 1 && displayName.value.trim().length <= 20);

const { data, error: meError } = await useFetch<NafynUser>("/api/v1/user/me", { headers: { Authorization: token } });
useLoadErrorToast(meError);
if (data.value) {
  applyUser(data.value);
}

function applyUser(u: NafynUser) {
  user.value = u;
  displayName.value = u.displayName ?? u.username;
  lastFm.value = u.lastFm ?? "";
  discogs.value = u.discogs ?? "";
  avatarVersion.value = u.avatar;
}

function triggerAvatarPicker() {
  avatarInput.value?.click();
}

function onAvatarSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  avatarFile.value = file;
  if (avatarObjectUrl.value) URL.revokeObjectURL(avatarObjectUrl.value);
  avatarObjectUrl.value = URL.createObjectURL(file);
}

async function removeAvatar() {
  if (avatarFile.value) {
    avatarFile.value = null;
    if (avatarObjectUrl.value) URL.revokeObjectURL(avatarObjectUrl.value);
    avatarObjectUrl.value = null;
    return;
  }

  await $fetch("/api/v1/user/avatar", { method: "DELETE", headers: { Authorization: token } })
    .catch((e) => {
      const err = apiErrorMessage(e, $t('settings.profile.error'));
      sendToast($t('settings.profile.removeAvatar'), err, false);
    });
  avatarVersion.value = null;
}

async function save() {
  saving.value = true;

  try {
    const updated: NafynUser = await $fetch("/api/v1/user/profile", {
      method: "PATCH",
      headers: { Authorization: token },
      body: {
        displayName: displayName.value.trim(),
        lastFm: lastFm.value.trim() || null,
        discogs: discogs.value.trim() || null
      }
    });

    applyUser(updated);

    if (avatarFile.value) {
      const body = new FormData();
      body.append("avatar", avatarFile.value);

      const withAvatar: NafynUser = await $fetch("/api/v1/user/avatar", {
        method: "POST",
        headers: { Authorization: token },
        body
      });

      applyUser(withAvatar);
      avatarFile.value = null;
      if (avatarObjectUrl.value) URL.revokeObjectURL(avatarObjectUrl.value);
      avatarObjectUrl.value = null;
    }

    sendToast($t('settings.profile.title'), $t('settings.profile.saved'));
  } catch (e) {
    const err = apiErrorMessage(e, $t('settings.profile.error'));
    sendToast($t('settings.profile.title'), err, false);
  } finally {
    saving.value = false;
  }
}

function sendToast(title: string | null, message: string, success: boolean = true) {
  useToast().sendToast({
    content: message,
    tint: success ? "green" : "red",
    icon: null,
    title
  })
}

async function logout() {
  // best-effort: revoke this device's own session server-side so it disappears from everyone's Sessions
  // list immediately, rather than lingering until its JWT naturally expires. A flaky network must never
  // block the user from actually leaving the page.
  await $fetch("/api/v1/auth/logout", { method: "POST", headers: { Authorization: token } }).catch(() => {});
  tokenCookie.value = null;
  navigateTo("/login");
}

function formatDate(date: string | number | Date): string {
  return new Date(date).toLocaleString();
}

// -- accounts panel --

const registerOpen = ref(true);
const generatingToken = ref(false);
const activeTokens = ref<RegisterTokenRow[]>([]);
const { items: users, loadingMore: usersLoadingMore, sentinel: usersSentinel, loadMore: loadMoreUsers } = useInfiniteList<NafynUser>((page, limit) => {
  return $fetch("/api/v1/users", { headers: { Authorization: token }, query: { page, limit } });
});
const editingId = ref<string | null>(null);
const editDraft = reactive({ displayName: "", username: "", lastFm: "", discogs: "", permissions: 0 });
const savingUser = ref(false);

const permOptions = Object.values(Permission).filter((v) => typeof v === "number" && v !== Permission.NONE) as Permission[];

function isRestrictedBit(p: Permission): boolean {
  return p === Permission.MANAGE_ACCOUNTS || p === Permission.ADMIN;
}

// the same rule the server enforces (server/entity/Permission.ts): ADMIN edits anyone; MANAGE_ACCOUNTS only
// accounts below it - not another MANAGE_ACCOUNTS holder, not an ADMIN, not itself
// your own row is read-only here (server/entity/Permission.ts refuses it too): your profile is under Profile,
// and nobody - an ADMIN included - gets to change their own permissions through the accounts list
function isSelf(u: NafynUser): boolean {
  return u.id === user.value?.id;
}

function canManage(u: NafynUser): boolean {
  return canManageUser(user.value?.id ?? "", perms.value, u.id, typeof u.permissions === "number" ? u.permissions : 0);
}

function avatarStyleFor(u: NafynUser) {
  return u.avatar ? { backgroundImage: `url(/api/v1/user/${u.id}/avatar?token=${encodeURIComponent(token)}&v=${u.avatar})` } : {};
}

function tokenUrl(t: string): string {
  return `${location.origin}/register?token=${t}`;
}

async function loadAccountsPanel() {
  try {
    const [reg, tokens] = await Promise.all([
      $fetch<{ open: boolean }>("/api/v1/settings/register"),
      $fetch<RegisterTokenRow[]>("/api/v1/settings/register-tokens", { headers: { Authorization: token } }),
      loadMoreUsers()
    ]);
    registerOpen.value = reg.open;
    activeTokens.value = tokens;
  } catch (e) {
    loadFailed($t('settings.accounts.title'), e);
  }
}

async function toggleRegisterOpen() {
  await $fetch("/api/v1/settings/register", { method: "PATCH", headers: { Authorization: token }, body: { open: registerOpen.value } })
    .catch((e) => {
      registerOpen.value = !registerOpen.value;
      sendToast($t('settings.accounts.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
    });
}

async function generateToken() {
  generatingToken.value = true;
  try {
    const t = await $fetch<RegisterTokenRow>("/api/v1/settings/register-tokens", { method: "POST", headers: { Authorization: token } });
    activeTokens.value = [t, ...activeTokens.value];
  } catch (e) {
    sendToast($t('settings.accounts.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    generatingToken.value = false;
  }
}

function toggleEdit(u: NafynUser) {
  if (editingId.value === u.id) {
    editingId.value = null;
    return;
  }
  editingId.value = u.id;
  editDraft.displayName = u.displayName ?? u.username;
  editDraft.username = u.username;
  editDraft.lastFm = u.lastFm ?? "";
  editDraft.discogs = u.discogs ?? "";
  editDraft.permissions = typeof u.permissions === "number" ? u.permissions : 0;
}

function togglePermBit(p: Permission, checked: boolean) {
  editDraft.permissions = checked ? (editDraft.permissions | p) : (editDraft.permissions & ~p);
}

async function saveUser(u: NafynUser) {
  savingUser.value = true;
  try {
    const updated = await $fetch<NafynUser>(`/api/v1/users/${u.id}`, {
      method: "PATCH",
      headers: { Authorization: token },
      body: {
        displayName: editDraft.displayName.trim(),
        username: editDraft.username.trim(),
        lastFm: editDraft.lastFm.trim() || null,
        discogs: editDraft.discogs.trim() || null,
        permissions: editDraft.permissions
      }
    });
    const idx = users.value.findIndex((x) => x.id === u.id);
    if (idx !== -1) users.value[idx] = updated;
    editingId.value = null;
    sendToast($t('settings.accounts.title'), $t('settings.profile.saved'));
  } catch (e) {
    sendToast($t('settings.accounts.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    savingUser.value = false;
  }
}

async function removeUser(u: NafynUser) {
  savingUser.value = true;
  try {
    await $fetch(`/api/v1/users/${u.id}`, { method: "DELETE", headers: { Authorization: token } });
    users.value = users.value.filter((x) => x.id !== u.id);
    editingId.value = null;
  } catch (e) {
    sendToast($t('settings.accounts.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    savingUser.value = false;
  }
}

// -- storage panel --

interface StorageResponse {
  totalBytes: number,
  freeBytes: number,
  usedByNafynBytes: number,
  perUser: { userId: string, username: string, displayName: string | null, bytes: number }[]
}

const storage = ref<StorageResponse | null>(null);

async function loadStoragePanel() {
  try {
    storage.value = await $fetch<StorageResponse>("/api/v1/settings/storage", { headers: { Authorization: token } });
  } catch (e) {
    loadFailed($t('settings.storage.title'), e);
  }
}

const usedPercent = computed(() => {
  if (!storage.value || storage.value.totalBytes === 0) return 0;
  return Math.min(100, (storage.value.usedByNafynBytes / storage.value.totalBytes) * 100);
});

const occupiedPercent = computed(() => {
  if (!storage.value || storage.value.totalBytes === 0) return 0;
  return Math.min(100, ((storage.value.totalBytes - storage.value.freeBytes) / storage.value.totalBytes) * 100);
});

const PALETTE = ["#e18c46", "#44cf44", "#4499cf", "#cf4444", "#cf44b8", "#cfc444", "#8c44cf", "#44cfa8"];

function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

// percent-of-circle [start, end) for each perUser slice, in the same order as the conic-gradient stops
const sliceBoundaries = computed(() => {
  if (!storage.value || storage.value.perUser.length === 0) return [];
  const total = storage.value.perUser.reduce((sum, u) => sum + u.bytes, 0);
  if (total === 0) return [];

  let cumulative = 0;
  return storage.value.perUser.map((u) => {
    const start = (cumulative / total) * 100;
    cumulative += u.bytes;
    const end = (cumulative / total) * 100;
    return { start, end };
  });
});

const pieGradient = computed(() => {
  if (!storage.value || sliceBoundaries.value.length === 0) return "none";
  const stops = sliceBoundaries.value.map(({ start, end }, i) => `${paletteColor(i)} ${start}% ${end}%`);
  return `conic-gradient(${stops.join(", ")})`;
});

const hoveredUserIndex = ref<number | null>(null);

function onPieHover(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;

  // conic-gradient's 0% is straight up (12 o'clock), going clockwise; atan2 measures clockwise from
  // 3 o'clock (since screen y grows downward), so rotate by 90deg to line the two up
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  const percent = (angle / 360) * 100;

  const index = sliceBoundaries.value.findIndex(({ start, end }) => percent >= start && percent < end);
  hoveredUserIndex.value = index === -1 ? null : index;
}

// -- appearance panel --

const appearance = useAppearanceSettings();
const dyslexicFont = useDyslexicFont();

async function loadAppearancePanel() {
  await syncAppearanceSettings();
}

async function toggleFileSize(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  try {
    await setAppearanceSetting({ showFileSize: checked });
  } catch {
    sendToast($t('settings.appearance.title'), $t('settings.profile.error'), false);
  }
}

async function toggleDuration(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  try {
    await setAppearanceSetting({ showDuration: checked });
  } catch {
    sendToast($t('settings.appearance.title'), $t('settings.profile.error'), false);
  }
}

// -- playback panel (crossfade) --

const playback = usePlaybackSettings();
// local while dragging, saved once on release rather than a PATCH per slider step
const crossfadeSeconds = ref(playback.value.crossfadeMs / 1000);
watch(() => playback.value.crossfadeMs, (ms) => { crossfadeSeconds.value = ms / 1000; });

async function toggleCrossfade(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  try {
    await setPlaybackSetting({ crossfadeEnabled: checked });
  } catch {
    sendToast($t('settings.playback.title'), $t('settings.profile.error'), false);
  }
}

async function saveCrossfadeLength() {
  try {
    await setPlaybackSetting({ crossfadeMs: Math.round(crossfadeSeconds.value * 1000) });
  } catch {
    sendToast($t('settings.playback.title'), $t('settings.profile.error'), false);
  }
}

// -- privacy panel (listening history) --

const insights = useInsights();
const historyEnabled = useHistoryEnabled();
// the queue panel's History follows this setting too
const { clearHistory: clearPlaybackHistory } = useUnity();
const exporting = ref(false);
const deletingHistory = ref(false);
const exportingAccount = ref(false);
const deletingAccount = ref(false);
const deleteAccountPassword = ref("");

async function loadPrivacyPanel() {
  try {
    await syncHistorySetting();
    if (passkeys.value.length === 0) passkeys.value = await $fetch<PasskeySummary[]>("/api/v1/user/passkeys", { headers: { Authorization: token } });
  } catch (e) {
    loadFailed($t('settings.privacy.title'), e);
  }
}

async function toggleHistory() {
  const wanted = historyEnabled.value;
  try {
    // the browser's UTC offset goes along with the toggle, so the server can bucket days, weeks and years
    // in the user's own calendar from the very first play
    await $fetch("/api/v1/insights/settings", {
      method: "PATCH",
      headers: { Authorization: token },
      body: { historyEnabled: wanted, tzOffsetMinutes: -new Date().getTimezoneOffset() }
    });
    // update the capture flag immediately, so the very next track played counts - without this, turning
    // history on here wouldn't take effect until something else happened to re-sync it
    setHistoryEnabledState(wanted);
    if (!wanted) clearPlaybackHistory();
    sendToast($t('settings.privacy.title'), wanted ? $t('settings.privacy.history.on') : $t('settings.privacy.history.off'));
  } catch (e) {
    // put the switch back where it was rather than leaving it showing a state the server never accepted
    setHistoryEnabledState(!wanted);
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  }
}

async function exportHistory() {
  exporting.value = true;
  try {
    // fetched as a blob rather than linked directly: the export endpoint needs an Authorization header, and
    // a plain <a href> cannot send one
    const blob = await $fetch<Blob>("/api/v1/insights/export", {
      headers: { Authorization: token },
      responseType: "blob"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nafyn-listening-history.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    exporting.value = false;
  }
}

// GDPR art. 15 + 20. Same blob-download mechanics as exportHistory above, for the same reason: the
// endpoint needs an Authorization header, which a plain <a href> cannot send
async function exportAccount() {
  exportingAccount.value = true;
  try {
    const blob = await $fetch<Blob>("/api/v1/user/export", {
      headers: { Authorization: token },
      responseType: "blob"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nafyn-account-data.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    exportingAccount.value = false;
  }
}

// GDPR art. 17. The password is re-checked server-side: a stolen token alone must not be able to delete an
// account, which is also why it is asked for here rather than being taken from the existing session
async function deleteOwnAccount() {
  if (!confirm($t('settings.privacy.deleteAccount.confirm'))) return;

  deletingAccount.value = true;
  try {
    await $fetch("/api/v1/user/me", {
      method: "DELETE",
      headers: { Authorization: token },
      body: { password: deleteAccountPassword.value }
    });

    // the account is gone, so there is no session left to revoke - just drop the cookie and leave
    deleteAccountPassword.value = "";
    tokenCookie.value = null;
    navigateTo("/login");
  } catch (e) {
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    deletingAccount.value = false;
  }
}

async function deleteHistory() {
  // irreversible and unrecoverable, so it asks first
  if (!confirm($t('settings.privacy.delete.confirm'))) return;

  deletingHistory.value = true;
  try {
    await insights.deleteHistory();
    clearPlaybackHistory();
    sendToast($t('settings.privacy.title'), $t('settings.privacy.delete.done'));
  } catch (e) {
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    deletingHistory.value = false;
  }
}

// -- sessions panel (Nafyn Unity + active sessions) --

interface SessionSummary {
  id: string,
  deviceLabel: string,
  createdAt: number,
  lastSeenAt: number,
  isCurrent: boolean
}

const unitySettings = useUnitySettings();
const unitySessionOverride = useUnitySessionOverride();
const sessions = ref<SessionSummary[]>([]);
const revokingSessionId = ref<string | null>(null);

async function loadSessionsPanel() {
  try {
    await syncUnitySettings();
    sessions.value = await $fetch<SessionSummary[]>("/api/v1/user/sessions", { headers: { Authorization: token } });
  } catch (e) {
    loadFailed($t('settings.sessions.title'), e);
  }
}

async function toggleUnity(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  try {
    await setUnitySetting({ enabled: checked });
  } catch {
    sendToast($t('settings.sessions.title'), $t('settings.profile.error'), false);
  }
}

function toggleUnitySessionOverride(e: Event) {
  setUnityDisabledThisSession((e.target as HTMLInputElement).checked);
}

async function revokeSession(id: string) {
  revokingSessionId.value = id;
  try {
    await $fetch(`/api/v1/user/sessions/${id}`, { method: "DELETE", headers: { Authorization: token } });
    sessions.value = sessions.value.filter((s) => s.id !== id);
  } catch (e) {
    sendToast($t('settings.sessions.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    revokingSessionId.value = null;
  }
}

// -- privacy panel (passkeys) --

const passkeys = ref<PasskeySummary[]>([]);
const newPasskeyLabel = ref("");
const addingPasskey = ref(false);
const deletingPasskeyId = ref<string | null>(null);
const passkeySupported = import.meta.client ? browserSupportsWebAuthn() : false;
// browserSupportsWebAuthn() alone can't tell "this browser has no WebAuthn" apart from "this browser removed
// the whole API because we're not in a secure context" - the latter is what plain http:// on a LAN IP looks
// like in every browser, and silently blaming "your browser" there is actively misleading
const passkeyNeedsSecureContext = import.meta.client && !passkeySupported && !window.isSecureContext;

async function addPasskey() {
  addingPasskey.value = true;
  try {
    const options = await $fetch("/api/v1/user/passkeys/register-options", { method: "POST", headers: { Authorization: token } });
    const response = await startRegistration({ optionsJSON: options });
    const created = await $fetch<PasskeySummary>("/api/v1/user/passkeys/register", {
      method: "POST",
      headers: { Authorization: token },
      body: { response, label: newPasskeyLabel.value.trim() || null }
    });
    passkeys.value = [created, ...passkeys.value];
    newPasskeyLabel.value = "";
    sendToast($t('settings.privacy.title'), $t('settings.privacy.passkeys.added'));
  } catch (e) {
    // the browser throws its own Error (e.g. user cancelled) rather than a $fetch error in that case
    const message = apiErrorMessage(e, $t('settings.profile.error'));
    sendToast($t('settings.privacy.title'), message, false);
  } finally {
    addingPasskey.value = false;
  }
}

async function removePasskey(id: string) {
  deletingPasskeyId.value = id;
  try {
    await $fetch(`/api/v1/user/passkeys/${id}`, { method: "DELETE", headers: { Authorization: token } });
    passkeys.value = passkeys.value.filter((p) => p.id !== id);
  } catch (e) {
    sendToast($t('settings.privacy.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    deletingPasskeyId.value = null;
  }
}

// -- developer panel (sample data) --

const sampleDataEnabled = ref(false);
const togglingSampleData = ref(false);

async function loadDeveloperPanel() {
  try {
    const state = await $fetch<{ enabled: boolean }>("/api/v1/user/sample-data", {
      headers: { Authorization: token }
    });
    sampleDataEnabled.value = state.enabled;
  } catch {
    // dev-only endpoint; nothing useful to show if it's unreachable
  }
}

async function toggleSampleData() {
  const wanted = sampleDataEnabled.value;
  togglingSampleData.value = true;
  try {
    const result = await $fetch<{ enabled: boolean }>("/api/v1/user/sample-data", {
      method: "POST",
      headers: { Authorization: token },
      body: { enabled: wanted }
    });
    sampleDataEnabled.value = result.enabled;
    sendToast($t('settings.developer.title'), wanted ? $t('settings.developer.sampleData.on') : $t('settings.developer.sampleData.off'));
  } catch (e) {
    sampleDataEnabled.value = !wanted;
    sendToast($t('settings.developer.title'), apiErrorMessage(e, $t('settings.profile.error')), false);
  } finally {
    togglingSampleData.value = false;
  }
}

// switching sub-tabs starts the new one at the top: the page scrolls as a whole, so the previous tab's scroll
// position would otherwise carry over and land the new tab half-way down (or past its end)
function selectCategory(id: Category["id"]) {
  activeCategory.value = id;
  if (import.meta.client) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

watch(activeCategory, async (cat) => {
  if (cat === 'accounts' && users.value.length === 0) await loadAccountsPanel();
  if (cat === 'storage' && !storage.value) await loadStoragePanel();
  if (cat === 'subsonic' && apiTokens.value.length === 0) await loadApiTokens();
  if (cat === 'privacy') await Promise.all([loadPrivacyPanel(), loadSessionsPanel()]);
  if (cat === 'appearance') await loadAppearancePanel();
  if (cat === 'playback') await syncPlaybackSettings();
  if (cat === 'developer') await loadDeveloperPanel();
});
</script>

<style>
.settings {
  display: flex;
  gap: 60px;
  align-items: flex-start;
}

.settings-nav {
  position: sticky;
  top: calc(15vh - 10px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 220px;
  flex-shrink: 0;
}

.settings-nav h2 {
  font-size: 1em;
  margin-bottom: 10px;
}

.settings-nav button {
  background: none;
  border: none;
  color: #ffffffae;
  text-align: left;
  font-family: "Instrument-Serif";
  font-size: 0.75em;
  padding: 8px 16px;
  border-radius: 250px;
}

.settings-nav button.active {
  background: #ffffffae;
  color: #000;
}

.settings-content {
  flex: 1;
  max-width: 450px;
  min-width: 0;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.panel input[type="text"],
.panel input[type="password"] {
  width: 100%;
  min-width: 0;
}

.panel label {
  font-size: 0.7em;
  color: #ffffff;
  margin-bottom: -8px;
}

.avatar-field {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 10px;
}

.avatar-preview {
  width: 90px;
  height: 90px;
  border-radius: 50%;
  background-color: #00000050;
  background-size: cover;
  background-position: center;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5em;
  cursor: pointer;
  flex-shrink: 0;
}

.avatar-preview.small {
  width: 40px;
  height: 40px;
  font-size: 1em;
  cursor: default;
}

.hidden-input {
  display: none;
}

.avatar-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.avatar-actions button {
  font-size: 0.8em;
}

.panel .error {
  color: #e06666;
  font-size: 0.7em;
}

.panel .saved {
  color: #93c47d;
  font-size: 0.7em;
}

.subsection {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 0;
  border-top: 1px solid #ffffff1a;
}

.subsection h2 {
  font-size: 0.9em;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85em;
}

.range-row {
  display: flex;
  align-items: center;
  gap: 14px;
  transition: opacity 0.15s ease;
}

.range-row.disabled {
  opacity: 0.4;
}

.range-row input[type="range"] {
  flex: 1;
  min-width: 0;
}

.range-row .range-value {
  font-family: var(--font-discy);
  font-variant-numeric: tabular-nums;
  font-size: 0.75em;
  width: 3.5em;
  text-align: right;
}

.token-generator {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.token-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  padding: 0;
}

.token-list li {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.token-list input {
  font-size: 0.75em;
}

.token-list .expires {
  font-size: 0.65em;
  color: #ffffff;
}

.user-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  padding: 0;
}

.scroll-sentinel {
  height: 1px;
}

.loading-more {
  text-align: center;
  color: #ffffff;
  font-size: 0.8em;
  padding: 10px 0;
}

.user-row {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  background: #00000030;
  min-width: 0;
}

.user-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}

.user-summary .col {
  display: flex;
  flex-direction: column;
  flex: 1 1 120px;
  min-width: 0;
}

.user-summary .title,
.user-summary .artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-summary .title {
  font-size: 0.9em;
}

.user-summary .artist {
  font-size: 0.7em;
  color: #ffffff;
}

.edit-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.perm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  font-size: 0.75em;
}

.perm-option {
  font-family: var(--font-discy);
  display: flex;
  align-items: center;
  gap: 6px;
  color: #fff;
}

.edit-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.bar {
  width: 100%;
  height: 10px;
  border-radius: 5px;
  background: #ffffff1a;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}

.bar > * {
  height: 100%;
  transition: width 0.3s ease;
}

.bar > .fill {
  background: #e18c46;
}

.bar > .occupied {
  background: #7c7c7c;
}

.storage-stats {
  font-size: 0.75em;
  color: #ffffff;
}

.pie-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
}

.pie {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  flex-shrink: 0;
  cursor: pointer;
}

.legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  font-size: 0.75em;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  margin: -3px -6px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.legend li.active {
  background: #ffffff1a;
  font-weight: bold;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.everyone-link {
  font-size: 0.85em;
  margin-top: 10px;
}

.subsonic-intro {
  font-size: 0.85em;
  color: #ffffff;
}

.copy-field {
  display: flex;
  gap: 10px;
}

.copy-field input {
  flex: 1;
  min-width: 0;
}

.copy-field button {
  flex-shrink: 0;
  font-size: 0.8em;
}

.subsonic-note {
  font-size: 0.7em;
  color: #ffffff;
}

.new-token-reveal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: #93c47d1a;
  border: 1px solid #93c47d55;
}

.new-token-warning {
  font-size: 0.75em;
  color: #93c47d;
}

.api-token-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  padding: 0;
}

.api-token-list li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #00000030;
}

.api-token-list .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.api-token-list .title {
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-token-list .artist {
  font-size: 0.65em;
  color: #ffffff;
}

@media screen and (max-width: 800px) {
  .settings {
    flex-direction: column;
    align-items: stretch;
    gap: 30px;
  }

  .settings-nav {
    position: static;
    flex-direction: row;
    flex-wrap: nowrap;
    width: 100%;
    overflow-x: auto;
    padding-bottom: 4px;
    -webkit-overflow-scrolling: touch;
  }

  .settings-nav button {
    flex-shrink: 0;
  }

  .settings-content {
    width: 100%;
    max-width: 100%;
  }

  .avatar-field {
    flex-wrap: wrap;
  }

  .user-summary button {
    flex: 1 0 100%;
  }

  .perm-grid {
    grid-template-columns: 1fr;
  }

  .edit-actions button {
    width: 100%;
  }

  .pie-wrap {
    flex-direction: column;
    align-items: flex-start;
  }

  .pie {
    align-self: center;
  }
}
</style>

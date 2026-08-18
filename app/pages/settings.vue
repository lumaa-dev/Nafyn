<template>
  <div class="settings">
    <nav class="settings-nav">
      <h2>{{ $t('settings.title') }}</h2>
      <button
        v-for="category in categories"
        :key="category.id"
        type="button"
        :class="{ active: activeCategory === category.id }"
        @click="activeCategory = category.id"
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
                <span class="perm-chips">
                  <span v-for="p in permBitsOf(u)" :key="p" class="chip">{{ $t(`settings.accounts.permissions.${Permission[p]}`) }}</span>
                </span>
                <button type="button" filled="hollow" :disabled="!canManage(u)" @click="toggleEdit(u)">{{ editingId === u.id ? $t('settings.accounts.users.cancel') : $t('settings.accounts.users.edit') }}</button>
              </div>

              <div v-if="editingId === u.id" class="edit-form">
                <label>{{ $t('settings.profile.displayName') }}</label>
                <input v-model="editDraft.displayName" type="text" maxlength="20">
                <label>{{ $t('settings.accounts.users.username') }}</label>
                <input v-model="editDraft.username" type="text">
                <label>{{ $t('settings.profile.lastFm') }}</label>
                <input v-model="editDraft.lastFm" type="text">
                <label>{{ $t('settings.profile.discogs') }}</label>
                <input v-model="editDraft.discogs" type="text">

                <label>{{ $t('settings.accounts.users.permissions') }}</label>
                <div class="perm-grid">
                  <label v-for="p in permOptions" :key="p" class="perm-option">
                    <input
                      type="checkbox"
                      :disabled="isRestrictedBit(p) && !isAdmin"
                      :checked="!!(editDraft.permissions & p)"
                      @change="togglePermBit(p, ($event.target as HTMLInputElement).checked)"
                    >
                    {{ $t(`settings.accounts.permissions.${Permission[p]}`) }}
                  </label>
                </div>

                <div class="edit-actions">
                  <button type="button" filled :disabled="savingUser" @click="saveUser(u)">{{ $t('settings.accounts.users.save') }}</button>
                  <button class="danger" type="button" filled="hollow" :disabled="savingUser" @click="removeUser(u)">{{ $t('settings.accounts.users.delete') }}</button>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <div v-else-if="activeCategory === 'storage'" class="panel">
        <h1>{{ $t('settings.storage.title') }}</h1>

        <section class="subsection" v-if="storage">
          <h2>{{ $t('settings.storage.usage.title') }}</h2>
          <div class="bar">
            <div class="fill" :style="{ width: `${usedPercent}%` }" />
          </div>
          <p class="storage-stats">{{ $t('settings.storage.usage.stats', { used: formatBytes(storage.usedByNafynBytes), free: formatBytes(storage.freeBytes), total: formatBytes(storage.totalBytes) }) }}</p>
        </section>

        <section class="subsection" v-if="storage && storage.perUser.length > 0">
          <h2>{{ $t('settings.storage.perUser.title') }}</h2>
          <div class="pie-wrap">
            <div class="pie" :style="{ background: pieGradient }" />
            <ul class="legend">
              <li v-for="(u, i) in storage.perUser" :key="u.userId">
                <span class="swatch" :style="{ background: paletteColor(i) }" />
                {{ u.displayName ?? u.username }} — {{ formatBytes(u.bytes) }}
              </li>
            </ul>
          </div>
        </section>

        <NuxtLink to="/l/all" class="everyone-link">{{ $t('settings.storage.everyoneLibraryLink') }}</NuxtLink>
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';
import { hasPermission, Permission } from '~~/server/entity/Permission';
import type { RegisterTokenRow } from '~~/server/core/registerTokens';

const token = useCookie("nafynToken").value ?? "";

interface Category {
  id: "profile" | "accounts" | "storage",
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

const categories = computed(() => {
  const cats: Category[] = [{ id: 'profile', label: $t('settings.categories.profile') }];
  if (canManageAccounts.value) cats.push({ id: 'accounts', label: $t('settings.categories.accounts') });
  if (canManageMusic.value) cats.push({ id: 'storage', label: $t('settings.categories.storage') });
  return cats;
});

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

const { data } = await useFetch<NafynUser>("/api/v1/user/me", { headers: { Authorization: token } });
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
      const err = e?.data?.statusMessage ?? $t('settings.profile.error');
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
    const err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error');
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

function formatDate(date: string | number | Date): string {
  return new Date(date).toLocaleString();
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// -- accounts panel --

const registerOpen = ref(true);
const generatingToken = ref(false);
const activeTokens = ref<RegisterTokenRow[]>([]);
const users = ref<NafynUser[]>([]);
const editingId = ref<string | null>(null);
const editDraft = reactive({ displayName: "", username: "", lastFm: "", discogs: "", permissions: 0 });
const savingUser = ref(false);

const permOptions = Object.values(Permission).filter((v) => typeof v === "number" && v !== Permission.NONE) as Permission[];

function isRestrictedBit(p: Permission): boolean {
  return p === Permission.MANAGE_ACCOUNTS || p === Permission.ADMIN;
}

function permBitsOf(u: NafynUser): Permission[] {
  const bits = typeof u.permissions === "number" ? u.permissions : 0;
  return permOptions.filter((p) => bits & p);
}

function canManage(u: NafynUser): boolean {
  if (isAdmin.value) return true;
  if (!canManageAccounts.value) return false;
  if (u.id === user.value?.id) return true;
  const bits = typeof u.permissions === "number" ? u.permissions : 0;
  return !(bits & (Permission.MANAGE_ACCOUNTS | Permission.ADMIN));
}

function avatarStyleFor(u: NafynUser) {
  return u.avatar ? { backgroundImage: `url(/api/v1/user/${u.id}/avatar?token=${encodeURIComponent(token)}&v=${u.avatar})` } : {};
}

function tokenUrl(t: string): string {
  return `${location.origin}/register?token=${t}`;
}

async function loadAccountsPanel() {
  const [reg, tokens, list] = await Promise.all([
    $fetch<{ open: boolean }>("/api/v1/settings/register"),
    $fetch<RegisterTokenRow[]>("/api/v1/settings/register-tokens", { headers: { Authorization: token } }),
    $fetch<NafynUser[]>("/api/v1/users", { headers: { Authorization: token } })
  ]);
  registerOpen.value = reg.open;
  activeTokens.value = tokens;
  users.value = list;
}

async function toggleRegisterOpen() {
  await $fetch("/api/v1/settings/register", { method: "PATCH", headers: { Authorization: token }, body: { open: registerOpen.value } })
    .catch((e) => {
      registerOpen.value = !registerOpen.value;
      sendToast($t('settings.accounts.title'), e?.data?.statusMessage ?? $t('settings.profile.error'), false);
    });
}

async function generateToken() {
  generatingToken.value = true;
  try {
    const t = await $fetch<RegisterTokenRow>("/api/v1/settings/register-tokens", { method: "POST", headers: { Authorization: token } });
    activeTokens.value = [t, ...activeTokens.value];
  } catch (e) {
    sendToast($t('settings.accounts.title'), (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error'), false);
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
    sendToast($t('settings.accounts.title'), (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error'), false);
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
    sendToast($t('settings.accounts.title'), (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error'), false);
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
  storage.value = await $fetch<StorageResponse>("/api/v1/settings/storage", { headers: { Authorization: token } });
}

const usedPercent = computed(() => {
  if (!storage.value || storage.value.totalBytes === 0) return 0;
  return Math.min(100, (storage.value.usedByNafynBytes / storage.value.totalBytes) * 100);
});

const PALETTE = ["#e18c46", "#44cf44", "#4499cf", "#cf4444", "#cf44b8", "#cfc444", "#8c44cf", "#44cfa8"];

function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

const pieGradient = computed(() => {
  if (!storage.value || storage.value.perUser.length === 0) return "none";
  const total = storage.value.perUser.reduce((sum, u) => sum + u.bytes, 0);
  if (total === 0) return "none";

  let cumulative = 0;
  const stops: string[] = [];
  storage.value.perUser.forEach((u, i) => {
    const start = (cumulative / total) * 100;
    cumulative += u.bytes;
    const end = (cumulative / total) * 100;
    stops.push(`${paletteColor(i)} ${start}% ${end}%`);
  });

  return `conic-gradient(${stops.join(", ")})`;
});

watch(activeCategory, async (cat) => {
  if (cat === 'accounts' && users.value.length === 0) await loadAccountsPanel();
  if (cat === 'storage' && !storage.value) await loadStoragePanel();
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
  color: #666666;
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
  color: #666666;
}

.user-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  padding: 0;
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
  color: #666666;
}

.perm-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 130px;
  flex-shrink: 0;
}

.chip {
  font-size: 0.6em;
  padding: 2px 8px;
  border-radius: 100px;
  background: #ffffff1a;
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
  font-family: "Discy";
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
}

.bar .fill {
  height: 100%;
  border-radius: 5px;
  background: #e18c46;
  transition: width 0.3s ease;
}

.storage-stats {
  font-size: 0.75em;
  color: #666666;
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

  .perm-chips {
    max-width: 100%;
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

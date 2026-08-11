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
    </section>
  </div>
</template>

<script lang="ts" setup>
import type { NafynUser } from '~~/server/entity/NafynUser';
const token = useCookie("nafynToken").value ?? "";

interface Category {
  id: "profile",
  label: string
}

const categories: Category[] = [
  { id: 'profile', label: $t('settings.categories.profile') }
];

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
      let err = e?.data?.statusMessage ?? $t('settings.profile.error');
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
    let err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error');
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
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
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

@media screen and (max-width: 800px) {
  .settings {
    flex-direction: column;
    gap: 30px;
  }

  .settings-nav {
    position: static;
    flex-direction: row;
    width: 100%;
    flex-wrap: wrap;
  }
}
</style>

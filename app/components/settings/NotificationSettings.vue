<template>
  <div class="notification-settings">
    <section class="subsection">
      <h2>{{ $t('settings.notifications.webhooks.title') }}</h2>
      <p class="subsonic-note">{{ $t('settings.notifications.webhooks.intro') }}</p>
      <WebhookManager scope="user" />
    </section>

    <section class="subsection">
      <h2>{{ $t('settings.notifications.devices.title') }}</h2>
      <p class="subsonic-note">{{ $t('settings.notifications.devices.intro') }}</p>
      <ul v-if="devices.length > 0" class="api-token-list">
        <li v-for="d in devices" :key="d.id">
          <span class="col">
            <span class="title">{{ d.deviceName || $t('settings.notifications.devices.unnamed') }}{{ d.currentSession ? ` (${$t('settings.notifications.devices.thisDevice')})` : '' }}</span>
            <span class="artist">
              <template v-if="d.environment === 'sandbox'">{{ $t('settings.notifications.devices.sandbox') }} &middot; </template>{{ $t('settings.notifications.devices.lastSeen', { date: formatDate(d.lastSeenAt) }) }}
            </span>
          </span>
          <button class="danger" type="button" filled="hollow" :disabled="busyDeviceId === d.id" @click="removeDevice(d.id)">{{ $t('settings.notifications.devices.remove') }}</button>
        </li>
      </ul>
      <p v-else class="subsonic-note">{{ $t('settings.notifications.devices.empty') }}</p>
    </section>

    <section class="subsection">
      <h2>{{ $t('settings.notifications.releases.title') }}</h2>
      <p class="subsonic-note">{{ $t('settings.notifications.releases.intro') }}</p>
      <ul v-if="subscriptions.length > 0" class="api-token-list">
        <li v-for="s in subscriptions" :key="s.id">
          <span class="col">
            <NuxtLink class="title" :to="`/${s.type === 'album' ? 'a' : 't'}/${s.musicbrainzId}`">{{ s.title ?? s.musicbrainzId }}</NuxtLink>
            <span class="artist">
              {{ s.artistName }} &middot;
              <template v-if="s.notifiedAt">{{ $t('countdown.outNow') }}</template>
              <ReleaseCountdown v-else compact :date="s.releaseDate" />
            </span>
          </span>
          <button v-if="!s.notifiedAt" class="danger" type="button" filled="hollow" :disabled="busySubscriptionId === s.id" @click="unsubscribe(s)">{{ $t('settings.notifications.releases.unfollow') }}</button>
        </li>
      </ul>
      <p v-else class="subsonic-note">{{ $t('settings.notifications.releases.empty') }}</p>
    </section>
  </div>
</template>

<script lang="ts" setup>
import type { ApnDeviceSummary } from '~~/server/utils/apn';
import type { ReleaseSubscription } from '~~/server/core/releaseSubscriptions';
import type { Paginated } from '~~/server/utils/pagination';
import WebhookManager from '~/components/settings/WebhookManager.vue';
import ReleaseCountdown from '~/components/ReleaseCountdown.vue';
import { useAuthToken } from '~/composables/useAuthToken';

const { t, locale } = useI18n();
const { token } = useAuthToken();

const devices = ref<ApnDeviceSummary[]>([]);
const subscriptions = ref<ReleaseSubscription[]>([]);
const busyDeviceId = ref<string | null>(null);
const busySubscriptionId = ref<string | null>(null);

function headers() {
  return { Authorization: token.value ?? "" };
}

function toast(content: string, success: boolean = true) {
  useToast().sendToast({ title: t('settings.categories.notifications'), content, tint: success ? "green" : "red", icon: null });
}

function errorMessage(e: unknown): string {
  return apiErrorMessage(e, t('settings.profile.error'));
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(locale.value, { year: "numeric", month: "short", day: "numeric" });
}

async function load() {
  try {
    const [d, s] = await Promise.all([
      $fetch<ApnDeviceSummary[]>("/api/v1/user/devices", { headers: headers() }),
      $fetch<Paginated<ReleaseSubscription>>("/api/v1/subscriptions", { headers: headers(), query: { limit: 200 } })
    ]);
    devices.value = d;
    subscriptions.value = s.items;
  } catch (e) {
    toast(errorMessage(e), false);
  }
}

async function removeDevice(id: string) {
  busyDeviceId.value = id;
  try {
    await $fetch(`/api/v1/user/devices/${id}`, { method: "DELETE", headers: headers() });
    devices.value = devices.value.filter((d) => d.id !== id);
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    busyDeviceId.value = null;
  }
}

async function unsubscribe(s: ReleaseSubscription) {
  busySubscriptionId.value = s.id;
  try {
    await $fetch(`/api/v1/subscriptions/${s.musicbrainzId}`, { method: "DELETE", headers: headers() });
    subscriptions.value = subscriptions.value.filter((x) => x.id !== s.id);
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    busySubscriptionId.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.notification-settings .subsection:first-child {
  border-top: none;
  padding-top: 0;
}

.notification-settings a.title {
  color: inherit;
  text-decoration: none;
}

.notification-settings a.title:hover {
  text-decoration: underline;
}
</style>

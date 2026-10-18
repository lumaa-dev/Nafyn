<template>
  <div class="webhook-manager">
    <ul v-if="webhooks.length > 0" class="api-token-list webhook-list">
      <li v-for="w in webhooks" :key="w.id" :class="{ off: !w.enabled }">
        <span class="col">
          <span class="title">{{ w.name }} <span class="format">{{ $t(`webhooks.formats.${w.format}`) }}</span></span>
          <span class="artist">{{ w.urlPreview }} &middot; {{ eventSummary(w) }}</span>
          <span v-if="!w.enabled && w.failureCount > 0" class="artist failure">{{ $t('webhooks.autoDisabled', { error: w.lastError ?? '' }) }}</span>
          <span v-else-if="w.failureCount > 0" class="artist failure">{{ $t('webhooks.failing', { count: w.failureCount, error: w.lastError ?? '' }) }}</span>
          <span v-else-if="w.lastDeliveredAt" class="artist">{{ $t('webhooks.lastDelivered', { date: formatDate(w.lastDeliveredAt) }) }}</span>
        </span>
        <span class="actions">
          <label class="switch-row" :title="$t('webhooks.enabled')">
            <input type="checkbox" :checked="w.enabled" :disabled="busyId === w.id" @change="setEnabled(w, ($event.target as HTMLInputElement).checked)">
          </label>
          <button type="button" filled="hollow" :disabled="busyId === w.id" @click="test(w)">{{ $t('webhooks.test') }}</button>
          <button class="danger" type="button" filled="hollow" :disabled="busyId === w.id" @click="remove(w)">{{ $t('webhooks.delete') }}</button>
        </span>
      </li>
    </ul>
    <p v-else class="subsonic-note">{{ $t('webhooks.empty') }}</p>

    <div class="token-generator webhook-form">
      <input v-model="form.name" type="text" maxlength="100" :placeholder="$t('webhooks.namePlaceholder')">
      <input v-model="form.url" type="text" maxlength="2048" :placeholder="$t('webhooks.urlPlaceholder')">
      <select v-model="form.format">
        <option value="auto">{{ $t('webhooks.formats.auto') }}</option>
        <option v-for="f in WEBHOOK_FORMATS" :key="f" :value="f">{{ $t(`webhooks.formats.${f}`) }}</option>
      </select>
      <fieldset class="events">
        <legend>{{ $t('webhooks.eventsLabel') }}</legend>
        <label v-for="e in availableEvents" :key="e" class="switch-row">
          <input v-model="form.events" type="checkbox" :value="e">
          {{ $t(`webhooks.events.${e}`) }}
        </label>
      </fieldset>
      <button type="button" filled="hollow" :disabled="creating || !form.name.trim() || !form.url.trim() || form.events.length === 0" @click="create">{{ $t('webhooks.add') }}</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
// list + create + test + delete for webhooks: a user's own (Settings -> Notifications) or the instance's
// global ones (Settings -> Webhooks, MANAGE_WEBHOOKS). Same API shape for both, rooted at a different path.
import {
  GLOBAL_WEBHOOK_EVENTS,
  NOTIFICATION_EVENTS,
  WEBHOOK_FORMATS,
  type NotificationEvent,
  type WebhookSummary
} from '~~/server/entity/Notification';
import { useAuthToken } from '~/composables/useAuthToken';

const props = defineProps<{ scope: "user" | "global" }>();

const { t, locale } = useI18n();
const { token } = useAuthToken();
const base = computed(() => props.scope === "user" ? "/api/v1/user/webhooks" : "/api/v1/webhooks");
const availableEvents = computed<readonly NotificationEvent[]>(() => props.scope === "user" ? NOTIFICATION_EVENTS : GLOBAL_WEBHOOK_EVENTS);

const webhooks = ref<WebhookSummary[]>([]);
const busyId = ref<string | null>(null);
const creating = ref(false);
const form = reactive({
  name: "",
  url: "",
  format: "auto" as string,
  events: [...availableEvents.value] as NotificationEvent[]
});

function headers() {
  return { Authorization: token.value ?? "" };
}

function errorMessage(e: unknown): string {
  return apiErrorMessage(e, t('settings.profile.error'));
}

function toast(content: string, success: boolean = true) {
  useToast().sendToast({ title: t('webhooks.title'), content, tint: success ? "green" : "red", icon: null });
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" });
}

function eventSummary(w: WebhookSummary): string {
  if (!w.events || w.events.length >= availableEvents.value.length) return t('webhooks.allEvents');
  if (w.events.length === 0) return t('webhooks.noEvents');
  return w.events.map((e) => t(`webhooks.events.${e}`)).join(", ");
}

async function load() {
  try {
    webhooks.value = await $fetch<WebhookSummary[]>(base.value, { headers: headers() });
  } catch (e) {
    toast(errorMessage(e), false);
  }
}

async function create() {
  creating.value = true;
  try {
    const allSelected = form.events.length >= availableEvents.value.length;
    const created = await $fetch<WebhookSummary>(base.value, {
      method: "POST",
      headers: headers(),
      body: {
        name: form.name.trim(),
        url: form.url.trim(),
        format: form.format,
        events: allSelected ? null : form.events
      }
    });
    webhooks.value.push(created);
    form.name = "";
    form.url = "";
    form.format = "auto";
    form.events = [...availableEvents.value];
    toast(t('webhooks.added'));
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    creating.value = false;
  }
}

async function setEnabled(w: WebhookSummary, enabled: boolean) {
  busyId.value = w.id;
  try {
    const updated = await $fetch<WebhookSummary>(`${base.value}/${w.id}`, { method: "PATCH", headers: headers(), body: { enabled } });
    webhooks.value = webhooks.value.map((x) => x.id === w.id ? updated : x);
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    busyId.value = null;
  }
}

async function test(w: WebhookSummary) {
  busyId.value = w.id;
  try {
    const result = await $fetch<{ ok: boolean, error: string | null }>(`${base.value}/${w.id}/test`, { method: "POST", headers: headers() });
    toast(result.ok ? t('webhooks.testSent', { name: w.name }) : t('webhooks.testFailed', { error: result.error ?? "" }), result.ok);
    await load();
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    busyId.value = null;
  }
}

async function remove(w: WebhookSummary) {
  busyId.value = w.id;
  try {
    await $fetch(`${base.value}/${w.id}`, { method: "DELETE", headers: headers() });
    webhooks.value = webhooks.value.filter((x) => x.id !== w.id);
  } catch (e) {
    toast(errorMessage(e), false);
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.webhook-list li.off {
  opacity: 0.55;
}

.webhook-list .actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.webhook-list .format {
  font-size: 0.75em;
  color: #666666;
  border: 1px solid #66666680;
  border-radius: 250px;
  padding: 0.05em 0.6em;
  margin-left: 6px;
}

.webhook-list .failure {
  color: #e06666;
}

.webhook-form .events {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid #ffffff1a;
  border-radius: 10px;
  padding: 10px 14px;
  margin: 0;
}

.webhook-form .events legend {
  font-size: 0.7em;
  color: #666666;
  padding: 0 6px;
}

.webhook-form .events label {
  margin-bottom: 0;
  font-size: 0.8em;
  color: inherit;
}
</style>

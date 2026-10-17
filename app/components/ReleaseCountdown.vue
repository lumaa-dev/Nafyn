<template>
  <!-- rendered only once mounted: the remaining time depends on the viewer's clock and timezone, which the
       server can't know, so an SSR'd value would just mismatch on hydration -->
  <span v-if="parts" class="countdown" :class="{ compact }" :title="exactLabel">
    <template v-if="parts.length > 0">{{ text }}</template>
    <template v-else>{{ $t('countdown.outNow') }}</template>
  </span>
</template>

<script lang="ts" setup>
// counts down to local midnight on a MusicBrainz release date. Units run months -> weeks -> days -> hours ->
// minutes -> seconds; leading zero units are dropped ("5 hours, 3 minutes, 12 seconds", never "0 months,
// 0 weeks, 0 days, 5 hours…"), inner ones are kept so the text doesn't reshuffle while it ticks.
const props = withDefaults(defineProps<{
  /** release date as the API returns it (UTC midnight ISO string, or a Date) - only its calendar day is used */
  date: string | Date,
  /** short units ("2mo 1w 3d 4h 5m 6s") for tight spots such as track rows */
  compact?: boolean
}>(), { compact: false });

const emit = defineEmits<{ released: [] }>();

const { t, locale } = useI18n();

type Unit = "months" | "weeks" | "days" | "hours" | "minutes" | "seconds";

// local midnight of the release *day*: the API sends UTC midnight, so the calendar date is read in UTC and
// rebuilt in the viewer's own zone - the same moment the server notifies subscribers at
const target = computed(() => {
  const iso = typeof props.date === "string" ? props.date : props.date.toISOString();
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
});

const now = ref<Date | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  // Jan 31 + 1 month must not spill into March
  if (result.getDate() !== day) result.setDate(0);
  return result;
}

const parts = computed<{ unit: Unit, value: number }[] | null>(() => {
  if (!now.value) return null;
  const end = target.value;
  if (now.value >= end) return [];

  // calendar months first, then fixed-length units for whatever is left
  let months = 0;
  while (addMonths(now.value, months + 1) <= end) months++;
  let rest = Math.floor((end.getTime() - addMonths(now.value, months).getTime()) / 1000);

  const weeks = Math.floor(rest / 604800); rest -= weeks * 604800;
  const days = Math.floor(rest / 86400); rest -= days * 86400;
  const hours = Math.floor(rest / 3600); rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const seconds = rest - minutes * 60;

  const all: { unit: Unit, value: number }[] = [
    { unit: "months", value: months },
    { unit: "weeks", value: weeks },
    { unit: "days", value: days },
    { unit: "hours", value: hours },
    { unit: "minutes", value: minutes },
    { unit: "seconds", value: seconds }
  ];
  const first = all.findIndex((p) => p.value > 0);
  return first === -1 ? [] : all.slice(first);
});

const text = computed(() => {
  const list = parts.value ?? [];
  if (props.compact) return list.map((p) => t(`countdown.short.${p.unit}`, { n: p.value })).join(" ");
  return list.map((p) => t(`countdown.long.${p.unit}`, p.value)).join(", ");
});

const exactLabel = computed(() => target.value.toLocaleString(locale.value, { dateStyle: "full", timeStyle: "short" }));

let announced = false;
watch(parts, (value) => {
  if (value && value.length === 0 && !announced) {
    announced = true;
    emit("released");
  }
});

onMounted(() => {
  now.value = new Date();
  timer = setInterval(() => { now.value = new Date(); }, 1000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.countdown {
  font-variant-numeric: tabular-nums;
}

.countdown.compact {
  font-size: 0.75em;
  color: #666666;
  white-space: nowrap;
}
</style>

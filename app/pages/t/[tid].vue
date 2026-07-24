<template></template>

<script lang="ts" setup>
interface TrackRedirect {
  albumId: string
}

const tid = useRoute().params.tid as string;
const token = useCookie("discyToken").value;

const { data } = await useAsyncData<TrackRedirect>(`track-${tid}`, () => {
  return token
    ? $fetch(`/api/v1/track/${tid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});

if (data.value?.albumId) {
  await navigateTo(`/a/${data.value.albumId}`, { replace: true });
}
</script>

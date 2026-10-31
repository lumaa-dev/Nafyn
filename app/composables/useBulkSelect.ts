// Select mode of a list page (Tracks, Albums, a playlist): the "Select" over button turns rows into checkable
// items, and the actions menu then acts on all of them at once (see useMediaMenu().openBulkMenu).
//
// Local to the page that calls it: leaving the page leaves select mode.
export function useBulkSelect() {
  const selecting = ref(false);
  const selectedIds = ref<string[]>([]);

  const count = computed(() => selectedIds.value.length);

  function isSelected(id: string): boolean {
    return selectedIds.value.includes(id);
  }

  function toggle(id: string) {
    selectedIds.value = isSelected(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id];
  }

  function selectAll(ids: string[]) {
    selectedIds.value = [...ids];
  }

  function clear() {
    selectedIds.value = [];
  }

  function start() {
    selecting.value = true;
  }

  /** leaves select mode and forgets the selection */
  function stop() {
    selecting.value = false;
    clear();
  }

  /** drops ids that are no longer in the list (after a delete) */
  function retain(existing: string[]) {
    const keep = new Set(existing);
    selectedIds.value = selectedIds.value.filter((id) => keep.has(id));
  }

  return { selecting, selectedIds, count, isSelected, toggle, selectAll, clear, start, stop, retain };
}

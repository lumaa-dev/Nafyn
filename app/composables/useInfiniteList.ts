// generic infinite-scroll pager against the `{ items, page, limit, total, hasMore }` shape every
// paginated Nafyn list endpoint returns (server/utils/pagination.ts)
export interface PageResult<T> {
  items: T[],
  page: number,
  limit: number,
  total: number,
  hasMore: boolean
}

export function useInfiniteList<T>(fetchPage: (page: number, limit: number) => Promise<PageResult<T>>, limit: number = 50) {
  const items = ref<T[]>([]) as Ref<T[]>;
  const page = ref(0);
  const hasMore = ref(true);
  const loadingMore = ref(false);
  const initialLoading = ref(true);

  async function loadMore() {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;

    try {
      const result = await fetchPage(page.value + 1, limit);
      items.value.push(...result.items);
      page.value = result.page;
      hasMore.value = result.hasMore;
    } finally {
      loadingMore.value = false;
      initialLoading.value = false;
    }
  }

  // drops loaded items and re-fetches the first page, used after the query itself changes (e.g. a new search term)
  async function reset() {
    items.value = [];
    page.value = 0;
    hasMore.value = true;
    initialLoading.value = true;
    await loadMore();
  }

  const sentinel = ref<HTMLElement | null>(null);
  let observer: IntersectionObserver | null = null;

  function observe(el: HTMLElement | null) {
    if (!observer) return;
    observer.disconnect();
    if (el) observer.observe(el);
  }

  onMounted(() => {
    observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "600px" });
    observe(sentinel.value);
  });

  watch(sentinel, (el) => observe(el));
  onUnmounted(() => observer?.disconnect());

  return { items, page, hasMore, loadingMore, initialLoading, loadMore, reset, sentinel };
}

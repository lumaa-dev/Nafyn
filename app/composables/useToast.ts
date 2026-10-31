const TOAST_DURATION: number = 6000;

export interface ToastState {
  toasts: Toast[];
  lastToast: Toast | null;
}

export interface Toast {
  id: ToastID;
  title: string | null;
  content: string;
  icon: "x" | "checkmark" | "info" | null;
  tint: "red" | "green" | null;
  timeout: NodeJS.Timeout | null;
}

export type ToastID = `${string}-${number}`

/**
 * The text to show for a failed API call: the server's own message when it sent one (routes use either
 * `statusMessage` or `message`), otherwise `fallback`. Never an object, never "[object Object]".
 */
export function apiErrorMessage(e: unknown, fallback?: string): string {
  const err = e as { data?: { statusMessage?: unknown, message?: unknown }, statusMessage?: unknown } | null | undefined;
  for (const candidate of [err?.data?.statusMessage, err?.data?.message, err?.statusMessage]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  // not `$t`: that global exists inside .vue files only, and this runs from plain functions after awaits
  return fallback ?? useNuxtApp().$i18n.t('common.error');
}

export const useToast = () => {
  const state = useState<ToastState>("toasts", () => ({
    toasts: [],
    lastToast: null
  }));

  function sendToast(toast: Omit<Toast, "id" | "timeout">) {
    if (state.value.lastToast?.timeout) {
      clearTimeout(state.value.lastToast.timeout!)
    }

    let newId: ToastID = `${encodeURIComponent(toast.content)}-${new Date().getTime()}`;
    let newTimeout: NodeJS.Timeout = setTimeout(() => {
      removeToast(newToast.id)
    }, TOAST_DURATION);

    let newToast: Toast = { ...toast, id: newId, timeout: newTimeout }

    state.value.lastToast = newToast;
    state.value.toasts.unshift(newToast);
  }

  /**
   * Remove any ongoing toast
   * @param id The Toast ID to remove
   * @returns Removed toast (if found)
   */
  function removeToast(id: ToastID): Toast | void {
    let index: number = state.value.toasts.findLastIndex((t) => t.id == id);
    if (index < 0) return console.error(`[useToast] Toast ${id} is not removable`);

    let removedToast = state.value.toasts.splice(index, 1)[0];
    if (!removedToast) return console.error(`[useToast] Toast ${id} hasn't been removed properly`);

    if (state.value.toasts.length > 0 && index == 0) {
      state.value.lastToast = state.value.toasts[0]!;
      state.value.lastToast.timeout = setTimeout(() => {
        removeToast(state.value.lastToast!.id)
      }, TOAST_DURATION);
    }

    return removedToast!;
  }

  /** Shows a failed API call as a red toast. This is how every page reports an error - see CLAUDE.md. */
  function sendError(title: string | null, e: unknown, fallback?: string) {
    sendToast({ title, content: apiErrorMessage(e, fallback), tint: "red", icon: null });
  }

  return {
    state,
    toastDuration: TOAST_DURATION,
    sendToast,
    sendError,
    removeToast,
    errorToast: (title: string, content: string): Omit<Toast, "id" | "timeout"> => {
      return {
        title,
        content,
        tint: "red",
        icon: null
      }
    },
    successToast: (title: string, content: string): Omit<Toast, "id" | "timeout"> => {
      return {
        title,
        content,
        tint: "green",
        icon: null
      }
    },
    toast: (title: string, content: string): Omit<Toast, "id" | "timeout"> => {
      return {
        title,
        content,
        tint: null,
        icon: null
      }
    }
  }
}

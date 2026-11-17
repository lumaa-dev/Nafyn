<template>
  <!-- the root only ever holds the textarea: @braccato/highlight wraps it in a layer of its own, which Vue must never
       have to insert a sibling next to -->
  <div class="lyrics-field">
    <textarea
      ref="input"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
  </div>
</template>

<script lang="ts" setup>
// The lyrics text field (track edit, manual import): a plain textarea with Braccato's syntax highlighting laid
// under it (@braccato/highlight `attachEditor`) - LRC timestamps recede, the sung words stay bright. The textarea
// keeps the caret, the selection, undo and every input; only the colours come from the layer.
import type { EditorHandle } from '@braccato/highlight';
import '@braccato/highlight/highlight.css';

const props = withDefaults(defineProps<{
  modelValue: string;
  format: 'plain' | 'lrc';
  placeholder?: string;
  rows?: number;
}>(), { placeholder: undefined, rows: 8 });

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const input = ref<HTMLTextAreaElement | null>(null);
let editor: EditorHandle | null = null;

onMounted(async () => {
  // the highlighter measures and paints in the browser; nothing of it runs during SSR
  const { attachEditor } = await import('@braccato/highlight');
  if (!input.value) return;
  editor = attachEditor(input.value, { format: props.format });
});

watch(() => props.format, (format) => editor?.setFormat(format));
// a value written by the form (prefill, reset) fires no `input` event: the layer has to be told
watch(() => props.modelValue, () => editor?.refresh(), { flush: 'post' });

onBeforeUnmount(() => {
  editor?.destroy();
  editor = null;
});
</script>

<style scoped>
/* the same field as the other inputs of the forms it sits in (dark, rounded, a visible focus). The fill and border
   are on the wrapper: the textarea itself has to stay transparent, the highlighted text is drawn under it. */
.lyrics-field {
  width: 100%;
  border-radius: 8px;
  background: #00000040;
  transition: background 0.2s ease-out;
}

.lyrics-field:hover {
  background: #00000055;
}

.lyrics-field :deep(textarea) {
  width: 100%;
  min-height: 120px;
  margin: 0;
  padding: 10px;
  border: 1px solid #666666;
  border-radius: 8px;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  font: inherit;
  font-family: var(--font-discy);
  font-size: 0.8em;
  resize: vertical !important;
}

.lyrics-field :deep(textarea:hover),
.lyrics-field :deep(textarea:focus) {
  background: transparent;
}

.lyrics-field :deep(textarea:focus) {
  border-color: #ffffffae;
}

/* the token colours, raised from @braccato/highlight's defaults (16-70% white) to stay readable on the dark field
   (DESIGN.md "Contrast"); colour only tells the kind of token apart, the text itself says what it is */
.lyrics-field {
  --bh-text: #ffffff;
  --bh-caret: #ffffff;
  --bh-placeholder: #ffffffae;
  --bh-timestamp: #c7d2fe;
  --bh-wordTime: #a5b4fc;
  --bh-agent: #fcd34d;
  --bh-meta: #f9a8d4;
  --bh-tag: #ffffffb3;
  --bh-attr: #ffffffb3;
  --bh-value: #86efac;
  --bh-punct: #ffffffb3;
  --bh-comment: #ffffffb3;
  --bh-bgText: #ffffffd9;
  --bh-bgText-editor: #ffffffd9;
  --bh-selection: #a5b4fc66;
}
</style>

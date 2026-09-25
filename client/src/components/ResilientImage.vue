<template>
  <img
    v-if="resolvedSrc"
    :src="resolvedSrc"
    :alt="alt"
    :width="width"
    :height="height"
    :loading="loading"
    :data-loaded="loaded ? 'true' : 'false'"
    @load="handleLoad"
    @error="handleError"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { diagnoseMediaFailure, mediaAccessKey, reportMediaLoadIssue } from '../utils/media-load-diagnostics';

const props = withDefaults(
  defineProps<{
    src: string | null;
    fallbackSrc?: string | null;
    alt: string;
    width?: number;
    height?: number;
    loading?: 'lazy' | 'eager';
    retryWhile?: boolean;
    maxRetries?: number;
    retryDelayMs?: number;
  }>(),
  {
    src: null,
    fallbackSrc: null,
    loading: 'lazy',
    retryWhile: false,
    maxRetries: 8,
    retryDelayMs: 1500
  }
);

const attempt = ref(0);
const loaded = ref(false);
const hiddenUntilRetry = ref(false);
const usingFallback = ref(false);
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let terminalDerivativeError = false;

const activeSrc = computed(() => {
  if (usingFallback.value && props.fallbackSrc && props.fallbackSrc !== props.src) {
    return props.fallbackSrc;
  }

  return props.src;
});

const resolvedSrc = computed(() => {
  if (!activeSrc.value || hiddenUntilRetry.value) {
    return null;
  }

  if (attempt.value === 0) {
    return activeSrc.value;
  }

  const separator = activeSrc.value.includes('?') ? '&' : '?';
  return `${activeSrc.value}${separator}retry=${attempt.value}`;
});

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function resetState() {
  generation += 1;
  terminalDerivativeError = false;
  clearRetryTimer();
  attempt.value = 0;
  loaded.value = false;
  hiddenUntilRetry.value = false;
  usingFallback.value = false;
}

function scheduleRetry() {
  if (!props.src || retryTimer || terminalDerivativeError) {
    return;
  }

  const canRetry = props.retryWhile || attempt.value < props.maxRetries;
  if (!canRetry) {
    return;
  }

  retryTimer = setTimeout(() => {
    retryTimer = null;
    hiddenUntilRetry.value = false;
    attempt.value += 1;
  }, props.retryDelayMs);
}

function handleLoad() {
  clearRetryTimer();
  loaded.value = true;
}

function handleError() {
  loaded.value = false;
  const source = activeSrc.value;
  const currentGeneration = generation, access = mediaAccessKey();
  void diagnoseMediaFailure(source).then(code => {
    if (!code || generation !== currentGeneration || access !== mediaAccessKey()) return;
    terminalDerivativeError = true;
    clearRetryTimer();
    if (!usingFallback.value) hiddenUntilRetry.value = true;
    reportMediaLoadIssue(source!, code);
  });

  if (!usingFallback.value && props.fallbackSrc && props.fallbackSrc !== props.src) {
    clearRetryTimer();
    attempt.value = 0;
    hiddenUntilRetry.value = false;
    usingFallback.value = true;
    return;
  }

  const canRetry = !terminalDerivativeError && (props.retryWhile || attempt.value < props.maxRetries);
  if (!canRetry) {
    hiddenUntilRetry.value = true;
    return;
  }

  hiddenUntilRetry.value = true;
  scheduleRetry();
}

watch(() => [props.src, props.fallbackSrc] as const, resetState);
watch(
  () => props.retryWhile,
  (retryWhile) => {
    if (retryWhile && hiddenUntilRetry.value) {
      scheduleRetry();
    }
  }
);

onBeforeUnmount(() => { generation += 1; clearRetryTimer(); });
</script>

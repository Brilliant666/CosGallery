<template>
  <section class="w-full">
    <ErrorState
      v-if="placesStore.placeError"
      class="mx-auto w-[min(100%,56rem)]"
      :title="t('placePage.errors.load')"
      :message="placesStore.placeError"
    />
    <template v-else-if="placesStore.currentPlace">
      <div class="mx-auto grid w-full max-w-[66.5rem] gap-5">
        <header class="px-4 sm:px-0">
          <section class="grid grid-cols-[10.75rem_minmax(0,1fr)] items-start gap-x-[2.65rem] pt-[0.6rem] pb-[2.4rem] max-md:grid-cols-[9rem_minmax(0,1fr)] max-md:gap-x-[2rem] max-sm:grid-cols-1 max-sm:gap-y-[1.35rem] max-sm:pb-[1.85rem] max-sm:text-center">
            <div class="grid place-items-center">
              <div class="rounded-full p-[0.22rem] shadow-[0_12px_24px_rgba(99,115,129,0.12)] [background:linear-gradient(135deg,var(--accent-soft),var(--surface-hover))]">
                <div class="grid h-[9.35rem] w-[9.35rem] place-items-center rounded-full border border-border bg-surface text-accent-strong max-md:h-[7.75rem] max-md:w-[7.75rem]">
                  <span class="i-fluent-location-48-filled h-[4.8rem] w-[4.8rem] max-md:h-[4rem] max-md:w-[4rem]" aria-hidden="true" />
                </div>
              </div>
            </div>

            <div class="grid gap-[1rem] pt-[0.35rem]">
              <div class="flex flex-wrap items-center gap-[0.75rem] max-sm:justify-center">
                <h1 class="m-0 min-w-0 break-words text-[2rem] font-medium leading-tight text-text max-sm:text-[1.65rem]">
                  {{ placesStore.currentPlace.name }}
                </h1>
                <span class="inline-flex items-center rounded-lg border border-border bg-surface-hover px-3 py-[0.45rem] text-[0.76rem] font-semibold text-muted">
                  {{ t('placePage.badge') }}
                </span>
              </div>

              <p class="m-0 text-[0.96rem] font-medium text-muted">
                {{ metadataLine }}
              </p>

              <div class="flex flex-wrap items-center gap-x-[1.6rem] gap-y-[0.75rem] text-[0.95rem] leading-none max-sm:justify-center">
                <span><strong class="mr-[0.35rem] font-semibold text-text">{{ formattedPostCount }}</strong>{{ ` ${postCountLabel}` }}</span>
                <span v-if="coordinateLine"><strong class="mr-[0.35rem] font-semibold text-text">{{ coordinateLine }}</strong>{{ ` ${t('placePage.coordinatesLabel')}` }}</span>
                <span><strong class="mr-[0.35rem] font-semibold text-text">{{ placeKindLabel }}</strong>{{ ` ${placeKindDetailLabel}` }}</span>
              </div>

              <div class="grid max-w-[34rem] gap-[0.28rem] max-sm:max-w-none">
                <span class="text-[0.74rem] font-bold text-muted uppercase">{{ t('placePage.sourceLabel') }}</span>
                <p class="m-0 text-[0.95rem] leading-[1.45] text-text">
                  {{ heroNote }}
                </p>
              </div>

              <div v-if="placesStore.currentPlace.isApproximate" class="flex max-sm:justify-center">
                <span class="inline-flex items-center rounded-lg border border-accent bg-accent-soft px-3 py-[0.45rem] text-[0.8rem] font-semibold text-accent-strong">
                  {{ t('placePage.approximateBadge') }}
                </span>
              </div>
            </div>
          </section>
        </header>

        <EmptyState
          v-if="!placesStore.loadingPlace && placesStore.currentImages.length === 0"
          class="mx-auto w-[min(100%,56rem)]"
          :title="t('placePage.emptyTitle')"
          :description="t('placePage.emptyDescription')"
        />
        <template v-else>
          <FolderGrid :items="placesStore.currentImages" variant="square" />
          <div class="px-4 pb-6 sm:px-0">
            <InfiniteLoader
              :loading="placesStore.loadingPlace"
              :has-more="placesStore.currentHasMore"
              @load-more="loadMore"
            />
          </div>
        </template>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
  import { computed, onMounted, watch } from "vue"
  import { useI18n } from "vue-i18n"

  import EmptyState from "../components/EmptyState.vue"
  import ErrorState from "../components/ErrorState.vue"
  import FolderGrid from "../components/FolderGrid.vue"
  import InfiniteLoader from "../components/InfiniteLoader.vue"
  import { usePlacesStore } from "../stores/places"

  const props = defineProps<{
    slug: string
  }>()

  const placesStore = usePlacesStore()
  const { t, locale } = useI18n()

  const metadataLine = computed(() => {
    const place = placesStore.currentPlace
    if (!place) {
      return ""
    }

    return [place.cityName, place.admin1Name, place.countryName ?? place.countryCode]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(", ") || t("placePage.metadataFallback")
  })

  const heroNote = computed(() => {
    const place = placesStore.currentPlace
    if (!place) {
      return ""
    }

    if (place.description) {
      return place.description
    }

    return place.isApproximate
      ? t("placePage.heroApproximate")
      : t("placePage.heroExact")
  })

  const coordinateLine = computed(() => {
    const place = placesStore.currentPlace
    if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
      return ""
    }

    return `${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`
  })

  const formattedPostCount = computed(() =>
    new Intl.NumberFormat(locale.value).format(placesStore.currentPlace?.postCount ?? 0),
  )

  const postCountLabel = computed(() =>
    placesStore.currentPlace?.postCount === 1 ? t("placePage.postCountOne") : t("placePage.postCountOther"),
  )

  const placeKindLabel = computed(() => {
    const place = placesStore.currentPlace
    if (!place) {
      return t("placePage.kind.offline")
    }

    if (place.kind === "manual") {
      return t("placePage.kind.manual")
    }

    if (place.kind === "approximate_spot" || place.isApproximate) {
      return t("placePage.kind.nearestCity")
    }

    return t("placePage.kind.city")
  })

  const placeKindDetailLabel = computed(() =>
    placesStore.currentPlace?.kind === "manual" ? t("placePage.kind.place") : t("placePage.kind.match"),
  )

  async function loadPlace() {
    await placesStore.loadPlace(props.slug, true)
  }

  async function loadMore() {
    if (placesStore.currentHasMore) {
      await placesStore.loadPlace(props.slug, false)
    }
  }

  onMounted(loadPlace)
  watch(
    () => props.slug,
    async () => {
      await loadPlace()
    },
  )
</script>

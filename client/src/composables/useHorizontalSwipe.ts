interface HorizontalSwipeOptions {
  canStart?: (event: PointerEvent) => boolean;
  isEnabled?: () => boolean;
  maxVerticalDistance?: number;
  minDistance?: number;
  minHorizontalRatio?: number;
  onSwipeLeft?: (event: PointerEvent) => void | Promise<void>;
  onSwipeRight?: (event: PointerEvent) => void | Promise<void>;
}

const DEFAULT_MIN_DISTANCE = 56;
const DEFAULT_MAX_VERTICAL_DISTANCE = 96;
const DEFAULT_MIN_HORIZONTAL_RATIO = 1.2;

export function useHorizontalSwipe(options: HorizontalSwipeOptions = {}) {
  let activePointerId: number | null = null;
  let capturedElement: Element | null = null;
  let startX = 0;
  let startY = 0;

  function releasePointerCapture() {
    if (capturedElement && activePointerId !== null && 'releasePointerCapture' in capturedElement) {
      try {
        capturedElement.releasePointerCapture(activePointerId);
      } catch {
        // Ignore failures if the pointer has already been released.
      }
    }

    capturedElement = null;
  }

  function reset() {
    releasePointerCapture();
    activePointerId = null;
    startX = 0;
    startY = 0;
  }

  function onPointerdown(event: PointerEvent) {
    if (!event.isPrimary || event.pointerType === 'mouse') {
      return;
    }

    if (options.isEnabled && !options.isEnabled()) {
      return;
    }

    if (options.canStart && !options.canStart(event)) {
      return;
    }

    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;

    if (event.currentTarget instanceof Element && 'setPointerCapture' in event.currentTarget) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        capturedElement = event.currentTarget;
      } catch {
        capturedElement = null;
      }
    }
  }

  function onPointermove(event: PointerEvent) {
    if (event.pointerId !== activePointerId) {
      return;
    }

    const deltaX = Math.abs(event.clientX - startX);
    const deltaY = Math.abs(event.clientY - startY);

    if (deltaX > 10 && deltaX > deltaY) {
      event.preventDefault();
    }
  }

  async function onPointerup(event: PointerEvent) {
    if (event.pointerId !== activePointerId) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const minDistance = options.minDistance ?? DEFAULT_MIN_DISTANCE;
    const maxVerticalDistance =
      options.maxVerticalDistance ?? DEFAULT_MAX_VERTICAL_DISTANCE;
    const minHorizontalRatio =
      options.minHorizontalRatio ?? DEFAULT_MIN_HORIZONTAL_RATIO;

    reset();

    if (Math.abs(deltaX) < minDistance || Math.abs(deltaY) > maxVerticalDistance) {
      return;
    }

    if (Math.abs(deltaX) <= Math.abs(deltaY) * minHorizontalRatio) {
      return;
    }

    if (deltaX < 0) {
      await options.onSwipeLeft?.(event);
      return;
    }

    await options.onSwipeRight?.(event);
  }

  function onPointercancel() {
    reset();
  }

  return {
    onPointercancel,
    onPointerdown,
    onPointermove,
    onPointerup,
  };
}

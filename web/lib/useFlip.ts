"use client";

// Dependency-free FLIP ("First Last Invert Play") list animation: when the
// order of [data-flip-key] children changes, each moved child glides from its
// old position to the new one instead of jumping. No-op under
// prefers-reduced-motion, on first mount, and for children that didn't move.

import { useEffect, useLayoutEffect, useRef } from "react";

const FLIP_MS = 450;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// SSR-safe layout effect (Next renders client components on the server too).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Attach the returned ref to a container whose children carry stable
 * `data-flip-key` attributes. The animation re-runs whenever `orderKey`
 * changes (e.g. the joined child ids in display order).
 */
export function useFlipGrid<T extends HTMLElement>(orderKey: string) {
  const ref = useRef<T | null>(null);
  const prevRects = useRef(new Map<string, { left: number; top: number }>());

  useIsoLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // First + Last: measure every keyed child, diff against the previous pass.
    const next = new Map<string, { left: number; top: number }>();
    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    container.querySelectorAll<HTMLElement>("[data-flip-key]").forEach((el) => {
      const key = el.dataset.flipKey;
      if (!key) return;
      const rect = el.getBoundingClientRect();
      next.set(key, { left: rect.left, top: rect.top });
      if (reduced) return;
      const prev = prevRects.current.get(key);
      if (!prev) return;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (dx !== 0 || dy !== 0) moved.push({ el, dx, dy });
    });
    prevRects.current = next;
    if (moved.length === 0) return;

    // Invert: snap each moved child back to its previous position…
    for (const { el, dx, dy } of moved) {
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    // …then Play: release to the natural position on the next frame.
    const raf = requestAnimationFrame(() => {
      for (const { el } of moved) {
        el.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASING}`;
        el.style.transform = "";
        el.addEventListener(
          "transitionend",
          () => {
            el.style.transition = "";
          },
          { once: true },
        );
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [orderKey]);

  return ref;
}

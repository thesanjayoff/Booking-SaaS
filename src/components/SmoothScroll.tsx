"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap, ScrollTrigger, initGsap, prefersReducedMotion } from "@/lib/gsap";

let lenis: Lenis | null = null;
export const getLenis = () => lenis;

/**
 * Lenis drives the scroll, GSAP's ticker drives Lenis, ScrollTrigger follows Lenis.
 * Mounted on the public landing page only: the booking flow and the admin panel are
 * task screens with their own scroll areas, so they keep native scrolling.
 */
export default function SmoothScroll() {
  useEffect(() => {
    initGsap();
    // Reduced motion gets plain native scrolling, no interpolation at all.
    if (prefersReducedMotion()) return;

    lenis = new Lenis({ duration: 1.2, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time: number) => lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      lenis?.destroy();
      lenis = null;
    };
  }, []);

  return null;
}

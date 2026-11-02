"use client";

import { useRef, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import { gsap, initGsap, prefersReducedMotion } from "@/lib/gsap";

/**
 * Children rise in one after another the first time the list scrolls into view.
 * Hidden by CSS until ready (with a failsafe), so there is no flash before hydration.
 */
export default function RevealList({
  children,
  as: Tag = "ul",
  className,
  ...rest
}: {
  children: ReactNode;
  as?: "ul" | "div" | "ol";
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  const root = useRef<HTMLElement | null>(null);

  useGSAP(
    () => {
      initGsap();
      const el = root.current;
      if (!el || prefersReducedMotion()) return;
      const items = Array.from(el.children);
      if (!items.length) return;
      gsap.set(items, { y: 28, opacity: 0 });
      el.setAttribute("data-reveal", "ready");
      gsap.to(items, {
        y: 0,
        opacity: 1,
        duration: 0.9,
        stagger: 0.08,
        ease: "power4.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    },
    { scope: root },
  );

  return (
    <Tag ref={root as never} className={className} data-reveal="pending" {...rest}>
      {children}
    </Tag>
  );
}

"use client";

import { useRef, Children, isValidElement, cloneElement, type ReactNode, type ReactElement } from "react";
import { useGSAP } from "@gsap/react";
import { gsap, SplitText, initGsap, prefersReducedMotion } from "@/lib/gsap";

type Props = {
  children: ReactNode;
  /** Reveal when scrolled into view (default) or straight away on mount. */
  animateOnScroll?: boolean;
  delay?: number;
};

/**
 * Line-mask text reveal: SplitText cuts the copy into lines, each line sits in an
 * overflow-hidden mask and slides up. The initial offset is set in CSS (see globals.css)
 * so nothing flashes unmasked before hydration; under reduced motion the CSS neutralises it.
 */
export default function Copy({ children, animateOnScroll = true, delay = 0 }: Props) {
  const container = useRef<HTMLElement | null>(null);
  const splits = useRef<SplitText[]>([]);

  useGSAP(
    () => {
      initGsap();
      const el = container.current;
      if (!el || prefersReducedMotion()) return;

      let cancelled = false;

      const run = async () => {
        // Split after the fonts load, or lines re-flow in the middle of the animation.
        try {
          await document.fonts.ready;
        } catch {
          /* fonts API unavailable: carry on */
        }
        await new Promise((r) => setTimeout(r, 60));
        if (cancelled || !container.current) return;

        splits.current = [];
        const lines: Element[] = [];
        const targets = container.current.hasAttribute("data-copy-wrapper")
          ? Array.from(container.current.children)
          : [container.current];

        targets.forEach((target) => {
          const split = SplitText.create(target as HTMLElement, {
            type: "lines",
            mask: "lines",
            linesClass: "line++",
            lineThreshold: 0.1,
          });
          splits.current.push(split);
          lines.push(...split.lines);
        });

        gsap.set(lines, { y: "100%" });
        container.current.setAttribute("data-copy", "ready");
        const vars: gsap.TweenVars = { y: "0%", duration: 1, stagger: 0.1, ease: "power4.out", delay };
        if (animateOnScroll) {
          gsap.to(lines, { ...vars, scrollTrigger: { trigger: container.current, start: "top 90%", once: true } });
        } else {
          gsap.to(lines, vars);
        }
      };

      void run();

      return () => {
        cancelled = true;
        splits.current.forEach((s) => s.revert());
        splits.current = [];
      };
    },
    { scope: container, dependencies: [animateOnScroll, delay] },
  );

  // Put the ref on a single element child so no extra wrapper is rendered.
  const items = Children.toArray(children);
  if (items.length === 1 && isValidElement(items[0])) {
    return cloneElement(items[0] as ReactElement<Record<string, unknown>>, { ref: container, "data-copy": "pending" });
  }
  return (
    <div ref={container as React.RefObject<HTMLDivElement>} data-copy-wrapper="true" data-copy="pending">
      {children}
    </div>
  );
}

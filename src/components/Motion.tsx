/**
 * Reusable Framer Motion animation wrappers for Fey-style page transitions.
 */
import { motion, type Variants } from 'framer-motion';
import { type ReactNode } from 'react';

// Fey easing curves
const feyEaseOut = [0.25, 0.46, 0.45, 0.94] as const;
// const feyEaseInOut = [0.455, 0.03, 0.515, 0.955] as const;

// ── Fade up (default page/section entrance) ──
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [...feyEaseOut] } },
};

// ── Stagger container ──
const stagger: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.03,
    },
  },
};

// ── Stagger child item ──
const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [...feyEaseOut] } },
};

// ── Scale in (cards, badges) ──
const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: [...feyEaseOut] } },
};

// ── Slide from right (sidebar panels) ──
const slideRight: Variants = {
  hidden: { opacity: 0, x: 20 },
  show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: [...feyEaseOut] } },
};

// ── Page wrapper — stagger children with fade-up ──
export function PageTransition({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ── Section — fade up entrance ──
export function FadeIn({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="show"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ── Stagger child — use inside PageTransition ──
export function StaggerItem({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}

// ── Scale entrance — for cards ──
export function ScaleIn({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      variants={scaleIn}
      initial="hidden"
      animate="show"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ── Slide from right — for sidebar content ──
export function SlideRight({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      variants={slideRight}
      initial="hidden"
      animate="show"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// Re-export motion for direct use
export { motion };

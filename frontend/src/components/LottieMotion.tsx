import { useEffect, useRef } from 'react';
import type { AnimationItem } from 'lottie-web';
import { Icon, type IconName } from './Icon.js';
import './components.css';

export interface LottieMotionProps {
  animationData: unknown;
  label: string;
  loop?: boolean;
  className?: string;
  fallbackIcon: IconName;
}

function shouldLoadLottieRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.navigator.userAgent.toLowerCase().includes('jsdom');
}

export function LottieMotion({
  animationData,
  label,
  loop = true,
  className,
  fallbackIcon,
}: LottieMotionProps): JSX.Element {
  const stageRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    let animation: AnimationItem | null = null;

    const load = async (): Promise<void> => {
      const stage = stageRef.current;
      if (!stage) return;
      if (!shouldLoadLottieRuntime()) return;
      try {
        const lottie = await import('lottie-web/build/player/lottie_light');
        if (cancelled || !stageRef.current) return;
        animation = lottie.default.loadAnimation({
          container: stageRef.current,
          renderer: 'svg',
          loop,
          autoplay: true,
          animationData: animationData as object,
          rendererSettings: {
            preserveAspectRatio: 'xMidYMid meet',
            progressiveLoad: true,
          },
        });
      } catch {
        stage.classList.add('nwa-lottie__stage--failed');
      }
    };

    void load();

    return () => {
      cancelled = true;
      animation?.destroy();
    };
  }, [animationData, loop]);

  const classes = className ? `nwa-lottie ${className}` : 'nwa-lottie';

  return (
    <span className={classes} role="img" aria-label={label} data-lottie-motion={label}>
      <span ref={stageRef} className="nwa-lottie__stage" aria-hidden="true" />
      <span className="nwa-lottie__fallback" aria-hidden="true">
        <Icon name={fallbackIcon} />
      </span>
    </span>
  );
}

export default LottieMotion;

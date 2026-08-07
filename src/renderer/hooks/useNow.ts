import { useEffect, useState } from 'react';

/**
 * A ticking clock for elapsed-time displays.
 *
 * Pass `enabled: false` when nothing on screen is actually live — a 1Hz
 * re-render of the shell while the app sits idle is exactly the kind of
 * background cost this product is supposed to avoid.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);

  return now;
}

export default useNow;

/**
 * requestIdleCallback / cancelIdleCallback with a setTimeout fallback for
 * browsers that don't support it (Safari < 16).
 */
export const scheduleIdle: typeof requestIdleCallback =
  typeof requestIdleCallback !== 'undefined'
    ? requestIdleCallback.bind(window)
    : (cb) => setTimeout(cb, 0) as unknown as number;

export const cancelIdle: typeof cancelIdleCallback =
  typeof cancelIdleCallback !== 'undefined'
    ? cancelIdleCallback.bind(window)
    : clearTimeout;

// A short log of one-off work that can cost a frame (a texture swapped in, a canvas printed), so
// the performance test can say what happened just before a slow frame.

export const workLog: { t: number; what: string }[] = [];

export function logWork(what: string) {
  workLog.push({ t: performance.now(), what });
  if (workLog.length > 200) workLog.shift();
}

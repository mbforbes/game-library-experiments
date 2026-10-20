// A texture swapped in (a close-up cover arriving, a scan) is uploaded and gets its mip chain built
// when it's next drawn: a dozen arriving together cost one frame a hundred small GPU passes (40+ ms
// on an iPhone). They take turns instead, one a frame. Each swap checks when its turn comes that
// what it's for is still there.

const queue: (() => void)[] = [];

export function swapSoon(fn: () => void) {
  queue.push(fn);
}

/** The frame loop, before it draws: the next swap in line. */
export function nextSwap() {
  queue.shift()?.();
}

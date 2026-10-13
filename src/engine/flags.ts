// Debug/ablation flags from the URL: ?no=overlays,upgrade,reflect,hover,audio,dust,post
// Used to isolate performance problems by switching pieces off.
const params = new URLSearchParams(location.search);
export const NO = new Set((params.get("no") ?? "").split(",").filter(Boolean));
export const off = (what: string) => NO.has(what);

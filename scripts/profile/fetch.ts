// bun scripts/profile/fetch.ts [--local] [--last=N] [--raw]
// Lists performance-test results uploaded by the profiler (/profile) and prints a summary of each:
// device + GPU, load timings, and every measured step (fps, frame-time percentiles, CPU/GPU ms).
// Remote (default) reads Cloudflare KV with the deploy token in .env.cloudflare-deploy; --local
// reads the dev server's local KV. Full JSON is saved to .cache/profiles/.

import { $ } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const NS = "cf686d99bbbb491b9221b45b50155f00";
const local = process.argv.includes("--local");
const raw = process.argv.includes("--raw");
const last = +(process.argv.find((a) => a.startsWith("--last="))?.split("=")[1] ?? 5);
mkdirSync(".cache/profiles", { recursive: true });

function env() {
  const e: Record<string, string> = {};
  for (const l of readFileSync(".env.cloudflare-deploy", "utf8").split("\n")) {
    const m = l.match(/^(\w+)=(.*)$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
}

async function listKeys(): Promise<string[]> {
  if (local) {
    const out = await $`bunx wrangler kv key list --local --binding STORE --prefix profile:`.quiet().text();
    return (JSON.parse(out) as { name: string }[]).map((k) => k.name);
  }
  const { CLOUDFLARE_ACCOUNT_ID: a, CLOUDFLARE_API_TOKEN: t } = env();
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${a}/storage/kv/namespaces/${NS}/keys?prefix=profile:&limit=1000`, { headers: { authorization: `Bearer ${t}` } });
  return ((await r.json()) as { result: { name: string }[] }).result.map((k) => k.name);
}

async function get(key: string): Promise<any> {
  const file = `.cache/profiles/${key.replace(/[^\w.-]/g, "_")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  let text: string;
  if (local) text = await $`bunx wrangler kv key get --local --binding STORE ${key}`.quiet().text();
  else {
    const { CLOUDFLARE_ACCOUNT_ID: a, CLOUDFLARE_API_TOKEN: t } = env();
    text = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${a}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${t}` } })).text();
  }
  writeFileSync(file, text);
  return JSON.parse(text);
}

const keys = (await listKeys()).sort().slice(-last);
for (const k of keys) {
  const p = await get(k);
  if (raw) {
    console.log(JSON.stringify(p, null, 1));
    continue;
  }
  const d = p.device ?? {};
  const g = d.gpu ?? {};
  if (p.kind === "loadtest") {
    const lt = Object.entries(p.levelTimes ?? {}).map(([id, v]: [string, any]) => `${id} ${v.built}+${v.compiled}ms${v.background ? "(bg)" : ""}`).join(" · ");
    console.log(`\n=== ${k}  LOAD TEST cold=${p.tag || "-"} visit ${p.visit} · ${d.os}/${d.browser} ${d.mobile ? "phone" : "desktop"} · ${g.description || g.renderer || ""} · ready ${Math.round(p.ready ?? 0)}ms · ${lt} · ${p.pipelines} pipelines${p.bgOff ? " · bg OFF" : ""}`);
    continue;
  }
  if (p.kind === "diag") {
    console.log(`\n=== ${k}  DIAG${p.partial ? " (partial)" : ""}${p.stalls?.length ? ` · ${p.stalls.length} stall(s)` : ""} · ${d.os}/${d.browser} ${d.mobile ? "phone" : "desktop"} · screen ${d.screen} @${d.native}x · ${p.backend} msaa ${p.msaa} · ${p.ua?.match(/Version\/[\d.]+|Chrome\/[\d.]+/)?.[0] ?? ""}`);
    if (p.levelTimes) console.log(`ready ${Math.round(p.ready ?? 0)} ms · ${Object.entries(p.levelTimes).map(([id, v]: [string, any]) => `${id} built ${v.built} + compiled ${v.compiled} ms`).join(" · ")}`);
    console.log("ms per frame at dpr 1 unless noted: flat out (js = our code + WebGPU calls) / at display pace, submit to GPU done");
    for (const [room, row] of Object.entries(p.results ?? {}) as [string, Record<string, { ms: number; js: number; paced?: number }>][]) {
      console.log(`  ${room}`);
      for (const [n, v] of Object.entries(row) as [string, any][]) if (v.stall) console.log(`    ${n.padEnd(10)} STALL: ${v.stall}`); else console.log(`    ${n.padEnd(10)} ${String(v.ms).padStart(6)} (js ${v.js}${v.gpu !== undefined ? `, gpu ${v.gpu}` : ""})${v.paced !== undefined ? `  paced ${v.paced}${v.gpuPaced !== undefined ? ` (gpu ${v.gpuPaced})` : ""}` : ""}`);
    }
    continue;
  }
  console.log(`\n=== ${k}`);
  console.log(`${d.os}/${d.browser} ${d.mobile ? "phone" : "desktop"} · ${p.viewport} @${d.native}x · ${d.cores ?? "?"} cores · ${d.memory ?? "?"} GB`);
  console.log(`GPU ${g.api}: ${g.vendor ?? ""} ${g.architecture ?? ""} ${g.description ?? ""} | ${g.renderer ?? ""}${d.integrated ? " (integrated)" : ""}`);
  if (p.device3) console.log(`three's device: ${JSON.stringify(p.device3.adapterInfo)} · timestamps ${p.device3.timestamps} · ${p.device3.features?.length ?? 0} features`);
  console.log(`backend ${p.backend} · msaa ${p.msaa} · refresh ${p.refreshMs}ms (every ${p.every}) · programs ${JSON.stringify(p.programs)} pipelines ${p.pipelines}`);
  console.log(`boot ${JSON.stringify(p.boot)} ready ${Math.round(p.ready ?? 0)}ms · levels ${JSON.stringify(p.levelTimes)} · switches ${JSON.stringify(p.switches)}`);
  console.log(`start ${JSON.stringify(p.startSettings)}`);
  console.log(`background prebuilding ${p.bgOff ? "switched OFF on this device (it cost frames)" : "on"}`);
  console.log("room    step                       fps   p50   p90   p99   max  >20ms  cpu   gpu   calls  tris   +pipes  bg");
  for (const s of p.segments ?? []) {
    console.log(
      `${s.room.padEnd(7)} ${s.name.padEnd(25)} ${String(s.fps).padStart(5)} ${String(s.p50).padStart(5)} ${String(s.p90).padStart(5)} ${String(s.p99).padStart(5)} ${String(s.max).padStart(5)} ${(Math.round(s.slow20 * 100) + "%").padStart(5)} ${String(s.cpuAvg).padStart(5)} ${String(s.gpuAvg).padStart(5)} ${String(s.drawCalls).padStart(6)} ${String(Math.round(s.triangles / 1000) + "k").padStart(6)} ${String(s.pipelinesAdded).padStart(4)} ${String(s.bg ?? "").padStart(5)}`,
    );
  }
  for (const s of p.segments ?? [])
    if (s.name === "browse" || s.hitches?.length)
      console.log(
        `${s.room} ${s.name}${s.name === "browse" ? ` (${(s.frames / Math.max(1, s.fps)).toFixed(1)} s, ${s.hovered} games under the pointer, ${s.opened} opened)` : ""}: ` +
          (s.hitches?.length ? "slow frames " + s.hitches.map((h: any) => `${h.at}s ${h.ms}ms (${h.doing})`).join(" | ") : "no slow frames"),
      );
  if (p.governorLog?.length) console.log("governor:", p.governorLog.map((l: any) => `${l.change} (${l.reason})`).join(" | "));
  if (p.errors?.length) console.log("errors:", p.errors.join(" | "));
}

// HUD: title + level picker, search, filters, stations, inspect panel, toasts, loading + debug.
// Plain DOM; styled in hud.css. Works as a bottom sheet on phones and a side panel on desktop.

import type { Game } from "../../shared/types";
import { platformOf } from "../../shared/platforms";
import { GRADE_COLORS } from "../media/spines";
import { FILTERS, newGames, type Filter, type LibraryStore } from "../library/store";
import type { ArtStore } from "../library/art";
import type { Station } from "../levels/types";
import type { Track } from "../levels";
import { loadForecasts, type Forecasts } from "../library/forecasts";
import { Voice } from "./voice";
import "./hud.css";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface HudCallbacks {
  onSearchPick(g: Game): void;
  onFilter(f: Filter): void;
  onLevel(id: string): void;
  onClose(): void;
  onFlip(): void;
  onSpine(): void;
  onPrev(): void;
  onNext(): void;
  onSound(): void;
  soundOn(): boolean;
  /** the sound menu: "shuffle", or a track's url, for the room you're in */
  onMusic(choice: string): void;
  onUi(kind: "tick" | "travel"): void;
}

export class Hud {
  root = h("div", "hud");
  private loading = h("div", "loading");
  private loadingMsg = h("div", "loading-msg");
  private toastEl = h("div", "toast");
  /** the sound button's menu (sound on/off, this room's tracks) and the now-playing credit */
  private soundMenu = h("div", "sound-menu");
  private npChip = h("div", "np-chip");
  private npTimer = 0;
  private paintSound = () => {};
  /** the Archivist's voice: in the open game's panel (beside its facts), else at the top */
  private panelVoice = new Voice();
  private topVoice = new Voice("v-top");
  private topVoiceTimer = 0;
  private stationsEl = h("div", "stations");
  private panel = h("aside", "panel");
  private searchBox = h("div", "search");
  private filterBox = h("div", "filters");
  private levelMenu = h("div", "level-menu");
  private levelName = h("span", "level-name");
  private debugEl = h("div", "debug");
  private tip = h("div", "tip");
  private switcher = h("div", "switcher");
  private help = h("div", "help");
  private toastTimer = 0;

  art!: ArtStore;
  private forecasts: Forecasts | null = null;

  constructor(private store: LibraryStore, private cb: HudCallbacks, levels: { id: string; name: string; tagline: string }[]) {
    document.body.appendChild(this.root);
    loadForecasts().then((f) => (this.forecasts = f));

    // loading
    this.loading.innerHTML = `<div class="loading-title">THE<br>BACKLOG</div><div class="loading-bar"><i></i></div>`;
    this.loading.appendChild(this.loadingMsg);
    this.root.appendChild(this.loading);

    // top bar
    const top = h("header", "topbar");
    const brand = h("button", "brand");
    brand.innerHTML = `<span class="logo">THE BACKLOG</span>`;
    brand.appendChild(this.levelName);
    brand.onclick = () => this.levelMenu.classList.toggle("open");
    const actions = h("div", "actions");
    const searchBtn = h("button", "icon-btn", `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>`);
    searchBtn.setAttribute("aria-label", "Search");
    searchBtn.onclick = () => {
      cb.onUi("tick");
      this.toggleSearch();
    };
    const filterBtn = h("button", "icon-btn", `<svg viewBox="0 0 24 24"><path d="M3 5h18M6 12h12M10 19h4"/></svg>`);
    filterBtn.setAttribute("aria-label", "Filter");
    filterBtn.onclick = () => {
      cb.onUi("tick");
      this.filterBox.classList.toggle("open");
    };
    const soundBtn = h("button", "icon-btn sound");
    const paintSound = (this.paintSound = () => {
      const on = cb.soundOn();
      soundBtn.innerHTML = on
        ? `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#fff" stroke="none"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#fff" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>`;
      soundBtn.setAttribute("aria-label", "Sound and music");
      const sw = this.soundMenu.querySelector(".sm-sound") as HTMLInputElement | null;
      if (sw) sw.checked = on;
    });
    paintSound();
    soundBtn.onclick = () => {
      this.soundMenu.classList.toggle("open");
      cb.onUi("tick");
    };
    // (a tap anywhere else closes it)
    addEventListener("pointerdown", (e) => {
      if (this.soundMenu.classList.contains("open") && !this.soundMenu.contains(e.target as Node) && !soundBtn.contains(e.target as Node)) this.soundMenu.classList.remove("open");
    });
    actions.append(soundBtn, searchBtn, filterBtn);
    top.append(brand, actions);
    this.root.appendChild(top);

    // level menu
    for (const l of levels) {
      const b = h("button", "level-item", `<b>${esc(l.name)}</b><span>${esc(l.tagline)}</span>`);
      b.onclick = () => {
        this.levelMenu.classList.remove("open");
        cb.onLevel(l.id);
      };
      this.levelMenu.appendChild(b);
    }
    this.root.appendChild(this.levelMenu);

    // search
    this.searchBox.innerHTML = `<input type="search" placeholder="Search ${store.games.length || ""} games…" autocomplete="off" spellcheck="false"><div class="results"></div>`;
    const input = this.searchBox.querySelector("input")!;
    const results = this.searchBox.querySelector(".results")!;
    input.addEventListener("input", () => {
      const list = store.search(input.value);
      results.innerHTML = "";
      for (const g of list) {
        const p = platformOf(g.platform);
        const row = h("button", "result", `<span class="r-title">${esc(g.title)}</span><span class="r-meta" style="--c:${p.neon}">${esc(p.short)} · ${statusLabel(g)}</span>`);
        row.onclick = () => {
          this.toggleSearch(false);
          cb.onSearchPick(g);
        };
        results.appendChild(row);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (results.querySelector(".result") as HTMLButtonElement | null)?.click();
      if (e.key === "Escape") this.toggleSearch(false);
    });
    this.root.appendChild(this.searchBox);

    // filters
    for (const f of FILTERS) {
      const b = h("button", "chip", f.label);
      b.dataset.f = f.id;
      b.onclick = () => {
        cb.onUi("tick");
        cb.onFilter(f.id);
        this.syncFilters();
      };
      if (f.id === "new") b.style.display = "none";
      this.filterBox.appendChild(b);
    }
    this.root.appendChild(this.filterBox);

    // level-switch loader (over the CRT-off black)
    this.switcher.innerHTML = `<div class="sw-name"></div><div class="loading-bar"><i></i></div>`;

    // tiny controls card: open on the first visit, then a "?" chip
    const touch = matchMedia("(pointer: coarse)").matches;
    const rows: [string, string][] = touch
      ? [["swipe", "move along"], ["pinch", "zoom"], ["tap", "pull out a game"], ["drag game", "turn it over"]]
      : [["scroll", "move along"], ["drag", "pan"], ["ctrl + scroll", "zoom"], ["click", "pull out a game"], ["← → / esc", "browse / put back"]];
    this.help.innerHTML = `<button class="help-chip" aria-label="Controls">?</button><div class="help-card">${rows.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join("")}<label class="toggle"><input type="checkbox" class="fps-toggle"> FPS meter</label><p class="credits"></p></div>`;
    const chip = this.help.querySelector(".help-chip") as HTMLButtonElement;
    chip.onclick = () => {
      cb.onUi("tick");
      this.help.classList.toggle("open");
    };
    let seen = false;
    try {
      seen = localStorage.getItem("the-backlog-help") === "1";
      localStorage.setItem("the-backlog-help", "1");
    } catch {}
    if (!seen) {
      this.help.classList.add("open");
      setTimeout(() => this.help.classList.remove("open"), 9000);
    }

    // stations + panel + toast + debug
    this.root.append(this.stationsEl, this.panel, this.toastEl, this.topVoice.el, this.soundMenu, this.npChip, this.debugEl, this.tip, this.switcher, this.help);
    this.topVoice.onDone = () => {
      clearTimeout(this.topVoiceTimer);
      this.topVoiceTimer = window.setTimeout(() => this.topVoice.el.classList.remove("show"), 3200);
    };
    this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.syncFilters();
  }

  setProgress(msg: string, frac?: number) {
    this.loadingMsg.textContent = msg;
    if (frac !== undefined) (this.loading.querySelector(".loading-bar i") as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  }

  hideLoading() {
    this.loading.classList.add("done");
    setTimeout(() => this.loading.remove(), 900);
  }

  /** The vault's password prompt; resolves true once `check` accepts a password, false if cancelled. */
  askVaultPassword(check: (pw: string) => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      const el = h("div", "vault-ask");
      el.innerHTML = `<form class="va-card"><div class="va-title">THE VAULT</div><input type="password" autocomplete="off" spellcheck="false" aria-label="Combination" placeholder="Combination"><div class="va-msg"></div><div class="va-actions"><button type="button" class="va-cancel">Cancel</button><button type="submit" class="va-go">Unlock</button></div></form>`;
      document.body.appendChild(el);
      const form = el.querySelector("form") as HTMLFormElement;
      const input = el.querySelector("input") as HTMLInputElement;
      const msg = el.querySelector(".va-msg") as HTMLElement;
      setTimeout(() => input.focus(), 50);
      const close = (v: boolean) => {
        el.remove();
        resolve(v);
      };
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      (el.querySelector(".va-cancel") as HTMLButtonElement).onclick = () => close(false);
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        msg.textContent = "…";
        let ok = false;
        try {
          ok = await check(input.value);
        } catch {}
        if (ok) return close(true);
        msg.textContent = "That's not it.";
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.select();
      };
    });
  }

  /** Show the "New" filter chip only when there are new games (with their count). */
  setNewCount(n: number) {
    const chip = this.filterBox.querySelector('[data-f="new"]') as HTMLElement | null;
    if (!chip) return;
    chip.style.display = n ? "" : "none";
    chip.textContent = `New · ${n}`;
  }

  /** Wire the FPS meter's on/off checkbox in the controls card. */
  bindFps(get: () => boolean, set: (on: boolean) => void) {
    const box = this.help.querySelector(".fps-toggle") as HTMLInputElement;
    box.checked = get();
    box.onchange = () => {
      set(box.checked);
      this.cb.onUi("tick");
    };
  }

  /** Music credit (Creative Commons / OverClocked ReMix attribution) in the controls card. */
  setCredits(t: Track | null) {
    const el = this.help.querySelector(".credits") as HTMLElement;
    el.innerHTML = t ? `♪ ${creditHtml(t)}` : "";
  }

  /** The sound menu for this room: on/off, shuffle or a chosen track, and the current credit. */
  setMusic(room: string, tracks: Track[], current: Track | null, choice: string) {
    const open = this.soundMenu.classList.contains("open");
    const row = (c: string, label: string, sub: string, on: boolean) => `<button class="sm-track${on ? " on" : ""}" data-c="${esc(c)}"><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</button>`;
    this.soundMenu.innerHTML =
      `<label class="sm-row"><span>Sound</span><input type="checkbox" class="sm-sound"></label>` +
      (tracks.length
        ? `<div class="sm-head">Music · ${esc(room)}</div>` +
          (tracks.length > 1 ? row("shuffle", "Shuffle", "a different one each visit", choice === "shuffle" || !tracks.some((t) => t.url === choice)) : "") +
          tracks.map((t) => row(t.url, t.title, [t.game, t.artist].filter(Boolean).join(" · "), choice === t.url)).join("") +
          (current ? `<p class="sm-credit">Playing: ${creditHtml(current)}</p>` : "")
        : "");
    const sw = this.soundMenu.querySelector(".sm-sound") as HTMLInputElement;
    sw.checked = this.cb.soundOn();
    sw.onchange = () => {
      this.cb.onSound();
      this.paintSound();
    };
    this.soundMenu.querySelectorAll<HTMLButtonElement>(".sm-track").forEach((b) => {
      b.onclick = () => {
        this.cb.onMusic(b.dataset.c!);
        this.cb.onUi("tick");
      };
    });
    this.soundMenu.classList.toggle("open", open);
  }

  /** A track started: its credit, briefly, by the sound button. */
  nowPlaying(t: Track) {
    this.npChip.innerHTML = `♪ ${creditHtml(t)}`;
    this.npChip.classList.add("show");
    clearTimeout(this.npTimer);
    this.npTimer = window.setTimeout(() => this.npChip.classList.remove("show"), 6000);
  }

  /** Level switch loader: name + bar while a world builds / compiles; null hides it. */
  switching(name: string | null, frac = 0) {
    this.switcher.classList.toggle("show", name !== null);
    if (name === null) return;
    (this.switcher.querySelector(".sw-name") as HTMLElement).textContent = name;
    (this.switcher.querySelector(".loading-bar i") as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  }

  showError(msg: string) {
    this.loadingMsg.innerHTML = `<span class="err">${esc(msg)}</span>`;
  }

  setLevel(name: string, accent: string, stations: Station[]) {
    this.levelName.textContent = name;
    document.documentElement.style.setProperty("--accent", accent);
    this.stationsEl.innerHTML = "";
    for (const s of stations) {
      const b = h("button", "station", esc(s.label));
      b.onclick = () => {
        this.stationsEl.querySelectorAll(".station").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        this.cb.onUi("travel");
        s.go();
      };
      this.stationsEl.appendChild(b);
    }
  }

  private toggleSearch(force?: boolean) {
    const open = this.searchBox.classList.toggle("open", force);
    const input = this.searchBox.querySelector("input")!;
    if (open) setTimeout(() => input.focus(), 50);
    else input.blur();
  }

  private syncFilters() {
    this.filterBox.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => b.classList.toggle("on", b.dataset.f === this.store.filter));
  }

  /**
   * The Archivist says something. With a game open it speaks in the game's panel (so it never
   * covers the game); otherwise in a bubble at the top. A new line replaces the last.
   */
  say(text: string) {
    const slot = this.panel.classList.contains("open") ? this.panel.querySelector(".facts") : null;
    if (slot) {
      slot.classList.add("has-voice");
      this.panelVoice.speak(text);
      return;
    }
    clearTimeout(this.topVoiceTimer);
    this.topVoice.el.classList.add("show");
    this.topVoice.speak(text);
  }

  toast(text: string, ms = 3200) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), ms);
  }

  get isSide() {
    return window.innerWidth > 820 && window.innerWidth > window.innerHeight;
  }

  /** the world on screen can add lines to a game's info panel (the vault: what it's worth) */
  factsHook?: (g: Game) => [string, string][];

  showGame(g: Game | null) {
    if (!g) {
      this.panel.classList.remove("open");
      return;
    }
    const p = platformOf(g.platform);
    const year = this.art.year(g);
    const facts: [string, string][] = [...(this.factsHook?.(g) ?? [])];
    if (g.developer) facts.push(["Developer", g.developer]);
    const e = this.art.entry(g);
    if (e?.pub && e.pub !== g.developer) facts.push(["Publisher", e.pub]);
    if (e?.r) facts.push(["Rated", ESRB_NAMES[e.r] ?? e.r]);
    if (e?.pl && e.pl > 1) facts.push(["Players", `1–${e.pl}`]);
    if (g.edition) facts.push(["Edition", g.edition]);
    if (year) facts.push(["Released", g.released ? fmt(g.released) : String(year)]);
    if (g.genre) facts.push(["Genre", g.genre]);
    if (g.status === "completed") {
      if (g.completedOn) facts.push(["Beaten", fmt(g.completedOn)]);
      facts.push(["Copy", g.ownPhysical ? `Physical${g.value ? ` · $${g.value}` : ""}` : "Digital / none"]);
    } else if (g.status === "wishlist") {
      if (g.looseValue) facts.push(["Loose", `$${g.looseValue}`]);
      if (g.cibValue) facts.push(["Complete in box", `$${g.cibValue}`]);
      if (g.rarity) facts.push(["Rarity", String(g.rarity)]);
      if (g.score !== undefined) facts.push(["Holistic score", String(g.score)]);
    } else {
      if (g.priority) facts.push(["Priority", `P${g.priority}`]);
    }
    if (g.hours) facts.push(["Length", `~${g.hours} hours`]);
    const grade = g.grade ? `<span class="grade" style="--g:${GRADE_COLORS[g.grade]}">${g.grade}</span>` : "";
    // the forecast for games not played yet; Cooper vs the crowd for notable disagreements
    const fc = g.status === "backlog" || g.status === "playing" ? this.forecasts?.forecasts[g.id] : undefined;
    const dis = g.status === "completed" ? this.forecasts?.context.disagreements.find((d) => d.id === g.id) : undefined;
    const extra = fc
      ? `<div class="forecast"><div class="r-label">Forecast</div><p><span class="grade" style="--g:${GRADE_COLORS[fc.grade] ?? "#999"}">${fc.grade}</span> ${esc(fc.why)} <span class="conf">· ${Math.round(fc.confidence * 100)}% sure</span></p></div>`
      : dis
        ? `<div class="forecast"><div class="r-label">vs the crowd</div><p>Crowd ★${dis.community.toFixed(1)}/5 · ${esc(dis.note)}</p></div>`
        : "";
    this.panel.innerHTML = `
      <div class="grab"></div>
      <div class="p-head">
        <div class="p-plat" style="--c:${p.neon}">${esc(p.name)}</div>
        <h2>${esc(g.title)}</h2>
        <div class="p-status s-${g.status}">${statusLabel(g)} ${grade}${newGames.since.has(g.id) ? `<span class="new-badge">NEW · added ${fmt(newGames.since.get(g.id)!.slice(0, 10))}</span>` : ""}</div>
      </div>
      <div class="facts"><dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>
      ${extra}
      ${g.review ? `<div class="review"><div class="r-label">Cooper's review</div><p>${esc(g.review)}</p></div>` : ""}
      <div class="p-actions">
        <button data-a="prev" aria-label="Previous">‹</button>
        <button data-a="flip">Flip</button>
        <button data-a="spine">Spine</button>
        <button data-a="next" aria-label="Next">›</button>
        <button data-a="close" class="close" aria-label="Close">✕</button>
      </div>`;
    // (a new game: the Archivist starts over, if it has something to say about this one)
    this.panelVoice.clear();
    this.panel.querySelector(".facts")!.appendChild(this.panelVoice.el);
    this.panel.querySelectorAll<HTMLButtonElement>("button[data-a]").forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === "close") this.cb.onClose();
        if (a === "flip") this.cb.onFlip();
        if (a === "spine") this.cb.onSpine();
        if (a === "prev") this.cb.onPrev();
        if (a === "next") this.cb.onNext();
        if (a === "spine" || a === "close") this.cb.onUi("tick");
      };
    });
    this.panel.classList.add("open");
    this.panel.scrollTop = 0;
    // (phones: the first-visit controls card would sit on top of the panel)
    if (!this.isSide) this.help.classList.remove("open");
  }

  /** Desktop hover tooltip */
  tooltip(g: Game | null, x: number, y: number) {
    if (!g) {
      this.tip.classList.remove("show");
      return;
    }
    const p = platformOf(g.platform);
    this.tip.innerHTML = `<b>${esc(g.title)}</b><span style="--c:${p.neon}">${esc(p.short)} · ${statusLabel(g)}${g.grade ? " · " + g.grade : ""}</span>`;
    this.tip.style.transform = `translate(${Math.min(x + 16, window.innerWidth - 260)}px, ${y + 18}px)`;
    this.tip.classList.add("show");
  }

  debug(text: string | null) {
    this.debugEl.style.display = text ? "block" : "none";
    if (text) this.debugEl.textContent = text;
  }
}

const ESRB_NAMES: Record<string, string> = { EC: "EC · Early Childhood", E: "E · Everyone", "E10+": "E10+ · Everyone 10+", T: "T · Teen", M: "M · Mature 17+", AO: "AO · Adults Only", RP: "Rating Pending", "K-A": "K-A · Kids to Adults" };

export function statusLabel(g: Game): string {
  switch (g.status) {
    case "completed":
      return "Beaten";
    case "playing":
      return "Now playing";
    case "wishlist":
      return "Wishlist";
    default:
      return "Backlog";
  }
}

function fmt(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${d}, ${y}`;
}

/** “Title” (Game) by Artist, Licence[, via Source]: the attribution each track's licence asks for. */
function creditHtml(t: Track) {
  const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;
  return `“${esc(t.title)}”${t.game ? ` (${esc(t.game)})` : ""} by ${a(t.link, t.artist)}, ${a(t.licenseUrl, t.license)}${t.via ? `, via ${a(t.via.url, t.via.name)}` : ""}`;
}

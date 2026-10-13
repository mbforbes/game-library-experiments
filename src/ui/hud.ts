// HUD: title + level picker, search, filters, stations, inspect panel, toasts, loading + debug.
// Plain DOM; styled in hud.css. Works as a bottom sheet on phones and a side panel on desktop.

import type { Game } from "../../shared/types";
import { platformOf } from "../../shared/platforms";
import { GRADE_COLORS } from "../media/spines";
import { FILTERS, type Filter, type LibraryStore } from "../library/store";
import type { ArtStore } from "../library/art";
import type { Station } from "../levels/types";
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
  onUi(kind: "tick" | "travel"): void;
}

export class Hud {
  root = h("div", "hud");
  private loading = h("div", "loading");
  private loadingMsg = h("div", "loading-msg");
  private toastEl = h("div", "toast");
  private stationsEl = h("div", "stations");
  private panel = h("aside", "panel");
  private searchBox = h("div", "search");
  private filterBox = h("div", "filters");
  private levelMenu = h("div", "level-menu");
  private levelName = h("span", "level-name");
  private debugEl = h("div", "debug");
  private tip = h("div", "tip");
  private toastTimer = 0;

  art!: ArtStore;

  constructor(private store: LibraryStore, private cb: HudCallbacks, levels: { id: string; name: string; tagline: string }[]) {
    document.body.appendChild(this.root);

    // loading
    this.loading.innerHTML = `<div class="loading-title">COOPER'S<br>LIBRARY</div><div class="loading-bar"><i></i></div>`;
    this.loading.appendChild(this.loadingMsg);
    this.root.appendChild(this.loading);

    // top bar
    const top = h("header", "topbar");
    const brand = h("button", "brand");
    brand.innerHTML = `<span class="logo">COOPER'S LIBRARY</span>`;
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
    const paintSound = () => {
      const on = cb.soundOn();
      soundBtn.innerHTML = on
        ? `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#fff" stroke="none"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#fff" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>`;
      soundBtn.setAttribute("aria-label", on ? "Mute sound" : "Unmute sound");
    };
    paintSound();
    soundBtn.onclick = () => {
      cb.onSound();
      paintSound();
      cb.onUi("tick");
    };
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
      this.filterBox.appendChild(b);
    }
    this.root.appendChild(this.filterBox);

    // stations + panel + toast + debug
    this.root.append(this.stationsEl, this.panel, this.toastEl, this.debugEl, this.tip);
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

  toast(text: string, ms = 3200) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), ms);
  }

  get isSide() {
    return window.innerWidth > 820 && window.innerWidth > window.innerHeight;
  }

  showGame(g: Game | null) {
    if (!g) {
      this.panel.classList.remove("open");
      return;
    }
    const p = platformOf(g.platform);
    const year = this.art.year(g);
    const facts: [string, string][] = [];
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
    this.panel.innerHTML = `
      <div class="grab"></div>
      <div class="p-head">
        <div class="p-plat" style="--c:${p.neon}">${esc(p.name)}</div>
        <h2>${esc(g.title)}</h2>
        <div class="p-status s-${g.status}">${statusLabel(g)} ${grade}</div>
      </div>
      <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${g.review ? `<div class="review"><div class="r-label">Cooper's review</div><p>${esc(g.review)}</p></div>` : ""}
      <div class="p-actions">
        <button data-a="prev" aria-label="Previous">‹</button>
        <button data-a="flip">Flip</button>
        <button data-a="spine">Spine</button>
        <button data-a="next" aria-label="Next">›</button>
        <button data-a="close" class="close" aria-label="Close">✕</button>
      </div>`;
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

// The Archivist's voice in the HUD: its icon (the lab's AI core; the eye flickers while it talks)
// and what it says, revealed quickly with a beat after punctuation, so it reads as speech
// without making you wait.

const ICON = `<svg class="v-core" viewBox="0 0 32 32" aria-hidden="true">
  <defs>
    <radialGradient id="v-eye-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#fff4c8"/><stop offset=".5" stop-color="#ffbf33"/><stop offset="1" stop-color="#ff8a00" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="v-shell"><circle cx="16" cy="16" r="14"/></clipPath>
  </defs>
  <circle cx="16" cy="16" r="14" fill="#dedfe2"/>
  <path d="M7 -2 L34 25" stroke="#1a1b1f" stroke-width="3.4" clip-path="url(#v-shell)"/>
  <circle cx="16" cy="18" r="6.4" fill="#1a1b1f"/>
  <circle class="v-eye" cx="16" cy="18" r="5.2" fill="url(#v-eye-glow)"/>
</svg>`;

/** ms per character, and the extra beat after punctuation */
const PER_CHAR = 1000 / 170;
const beat = (c: string) => (c === "." || c === "!" || c === "?" ? 90 : c === "," || c === ";" || c === ":" ? 40 : c === "…" || c === "—" ? 110 : 0);

export class Voice {
  readonly el = document.createElement("div");
  private text = document.createElement("span");
  private raf = 0;
  /** called when a line has been fully revealed */
  onDone?: () => void;

  constructor(extraClass = "") {
    this.el.className = `voice ${extraClass}`.trim();
    this.el.innerHTML = ICON;
    this.text.className = "v-text";
    this.el.appendChild(this.text);
  }

  speak(line: string) {
    cancelAnimationFrame(this.raf);
    this.el.setAttribute("aria-label", line);
    this.el.classList.add("talking");
    // when each character appears
    const at: number[] = [];
    let t = 0;
    for (const c of line) {
      at.push(t);
      t += PER_CHAR + beat(c);
    }
    const chars = [...line];
    const t0 = performance.now();
    let shown = 0;
    const tick = () => {
      const now = performance.now() - t0;
      const before = shown;
      while (shown < chars.length && at[shown] <= now) shown++;
      if (shown !== before) this.text.textContent = chars.slice(0, shown).join("");
      if (shown < chars.length) this.raf = requestAnimationFrame(tick);
      else {
        this.el.classList.remove("talking");
        this.onDone?.();
      }
    };
    tick();
  }

  clear() {
    cancelAnimationFrame(this.raf);
    this.text.textContent = "";
    this.el.removeAttribute("aria-label");
    this.el.classList.remove("talking");
  }
}

// Rotary knob control: drag up/down, scroll, double-click to reset.

export class Knob {
  constructor(el, { min = -1, max = 1, value = 0, onChange, label = '' }) {
    this.el = el;
    this.min = min;
    this.max = max;
    this.def = value;
    this.onChange = onChange;
    el.classList.add('knob');
    el.innerHTML = `<div class="knob-dial"><div class="knob-ind"></div></div><span class="knob-label">${label}</span>`;
    this.dial = el.querySelector('.knob-dial');
    this.value = value;

    let startY = 0;
    let startV = 0;
    this.dial.addEventListener('pointerdown', (e) => {
      this.dial.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startV = this._v;
      e.preventDefault();
    });
    this.dial.addEventListener('pointermove', (e) => {
      if (!this.dial.hasPointerCapture(e.pointerId)) return;
      const sens = e.shiftKey ? 600 : 160;
      this.value = startV + ((startY - e.clientY) / sens) * (this.max - this.min);
    });
    this.dial.addEventListener('dblclick', () => { this.value = this.def; });
    this.dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.value = this._v - Math.sign(e.deltaY) * 0.03 * (this.max - this.min);
    }, { passive: false });
  }

  get value() { return this._v; }

  set value(v) {
    v = Math.max(this.min, Math.min(this.max, v));
    // Detent at the default value.
    if (Math.abs(v - this.def) < 0.015 * (this.max - this.min)) v = this.def;
    this._v = v;
    const frac = (v - this.min) / (this.max - this.min);
    this.dial.style.setProperty('--rot', `${-135 + frac * 270}deg`);
    this.el.classList.toggle('off-center', v !== this.def);
    this.onChange?.(v);
  }
}

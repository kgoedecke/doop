import type { ComponentVariant } from './designSystem.ts'

/**
 * Ready-made starting points for every preset kind: markup, the component's
 * own CSS (shared values come from the global stylesheet's tokens) and, where
 * the kind behaves, a little JS. `{{s}}` stands for the component's slug, so
 * the starter's class names and its `data-doop-component` follow whatever
 * slug the person picks.
 */
export interface ComponentPreset {
  description: string
  html: string
  css: string
  js?: string
  variants?: ComponentVariant[]
}

const field = (s: string) => `.${s} { display: grid; gap: var(--space-1); font-size: var(--text-sm); }
.${s} label { font-weight: var(--weight-medium); }
.${s} input, .${s} textarea, .${s} select {
  font: inherit; color: var(--color-text); background: var(--color-bg);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3); transition: border-color var(--duration) var(--ease);
}
.${s} input:focus, .${s} textarea:focus, .${s} select:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-focus); }
.${s} small { color: var(--color-text-muted); font-size: var(--text-xs); }`

const PRESETS: Record<string, ComponentPreset> = {
  /* ---- buttons ---- */
  Button: {
    description: 'The primary action of a view. One primary per screen; secondary and ghost for the rest.',
    html: `<button class="{{s}}" data-doop-component="{{s}}">Continue</button>`,
    css: `.{{s}} {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  height: 40px; padding: 0 var(--space-4); border: 1px solid transparent; border-radius: var(--radius-md);
  font: var(--weight-medium) var(--text-sm) var(--font-sans); cursor: pointer;
  background: var(--color-primary); color: var(--color-primary-contrast);
  transition: background var(--duration) var(--ease), transform var(--duration) var(--ease);
}
.{{s}}:hover { background: var(--color-primary-hover); }
.{{s}}:active { transform: translateY(1px); }
.{{s}}:disabled { opacity: 0.45; cursor: not-allowed; }
.{{s}}--secondary { background: var(--color-surface); color: var(--color-text); border-color: var(--color-border); }
.{{s}}--secondary:hover { background: var(--color-bg); }
.{{s}}--ghost { background: transparent; color: var(--color-text); }
.{{s}}--ghost:hover { background: var(--color-surface); }
.{{s}}--sm { height: 32px; padding: 0 var(--space-3); font-size: var(--text-xs); }`,
    variants: [
      { name: 'Secondary', html: `<button class="{{s}} {{s}}--secondary" data-doop-component="{{s}}">Cancel</button>` },
      { name: 'Ghost', html: `<button class="{{s}} {{s}}--ghost" data-doop-component="{{s}}">Learn more</button>` },
      { name: 'Small', html: `<button class="{{s}} {{s}}--sm" data-doop-component="{{s}}">Save</button>` },
    ],
  },
  ButtonGroup: {
    description: 'Related actions joined into one control.',
    html: `<div class="{{s}}" role="group" data-doop-component="{{s}}"><button>Day</button><button>Week</button><button>Month</button></div>`,
    css: `.{{s}} { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
.{{s}} button { font: var(--weight-medium) var(--text-sm) var(--font-sans); padding: var(--space-2) var(--space-4); border: 0; background: var(--color-bg); color: var(--color-text); cursor: pointer; }
.{{s}} button + button { border-left: 1px solid var(--color-border); }
.{{s}} button:hover { background: var(--color-surface); }`,
  },
  CloseButton: {
    description: 'Dismisses a dialog, toast or panel.',
    html: `<button class="{{s}}" aria-label="Close" data-doop-component="{{s}}">×</button>`,
    css: `.{{s}} { display: inline-grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text-muted); font-size: 18px; line-height: 1; cursor: pointer; }
.{{s}}:hover { color: var(--color-text); background: var(--color-border); }`,
  },
  ToggleButton: {
    description: 'A button that stays pressed: bold, mute, favourite.',
    html: `<button class="{{s}}" aria-pressed="false" data-doop-component="{{s}}">★ Favourite</button>`,
    css: `.{{s}} { font: var(--weight-medium) var(--text-sm) var(--font-sans); padding: var(--space-2) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); cursor: pointer; }
.{{s}}[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg); border-color: var(--color-text); }`,
    js: `elements.forEach(function (el) {
  el.addEventListener('click', function () { el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true')) })
})`,
  },
  ToggleButtonGroup: {
    description: 'Pick one option of a few, shown side by side.',
    html: `<div class="{{s}}" role="radiogroup" data-doop-component="{{s}}"><button aria-pressed="true">List</button><button aria-pressed="false">Grid</button><button aria-pressed="false">Board</button></div>`,
    css: `.{{s}} { display: inline-flex; gap: 2px; padding: 3px; background: var(--color-surface); border-radius: var(--radius-md); }
.{{s}} button { font: var(--weight-medium) var(--text-sm) var(--font-sans); padding: 6px var(--space-3); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.{{s}} button[aria-pressed="true"] { background: var(--color-bg); color: var(--color-text); box-shadow: var(--shadow-sm); }`,
    js: `elements.forEach(function (group) {
  group.addEventListener('click', function (event) {
    var picked = event.target.closest('button')
    if (!picked) return
    group.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === picked)) })
  })
})`,
  },

  /* ---- collections ---- */
  Dropdown: {
    description: 'A menu of actions behind a trigger.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><button class="{{s}}__trigger">Options ▾</button><ul class="{{s}}__menu" hidden><li>Edit</li><li>Duplicate</li><li class="{{s}}__danger">Delete</li></ul></div>`,
    css: `.{{s}} { position: relative; display: inline-block; font: var(--text-sm) var(--font-sans); }
.{{s}}__trigger { font: inherit; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); cursor: pointer; }
.{{s}}__menu { position: absolute; top: calc(100% + 4px); left: 0; min-width: 160px; margin: 0; padding: var(--space-1); list-style: none; background: var(--color-surface-raised); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: var(--shadow-md); z-index: 10; }
.{{s}}__menu li { padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); cursor: pointer; }
.{{s}}__menu li:hover { background: var(--color-surface); }
.{{s}}__danger { color: var(--color-danger); }`,
    js: `elements.forEach(function (el) {
  var menu = el.querySelector('ul')
  el.querySelector('button').addEventListener('click', function () { menu.hidden = !menu.hidden })
  document.addEventListener('click', function (event) { if (!el.contains(event.target)) menu.hidden = true })
})`,
  },
  ListBox: {
    description: 'A list to pick one or more items from.',
    html: `<ul class="{{s}}" role="listbox" data-doop-component="{{s}}"><li aria-selected="true">Inbox</li><li>Drafts</li><li>Archive</li></ul>`,
    css: `.{{s}} { width: 220px; margin: 0; padding: var(--space-1); list-style: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); font: var(--text-sm) var(--font-sans); }
.{{s}} li { padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); cursor: pointer; }
.{{s}} li:hover { background: var(--color-surface); }
.{{s}} li[aria-selected="true"] { background: var(--color-primary); color: var(--color-primary-contrast); }`,
    js: `elements.forEach(function (list) {
  list.addEventListener('click', function (event) {
    var item = event.target.closest('li')
    if (!item) return
    list.querySelectorAll('li').forEach(function (li) { li.setAttribute('aria-selected', String(li === item)) })
  })
})`,
  },
  TagGroup: {
    description: 'A set of removable tags.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><span>Design <button aria-label="Remove">×</button></span><span>Research <button aria-label="Remove">×</button></span><span>Ops <button aria-label="Remove">×</button></span></div>`,
    css: `.{{s}} { display: flex; flex-wrap: wrap; gap: var(--space-2); font: var(--text-xs) var(--font-sans); }
.{{s}} span { display: inline-flex; align-items: center; gap: var(--space-1); padding: 4px var(--space-2); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-full); }
.{{s}} button { border: 0; background: none; color: var(--color-text-muted); cursor: pointer; padding: 0; }`,
    js: `elements.forEach(function (group) {
  group.addEventListener('click', function (event) { var b = event.target.closest('button'); if (b) b.parentElement.remove() })
})`,
  },

  /* ---- colors ---- */
  ColorArea: {
    description: 'A two-dimensional saturation / brightness picker.',
    html: `<div class="{{s}}" style="--hue: 228" data-doop-component="{{s}}"><span class="{{s}}__thumb" style="left: 70%; top: 30%"></span></div>`,
    css: `.{{s}} { position: relative; width: 220px; height: 160px; border-radius: var(--radius-md); background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(var(--hue) 100% 50%)); cursor: crosshair; }
.{{s}}__thumb { position: absolute; width: 16px; height: 16px; border: 2px solid #fff; border-radius: 50%; box-shadow: var(--shadow-md); transform: translate(-50%, -50%); }`,
    js: `elements.forEach(function (area) {
  var thumb = area.querySelector('span')
  area.addEventListener('pointerdown', function (event) {
    var move = function (e) { var r = area.getBoundingClientRect(); thumb.style.left = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)) + '%'; thumb.style.top = Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100)) + '%' }
    move(event); area.setPointerCapture(event.pointerId); area.onpointermove = move; area.onpointerup = function () { area.onpointermove = null }
  })
})`,
  },
  ColorField: {
    description: 'A text field for a hex colour, with its swatch.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span class="{{s}}__swatch" style="background:#2743ee"></span><input value="#2743EE" aria-label="Colour" /></label>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); padding: 6px var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: var(--text-sm) var(--font-mono); }
.{{s}}__swatch { width: 20px; height: 20px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.1); }
.{{s}} input { width: 90px; border: 0; font: inherit; outline: none; background: transparent; color: var(--color-text); }`,
    js: `elements.forEach(function (el) {
  var input = el.querySelector('input'), swatch = el.querySelector('span')
  input.addEventListener('input', function () { swatch.style.background = input.value })
})`,
  },
  ColorPicker: {
    description: 'Pick any colour: native picker plus its value.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><input type="color" value="#2743ee" /><span>#2743ee</span></label>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); font: var(--text-sm) var(--font-mono); }
.{{s}} input { width: 36px; height: 36px; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: none; cursor: pointer; }`,
    js: `elements.forEach(function (el) {
  var input = el.querySelector('input'), out = el.querySelector('span')
  input.addEventListener('input', function () { out.textContent = input.value })
})`,
  },
  ColorSlider: {
    description: 'A slider along one colour channel, here hue.',
    html: `<input class="{{s}}" type="range" min="0" max="360" value="228" aria-label="Hue" data-doop-component="{{s}}" />`,
    css: `.{{s}} { -webkit-appearance: none; appearance: none; width: 220px; height: 14px; border-radius: var(--radius-full); background: linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red); }
.{{s}}::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border: 2px solid #fff; border-radius: 50%; background: transparent; box-shadow: var(--shadow-md); }`,
  },
  ColorSwatch: {
    description: 'One colour, shown as a chip.',
    html: `<span class="{{s}}" style="--swatch: #2743ee" title="Primary" data-doop-component="{{s}}"></span>`,
    css: `.{{s}} { display: inline-block; width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--swatch); box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }`,
  },
  ColorSwatchPicker: {
    description: 'Pick one colour from a palette.',
    html: `<div class="{{s}}" role="radiogroup" data-doop-component="{{s}}"><button style="--swatch:#2743ee" aria-checked="true"></button><button style="--swatch:#0e9f6e"></button><button style="--swatch:#c77800"></button><button style="--swatch:#d0341f"></button><button style="--swatch:#8b5cf6"></button></div>`,
    css: `.{{s}} { display: flex; gap: var(--space-2); }
.{{s}} button { width: 28px; height: 28px; border: 0; border-radius: 50%; background: var(--swatch); cursor: pointer; }
.{{s}} button[aria-checked="true"] { box-shadow: 0 0 0 2px var(--color-bg), 0 0 0 4px var(--swatch); }`,
    js: `elements.forEach(function (group) {
  group.addEventListener('click', function (event) {
    var picked = event.target.closest('button')
    if (!picked) return
    group.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-checked', String(b === picked)) })
  })
})`,
  },

  /* ---- controls ---- */
  Slider: {
    description: 'Pick a value within a range.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Volume <output>60</output></span><input type="range" min="0" max="100" value="60" /></label>`,
    css: `.{{s}} { display: grid; gap: var(--space-2); width: 240px; font: var(--text-sm) var(--font-sans); }
.{{s}} span { display: flex; justify-content: space-between; }
.{{s}} output { color: var(--color-text-muted); font-family: var(--font-mono); }
.{{s}} input { accent-color: var(--color-primary); }`,
    js: `elements.forEach(function (el) {
  var input = el.querySelector('input'), out = el.querySelector('output')
  input.addEventListener('input', function () { out.textContent = input.value })
})`,
  },
  Switch: {
    description: 'An on / off setting that applies at once.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><input type="checkbox" checked /><span class="{{s}}__track"></span> Notifications</label>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); font: var(--text-sm) var(--font-sans); cursor: pointer; }
.{{s}} input { position: absolute; opacity: 0; pointer-events: none; }
.{{s}}__track { position: relative; width: 36px; height: 22px; border-radius: var(--radius-full); background: var(--color-border); transition: background var(--duration) var(--ease); }
.{{s}}__track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: var(--shadow-sm); transition: transform var(--duration) var(--ease); }
.{{s}} input:checked + .{{s}}__track { background: var(--color-primary); }
.{{s}} input:checked + .{{s}}__track::after { transform: translateX(14px); }`,
  },

  /* ---- data display ---- */
  Badge: {
    description: 'A short status or count label.',
    html: `<span class="{{s}}" data-doop-component="{{s}}">New</span>`,
    css: `.{{s}} { display: inline-flex; align-items: center; padding: 2px var(--space-2); border-radius: var(--radius-full); font: var(--weight-medium) var(--text-xs) var(--font-sans); background: color-mix(in srgb, var(--color-primary) 12%, transparent); color: var(--color-primary); }
.{{s}}--success { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
.{{s}}--danger { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }`,
    variants: [
      { name: 'Success', html: `<span class="{{s}} {{s}}--success" data-doop-component="{{s}}">Paid</span>` },
      { name: 'Danger', html: `<span class="{{s}} {{s}}--danger" data-doop-component="{{s}}">Overdue</span>` },
    ],
  },
  Chip: {
    description: 'A compact, selectable filter or attribute.',
    html: `<button class="{{s}}" aria-pressed="false" data-doop-component="{{s}}">Remote</button>`,
    css: `.{{s}} { height: 30px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-full); background: var(--color-bg); font: var(--text-sm) var(--font-sans); color: var(--color-text); cursor: pointer; }
.{{s}}[aria-pressed="true"] { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary); }`,
    js: `elements.forEach(function (el) {
  el.addEventListener('click', function () { el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true')) })
})`,
  },
  Table: {
    description: 'Rows of structured data with a header.',
    html: `<table class="{{s}}" data-doop-component="{{s}}"><thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody><tr><td>Ana Lima</td><td>Designer</td><td>Active</td></tr><tr><td>Rui Costa</td><td>Engineer</td><td>Invited</td></tr></tbody></table>`,
    css: `.{{s}} { width: 100%; border-collapse: collapse; font: var(--text-sm) var(--font-sans); }
.{{s}} th { text-align: left; font-weight: var(--weight-medium); color: var(--color-text-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border); }
.{{s}} td { padding: var(--space-3); border-bottom: 1px solid var(--color-border); }
.{{s}} tbody tr:hover { background: var(--color-surface); }`,
  },

  /* ---- date and time ---- */
  Calendar: {
    description: 'A month grid to pick a day.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><header>October 2026</header><div class="{{s}}__grid"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span><button>1</button><button>2</button><button>3</button><button>4</button><button>5</button><button>6</button><button>7</button><button>8</button><button>9</button><button aria-selected="true">10</button><button>11</button><button>12</button><button>13</button><button>14</button></div></div>`,
    css: `.{{s}} { width: 260px; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); font: var(--text-sm) var(--font-sans); }
.{{s}} header { font-weight: var(--weight-bold); margin-bottom: var(--space-2); }
.{{s}}__grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
.{{s}}__grid span { color: var(--color-text-muted); font-size: var(--text-xs); padding: var(--space-1) 0; }
.{{s}}__grid button { aspect-ratio: 1; border: 0; border-radius: var(--radius-sm); background: none; font: inherit; cursor: pointer; }
.{{s}}__grid button:hover { background: var(--color-surface); }
.{{s}}__grid button[aria-selected="true"] { background: var(--color-primary); color: var(--color-primary-contrast); }`,
    js: `elements.forEach(function (cal) {
  cal.addEventListener('click', function (event) {
    var day = event.target.closest('button')
    if (!day) return
    cal.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-selected', String(b === day)) })
  })
})`,
  },
  DateField: {
    description: 'Type a date.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Start date</span><input type="date" value="2026-10-31" /></label>`,
    css: field('{{s}}'),
  },
  DatePicker: {
    description: 'A date field with a calendar popover.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Due</span><input type="date" value="2026-11-14" /><small>We remind you a day before.</small></label>`,
    css: field('{{s}}'),
  },
  DateRangePicker: {
    description: 'Pick a start and an end date.',
    html: `<fieldset class="{{s}}" data-doop-component="{{s}}"><legend>Stay</legend><input type="date" value="2026-12-20" aria-label="From" /><span>→</span><input type="date" value="2026-12-27" aria-label="To" /></fieldset>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: var(--text-sm) var(--font-sans); }
.{{s}} legend { padding: 0 var(--space-1); font-size: var(--text-xs); color: var(--color-text-muted); }
.{{s}} input { border: 0; font: inherit; background: transparent; color: var(--color-text); }`,
  },
  RangeCalendar: {
    description: 'A month grid where a span of days is picked.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><button>8</button><button class="is-start">9</button><button class="is-in">10</button><button class="is-in">11</button><button class="is-end">12</button><button>13</button><button>14</button></div>`,
    css: `.{{s}} { display: grid; grid-template-columns: repeat(7, 36px); font: var(--text-sm) var(--font-sans); }
.{{s}} button { height: 36px; border: 0; background: none; font: inherit; cursor: pointer; }
.{{s}} .is-in { background: color-mix(in srgb, var(--color-primary) 12%, transparent); }
.{{s}} .is-start, .{{s}} .is-end { background: var(--color-primary); color: var(--color-primary-contrast); }
.{{s}} .is-start { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
.{{s}} .is-end { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }`,
  },
  TimeField: {
    description: 'Type a time of day.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Meeting time</span><input type="time" value="14:30" /></label>`,
    css: field('{{s}}'),
  },

  /* ---- feedback and loading ---- */
  Alert: {
    description: 'An inline message about the state of a page or form.',
    html: `<div class="{{s}}" role="alert" data-doop-component="{{s}}"><strong>Payment failed.</strong> Update your card to keep your plan.</div>`,
    css: `.{{s}} { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent); background: color-mix(in srgb, var(--color-danger) 8%, transparent); color: var(--color-text); font: var(--text-sm) var(--font-sans); }
.{{s}} strong { color: var(--color-danger); }
.{{s}}--info { border-color: color-mix(in srgb, var(--color-primary) 35%, transparent); background: color-mix(in srgb, var(--color-primary) 8%, transparent); }
.{{s}}--info strong { color: var(--color-primary); }`,
    variants: [
      {
        name: 'Info',
        html: `<div class="{{s}} {{s}}--info" role="status" data-doop-component="{{s}}"><strong>Heads up.</strong> Maintenance on Sunday.</div>`,
      },
    ],
  },
  Meter: {
    description: 'A measure within a known range: storage, score.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Storage <b>72%</b></span><meter min="0" max="100" value="72"></meter></label>`,
    css: `.{{s}} { display: grid; gap: var(--space-1); width: 240px; font: var(--text-sm) var(--font-sans); }
.{{s}} span { display: flex; justify-content: space-between; }
.{{s}} meter { width: 100%; height: 8px; }`,
  },
  ProgressBar: {
    description: 'How far along a task is.',
    html: `<div class="{{s}}" role="progressbar" aria-valuenow="45" aria-valuemin="0" aria-valuemax="100" style="--value: 45%" data-doop-component="{{s}}"><span></span></div>`,
    css: `.{{s}} { width: 240px; height: 8px; border-radius: var(--radius-full); background: var(--color-surface); overflow: hidden; }
.{{s}} span { display: block; width: var(--value); height: 100%; border-radius: inherit; background: var(--color-primary); transition: width var(--duration) var(--ease); }`,
  },
  ProgressCircle: {
    description: 'Circular progress for compact spaces.',
    html: `<div class="{{s}}" role="progressbar" aria-valuenow="65" style="--value: 65" data-doop-component="{{s}}"><span>65%</span></div>`,
    css: `.{{s}} { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: conic-gradient(var(--color-primary) calc(var(--value) * 1%), var(--color-surface) 0); font: var(--weight-medium) var(--text-xs) var(--font-sans); }
.{{s}} span { display: grid; place-items: center; width: 50px; height: 50px; border-radius: 50%; background: var(--color-bg); }`,
  },
  Skeleton: {
    description: 'A placeholder while content loads.',
    html: `<div class="{{s}}" aria-hidden="true" data-doop-component="{{s}}"><span style="width: 60%"></span><span></span><span style="width: 80%"></span></div>`,
    css: `.{{s}} { display: grid; gap: var(--space-2); width: 260px; }
.{{s}} span { height: 12px; border-radius: var(--radius-sm); background: linear-gradient(90deg, var(--color-surface) 0%, var(--color-border) 50%, var(--color-surface) 100%); background-size: 200% 100%; animation: {{s}}-shimmer 1.4s infinite linear; }
@keyframes {{s}}-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }`,
  },
  Spinner: {
    description: 'Indeterminate loading.',
    html: `<span class="{{s}}" role="status" aria-label="Loading" data-doop-component="{{s}}"></span>`,
    css: `.{{s}} { display: inline-block; width: 24px; height: 24px; border: 3px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: {{s}}-spin 0.8s linear infinite; }
@keyframes {{s}}-spin { to { transform: rotate(360deg); } }`,
  },

  /* ---- forms ---- */
  Checkbox: {
    description: 'Turn one option on or off, inside a form.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><input type="checkbox" checked /> Remember me</label>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); font: var(--text-sm) var(--font-sans); cursor: pointer; }
.{{s}} input { width: 16px; height: 16px; accent-color: var(--color-primary); }`,
  },
  CheckboxGroup: {
    description: 'Several related checkboxes under one label.',
    html: `<fieldset class="{{s}}" data-doop-component="{{s}}"><legend>Notify me about</legend><label><input type="checkbox" checked /> Comments</label><label><input type="checkbox" /> Mentions</label><label><input type="checkbox" checked /> Approvals</label></fieldset>`,
    css: `.{{s}} { display: grid; gap: var(--space-2); margin: 0; padding: 0; border: 0; font: var(--text-sm) var(--font-sans); }
.{{s}} legend { margin-bottom: var(--space-2); font-weight: var(--weight-medium); }
.{{s}} label { display: inline-flex; align-items: center; gap: var(--space-2); }
.{{s}} input { accent-color: var(--color-primary); }`,
  },
  Description: {
    description: 'Helper text under a field.',
    html: `<p class="{{s}}" data-doop-component="{{s}}">Use at least 8 characters, with a number.</p>`,
    css: `.{{s}} { margin: 0; font: var(--text-xs) var(--font-sans); color: var(--color-text-muted); }`,
  },
  ErrorMessage: {
    description: 'A form-level error.',
    html: `<p class="{{s}}" role="alert" data-doop-component="{{s}}">We couldn’t save your changes. Try again.</p>`,
    css: `.{{s}} { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-danger) 8%, transparent); color: var(--color-danger); font: var(--text-sm) var(--font-sans); }`,
  },
  FieldError: {
    description: 'The error under one field.',
    html: `<p class="{{s}}" data-doop-component="{{s}}">Enter a valid email address.</p>`,
    css: `.{{s}} { margin: 0; font: var(--text-xs) var(--font-sans); color: var(--color-danger); }
.{{s}}::before { content: '⚠ '; }`,
  },
  Fieldset: {
    description: 'Groups related fields under a heading.',
    html: `<fieldset class="{{s}}" data-doop-component="{{s}}"><legend>Shipping address</legend><input placeholder="Street" /><input placeholder="City" /></fieldset>`,
    css: `.{{s}} { display: grid; gap: var(--space-3); margin: 0; padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); font: var(--text-sm) var(--font-sans); }
.{{s}} legend { padding: 0 var(--space-1); font-weight: var(--weight-medium); }
.{{s}} input { font: inherit; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }`,
  },
  Form: {
    description: 'A complete form: fields stacked, one primary action.',
    html: `<form class="{{s}}" data-doop-component="{{s}}" onsubmit="return false"><label>Email<input type="email" placeholder="you@company.com" /></label><label>Password<input type="password" /></label><button>Sign in</button></form>`,
    css: `.{{s}} { display: grid; gap: var(--space-4); width: 320px; font: var(--text-sm) var(--font-sans); }
.{{s}} label { display: grid; gap: var(--space-1); font-weight: var(--weight-medium); }
.{{s}} input { font: inherit; font-weight: var(--weight-regular); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
.{{s}} button { height: 40px; border: 0; border-radius: var(--radius-md); background: var(--color-primary); color: var(--color-primary-contrast); font: var(--weight-medium) var(--text-sm) var(--font-sans); cursor: pointer; }`,
  },
  Input: {
    description: 'A bare text input.',
    html: `<input class="{{s}}" placeholder="Type here…" data-doop-component="{{s}}" />`,
    css: `.{{s}} { width: 260px; height: 38px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: var(--text-sm) var(--font-sans); color: var(--color-text); background: var(--color-bg); }
.{{s}}:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-focus); }`,
  },
  InputGroup: {
    description: 'An input with an addon before or after it.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><span>https://</span><input placeholder="your-site.com" /></div>`,
    css: `.{{s}} { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; font: var(--text-sm) var(--font-sans); }
.{{s}} span { padding: var(--space-2) var(--space-3); background: var(--color-surface); color: var(--color-text-muted); border-right: 1px solid var(--color-border); }
.{{s}} input { border: 0; padding: var(--space-2) var(--space-3); font: inherit; outline: none; }`,
  },
  InputOTP: {
    description: 'A one-time code, one box per digit.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><input maxlength="1" /><input maxlength="1" /><input maxlength="1" /><span>–</span><input maxlength="1" /><input maxlength="1" /><input maxlength="1" /></div>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); }
.{{s}} input { width: 42px; height: 50px; text-align: center; font: var(--weight-bold) var(--text-lg) var(--font-mono); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
.{{s}} input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-focus); }
.{{s}} span { color: var(--color-text-muted); }`,
    js: `elements.forEach(function (el) {
  var boxes = Array.prototype.slice.call(el.querySelectorAll('input'))
  boxes.forEach(function (box, i) { box.addEventListener('input', function () { if (box.value && boxes[i + 1]) boxes[i + 1].focus() }) })
})`,
  },
  Label: {
    description: 'Names a field.',
    html: `<label class="{{s}}" data-doop-component="{{s}}">Full name <em>*</em></label>`,
    css: `.{{s}} { font: var(--weight-medium) var(--text-sm) var(--font-sans); color: var(--color-text); }
.{{s}} em { font-style: normal; color: var(--color-danger); }`,
  },
  NumberField: {
    description: 'A number with step buttons.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><button aria-label="Decrease">−</button><input type="number" value="2" /><button aria-label="Increase">+</button></div>`,
    css: `.{{s}} { display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-sm); overflow: hidden; font: var(--text-sm) var(--font-sans); }
.{{s}} button { width: 34px; border: 0; background: var(--color-surface); font-size: 16px; cursor: pointer; }
.{{s}} input { width: 56px; border: 0; text-align: center; font: inherit; -moz-appearance: textfield; }
.{{s}} input::-webkit-inner-spin-button { -webkit-appearance: none; }`,
    js: `elements.forEach(function (el) {
  var input = el.querySelector('input'), buttons = el.querySelectorAll('button')
  buttons[0].addEventListener('click', function () { input.stepDown() })
  buttons[1].addEventListener('click', function () { input.stepUp() })
})`,
  },
  RadioGroup: {
    description: 'Pick exactly one of a few options.',
    html: `<fieldset class="{{s}}" data-doop-component="{{s}}"><legend>Plan</legend><label><input type="radio" name="{{s}}-plan" checked /> Monthly</label><label><input type="radio" name="{{s}}-plan" /> Yearly</label></fieldset>`,
    css: `.{{s}} { display: grid; gap: var(--space-2); margin: 0; padding: 0; border: 0; font: var(--text-sm) var(--font-sans); }
.{{s}} legend { margin-bottom: var(--space-2); font-weight: var(--weight-medium); }
.{{s}} label { display: inline-flex; align-items: center; gap: var(--space-2); }
.{{s}} input { accent-color: var(--color-primary); }`,
  },
  SearchField: {
    description: 'A search input with its glyph.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" placeholder="Search" /></label>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-2); width: 280px; height: 38px; padding: 0 var(--space-3); border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text-muted); }
.{{s}} input { flex: 1; border: 0; background: transparent; font: var(--text-sm) var(--font-sans); color: var(--color-text); outline: none; }`,
  },
  TextField: {
    description: 'A labelled text input with optional helper text.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Email</span><input type="email" placeholder="you@company.com" /><small>We never share it.</small></label>`,
    css: field('{{s}}'),
  },
  TextArea: {
    description: 'Multi-line text.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Message</span><textarea rows="4" placeholder="Tell us more…"></textarea></label>`,
    css: field('{{s}}') + `\n.{{s}} textarea { resize: vertical; width: 320px; }`,
  },

  /* ---- layout ---- */
  Card: {
    description: 'A surface grouping one topic: media, title, body, actions.',
    html: `<article class="{{s}}" data-doop-component="{{s}}"><h3>Quarterly report</h3><p>Revenue grew 18% with churn holding under 2%.</p><a href="#">Read more →</a></article>`,
    css: `.{{s}} { width: 300px; padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-raised); box-shadow: var(--shadow-sm); font-family: var(--font-sans); }
.{{s}} h3 { margin: 0 0 var(--space-2); font-size: var(--text-lg); }
.{{s}} p { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
.{{s}} a { color: var(--color-primary); font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: none; }`,
  },
  Separator: {
    description: 'A rule between groups of content.',
    html: `<hr class="{{s}}" data-doop-component="{{s}}" />`,
    css: `.{{s}} { width: 100%; height: 1px; margin: var(--space-4) 0; border: 0; background: var(--color-border); }`,
  },
  Surface: {
    description: 'A plain raised background to sit content on.',
    html: `<div class="{{s}}" data-doop-component="{{s}}">Content sits here.</div>`,
    css: `.{{s}} { padding: var(--space-5); border-radius: var(--radius-lg); background: var(--color-surface); font: var(--text-sm) var(--font-sans); }`,
  },
  Toolbar: {
    description: 'A row of related tools.',
    html: `<div class="{{s}}" role="toolbar" data-doop-component="{{s}}"><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><span></span><button>⋯</button></div>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: 2px; padding: var(--space-1); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); box-shadow: var(--shadow-sm); }
.{{s}} button { width: 32px; height: 32px; border: 0; border-radius: var(--radius-sm); background: none; font: var(--text-sm) var(--font-sans); cursor: pointer; }
.{{s}} button:hover { background: var(--color-surface); }
.{{s}} span { width: 1px; height: 20px; margin: 0 var(--space-1); background: var(--color-border); }`,
  },

  /* ---- media ---- */
  Avatar: {
    description: 'A person: photo, else initials.',
    html: `<span class="{{s}}" data-doop-component="{{s}}">AL</span>`,
    css: `.{{s}} { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: color-mix(in srgb, var(--color-primary) 16%, var(--color-bg)); color: var(--color-primary); font: var(--weight-bold) var(--text-sm) var(--font-sans); overflow: hidden; }
.{{s}} img { width: 100%; height: 100%; object-fit: cover; }`,
  },
  AvatarGroup: {
    description: 'Several people, overlapped, with a count.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><span>AL</span><span>RC</span><span>MS</span><span class="{{s}}__more">+4</span></div>`,
    css: `.{{s}} { display: inline-flex; }
.{{s}} span { display: grid; place-items: center; width: 34px; height: 34px; margin-left: -8px; border: 2px solid var(--color-bg); border-radius: 50%; background: color-mix(in srgb, var(--color-primary) 16%, var(--color-bg)); color: var(--color-primary); font: var(--weight-bold) var(--text-xs) var(--font-sans); }
.{{s}} span:first-child { margin-left: 0; }
.{{s}}__more { background: var(--color-surface) !important; color: var(--color-text-muted) !important; }`,
  },

  /* ---- navigation ---- */
  Accordion: {
    description: 'Stacked sections, one open at a time.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><details open><summary>What is included?</summary><p>Unlimited canvases and agents.</p></details><details><summary>Can I cancel?</summary><p>Anytime, from billing.</p></details></div>`,
    css: `.{{s}} { width: 360px; border: 1px solid var(--color-border); border-radius: var(--radius-md); font: var(--text-sm) var(--font-sans); }
.{{s}} details + details { border-top: 1px solid var(--color-border); }
.{{s}} summary { padding: var(--space-3) var(--space-4); font-weight: var(--weight-medium); cursor: pointer; list-style: none; }
.{{s}} summary::after { content: '+'; float: right; color: var(--color-text-muted); }
.{{s}} details[open] summary::after { content: '−'; }
.{{s}} p { margin: 0; padding: 0 var(--space-4) var(--space-3); color: var(--color-text-muted); }`,
    js: `elements.forEach(function (el) {
  el.addEventListener('toggle', function (event) {
    if (!event.target.open) return
    el.querySelectorAll('details').forEach(function (d) { if (d !== event.target) d.open = false })
  }, true)
})`,
  },
  Breadcrumbs: {
    description: 'Where this page sits in the hierarchy.',
    html: `<nav class="{{s}}" aria-label="Breadcrumb" data-doop-component="{{s}}"><a href="#">Home</a><a href="#">Projects</a><span aria-current="page">Doop</span></nav>`,
    css: `.{{s}} { display: flex; align-items: center; gap: var(--space-2); font: var(--text-sm) var(--font-sans); color: var(--color-text-muted); }
.{{s}} a { color: inherit; text-decoration: none; }
.{{s}} a:hover { color: var(--color-text); }
.{{s}} a::after { content: '/'; margin-left: var(--space-2); color: var(--color-border); }
.{{s}} [aria-current] { color: var(--color-text); font-weight: var(--weight-medium); }`,
  },
  Disclosure: {
    description: 'Show or hide one block of content.',
    html: `<details class="{{s}}" data-doop-component="{{s}}"><summary>Advanced settings</summary><p>Fine-grained controls live here.</p></details>`,
    css: `.{{s}} { font: var(--text-sm) var(--font-sans); }
.{{s}} summary { cursor: pointer; font-weight: var(--weight-medium); color: var(--color-primary); }
.{{s}} p { margin: var(--space-2) 0 0; color: var(--color-text-muted); }`,
  },
  DisclosureGroup: {
    description: 'Several disclosures that open independently.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><details><summary>Profile</summary><p>Name, photo, bio.</p></details><details><summary>Security</summary><p>Password and 2FA.</p></details></div>`,
    css: `.{{s}} { display: grid; gap: var(--space-2); width: 320px; font: var(--text-sm) var(--font-sans); }
.{{s}} details { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-surface); }
.{{s}} summary { cursor: pointer; font-weight: var(--weight-medium); }
.{{s}} p { margin: var(--space-2) 0 0; color: var(--color-text-muted); }`,
  },
  Link: {
    description: 'An inline link.',
    html: `<a class="{{s}}" href="#" data-doop-component="{{s}}">View documentation</a>`,
    css: `.{{s}} { color: var(--color-primary); font: var(--weight-medium) var(--text-sm) var(--font-sans); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, var(--color-primary) 35%, transparent); }
.{{s}}:hover { text-decoration-color: currentColor; }`,
  },
  Pagination: {
    description: 'Move between pages of results.',
    html: `<nav class="{{s}}" aria-label="Pagination" data-doop-component="{{s}}"><button>‹</button><button>1</button><button aria-current="page">2</button><button>3</button><span>…</span><button>9</button><button>›</button></nav>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-1); font: var(--text-sm) var(--font-sans); }
.{{s}} button { min-width: 32px; height: 32px; border: 0; border-radius: var(--radius-sm); background: none; font: inherit; cursor: pointer; }
.{{s}} button:hover { background: var(--color-surface); }
.{{s}} button[aria-current] { background: var(--color-text); color: var(--color-bg); }
.{{s}} span { color: var(--color-text-muted); padding: 0 var(--space-1); }`,
  },
  Tabs: {
    description: 'Switch between views of the same context.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Activity</button><button role="tab" aria-selected="false">Settings</button></div><div role="tabpanel">Overview content</div><div role="tabpanel" hidden>Activity content</div><div role="tabpanel" hidden>Settings content</div></div>`,
    css: `.{{s}} { font: var(--text-sm) var(--font-sans); }
.{{s}} [role="tablist"] { display: flex; gap: var(--space-4); border-bottom: 1px solid var(--color-border); }
.{{s}} [role="tab"] { padding: var(--space-2) 0; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; font: inherit; color: var(--color-text-muted); cursor: pointer; }
.{{s}} [role="tab"][aria-selected="true"] { color: var(--color-text); border-bottom-color: var(--color-primary); font-weight: var(--weight-medium); }
.{{s}} [role="tabpanel"] { padding: var(--space-4) 0; }`,
    js: `elements.forEach(function (el) {
  var tabs = Array.prototype.slice.call(el.querySelectorAll('[role="tab"]'))
  var panels = el.querySelectorAll('[role="tabpanel"]')
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t, j) { t.setAttribute('aria-selected', String(i === j)); if (panels[j]) panels[j].hidden = i !== j })
    })
  })
})`,
  },

  /* ---- overlays ---- */
  AlertDialog: {
    description: 'Asks to confirm a consequential action.',
    html: `<div class="{{s}}" role="alertdialog" data-doop-component="{{s}}"><h3>Delete project?</h3><p>This removes 24 frames for everyone. It can’t be undone.</p><footer><button>Cancel</button><button class="{{s}}__danger">Delete</button></footer></div>`,
    css: `.{{s}} { width: 380px; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--color-surface-raised); box-shadow: var(--shadow-lg); font-family: var(--font-sans); }
.{{s}} h3 { margin: 0 0 var(--space-2); font-size: var(--text-lg); }
.{{s}} p { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
.{{s}} footer { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-5); }
.{{s}} button { height: 36px; padding: 0 var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); font: var(--weight-medium) var(--text-sm) var(--font-sans); cursor: pointer; }
.{{s}}__danger { background: var(--color-danger) !important; border-color: var(--color-danger) !important; color: #fff; }`,
  },
  Drawer: {
    description: 'A panel sliding in from the edge of the screen.',
    html: `<aside class="{{s}}" data-doop-component="{{s}}"><header>Filters</header><p>Status, owner, date…</p></aside>`,
    css: `.{{s}} { width: 320px; height: 420px; padding: var(--space-5); background: var(--color-surface-raised); border-left: 1px solid var(--color-border); box-shadow: var(--shadow-lg); font: var(--text-sm) var(--font-sans); }
.{{s}} header { font-size: var(--text-lg); font-weight: var(--weight-bold); margin-bottom: var(--space-3); }
.{{s}} p { color: var(--color-text-muted); }`,
  },
  Modal: {
    description: 'Focused task on top of the page.',
    html: `<div class="{{s}}" role="dialog" data-doop-component="{{s}}"><header><h3>Invite people</h3><button aria-label="Close">×</button></header><p>They’ll get an email with a link to this workspace.</p><input placeholder="name@company.com" /></div>`,
    css: `.{{s}} { width: 440px; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--color-surface-raised); box-shadow: var(--shadow-lg); font-family: var(--font-sans); }
.{{s}} header { display: flex; justify-content: space-between; align-items: center; }
.{{s}} h3 { margin: 0; font-size: var(--text-lg); }
.{{s}} header button { border: 0; background: var(--color-surface); border-radius: 50%; width: 28px; height: 28px; cursor: pointer; }
.{{s}} p { color: var(--color-text-muted); font-size: var(--text-sm); }
.{{s}} input { width: 100%; height: 38px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: var(--text-sm) var(--font-sans); }`,
  },
  Popover: {
    description: 'Rich content anchored to a trigger.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><strong>Shared with 4 people</strong><p>Anyone with the link can view.</p></div>`,
    css: `.{{s}} { position: relative; width: 240px; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised); box-shadow: var(--shadow-md); font: var(--text-sm) var(--font-sans); }
.{{s}}::before { content: ''; position: absolute; top: -6px; left: 24px; width: 10px; height: 10px; background: inherit; border-left: 1px solid var(--color-border); border-top: 1px solid var(--color-border); transform: rotate(45deg); }
.{{s}} p { margin: var(--space-1) 0 0; color: var(--color-text-muted); }`,
  },
  Toast: {
    description: 'A brief confirmation that fades away.',
    html: `<div class="{{s}}" role="status" data-doop-component="{{s}}"><span>✓</span> Changes saved <button>Undo</button></div>`,
    css: `.{{s}} { display: inline-flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-text); color: var(--color-bg); box-shadow: var(--shadow-lg); font: var(--text-sm) var(--font-sans); }
.{{s}} span { color: var(--color-success); }
.{{s}} button { border: 0; background: none; color: inherit; font: var(--weight-bold) var(--text-sm) var(--font-sans); text-decoration: underline; cursor: pointer; }`,
  },
  Tooltip: {
    description: 'A short label on hover or focus.',
    html: `<span class="{{s}}" data-tip="Copy link" data-doop-component="{{s}}"><button>🔗</button></span>`,
    css: `.{{s}} { position: relative; display: inline-flex; }
.{{s}} button { width: 34px; height: 34px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); cursor: pointer; }
.{{s}}::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); padding: 4px var(--space-2); border-radius: var(--radius-sm); background: var(--color-text); color: var(--color-bg); font: var(--text-xs) var(--font-sans); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity var(--duration) var(--ease); }
.{{s}}:hover::after, .{{s}}:focus-within::after { opacity: 1; }`,
  },
  Sheet: {
    description: 'A bottom sheet for mobile flows.',
    html: `<section class="{{s}}" data-doop-component="{{s}}"><span class="{{s}}__grip"></span><h3>Share</h3><p>Send this design to your team.</p></section>`,
    css: `.{{s}} { width: 375px; padding: var(--space-3) var(--space-5) var(--space-6); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: var(--color-surface-raised); box-shadow: var(--shadow-lg); font-family: var(--font-sans); }
.{{s}}__grip { display: block; width: 40px; height: 4px; margin: 0 auto var(--space-4); border-radius: var(--radius-full); background: var(--color-border); }
.{{s}} h3 { margin: 0 0 var(--space-1); font-size: var(--text-lg); }
.{{s}} p { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }`,
  },

  /* ---- pickers ---- */
  Autocomplete: {
    description: 'A text input suggesting matches as you type.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><input placeholder="Search a country" /><ul><li>Brazil</li><li>Portugal</li><li>Spain</li><li>Germany</li></ul></div>`,
    css: `.{{s}} { position: relative; width: 260px; font: var(--text-sm) var(--font-sans); }
.{{s}} input { width: 100%; height: 38px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font: inherit; }
.{{s}} ul { margin: var(--space-1) 0 0; padding: var(--space-1); list-style: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised); box-shadow: var(--shadow-md); }
.{{s}} li { padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); cursor: pointer; }
.{{s}} li:hover { background: var(--color-surface); }`,
    js: `elements.forEach(function (el) {
  var input = el.querySelector('input'), items = el.querySelectorAll('li')
  input.addEventListener('input', function () {
    var q = input.value.toLowerCase()
    items.forEach(function (li) { li.hidden = q && li.textContent.toLowerCase().indexOf(q) === -1 })
  })
  el.addEventListener('click', function (event) { var li = event.target.closest('li'); if (li) input.value = li.textContent })
})`,
  },
  ComboBox: {
    description: 'Pick from a list or type a value.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Framework</span><input list="{{s}}-options" placeholder="Choose or type" /><datalist id="{{s}}-options"><option value="React"></option><option value="Vue"></option><option value="Svelte"></option></datalist></label>`,
    css: field('{{s}}'),
  },
  Select: {
    description: 'Pick one value from a short list.',
    html: `<label class="{{s}}" data-doop-component="{{s}}"><span>Country</span><select><option>Brazil</option><option>Portugal</option><option>United States</option></select></label>`,
    css: field('{{s}}'),
  },

  /* ---- typography ---- */
  Kbd: {
    description: 'A keyboard key or shortcut.',
    html: `<span class="{{s}}" data-doop-component="{{s}}"><kbd>⌘</kbd><kbd>K</kbd></span>`,
    css: `.{{s}} { display: inline-flex; gap: 3px; }
.{{s}} kbd { min-width: 22px; height: 22px; padding: 0 6px; display: inline-grid; place-items: center; border-radius: 5px; background: var(--color-surface); box-shadow: inset 0 -1px 0 var(--color-border), 0 0 0 1px var(--color-border); font: var(--text-xs) var(--font-mono); color: var(--color-text-muted); }`,
  },
  Typography: {
    description: 'The type scale: headings, body and captions.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><h1>Display heading</h1><h2>Section heading</h2><p>Body copy sets the reading rhythm of every screen.</p><small>Caption · 2 min read</small></div>`,
    css: `.{{s}} { font-family: var(--font-sans); color: var(--color-text); }
.{{s}} h1 { margin: 0 0 var(--space-2); font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
.{{s}} h2 { margin: 0 0 var(--space-3); font-size: var(--text-xl); line-height: 1.25; }
.{{s}} p { margin: 0 0 var(--space-2); font-size: var(--text-md); line-height: 1.6; }
.{{s}} small { font-size: var(--text-xs); color: var(--color-text-muted); }`,
  },

  /* ---- utilities ---- */
  ScrollShadow: {
    description: 'A scroll area whose edges fade where content continues.',
    html: `<div class="{{s}}" data-doop-component="{{s}}"><p>Scroll me.</p><p>Line two</p><p>Line three</p><p>Line four</p><p>Line five</p><p>Line six</p><p>Line seven</p><p>Line eight</p></div>`,
    css: `.{{s}} { width: 240px; height: 160px; overflow-y: auto; padding: 0 var(--space-3); font: var(--text-sm) var(--font-sans);
  mask-image: linear-gradient(to bottom, transparent, #000 24px, #000 calc(100% - 24px), transparent); }`,
  },
}

const GENERIC: ComponentPreset = {
  description: '',
  html: `<div class="{{s}}" data-doop-component="{{s}}">Component</div>`,
  css: `.{{s}} { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); font: var(--text-sm) var(--font-sans); }`,
}

const fill = (text: string, slug: string) => text.replace(/\{\{s\}\}/g, slug)

/** The starter for a kind (or a blank one), written out for `slug`. */
export function presetFor(kind: string | undefined, slug: string): Required<ComponentPreset> {
  const preset = (kind && PRESETS[kind]) || GENERIC
  return {
    description: preset.description,
    html: fill(preset.html, slug),
    css: fill(preset.css, slug),
    js: preset.js ?? '',
    variants: (preset.variants ?? []).map((variant) => ({ name: variant.name, html: fill(variant.html, slug) })),
  }
}

export function hasPreset(kind: string): boolean {
  return kind in PRESETS
}

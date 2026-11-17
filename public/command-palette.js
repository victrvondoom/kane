// Command palette (Ctrl+K / ⌘K, and the Search entry on phones). Destinations and actions are real; project results come
// from the account's own /api/projects list. Keyboard: type to filter, ↑/↓ to move, Enter to run, Esc to close.
// The native <dialog> traps focus and returns it to the control that opened it.
const S = () => window.SP;

function staticItems({ openAgent, navigate }) {
  return [
    { label: 'Projects', hint: 'Go', keys: 'home dashboard projects', run: () => navigate('#/app') },
    { label: 'New project', hint: 'Go', keys: 'create add', run: () => navigate('#/new') },
    { label: 'On-call engineer — voice call screen', hint: 'Go', keys: 'oncall call voice incidents', run: () => navigate('#/oncall') },
    { label: 'SHIPPROOF ENGINEER — open conversation', hint: 'Agent', keys: 'agent engineer chat ask', run: () => openAgent() },
  ];
}

export function openPalette({ openAgent, navigate = (h) => { location.hash = h; }, onSignOut, onDemo } = {}) {
  const { h, api, toast } = S();
  const opener = document.activeElement;
  let items = staticItems({ openAgent, navigate }), shown = [], active = 0;
  const listId = 'palette-list';
  const input = h('input', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Search projects and commands', placeholder: 'Search projects, pages and actions…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { id: listId, role: 'listbox', class: 'palette-list', 'aria-label': 'Results' });
  const status = h('div', { class: 'small mute', role: 'status', 'aria-live': 'polite' });
  const dlg = h('dialog', { class: 'dlg palette', 'aria-label': 'Search and commands' },
    h('div', { class: 'stack-s' }, input, status, list, h('p', { class: 'small mute palette-foot' }, '↑ ↓ move · Enter run · Esc close')));

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => !q || `${it.label} ${it.keys || ''}`.toLowerCase().includes(q)).slice(0, 30);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((it, i) => h('li', { id: `pal-${i}`, role: 'option', 'aria-selected': String(i === active), class: i === active ? 'on' : '', onmousedown: (e) => { e.preventDefault(); choose(i); } },
      h('span', { class: 'grow' }, it.label), it.hint ? h('span', { class: 'small mute' }, it.hint) : null)));
    status.textContent = shown.length ? '' : 'No matches.';
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '');
  };
  const choose = (i) => { const it = shown[i]; if (!it) return; close(); Promise.resolve().then(() => it.run()).catch((e) => toast(e.message, true)); };
  const close = () => { dlg.close(); };
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  });
  dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // backdrop click

  document.body.append(dlg); dlg.showModal(); draw(); input.focus();

  // Projects and the account's own pages come from the server; nothing is invented.
  api('GET', '/projects').then(({ projects }) => {
    const pItems = projects.flatMap((p) => [
      { label: p.name, hint: 'Project', keys: `project ${p.name}`, run: () => navigate(`#/p/${p.id}`) },
      { label: `${p.name} · Failure analysis`, hint: 'Project', keys: `${p.name} failures failed`, run: () => navigate(`#/p/${p.id}/failures`) },
      { label: `${p.name} · Release intelligence`, hint: 'Project', keys: `${p.name} release blockers intelligence`, run: () => navigate(`#/p/${p.id}/intelligence`) },
    ]);
    items = [...pItems, ...items, { label: 'Judge demo — load and open', hint: 'Action', keys: 'demo judge', run: () => onDemo?.() }, { label: 'Sign out', hint: 'Action', keys: 'logout account', run: () => onSignOut?.() }];
    draw();
  }).catch(() => {});
}

/** Ctrl+K / ⌘K opens the palette from anywhere, unless a dialog is already open. Installed once. */
export function installPaletteShortcut(open) {
  if (window.__paletteShortcut) return;
  window.__paletteShortcut = true;
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault(); open();
    }
  });
}

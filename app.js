(() => {
  'use strict';

  /* ---------- Config ---------- */

  const STORAGE_KEY = 'contact-book.v2';
  const LEGACY_KEY = 'contact-book.v1';
  const VIEW_KEY = 'contact-book.view';
  const DISMISSED_KEY = 'contact-book.dismissed';
  const NOTIFIED_KEY = 'contact-book.notified';
  const SEED_URL = 'data/contacts.json';
  const UPCOMING_DAYS = 30;
  const LEAD_TIMES = [0, 1, 3, 7, 14];
  const VIEWS = ['list', 'tile', 'card'];

  const LABELS = {
    phones: ['Mobile', 'Home', 'Work', 'Other'],
    emails: ['Personal', 'Work', 'Other'],
    addresses: ['Home', 'Work', 'Other']
  };
  const ADD_TEXT = { phones: 'Add phone', emails: 'Add email', addresses: 'Add address' };

  // A relation stored on contact X as { id: Y, type } means "Y is X's <type>"
  const REL_TYPES = {
    parent:    { label: 'Parent',            role: 'Parent',    reverse: 'child' },
    child:     { label: 'Child',             role: 'Child',     reverse: 'parent' },
    spouse:    { label: 'Spouse or partner', role: 'Partner',   reverse: 'spouse' },
    sibling:   { label: 'Sibling',           role: 'Sibling',   reverse: 'sibling' },
    relative:  { label: 'Relative',          role: 'Relative',  reverse: 'relative' },
    friend:    { label: 'Friend',            role: 'Friend',    reverse: 'friend' },
    colleague: { label: 'Colleague',         role: 'Colleague', reverse: 'colleague' }
  };

  const KIND_LABEL = { birthday: 'Birthday', anniversary: 'Anniversary' };

  /* ---------- State ---------- */

  const state = {
    contacts: [],
    selectedId: null,
    mode: 'view',          // view | new | edit
    activeTag: null,
    query: '',
    draftTags: [],
    view: 'list'
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const els = {
    collection: $('#collection'),
    pane: $('#pane'),
    drawer: $('#drawer'),
    sheet: $('#reminderSheet'),
    reminderPane: $('#reminderPane'),
    reminderCount: $('#reminderCount'),
    search: $('#search'),
    tagFilter: $('#tagFilter'),
    upcoming: $('#upcoming'),
    count: $('#count'),
    toast: $('#toast'),
    importFile: $('#importFile')
  };

  /* ---------- Helpers ---------- */

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function uid() {
    return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
  }

  function isIso(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  }

  function byName(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

  function findContact(id) {
    return state.contacts.find(c => c.id === id) || null;
  }

  function primary(list) {
    return list.length ? list[0].value : '';
  }

  function uniqueTags(tags) {
    const seen = new Set();
    const out = [];
    for (const t of tags) {
      const v = String(t).trim().replace(/\s+/g, ' ');
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  function normEntries(list, fallbackLabel) {
    return (Array.isArray(list) ? list : [])
      .map(e => (typeof e === 'string'
        ? { label: fallbackLabel, value: e.trim() }
        : { label: String(e?.label || '').trim() || fallbackLabel, value: String(e?.value || '').trim() }))
      .filter(e => e.value);
  }

  function normReminder(r) {
    const days = Number(r?.days);
    return { on: r ? r.on !== false : true, days: LEAD_TIMES.includes(days) ? days : 1 };
  }

  // Accepts v2 records and v1 records (single phone/email/address strings)
  function normalize(c) {
    const now = new Date().toISOString();
    return {
      id: String(c.id || uid()),
      name: String(c.name || '').trim(),
      phones: normEntries(c.phones ?? (c.phone ? [c.phone] : []), 'Mobile'),
      emails: normEntries(c.emails ?? (c.email ? [c.email] : []), 'Personal'),
      addresses: normEntries(c.addresses ?? (c.address ? [c.address] : []), 'Home'),
      dob: isIso(c.dob) ? c.dob : '',
      anniversary: isIso(c.anniversary) ? c.anniversary : '',
      tags: uniqueTags(Array.isArray(c.tags) ? c.tags : []),
      relations: (Array.isArray(c.relations) ? c.relations : [])
        .filter(r => r && r.id && REL_TYPES[r.type])
        .map(r => ({ id: String(r.id), type: r.type })),
      reminders: {
        birthday: normReminder(c.reminders?.birthday),
        anniversary: normReminder(c.reminders?.anniversary)
      },
      createdAt: c.createdAt || now,
      updatedAt: c.updatedAt || now
    };
  }

  /* ---------- Relationships ---------- */

  // Drops broken links and makes every link two-way
  function repairRelations() {
    const ids = new Set(state.contacts.map(c => c.id));
    for (const c of state.contacts) {
      const seen = new Map();
      for (const r of c.relations) {
        if (r.id !== c.id && ids.has(r.id)) seen.set(r.id, r);
      }
      c.relations = [...seen.values()];
    }
    for (const c of state.contacts) {
      for (const r of c.relations) {
        const other = findContact(r.id);
        const want = REL_TYPES[r.type].reverse;
        const back = other.relations.find(x => x.id === c.id);
        if (!back) other.relations.push({ id: c.id, type: want });
        else if (back.type !== want) back.type = want;
      }
    }
  }

  // The saved contact's relations become the source of truth for every pair it is in
  function syncRelations(x) {
    for (const y of state.contacts) {
      if (y.id !== x.id) y.relations = y.relations.filter(r => r.id !== x.id);
    }
    for (const r of x.relations) {
      const y = findContact(r.id);
      if (y) y.relations.push({ id: x.id, type: REL_TYPES[r.type].reverse });
    }
  }

  function related(c, type) {
    return c.relations.filter(r => r.type === type).map(r => findContact(r.id)).filter(Boolean);
  }

  function uniqPeople(list, excludeId) {
    const map = new Map();
    for (const p of list) if (p.id !== excludeId) map.set(p.id, p);
    return [...map.values()].sort(byName);
  }

  /* ---------- Dates ---------- */

  function parseIso(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  function today0() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function isoToday() {
    const t = today0();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }

  function isLeap(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  // Feb 29 falls back to Feb 28 in non-leap years
  function dateIn(year, m, d) {
    return (m === 2 && d === 29 && !isLeap(year)) ? new Date(year, 1, 28) : new Date(year, m - 1, d);
  }

  function fmtDate(s) {
    const { y, m, d } = parseIso(s);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function fmtShort(date) {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function nextOccurrence(s) {
    const { y, m, d } = parseIso(s);
    const t = today0();
    let dt = dateIn(t.getFullYear(), m, d);
    if (dt < t) dt = dateIn(t.getFullYear() + 1, m, d);
    return { date: dt, days: Math.round((dt - t) / 86400000), years: dt.getFullYear() - y };
  }

  function yearsSince(s) {
    const { y, m, d } = parseIso(s);
    const t = today0();
    let n = t.getFullYear() - y;
    if (t < dateIn(t.getFullYear(), m, d)) n--;
    return n;
  }

  function whenLabel(days) {
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return `In ${days} days`;
  }

  function leadLabel(days) {
    if (days === 0) return 'on the day';
    if (days === 1) return '1 day before';
    return `${days} days before`;
  }

  function eventsFor(c) {
    const out = [];
    if (c.dob) out.push({ kind: 'birthday', o: nextOccurrence(c.dob) });
    if (c.anniversary) out.push({ kind: 'anniversary', o: nextOccurrence(c.anniversary) });
    return out;
  }

  function eventDetail(kind, o) {
    if (o.years <= 0) return '';
    return kind === 'birthday' ? `turns ${o.years}` : `${o.years} ${o.years === 1 ? 'year' : 'years'}`;
  }

  function nextEvent(c) {
    return eventsFor(c).sort((a, b) => a.o.days - b.o.days)[0] || null;
  }

  /* ---------- Storage ---------- */

  function readLS(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeLS(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }

  function loadSet(key) {
    try { return new Set(JSON.parse(readLS(key) || '[]')); } catch { return new Set(); }
  }

  function saveSet(key, set) {
    // keep the most recent 500 keys so the list doesn't grow forever
    writeLS(key, JSON.stringify([...set].slice(-500)));
  }

  function persist() {
    if (!writeLS(STORAGE_KEY, JSON.stringify(state.contacts))) {
      toast('This browser blocked saving. Use Export JSON to keep a copy.');
    }
  }

  async function load() {
    const view = readLS(VIEW_KEY);
    if (VIEWS.includes(view)) state.view = view;

    for (const key of [STORAGE_KEY, LEGACY_KEY]) {
      const saved = readLS(key);
      if (!saved) continue;
      try {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) {
          state.contacts = arr.map(normalize).filter(c => c.name);
          repairRelations();
          persist();
          return;
        }
      } catch { /* try the next source */ }
    }

    try {
      const res = await fetch(SEED_URL, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.contacts || []);
        state.contacts = arr.map(normalize).filter(c => c.name);
      }
    } catch {
      state.contacts = [];
    }
    repairRelations();
    persist();
  }

  /* ---------- Toast ---------- */

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  /* ---------- Reminders ---------- */

  function reminderKey(c, e) {
    return `${c.id}:${e.kind}:${e.o.date.getFullYear()}`;
  }

  function dueReminders() {
    const dismissed = loadSet(DISMISSED_KEY);
    const out = [];
    for (const c of state.contacts) {
      for (const e of eventsFor(c)) {
        const r = c.reminders[e.kind];
        if (!r.on || e.o.days > r.days) continue;
        const key = reminderKey(c, e);
        if (!dismissed.has(key)) out.push({ c, ...e, key });
      }
    }
    return out.sort((a, b) => a.o.days - b.o.days || byName(a.c, b.c));
  }

  function reminderSentence(d) {
    const when = whenLabel(d.o.days).toLowerCase();
    const detail = eventDetail(d.kind, d.o);
    return `${KIND_LABEL[d.kind]} ${when}${detail ? ', ' + detail : ''}`;
  }

  function renderReminderBadge() {
    const n = dueReminders().length;
    els.reminderCount.hidden = n === 0;
    els.reminderCount.textContent = n;
    $('#remindersBtn').setAttribute('aria-label', n ? `Reminders, ${n} due` : 'Reminders');
  }

  function notifyDue() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const notified = loadSet(NOTIFIED_KEY);
    for (const d of dueReminders()) {
      if (notified.has(d.key)) continue;
      try {
        new Notification(d.c.name, { body: reminderSentence(d), tag: d.key });
        notified.add(d.key);
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
    saveSet(NOTIFIED_KEY, notified);
  }

  function notificationBlock() {
    if (!('Notification' in window)) {
      return '<p>This browser doesn\u2019t support notifications. Use the calendar file below instead.</p>';
    }
    if (Notification.permission === 'granted') {
      return '<p>Notifications are on. You\u2019ll get one for each due reminder while this page is open in a tab.</p>';
    }
    if (Notification.permission === 'denied') {
      return '<p>Notifications are blocked for this site. Allow them in your browser\u2019s site settings, then reload.</p>';
    }
    return `<p>Get a browser notification for each due reminder while this page is open in a tab.</p>
            <button type="button" class="btn ghost" data-action="enable-notifications">Turn on notifications</button>`;
  }

  function renderReminderSheet() {
    const due = dueReminders();
    els.reminderPane.innerHTML = `
      <div class="sheet-head">
        <h2 tabindex="-1">Reminders</h2>
        <button type="button" class="btn ghost small" data-action="close-sheet">Close</button>
      </div>
      ${due.length
        ? `<ul class="due-list">${due.map(d => `
            <li class="due-item">
              <span class="event-date" aria-hidden="true">
                <span class="event-day">${d.o.date.getDate()}</span>
                <span class="event-month">${d.o.date.toLocaleDateString(undefined, { month: 'short' })}</span>
              </span>
              <span class="due-text">
                <strong>${esc(d.c.name)}</strong>
                <span>${esc(reminderSentence(d))}</span>
              </span>
              <span class="due-actions">
                <button type="button" class="btn ghost small" data-open="${esc(d.c.id)}">Open</button>
                <button type="button" class="btn ghost small" data-dismiss="${esc(d.key)}">Dismiss</button>
              </span>
            </li>`).join('')}</ul>`
        : '<p class="muted">Nothing due right now. A reminder shows up here based on the lead time set on each contact.</p>'}
      <section class="sheet-section">
        <h3 class="section-title">Browser notifications</h3>
        ${notificationBlock()}
      </section>
      <section class="sheet-section">
        <h3 class="section-title">Calendar reminders</h3>
        <p>Download every birthday and anniversary as yearly calendar events, with alerts matching each contact\u2019s reminder setting. Import the file into Google Calendar, Outlook or Apple Calendar to get reminders even when this app is closed.</p>
        <button type="button" class="btn primary" data-action="download-ics">Download calendar file (.ics)</button>
      </section>`;
  }

  function openReminders() {
    renderReminderSheet();
    if (!els.sheet.open) els.sheet.showModal();
    $('h2', els.reminderPane).focus();
  }

  /* ---------- Calendar export ---------- */

  function icsText(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  function buildIcs() {
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Contact Book//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Contacts'];

    for (const c of state.contacts) {
      for (const kind of ['birthday', 'anniversary']) {
        const iso = kind === 'birthday' ? c.dob : c.anniversary;
        if (!iso) continue;
        const { y, m, d } = parseIso(iso);
        const rrule = (m === 2 && d === 29) ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'RRULE:FREQ=YEARLY';
        const summary = `${c.name}\u2019s ${kind}`;
        lines.push(
          'BEGIN:VEVENT',
          `UID:${c.id}-${kind}@contact-book`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
          rrule,
          `SUMMARY:${icsText(summary)}`,
          'TRANSP:TRANSPARENT'
        );
        const r = c.reminders[kind];
        if (r.on) {
          // alert at 9:00 on the day, or 9:00 N days before
          const trigger = r.days === 0 ? 'PT9H' : `-PT${r.days * 24 - 9}H`;
          lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, `TRIGGER:${trigger}`, 'END:VALARM');
        }
        lines.push('END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- Rendering: header, band, filters ---------- */

  function allTags() {
    const map = new Map();
    for (const c of state.contacts) {
      for (const t of c.tags) {
        const key = t.toLowerCase();
        const entry = map.get(key);
        if (entry) entry.count++;
        else map.set(key, { name: t, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    const tag = state.activeTag ? state.activeTag.toLowerCase() : null;
    return state.contacts
      .filter(c => {
        if (tag && !c.tags.some(t => t.toLowerCase() === tag)) return false;
        if (!q) return true;
        const hay = [c.name, ...c.tags, ...c.phones.map(e => e.value), ...c.emails.map(e => e.value), ...c.addresses.map(e => e.value)];
        return hay.some(v => v && v.toLowerCase().includes(q));
      })
      .sort(byName);
  }

  function renderUpcoming() {
    const events = [];
    for (const c of state.contacts) {
      for (const e of eventsFor(c)) {
        if (e.o.days <= UPCOMING_DAYS) events.push({ c, ...e });
      }
    }
    events.sort((a, b) => a.o.days - b.o.days || byName(a.c, b.c));

    const head = `<h2 class="upcoming-title">Next ${UPCOMING_DAYS} days</h2>`;
    if (!events.length) {
      els.upcoming.innerHTML = head + '<p class="upcoming-empty">No birthdays or anniversaries coming up.</p>';
      return;
    }

    els.upcoming.innerHTML = head + `<ol class="upcoming-list">${events.map(e => {
      const detail = eventDetail(e.kind, e.o);
      return `
      <li>
        <button type="button" class="event" data-id="${esc(e.c.id)}">
          <span class="event-date" aria-hidden="true">
            <span class="event-day">${e.o.date.getDate()}</span>
            <span class="event-month">${e.o.date.toLocaleDateString(undefined, { month: 'short' })}</span>
          </span>
          <span class="event-text">
            <span class="event-name">${esc(e.c.name)}</span>
            <span class="event-kind">${KIND_LABEL[e.kind]}${detail ? ', ' + detail : ''}</span>
            <span class="event-when">${whenLabel(e.o.days)}</span>
          </span>
        </button>
      </li>`;
    }).join('')}</ol>`;
  }

  function renderTagFilter() {
    const tags = allTags();
    if (state.activeTag && !tags.some(t => t.name.toLowerCase() === state.activeTag.toLowerCase())) {
      state.activeTag = null;
    }
    els.tagFilter.innerHTML = tags.map(t => {
      const on = !!state.activeTag && t.name.toLowerCase() === state.activeTag.toLowerCase();
      return `<button type="button" class="filter-chip${on ? ' is-on' : ''}" data-tag="${esc(t.name)}" aria-pressed="${on}">${esc(t.name)} <span>${t.count}</span></button>`;
    }).join('');
  }

  /* ---------- Rendering: collection (list / tile / card) ---------- */

  function nextLabel(c) {
    const e = nextEvent(c);
    return e ? `${KIND_LABEL[e.kind]}, ${fmtShort(e.o.date)}` : '';
  }

  function itemHtml(c) {
    const phone = primary(c.phones);
    const email = primary(c.emails);
    const address = primary(c.addresses);
    const active = c.id === state.selectedId ? ' is-active' : '';
    const avatar = `<span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>`;

    if (state.view === 'tile') {
      return `
        <button type="button" class="item${active}" data-id="${esc(c.id)}">
          <span class="avatar large" aria-hidden="true">${esc(initials(c.name))}</span>
          <span class="item-main">
            <span class="item-name">${esc(c.name)}</span>
            <span class="item-sub">${esc(phone || email || c.tags[0] || '')}</span>
          </span>
        </button>`;
    }

    if (state.view === 'card') {
      const line = (label, value) => value
        ? `<span class="card-line"><span>${label}</span><span>${esc(value)}</span></span>` : '';
      const next = nextLabel(c);
      return `
        <button type="button" class="item${active}" data-id="${esc(c.id)}">
          <span class="card-head">
            ${avatar}
            <span class="item-main">
              <span class="card-name">${esc(c.name)}</span>
              ${c.tags.length ? `<span class="pill-row">${c.tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</span>` : ''}
            </span>
          </span>
          <span class="card-lines">
            ${line('Phone', phone)}
            ${line('Email', email)}
            ${line('Address', address.split('\n')[0])}
            ${!phone && !email && !address ? '<span class="muted">No contact details yet</span>' : ''}
          </span>
          ${next ? `<span class="card-foot">${esc(next)}</span>` : ''}
        </button>`;
    }

    return `
      <button type="button" class="item${active}" data-id="${esc(c.id)}">
        ${avatar}
        <span class="item-main">
          <span class="item-name">${esc(c.name)}</span>
          <span class="item-sub">${esc(phone || email || '')}</span>
          ${c.tags.length ? `<span class="item-tags">${esc(c.tags.join(', '))}</span>` : ''}
        </span>
        <span class="col">${esc(phone)}</span>
        <span class="col">${esc(email)}</span>
        <span class="col">${esc(nextLabel(c))}</span>
      </button>`;
  }

  function renderCollection() {
    const total = state.contacts.length;
    els.count.textContent = `${total} ${total === 1 ? 'contact' : 'contacts'}`;
    els.collection.className = `collection view-${state.view}`;
    $$('.view-switch [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));

    const items = filtered();
    if (!items.length) {
      els.collection.innerHTML = `<p class="list-empty">${total ? 'No contacts match this search.' : 'No contacts yet. Use New contact to add your first one.'}</p>`;
      return;
    }

    let html = state.view === 'list'
      ? '<div class="list-head" aria-hidden="true"><span></span><span>Name</span><span>Phone</span><span>Email</span><span>Next date</span></div>'
      : '';
    let letter = '';
    for (const c of items) {
      const first = (c.name[0] || '#').toUpperCase();
      const l = /[A-Z]/.test(first) ? first : '#';
      // letter headers only in list view; in tiles and cards they leave gaps in the grid
      if (state.view === 'list' && l !== letter) {
        letter = l;
        html += `<div class="letter" aria-hidden="true">${l}</div>`;
      }
      html += itemHtml(c);
    }
    els.collection.innerHTML = html;
  }

  /* ---------- Rendering: detail ---------- */

  function treeNode(p, role, isSelf = false) {
    const attrs = isSelf ? 'aria-current="true"' : `data-open="${esc(p.id)}"`;
    return `
      <button type="button" class="tree-node${isSelf ? ' is-self' : ''}" ${attrs}>
        <span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="tree-node-text">
          <span class="tree-node-name">${esc(p.name)}</span>
          <span class="tree-node-role">${role}</span>
        </span>
      </button>`;
  }

  function treeGen(caption, people, role) {
    if (!people.length) return '';
    return `
      <div class="tree-gen">
        <span class="tree-cap">${caption}</span>
        <div class="tree-nodes">${people.map(p => treeNode(p, role)).join('')}</div>
      </div>`;
  }

  function relationshipHtml(c) {
    const parents = uniqPeople(related(c, 'parent'), c.id);
    const grandparents = uniqPeople(parents.flatMap(p => related(p, 'parent')), c.id);
    const partners = uniqPeople(related(c, 'spouse'), c.id);
    const siblings = uniqPeople([...related(c, 'sibling'), ...parents.flatMap(p => related(p, 'child'))], c.id);
    const children = uniqPeople(related(c, 'child'), c.id);
    const grandchildren = uniqPeople(children.flatMap(ch => related(ch, 'child')), c.id);
    const others = c.relations
      .filter(r => !['parent', 'child', 'spouse', 'sibling'].includes(r.type))
      .map(r => ({ p: findContact(r.id), type: r.type }))
      .filter(x => x.p)
      .sort((a, b) => byName(a.p, b.p));

    const hasFamily = parents.length || partners.length || siblings.length || children.length;

    const tree = hasFamily
      ? `<div class="tree">
          ${treeGen('Grandparents', grandparents, 'Grandparent')}
          ${treeGen('Parents', parents, 'Parent')}
          <div class="tree-gen">
            <div class="tree-nodes">
              ${siblings.map(p => treeNode(p, 'Sibling')).join('')}
              ${treeNode(c, 'This contact', true)}
              ${partners.map(p => treeNode(p, 'Partner')).join('')}
            </div>
          </div>
          ${treeGen('Children', children, 'Child')}
          ${treeGen('Grandchildren', grandchildren, 'Grandchild')}
        </div>`
      : '<p class="tree-empty">No family links yet. Edit this contact to connect parents, children, a partner or siblings.</p>';

    const connections = others.length
      ? `<div class="connections">${others.map(x => treeNode(x.p, REL_TYPES[x.type].role)).join('')}</div>`
      : '';

    return `<h3 class="section-title">Relationships</h3>${tree}${connections}`;
  }

  function renderDetail(c) {
    const rows = [];
    const entries = (list, render) => `<ul class="entries">${list.map(e => `<li>${render(e)}<span class="entry-label">${esc(e.label)}</span></li>`).join('')}</ul>`;

    if (c.phones.length) {
      rows.push(['Phone', entries(c.phones, e => `<a href="tel:${esc(e.value.replace(/[^\d+]/g, ''))}">${esc(e.value)}</a>`)]);
    }
    if (c.emails.length) {
      rows.push(['Email', entries(c.emails, e => `<a href="mailto:${esc(e.value)}">${esc(e.value)}</a>`)]);
    }
    if (c.addresses.length) {
      rows.push(['Address', entries(c.addresses, e => `<span class="pre">${esc(e.value)}</span>`)]);
    }
    for (const kind of ['birthday', 'anniversary']) {
      const iso = kind === 'birthday' ? c.dob : c.anniversary;
      if (!iso) continue;
      const n = yearsSince(iso);
      const extra = n < 0 ? '' : kind === 'birthday' ? ` <span class="muted">(age ${n})</span>` : ` <span class="muted">(${n} ${n === 1 ? 'year' : 'years'})</span>`;
      const r = c.reminders[kind];
      rows.push([
        kind === 'birthday' ? 'Date of birth' : 'Anniversary',
        `${fmtDate(iso)}${extra}<span class="reminder-note">${r.on ? `Reminder ${leadLabel(r.days)}` : 'No reminder'}</span>`
      ]);
    }

    els.pane.innerHTML = `
      <article class="detail">
        <div class="pane-top">
          <button type="button" class="btn ghost small" data-action="close">Close</button>
        </div>
        <header class="detail-head">
          <span class="avatar large" aria-hidden="true">${esc(initials(c.name))}</span>
          <div>
            <h2 class="detail-name" tabindex="-1">${esc(c.name)}</h2>
            ${c.tags.length ? `<ul class="tags">${c.tags.map(t => `<li><button type="button" class="tag" data-tag="${esc(t)}" title="Show everyone tagged ${esc(t)}">${esc(t)}</button></li>`).join('')}</ul>` : ''}
          </div>
        </header>
        ${rows.length
          ? `<dl class="fields">${rows.map(([k, v]) => `<div class="field-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`
          : '<p class="muted">No details added yet.</p>'}
        ${relationshipHtml(c)}
        <div class="detail-actions">
          <button type="button" class="btn primary" data-action="edit">Edit contact</button>
          <button type="button" class="btn danger" data-action="delete">Delete contact</button>
        </div>
      </article>`;
    $('.detail-name', els.pane).focus();
  }

  /* ---------- Rendering: form ---------- */

  function labelOptions(kind, current) {
    const opts = [...LABELS[kind]];
    if (current && !opts.includes(current)) opts.push(current);
    return opts.map(l => `<option${l === current ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }

  function mvRow(kind, entry = { label: LABELS[kind][0], value: '' }) {
    const field = kind === 'addresses'
      ? `<textarea class="mv-value" rows="2" aria-label="Address">${esc(entry.value)}</textarea>`
      : `<input class="mv-value" type="${kind === 'phones' ? 'tel' : 'email'}" value="${esc(entry.value)}" aria-label="${kind === 'phones' ? 'Phone number' : 'Email address'}">`;
    return `
      <div class="mv-row">
        <select class="mv-label" aria-label="Label">${labelOptions(kind, entry.label)}</select>
        ${field}
        <button type="button" class="icon-btn" data-remove-row aria-label="Remove">&times;</button>
      </div>`;
  }

  function mvBlock(kind, title, list) {
    const rows = list.length ? list : [undefined];
    return `
      <div class="field full">
        <span class="field-label">${title}</span>
        <div class="mv" data-kind="${kind}">${rows.map(e => mvRow(kind, e)).join('')}</div>
        <div><button type="button" class="link-btn" data-add="${kind}">${ADD_TEXT[kind]}</button></div>
      </div>`;
  }

  function relRow(selfId, rel = { id: '', type: 'parent' }) {
    const people = state.contacts.filter(p => p.id !== selfId).sort(byName);
    return `
      <div class="mv-row rel-row">
        <select class="rel-person" aria-label="Person">
          <option value="">Choose a person</option>
          ${people.map(p => `<option value="${esc(p.id)}"${p.id === rel.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select class="rel-type" aria-label="Relationship to this contact">
          ${Object.entries(REL_TYPES).map(([k, v]) => `<option value="${k}"${k === rel.type ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn" data-remove-row aria-label="Remove relationship">&times;</button>
      </div>`;
  }

  function reminderCtl(kind, r) {
    return `
      <div class="reminder-ctl">
        <label><input type="checkbox" name="${kind}-remind"${r.on ? ' checked' : ''}> Remind me</label>
        <select name="${kind}-days" aria-label="${KIND_LABEL[kind]} reminder timing">
          ${LEAD_TIMES.map(d => `<option value="${d}"${d === r.days ? ' selected' : ''}>${leadLabel(d)}</option>`).join('')}
        </select>
      </div>`;
  }

  function renderTagChips() {
    const box = $('#tagChips');
    if (!box) return;
    box.innerHTML = state.draftTags.map((t, i) => `
      <span class="chip">${esc(t)}<button type="button" class="chip-x" data-remove="${i}" aria-label="Remove tag ${esc(t)}">&times;</button></span>`
    ).join('');
  }

  function addDraftTags(text) {
    state.draftTags = uniqueTags([...state.draftTags, ...String(text || '').split(',')]);
    renderTagChips();
  }

  function renderForm(c) {
    const isNew = !c.id;
    const base = isNew ? normalize({ name: '' }) : c;
    state.draftTags = [...base.tags];
    const others = state.contacts.filter(p => p.id !== base.id).length;

    els.pane.innerHTML = `
      <form id="contactForm" class="form" novalidate>
        <h2>${isNew ? 'New contact' : 'Edit contact'}</h2>
        <div class="form-grid">
          <label class="field full">
            <span class="field-label">Name</span>
            <input name="name" autocomplete="off" value="${esc(base.name)}" required>
          </label>

          ${mvBlock('phones', 'Phone numbers', base.phones)}
          ${mvBlock('emails', 'Email addresses', base.emails)}
          ${mvBlock('addresses', 'Addresses', base.addresses)}

          <div class="field date-block">
            <label class="field">
              <span class="field-label">Date of birth</span>
              <input name="dob" type="date" value="${esc(base.dob)}">
            </label>
            ${reminderCtl('birthday', base.reminders.birthday)}
          </div>
          <div class="field date-block">
            <label class="field">
              <span class="field-label">Anniversary</span>
              <input name="anniversary" type="date" value="${esc(base.anniversary)}">
            </label>
            ${reminderCtl('anniversary', base.reminders.anniversary)}
          </div>

          <div class="field full">
            <span class="field-label" id="tagsLabel">Tags</span>
            <div class="tag-input" id="tagBox">
              <span id="tagChips"></span>
              <input id="tagEntry" list="tagSuggestions" placeholder="Type a tag, press Enter" aria-labelledby="tagsLabel" autocomplete="off">
            </div>
            <datalist id="tagSuggestions">${allTags().map(t => `<option value="${esc(t.name)}"></option>`).join('')}</datalist>
            <p class="hint">Separate tags with Enter or a comma. Backspace removes the last one.</p>
          </div>

          <div class="field full">
            <span class="field-label">Relationships</span>
            ${others
              ? `<p class="hint">Pick a person and how they\u2019re related to this contact. The link is added to their profile too.</p>
                 <div class="mv" id="relRows">${base.relations.map(r => relRow(base.id, r)).join('')}</div>
                 <div><button type="button" class="link-btn" data-add="relation">Add relationship</button></div>`
              : '<p class="hint">Add more contacts to start linking people together.</p>'}
          </div>
        </div>
        <p class="form-error" id="formError" role="alert"></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">${isNew ? 'Add contact' : 'Save changes'}</button>
          <button type="button" class="btn ghost" data-action="cancel">Cancel</button>
        </div>
      </form>`;

    renderTagChips();

    const form = $('#contactForm');
    const entry = $('#tagEntry');

    entry.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addDraftTags(entry.value);
        entry.value = '';
      } else if (e.key === 'Backspace' && !entry.value && state.draftTags.length) {
        state.draftTags.pop();
        renderTagChips();
      }
    });

    entry.addEventListener('blur', () => {
      if (entry.value.trim()) {
        addDraftTags(entry.value);
        entry.value = '';
      }
    });

    $('#tagBox').addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (btn) {
        state.draftTags.splice(Number(btn.dataset.remove), 1);
        renderTagChips();
        entry.focus();
      } else if (e.target.id === 'tagBox') {
        entry.focus();
      }
    });

    form.addEventListener('click', e => {
      const add = e.target.closest('[data-add]');
      if (add) {
        const kind = add.dataset.add;
        const holder = kind === 'relation' ? $('#relRows') : $(`.mv[data-kind="${kind}"]`, form);
        holder.insertAdjacentHTML('beforeend', kind === 'relation' ? relRow(base.id) : mvRow(kind));
        const last = holder.lastElementChild;
        (last.querySelector('.mv-value') || last.querySelector('select')).focus();
        return;
      }
      const remove = e.target.closest('[data-remove-row]');
      if (remove) {
        const row = remove.closest('.mv-row');
        const holder = row.parentElement;
        row.remove();
        // keep one empty row for phones, emails and addresses
        if (holder.dataset.kind && !holder.children.length) holder.insertAdjacentHTML('beforeend', mvRow(holder.dataset.kind));
      }
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      addDraftTags(entry.value);
      entry.value = '';
      saveForm(form, base, isNew);
    });

    form.elements.name.focus();
  }

  function renderPane() {
    if (state.mode === 'new') return renderForm({});
    const c = findContact(state.selectedId);
    if (!c) return closeDrawer();
    if (state.mode === 'edit') return renderForm(c);
    return renderDetail(c);
  }

  function render() {
    renderUpcoming();
    renderTagFilter();
    renderCollection();
    renderReminderBadge();
    if (els.drawer.open) renderPane();
  }

  /* ---------- Drawer ---------- */

  function openDrawer() {
    if (!els.drawer.open) els.drawer.showModal();
    renderPane();
  }

  function closeDrawer() {
    if (els.drawer.open) els.drawer.close();
  }

  function selectContact(id) {
    if (els.sheet.open) els.sheet.close();
    state.selectedId = id;
    state.mode = 'view';
    renderCollection();
    openDrawer();
  }

  /* ---------- Actions ---------- */

  function showError(form, msg, el) {
    $('#formError').textContent = msg;
    $$('[aria-invalid]', form).forEach(x => x.removeAttribute('aria-invalid'));
    if (el) {
      el.setAttribute('aria-invalid', 'true');
      el.focus();
    }
  }

  function collectEntries(form, kind) {
    return $$(`.mv[data-kind="${kind}"] .mv-row`, form).map(row => ({
      label: $('.mv-label', row).value,
      value: $('.mv-value', row).value.trim(),
      el: $('.mv-value', row)
    })).filter(e => e.value);
  }

  function saveForm(form, original, isNew) {
    const name = form.elements.name.value.trim();
    const phones = collectEntries(form, 'phones');
    const emails = collectEntries(form, 'emails');
    const addresses = collectEntries(form, 'addresses');
    const dob = form.elements.dob.value;
    const anniversary = form.elements.anniversary.value;

    if (!name) return showError(form, 'Add a name to save this contact.', form.elements.name);

    const badEmail = emails.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.value));
    if (badEmail) return showError(form, 'Enter a valid email address, like name@example.com.', badEmail.el);

    if (dob && dob > isoToday()) return showError(form, 'Date of birth can\u2019t be in the future.', form.elements.dob);

    const relMap = new Map();
    for (const row of $$('.rel-row', form)) {
      const id = $('.rel-person', row).value;
      if (id) relMap.set(id, { id, type: $('.rel-type', row).value });
    }

    const strip = list => list.map(({ label, value }) => ({ label, value }));
    const data = {
      name,
      phones: strip(phones),
      emails: strip(emails),
      addresses: strip(addresses),
      dob,
      anniversary,
      tags: [...state.draftTags],
      relations: [...relMap.values()],
      reminders: {
        birthday: { on: form.elements['birthday-remind'].checked, days: Number(form.elements['birthday-days'].value) },
        anniversary: { on: form.elements['anniversary-remind'].checked, days: Number(form.elements['anniversary-days'].value) }
      }
    };

    let saved;
    if (isNew) {
      saved = normalize(data);
      state.contacts.push(saved);
    } else {
      saved = findContact(original.id);
      Object.assign(saved, normalize({ ...saved, ...data, updatedAt: new Date().toISOString() }));
    }
    saved.relations = saved.relations.filter(r => r.id !== saved.id && findContact(r.id));
    syncRelations(saved);

    state.selectedId = saved.id;
    state.mode = 'view';
    persist();
    render();
    notifyDue();
    toast(isNew ? 'Contact added' : 'Changes saved');
  }

  function cancelForm() {
    if (state.mode === 'new') {
      state.mode = 'view';
      if (state.selectedId && findContact(state.selectedId)) renderPane();
      else closeDrawer();
      return;
    }
    state.mode = 'view';
    renderPane();
  }

  function deleteSelected() {
    const c = findContact(state.selectedId);
    if (!c) return;
    if (!confirm(`Delete ${c.name}? Their relationship links will be removed too. This can\u2019t be undone.`)) return;
    state.contacts = state.contacts.filter(x => x.id !== c.id);
    for (const other of state.contacts) other.relations = other.relations.filter(r => r.id !== c.id);
    state.selectedId = null;
    state.mode = 'view';
    persist();
    closeDrawer();
    render();
    toast('Contact deleted');
  }

  function setTagFilter(tag) {
    const same = state.activeTag && tag && state.activeTag.toLowerCase() === tag.toLowerCase();
    state.activeTag = same ? null : tag;
    renderTagFilter();
    renderCollection();
  }

  function setView(view) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    writeLS(VIEW_KEY, view);
    renderCollection();
  }

  function exportJson() {
    const payload = { version: 2, exportedAt: new Date().toISOString(), contacts: state.contacts };
    download(JSON.stringify(payload, null, 2), `contacts-${isoToday()}.json`, 'application/json');
    toast('Contacts exported');
  }

  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : data.contacts;
      if (!Array.isArray(arr)) throw new Error('No contacts array');

      const incoming = arr.map(normalize).filter(c => c.name);
      const byId = new Map(state.contacts.map(c => [c.id, c]));
      let added = 0;
      let updated = 0;
      for (const c of incoming) {
        if (byId.has(c.id)) updated++;
        else added++;
        byId.set(c.id, c);
      }
      state.contacts = [...byId.values()];
      repairRelations();
      persist();
      render();
      notifyDue();
      toast(`Imported ${added} new, ${updated} updated`);
    } catch {
      toast('That file isn\u2019t a valid contacts JSON file.');
    }
  }

  /* ---------- Events ---------- */

  els.collection.addEventListener('click', e => {
    const btn = e.target.closest('[data-id]');
    if (btn) selectContact(btn.dataset.id);
  });

  els.upcoming.addEventListener('click', e => {
    const btn = e.target.closest('[data-id]');
    if (btn) selectContact(btn.dataset.id);
  });

  els.tagFilter.addEventListener('click', e => {
    const btn = e.target.closest('[data-tag]');
    if (btn) setTagFilter(btn.dataset.tag);
  });

  $('.view-switch').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderCollection();
  });

  els.pane.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) {
      selectContact(open.dataset.open);
      return;
    }

    const tagBtn = e.target.closest('.tag[data-tag]');
    if (tagBtn) {
      state.activeTag = null;
      setTagFilter(tagBtn.dataset.tag);
      closeDrawer();
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'edit':
        state.mode = 'edit';
        renderPane();
        break;
      case 'delete':
        deleteSelected();
        break;
      case 'cancel':
        cancelForm();
        break;
      case 'close':
        closeDrawer();
        break;
    }
  });

  // Escape inside a form returns to the detail view instead of closing
  els.drawer.addEventListener('cancel', e => {
    if (state.mode === 'edit') {
      e.preventDefault();
      cancelForm();
    }
  });

  // Backdrop click closes, but never while a form is open
  els.drawer.addEventListener('click', e => {
    if (e.target === els.drawer && state.mode === 'view') closeDrawer();
  });

  els.drawer.addEventListener('close', () => {
    state.mode = 'view';
    state.selectedId = null;
    renderCollection();
  });

  els.reminderPane.addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open) {
      selectContact(open.dataset.open);
      return;
    }

    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) {
      const set = loadSet(DISMISSED_KEY);
      set.add(dismiss.dataset.dismiss);
      saveSet(DISMISSED_KEY, set);
      renderReminderSheet();
      renderReminderBadge();
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'close-sheet') els.sheet.close();
    if (btn.dataset.action === 'download-ics') {
      download(buildIcs(), 'contacts-reminders.ics', 'text/calendar');
      toast('Calendar file downloaded');
    }
    if (btn.dataset.action === 'enable-notifications') {
      await Notification.requestPermission();
      renderReminderSheet();
      notifyDue();
    }
  });

  els.sheet.addEventListener('click', e => {
    if (e.target === els.sheet) els.sheet.close();
  });

  $('#remindersBtn').addEventListener('click', openReminders);

  $('#newBtn').addEventListener('click', () => {
    state.mode = 'new';
    openDrawer();
  });

  $('#exportBtn').addEventListener('click', exportJson);
  $('#importBtn').addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files[0];
    if (file) await importJson(file);
    els.importFile.value = '';
  });

  /* ---------- Start ---------- */

  load().then(() => {
    render();
    notifyDue();
    // re-check hourly so reminders roll over at midnight while the tab stays open
    setInterval(() => {
      renderUpcoming();
      renderReminderBadge();
      notifyDue();
    }, 60 * 60 * 1000);
  });
})();


// ============================================================
// OLD CODE (v1) - kept for reference, not executed
// ============================================================
// (() => {
//   'use strict';
// 
//   const STORAGE_KEY = 'contact-book.v1';
//   const SEED_URL = 'data/contacts.json';
//   const UPCOMING_DAYS = 30;
// 
//   const state = {
//     contacts: [],
//     selectedId: null,
//     mode: 'view',          // view | new | edit
//     activeTag: null,
//     query: '',
//     draftTags: []
//   };
// 
//   const $ = (sel, root = document) => root.querySelector(sel);
//   const els = {
//     list: $('#list'),
//     pane: $('#pane'),
//     search: $('#search'),
//     tagFilter: $('#tagFilter'),
//     upcoming: $('#upcoming'),
//     count: $('#count'),
//     toast: $('#toast'),
//     importFile: $('#importFile')
//   };
// 
//   /* ---------- Helpers ---------- */
// 
//   function esc(v) {
//     return String(v ?? '').replace(/[&<>"']/g, ch => (
//       { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
//     ));
//   }
// 
//   function uid() {
//     return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
//   }
// 
//   function initials(name) {
//     return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
//   }
// 
//   function isIso(s) {
//     return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
//   }
// 
//   function uniqueTags(tags) {
//     const seen = new Set();
//     const out = [];
//     for (const t of tags) {
//       const v = String(t).trim().replace(/\s+/g, ' ');
//       if (!v) continue;
//       const key = v.toLowerCase();
//       if (seen.has(key)) continue;
//       seen.add(key);
//       out.push(v);
//     }
//     return out;
//   }
// 
//   function normalize(c) {
//     const now = new Date().toISOString();
//     return {
//       id: c.id || uid(),
//       name: String(c.name || '').trim(),
//       address: String(c.address || '').trim(),
//       phone: String(c.phone || '').trim(),
//       email: String(c.email || '').trim(),
//       dob: isIso(c.dob) ? c.dob : '',
//       anniversary: isIso(c.anniversary) ? c.anniversary : '',
//       tags: uniqueTags(Array.isArray(c.tags) ? c.tags : []),
//       createdAt: c.createdAt || now,
//       updatedAt: c.updatedAt || now
//     };
//   }
// 
//   /* ---------- Dates ---------- */
// 
//   function parseIso(s) {
//     const [y, m, d] = s.split('-').map(Number);
//     return { y, m, d };
//   }
// 
//   function today0() {
//     const t = new Date();
//     return new Date(t.getFullYear(), t.getMonth(), t.getDate());
//   }
// 
//   function isoToday() {
//     const t = today0();
//     return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
//   }
// 
//   function isLeap(y) {
//     return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
//   }
// 
//   // Feb 29 falls back to Feb 28 in non-leap years
//   function dateIn(year, m, d) {
//     return (m === 2 && d === 29 && !isLeap(year)) ? new Date(year, 1, 28) : new Date(year, m - 1, d);
//   }
// 
//   function fmtDate(s) {
//     const { y, m, d } = parseIso(s);
//     return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
//   }
// 
//   function nextOccurrence(s) {
//     const { y, m, d } = parseIso(s);
//     const t = today0();
//     let dt = dateIn(t.getFullYear(), m, d);
//     if (dt < t) dt = dateIn(t.getFullYear() + 1, m, d);
//     return { date: dt, days: Math.round((dt - t) / 86400000), years: dt.getFullYear() - y };
//   }
// 
//   function yearsSince(s) {
//     const { y, m, d } = parseIso(s);
//     const t = today0();
//     let n = t.getFullYear() - y;
//     if (t < dateIn(t.getFullYear(), m, d)) n--;
//     return n;
//   }
// 
//   function whenLabel(days) {
//     if (days === 0) return 'Today';
//     if (days === 1) return 'Tomorrow';
//     return `In ${days} days`;
//   }
// 
//   /* ---------- Storage ---------- */
// 
//   function persist() {
//     try {
//       localStorage.setItem(STORAGE_KEY, JSON.stringify(state.contacts));
//     } catch {
//       toast('This browser blocked saving. Use Export JSON to keep a copy.');
//     }
//   }
// 
//   async function load() {
//     let saved = null;
//     try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
// 
//     if (saved) {
//       try {
//         const arr = JSON.parse(saved);
//         if (Array.isArray(arr)) {
//           state.contacts = arr.map(normalize);
//           return;
//         }
//       } catch { /* fall through to seed file */ }
//     }
// 
//     try {
//       const res = await fetch(SEED_URL, { cache: 'no-store' });
//       if (res.ok) {
//         const data = await res.json();
//         const arr = Array.isArray(data) ? data : (data.contacts || []);
//         state.contacts = arr.map(normalize).filter(c => c.name);
//       }
//     } catch {
//       state.contacts = [];
//     }
//     persist();
//   }
// 
//   /* ---------- Toast ---------- */
// 
//   let toastTimer;
//   function toast(msg) {
//     els.toast.textContent = msg;
//     els.toast.classList.add('show');
//     clearTimeout(toastTimer);
//     toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
//   }
// 
//   /* ---------- Rendering ---------- */
// 
//   function allTags() {
//     const map = new Map();
//     for (const c of state.contacts) {
//       for (const t of c.tags) {
//         const key = t.toLowerCase();
//         const entry = map.get(key);
//         if (entry) entry.count++;
//         else map.set(key, { name: t, count: 1 });
//       }
//     }
//     return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
//   }
// 
//   function filtered() {
//     const q = state.query.trim().toLowerCase();
//     const tag = state.activeTag ? state.activeTag.toLowerCase() : null;
//     return state.contacts
//       .filter(c => {
//         if (tag && !c.tags.some(t => t.toLowerCase() === tag)) return false;
//         if (!q) return true;
//         return [c.name, c.phone, c.email, c.address, ...c.tags].some(v => v && v.toLowerCase().includes(q));
//       })
//       .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
//   }
// 
//   function renderUpcoming() {
//     const events = [];
//     for (const c of state.contacts) {
//       if (c.dob) {
//         const o = nextOccurrence(c.dob);
//         if (o.days <= UPCOMING_DAYS) events.push({ c, o, kind: 'Birthday', detail: o.years > 0 ? `turns ${o.years}` : '' });
//       }
//       if (c.anniversary) {
//         const o = nextOccurrence(c.anniversary);
//         if (o.days <= UPCOMING_DAYS) events.push({ c, o, kind: 'Anniversary', detail: o.years > 0 ? `${o.years} ${o.years === 1 ? 'year' : 'years'}` : '' });
//       }
//     }
//     events.sort((a, b) => a.o.days - b.o.days || a.c.name.localeCompare(b.c.name));
// 
//     const head = `<h2 class="upcoming-title">Next ${UPCOMING_DAYS} days</h2>`;
//     if (!events.length) {
//       els.upcoming.innerHTML = head + '<p class="upcoming-empty">No birthdays or anniversaries coming up.</p>';
//       return;
//     }
// 
//     els.upcoming.innerHTML = head + `<ol class="upcoming-list">${events.map(e => `
//       <li>
//         <button type="button" class="event" data-id="${esc(e.c.id)}">
//           <span class="event-date" aria-hidden="true">
//             <span class="event-day">${e.o.date.getDate()}</span>
//             <span class="event-month">${e.o.date.toLocaleDateString(undefined, { month: 'short' })}</span>
//           </span>
//           <span class="event-text">
//             <span class="event-name">${esc(e.c.name)}</span>
//             <span class="event-kind">${e.kind}${e.detail ? ', ' + e.detail : ''}</span>
//             <span class="event-when">${whenLabel(e.o.days)}</span>
//           </span>
//         </button>
//       </li>`).join('')}</ol>`;
//   }
// 
//   function renderTagFilter() {
//     const tags = allTags();
//     if (state.activeTag && !tags.some(t => t.name.toLowerCase() === state.activeTag.toLowerCase())) {
//       state.activeTag = null;
//     }
//     els.tagFilter.innerHTML = tags.map(t => {
//       const on = !!state.activeTag && t.name.toLowerCase() === state.activeTag.toLowerCase();
//       return `<button type="button" class="filter-chip${on ? ' is-on' : ''}" data-tag="${esc(t.name)}" aria-pressed="${on}">${esc(t.name)} <span>${t.count}</span></button>`;
//     }).join('');
//   }
// 
//   function renderList() {
//     const total = state.contacts.length;
//     els.count.textContent = `${total} ${total === 1 ? 'contact' : 'contacts'}`;
// 
//     const items = filtered();
//     if (!items.length) {
//       els.list.innerHTML = `<li class="list-empty">${total ? 'No contacts match this search.' : 'No contacts yet. Add your first one.'}</li>`;
//       return;
//     }
// 
//     let html = '';
//     let letter = '';
//     for (const c of items) {
//       const first = (c.name[0] || '#').toUpperCase();
//       const l = /[A-Z]/.test(first) ? first : '#';
//       if (l !== letter) {
//         letter = l;
//         html += `<li class="letter" aria-hidden="true">${l}</li>`;
//       }
//       html += `
//         <li>
//           <button type="button" class="contact-row${c.id === state.selectedId ? ' is-active' : ''}" data-id="${esc(c.id)}">
//             <span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>
//             <span class="row-text">
//               <span class="row-name">${esc(c.name)}</span>
//               <span class="row-sub">${esc(c.phone || c.email || 'No phone or email')}</span>
//             </span>
//           </button>
//         </li>`;
//     }
//     els.list.innerHTML = html;
//   }
// 
//   function renderEmpty() {
//     els.pane.innerHTML = `
//       <div class="pane-empty">
//         <p>${state.contacts.length ? 'Pick a contact to see their details, or add someone new.' : 'Your contact book is empty. Add the first person to get started.'}</p>
//         <button type="button" class="btn primary" data-action="new">New contact</button>
//       </div>`;
//   }
// 
//   function renderDetail(c) {
//     const rows = [];
//     if (c.phone) rows.push(['Phone', `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>`]);
//     if (c.email) rows.push(['Email', `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`]);
//     if (c.address) rows.push(['Address', `<span class="pre">${esc(c.address)}</span>`]);
//     if (c.dob) {
//       const age = yearsSince(c.dob);
//       rows.push(['Date of birth', `${fmtDate(c.dob)}${age >= 0 ? ` <span class="muted">(age ${age})</span>` : ''}`]);
//     }
//     if (c.anniversary) {
//       const yrs = yearsSince(c.anniversary);
//       rows.push(['Anniversary', `${fmtDate(c.anniversary)}${yrs >= 0 ? ` <span class="muted">(${yrs} ${yrs === 1 ? 'year' : 'years'})</span>` : ''}`]);
//     }
// 
//     els.pane.innerHTML = `
//       <article class="detail">
//         <button type="button" class="back" data-action="back">Back to contacts</button>
//         <header class="detail-head">
//           <span class="avatar large" aria-hidden="true">${esc(initials(c.name))}</span>
//           <div>
//             <h2 class="detail-name">${esc(c.name)}</h2>
//             ${c.tags.length ? `<ul class="tags">${c.tags.map(t => `<li><button type="button" class="tag" data-tag="${esc(t)}" title="Show everyone tagged ${esc(t)}">${esc(t)}</button></li>`).join('')}</ul>` : ''}
//           </div>
//         </header>
//         ${rows.length
//           ? `<dl class="fields">${rows.map(([k, v]) => `<div class="field-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`
//           : '<p class="muted">No details added yet.</p>'}
//         <div class="detail-actions">
//           <button type="button" class="btn primary" data-action="edit">Edit contact</button>
//           <button type="button" class="btn danger" data-action="delete">Delete contact</button>
//         </div>
//       </article>`;
//   }
// 
//   function renderTagChips() {
//     const box = $('#tagChips');
//     if (!box) return;
//     box.innerHTML = state.draftTags.map((t, i) => `
//       <span class="chip">${esc(t)}<button type="button" class="chip-x" data-remove="${i}" aria-label="Remove tag ${esc(t)}">&times;</button></span>`
//     ).join('');
//   }
// 
//   function addDraftTags(text) {
//     const parts = String(text || '').split(',');
//     state.draftTags = uniqueTags([...state.draftTags, ...parts]);
//     renderTagChips();
//   }
// 
//   function renderForm(c) {
//     const isNew = !c.id;
//     state.draftTags = [...(c.tags || [])];
// 
//     els.pane.innerHTML = `
//       <form id="contactForm" class="form" novalidate>
//         <button type="button" class="back" data-action="cancel">Back</button>
//         <h2>${isNew ? 'New contact' : 'Edit contact'}</h2>
//         <div class="form-grid">
//           <label class="field full">
//             <span class="field-label">Name</span>
//             <input name="name" autocomplete="off" value="${esc(c.name)}" required>
//           </label>
//           <label class="field">
//             <span class="field-label">Phone</span>
//             <input name="phone" type="tel" value="${esc(c.phone)}">
//           </label>
//           <label class="field">
//             <span class="field-label">Email</span>
//             <input name="email" type="email" value="${esc(c.email)}">
//           </label>
//           <label class="field full">
//             <span class="field-label">Address</span>
//             <textarea name="address" rows="3">${esc(c.address)}</textarea>
//           </label>
//           <label class="field">
//             <span class="field-label">Date of birth</span>
//             <input name="dob" type="date" value="${esc(c.dob)}">
//           </label>
//           <label class="field">
//             <span class="field-label">Anniversary</span>
//             <input name="anniversary" type="date" value="${esc(c.anniversary)}">
//           </label>
//           <div class="field full">
//             <span class="field-label" id="tagsLabel">Tags</span>
//             <div class="tag-input" id="tagBox">
//               <span id="tagChips"></span>
//               <input id="tagEntry" list="tagSuggestions" placeholder="Type a tag, press Enter" aria-labelledby="tagsLabel" autocomplete="off">
//             </div>
//             <datalist id="tagSuggestions">${allTags().map(t => `<option value="${esc(t.name)}"></option>`).join('')}</datalist>
//             <p class="hint">Separate tags with Enter or a comma. Backspace removes the last one.</p>
//           </div>
//         </div>
//         <p class="form-error" id="formError" role="alert"></p>
//         <div class="form-actions">
//           <button type="submit" class="btn primary">${isNew ? 'Add contact' : 'Save changes'}</button>
//           <button type="button" class="btn ghost" data-action="cancel">Cancel</button>
//         </div>
//       </form>`;
// 
//     renderTagChips();
// 
//     const form = $('#contactForm');
//     const entry = $('#tagEntry');
// 
//     entry.addEventListener('keydown', e => {
//       if (e.key === 'Enter' || e.key === ',') {
//         e.preventDefault();
//         addDraftTags(entry.value);
//         entry.value = '';
//       } else if (e.key === 'Backspace' && !entry.value && state.draftTags.length) {
//         state.draftTags.pop();
//         renderTagChips();
//       }
//     });
// 
//     entry.addEventListener('blur', () => {
//       if (entry.value.trim()) {
//         addDraftTags(entry.value);
//         entry.value = '';
//       }
//     });
// 
//     $('#tagBox').addEventListener('click', e => {
//       const btn = e.target.closest('[data-remove]');
//       if (btn) {
//         state.draftTags.splice(Number(btn.dataset.remove), 1);
//         renderTagChips();
//         entry.focus();
//       } else if (e.target.id === 'tagBox') {
//         entry.focus();
//       }
//     });
// 
//     form.addEventListener('submit', e => {
//       e.preventDefault();
//       addDraftTags(entry.value);
//       entry.value = '';
//       saveForm(form, c);
//     });
// 
//     form.addEventListener('keydown', e => {
//       if (e.key === 'Escape') cancelForm();
//     });
// 
//     form.elements.name.focus();
//   }
// 
//   function renderPane() {
//     const showing = state.mode !== 'view' || !!state.selectedId;
//     document.body.classList.toggle('show-detail', showing);
// 
//     if (state.mode === 'new') return renderForm({});
// 
//     const c = state.contacts.find(x => x.id === state.selectedId);
//     if (c && state.mode === 'edit') return renderForm(c);
//     if (c) return renderDetail(c);
// 
//     state.selectedId = null;
//     state.mode = 'view';
//     document.body.classList.remove('show-detail');
//     renderEmpty();
//   }
// 
//   function render() {
//     renderUpcoming();
//     renderTagFilter();
//     renderList();
//     renderPane();
//   }
// 
//   /* ---------- Actions ---------- */
// 
//   function showError(form, msg, field) {
//     $('#formError').textContent = msg;
//     [...form.querySelectorAll('[aria-invalid]')].forEach(el => el.removeAttribute('aria-invalid'));
//     if (field && form.elements[field]) {
//       form.elements[field].setAttribute('aria-invalid', 'true');
//       form.elements[field].focus();
//     }
//   }
// 
//   function saveForm(form, original) {
//     const fd = new FormData(form);
//     const data = {
//       name: String(fd.get('name') || '').trim(),
//       phone: String(fd.get('phone') || '').trim(),
//       email: String(fd.get('email') || '').trim(),
//       address: String(fd.get('address') || '').trim(),
//       dob: String(fd.get('dob') || ''),
//       anniversary: String(fd.get('anniversary') || ''),
//       tags: [...state.draftTags]
//     };
// 
//     if (!data.name) return showError(form, 'Add a name to save this contact.', 'name');
//     if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
//       return showError(form, 'Enter a valid email address, like name@example.com.', 'email');
//     }
//     if (data.dob && data.dob > isoToday()) {
//       return showError(form, 'Date of birth can\u2019t be in the future.', 'dob');
//     }
// 
//     const isNew = !original.id;
//     if (isNew) {
//       const created = normalize(data);
//       state.contacts.push(created);
//       state.selectedId = created.id;
//     } else {
//       const target = state.contacts.find(x => x.id === original.id);
//       Object.assign(target, normalize({ ...target, ...data, updatedAt: new Date().toISOString() }));
//       state.selectedId = target.id;
//     }
// 
//     state.mode = 'view';
//     persist();
//     render();
//     toast(isNew ? 'Contact added' : 'Changes saved');
//   }
// 
//   function cancelForm() {
//     state.mode = 'view';
//     renderPane();
//   }
// 
//   function deleteSelected() {
//     const c = state.contacts.find(x => x.id === state.selectedId);
//     if (!c) return;
//     if (!confirm(`Delete ${c.name}? This can\u2019t be undone.`)) return;
//     state.contacts = state.contacts.filter(x => x.id !== c.id);
//     state.selectedId = null;
//     state.mode = 'view';
//     persist();
//     render();
//     toast('Contact deleted');
//   }
// 
//   function selectContact(id) {
//     state.selectedId = id;
//     state.mode = 'view';
//     renderList();
//     renderPane();
//     if (window.matchMedia('(max-width: 760px)').matches) window.scrollTo(0, 0);
//   }
// 
//   function setTagFilter(tag) {
//     const same = state.activeTag && tag && state.activeTag.toLowerCase() === tag.toLowerCase();
//     state.activeTag = same ? null : tag;
//     renderTagFilter();
//     renderList();
//   }
// 
//   function exportJson() {
//     const payload = { version: 1, exportedAt: new Date().toISOString(), contacts: state.contacts };
//     const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
//     const url = URL.createObjectURL(blob);
//     const a = document.createElement('a');
//     a.href = url;
//     a.download = `contacts-${isoToday()}.json`;
//     document.body.appendChild(a);
//     a.click();
//     a.remove();
//     setTimeout(() => URL.revokeObjectURL(url), 1000);
//     toast('Contacts exported');
//   }
// 
//   async function importJson(file) {
//     try {
//       const data = JSON.parse(await file.text());
//       const arr = Array.isArray(data) ? data : data.contacts;
//       if (!Array.isArray(arr)) throw new Error('No contacts array');
// 
//       const incoming = arr.map(normalize).filter(c => c.name);
//       const byId = new Map(state.contacts.map(c => [c.id, c]));
//       let added = 0;
//       let updated = 0;
//       for (const c of incoming) {
//         if (byId.has(c.id)) updated++;
//         else added++;
//         byId.set(c.id, c);
//       }
//       state.contacts = [...byId.values()];
//       persist();
//       render();
//       toast(`Imported ${added} new, ${updated} updated`);
//     } catch {
//       toast('That file isn\u2019t a valid contacts JSON file.');
//     }
//   }
// 
//   /* ---------- Events ---------- */
// 
//   els.list.addEventListener('click', e => {
//     const btn = e.target.closest('[data-id]');
//     if (btn) selectContact(btn.dataset.id);
//   });
// 
//   els.upcoming.addEventListener('click', e => {
//     const btn = e.target.closest('[data-id]');
//     if (btn) selectContact(btn.dataset.id);
//   });
// 
//   els.tagFilter.addEventListener('click', e => {
//     const btn = e.target.closest('[data-tag]');
//     if (btn) setTagFilter(btn.dataset.tag);
//   });
// 
//   els.search.addEventListener('input', () => {
//     state.query = els.search.value;
//     renderList();
//   });
// 
//   els.pane.addEventListener('click', e => {
//     const tagBtn = e.target.closest('.tag[data-tag]');
//     if (tagBtn) {
//       state.activeTag = null;
//       setTagFilter(tagBtn.dataset.tag);
//       if (window.matchMedia('(max-width: 760px)').matches) {
//         state.selectedId = null;
//         renderList();
//         renderPane();
//       }
//       return;
//     }
// 
//     const btn = e.target.closest('[data-action]');
//     if (!btn) return;
//     switch (btn.dataset.action) {
//       case 'new':
//         state.mode = 'new';
//         renderPane();
//         break;
//       case 'edit':
//         state.mode = 'edit';
//         renderPane();
//         break;
//       case 'delete':
//         deleteSelected();
//         break;
//       case 'cancel':
//         cancelForm();
//         break;
//       case 'back':
//         state.selectedId = null;
//         state.mode = 'view';
//         renderList();
//         renderPane();
//         break;
//     }
//   });
// 
//   $('#newBtn').addEventListener('click', () => {
//     state.mode = 'new';
//     renderPane();
//     if (window.matchMedia('(max-width: 760px)').matches) window.scrollTo(0, 0);
//   });
// 
//   $('#exportBtn').addEventListener('click', exportJson);
//   $('#importBtn').addEventListener('click', () => els.importFile.click());
//   els.importFile.addEventListener('change', async () => {
//     const file = els.importFile.files[0];
//     if (file) await importJson(file);
//     els.importFile.value = '';
//   });
// 
//   /* ---------- Start ---------- */
// 
//   load().then(render);
// })();

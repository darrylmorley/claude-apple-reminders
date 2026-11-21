// reminders.js — JavaScript for Automation (JXA) bridge to Apple Reminders.
//
// Invoked by server.mjs as:
//   /usr/bin/osascript -l JavaScript reminders.js '<json request>'
//
// The request arrives as a single argv string and is parsed with JSON.parse,
// so reminder titles, notes and search terms are only ever *data*. Nothing in
// this file builds code from user input (no eval, no AppleScript strings, no
// shell). The server has already validated every field before calling us.
//
// Output: one JSON line on stdout: {"ok":true,"result":...} or {"ok":false,"error":"..."}.

function run(argv) {
  let req;
  try {
    req = JSON.parse(argv[0]);
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'Bad request passed to reminders.js' });
  }
  const op = OPS[req.op];
  if (!op) return JSON.stringify({ ok: false, error: 'Unknown operation: ' + req.op });
  try {
    const app = Application('Reminders');
    return JSON.stringify({ ok: true, result: op(app, req.args || {}) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- helpers ----------

const PRIORITY_OUT = (p) => (p === 0 || p == null ? 'none' : p <= 4 ? 'high' : p === 5 ? 'medium' : 'low');
const PRIORITY_IN = { none: 0, high: 1, medium: 5, low: 9 };

function pad(n) { return (n < 10 ? '0' : '') + n; }

// Local wall-clock time with offset, e.g. 2026-11-21T09:30:00+00:00
function localIso(d) {
  if (!d) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}

function localDate(d) {
  return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : null;
}

// Dates arrive pre-validated as "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (Mac local time).
// Built from numeric parts so the Mac's region/locale can never reorder day and month.
function parseDue(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { allDay: true, date: new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0) };
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (m) return { allDay: false, date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) };
  throw new Error('Invalid date: ' + s);
}

// Bulk property read; returns an array of nulls if the property isn't supported.
function bulk(fn, n) {
  try {
    const v = fn();
    return Array.isArray(v) ? v : new Array(n).fill(null);
  } catch (e) {
    return new Array(n).fill(null);
  }
}

function allLists(app) {
  const ids = app.lists.id();
  const names = app.lists.name();
  return ids.map((id, i) => ({ id: id, name: names[i] }));
}

// Accepts a list id or a list name (exact, then case-insensitive).
function resolveList(app, ref) {
  const lists = allLists(app);
  let m = lists.filter((l) => l.id === ref);
  if (!m.length) m = lists.filter((l) => l.name === ref);
  if (!m.length) m = lists.filter((l) => l.name.toLowerCase() === String(ref).toLowerCase());
  if (!m.length) {
    throw new Error('No list called "' + ref + '". Lists: ' + lists.map((l) => l.name).join(', '));
  }
  if (m.length > 1) throw new Error('More than one list is called "' + ref + '"; use its id instead.');
  return { info: m[0], obj: app.lists.byId(m[0].id) };
}

// Reads every reminder in an element specifier using one Apple Event per property.
function readMany(spec, list) {
  const n = spec.length;
  if (!n) return [];
  const ids = spec.id();
  const names = spec.name();
  const bodies = bulk(() => spec.body(), n);
  const done = bulk(() => spec.completed(), n);
  const due = bulk(() => spec.dueDate(), n);
  const allday = bulk(() => spec.alldayDueDate(), n);
  const remind = bulk(() => spec.remindMeDate(), n);
  const prio = bulk(() => spec.priority(), n);
  const flagged = bulk(() => spec.flagged(), n);
  const doneAt = bulk(() => spec.completionDate(), n);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(shape({
      id: ids[i], name: names[i], body: bodies[i], completed: done[i], dueDate: due[i],
      alldayDueDate: allday[i], remindMeDate: remind[i], priority: prio[i],
      flagged: flagged[i], completionDate: doneAt[i],
    }, list));
  }
  return out;
}

function readOne(r, list) {
  const get = (fn) => { try { return fn(); } catch (e) { return null; } };
  if (!list) {
    const c = get(() => r.container());
    list = c ? { id: get(() => c.id()), name: get(() => c.name()) } : { id: null, name: null };
  }
  return shape({
    id: r.id(), name: r.name(), body: get(() => r.body()), completed: get(() => r.completed()),
    dueDate: get(() => r.dueDate()), alldayDueDate: get(() => r.alldayDueDate()),
    remindMeDate: get(() => r.remindMeDate()), priority: get(() => r.priority()),
    flagged: get(() => r.flagged()), completionDate: get(() => r.completionDate()),
  }, list);
}

function isMidnight(d) {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
}

function shape(p, list) {
  // Reminders fills "allday due date" for timed reminders too, so it can't be used on its own.
  // A reminder is all-day only if it has an all-day date and no time of day on its due date.
  const allDay = !!p.alldayDueDate && (!p.dueDate || isMidnight(p.dueDate));
  return {
    id: p.id,
    title: p.name,
    notes: p.body || null,
    list: list.name,
    listId: list.id,
    completed: !!p.completed,
    due: allDay ? localDate(p.alldayDueDate) : localIso(p.dueDate),
    allDay: allDay,
    alert: localIso(p.remindMeDate),
    priority: PRIORITY_OUT(p.priority),
    flagged: !!p.flagged,
    completedAt: localIso(p.completionDate),
    // epoch ms for sorting/filtering in JS; removed before returning
    _due: allDay ? p.alldayDueDate.getTime() : p.dueDate ? p.dueDate.getTime() : null,
  };
}

function strip(r) { delete r._due; return r; }

function findReminder(app, id) {
  const r = app.reminders.byId(id);
  try { r.name(); } catch (e) { throw new Error('No reminder with id ' + id); }
  return r;
}

// Reminders' scripting can set a due date but can't remove one, and it adds an alert by itself
// (at the due time, or midnight for all-day) that scripting can't remove either. So the tools
// only ever set dates; for timed reminders we also set the alert explicitly to the due time.
function setDue(r, due) {
  if (due === undefined) return;
  const d = parseDue(due);
  if (d.allDay) {
    r.alldayDueDate = d.date;
  } else {
    r.dueDate = d.date;
    r.remindMeDate = d.date;
  }
}

// Reads the reminder back and reports anything Reminders didn't store as asked.
function verifyDue(saved, due) {
  if (due === undefined) return [];
  const d = parseDue(due);
  if (d.allDay) {
    if (!saved.allDay || saved.due !== due) {
      return ['Asked for all-day on ' + due + ' but Reminders stored ' + saved.due + (saved.allDay ? ' (all-day)' : ' (timed)') + '.'];
    }
  } else if (saved.allDay || !saved.due || saved.due.slice(0, 16) !== due) {
    return ['Asked for ' + due + ' but Reminders stored ' + saved.due + (saved.allDay ? ' (all-day)' : '') + '.'];
  }
  return [];
}

function withChecks(saved, a) {
  const warnings = verifyDue(saved, a.due);
  if (warnings.length) saved.warnings = warnings;
  return saved;
}

function applyFields(r, a) {
  if (a.title !== undefined) r.name = a.title;
  if (a.notes !== undefined) r.body = a.notes === null ? '' : a.notes;
  setDue(r, a.due);
  if (a.priority !== undefined) r.priority = PRIORITY_IN[a.priority];
  if (a.flagged !== undefined) r.flagged = a.flagged;
  if (a.completed !== undefined) r.completed = a.completed;
}

// ---------- operations ----------

const OPS = {
  list_lists(app) {
    return allLists(app).map((l) => {
      let open = null;
      try { open = app.lists.byId(l.id).reminders.whose({ completed: false }).length; } catch (e) {}
      return { id: l.id, name: l.name, openCount: open };
    });
  },

  get_reminders(app, a) {
    const lists = a.list ? [resolveList(app, a.list).info] : allLists(app);
    let rows = [];
    lists.forEach((l) => {
      const all = app.lists.byId(l.id).reminders;
      const spec = a.status === 'all' ? all : all.whose({ completed: a.status === 'completed' });
      rows = rows.concat(readMany(spec, l));
    });
    const before = a.dueBefore ? parseDue(a.dueBefore) : null;
    const after = a.dueAfter ? parseDue(a.dueAfter) : null;
    // all-day "before" bound includes the whole day
    const beforeMs = before ? before.date.getTime() + (before.allDay ? 86400000 : 0) : null;
    const afterMs = after ? after.date.getTime() : null;
    const q = a.search ? a.search.toLowerCase() : null;
    rows = rows.filter((r) => {
      if (a.flaggedOnly && !r.flagged) return false;
      if (beforeMs !== null && (r._due === null || r._due >= beforeMs)) return false;
      if (afterMs !== null && (r._due === null || r._due < afterMs)) return false;
      if (q && (r.title || '').toLowerCase().indexOf(q) < 0 && (r.notes || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    rows.sort((x, y) => (x._due === null) - (y._due === null) || (x._due || 0) - (y._due || 0));
    const total = rows.length;
    const limit = a.limit || 100;
    return { total: total, returned: Math.min(total, limit), truncated: total > limit, reminders: rows.slice(0, limit).map(strip) };
  },

  get_reminder(app, a) {
    return strip(readOne(findReminder(app, a.id)));
  },

  create_reminder(app, a) {
    const l = resolveList(app, a.list);
    const props = { name: a.title };
    if (a.notes) props.body = a.notes;
    const r = app.Reminder(props);
    l.obj.reminders.push(r);
    applyFields(r, { due: a.due, priority: a.priority, flagged: a.flagged });
    return withChecks(strip(readOne(r, l.info)), a);
  },

  update_reminder(app, a) {
    const r = findReminder(app, a.id);
    applyFields(r, a);
    if (a.moveToList) {
      const target = resolveList(app, a.moveToList);
      try {
        app.move(r, { to: target.obj });
      } catch (e) {
        throw new Error('Other changes were saved, but Reminders refused to move the reminder to "' +
          target.info.name + '" (' + e.message + ').');
      }
      return withChecks(strip(readOne(app.reminders.byId(a.id))), a);
    }
    return withChecks(strip(readOne(r)), a);
  },

  set_completed(app, a) {
    return a.ids.map((id) => {
      try {
        const r = findReminder(app, id);
        r.completed = a.completed;
        return { id: id, title: r.name(), ok: true };
      } catch (e) {
        return { id: id, ok: false, error: e.message };
      }
    });
  },

  // Used by the server to build the confirmation dialog before deleting.
  describe_reminders(app, a) {
    return a.ids.map((id) => {
      try { return strip(readOne(findReminder(app, id))); } catch (e) { return { id: id, missing: true }; }
    });
  },

  delete_reminders(app, a) {
    return a.ids.map((id) => {
      try {
        app.delete(findReminder(app, id));
        return { id: id, ok: true };
      } catch (e) {
        return { id: id, ok: false, error: e.message };
      }
    });
  },

  create_list(app, a) {
    if (allLists(app).some((l) => l.name.toLowerCase() === a.name.toLowerCase())) {
      throw new Error('A list called "' + a.name + '" already exists.');
    }
    const l = app.List({ name: a.name });
    app.lists.push(l);
    return { id: l.id(), name: l.name() };
  },

  describe_list(app, a) {
    const l = resolveList(app, a.list);
    return {
      id: l.info.id,
      name: l.info.name,
      total: l.obj.reminders.length,
      open: l.obj.reminders.whose({ completed: false }).length,
    };
  },

  delete_list(app, a) {
    const l = resolveList(app, a.list);
    app.delete(l.obj);
    return { id: l.info.id, name: l.info.name, deleted: true };
  },
};

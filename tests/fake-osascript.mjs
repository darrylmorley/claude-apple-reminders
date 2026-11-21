#!/usr/bin/env node
// Test double for /usr/bin/osascript. Runs the real reminders.js against an
// in-memory imitation of the Reminders JXA object model, persisted in $FAKE_STATE.
// Dialog calls (-e ...) record their message to $FAKE_DIALOG_LOG and answer with $FAKE_DIALOG.
import fs from 'node:fs';
import vm from 'node:vm';

const argv = process.argv.slice(2);
const STATE = process.env.FAKE_STATE;
const log = (f, s) => fs.appendFileSync(f, `${s}\n`);
if (process.env.FAKE_ARGV_LOG) log(process.env.FAKE_ARGV_LOG, JSON.stringify(argv));

if (argv[0] === '-e') {
  // confirmation dialog: last argument is the message
  const lines = [];
  let i = 0;
  while (argv[i] === '-e') { lines.push(argv[i + 1]); i += 2; }
  const msg = argv.slice(i).join(' ');
  log(process.env.FAKE_DIALOG_LOG, JSON.stringify(msg));
  const a = process.env.FAKE_DIALOG || 'Cancel';
  if (a === 'Cancel') { process.stderr.write('execution error: User canceled. (-128)\n'); process.exit(1); }
  process.stdout.write(`${a === 'timeout' ? 'timeout' : a}\n`);
  process.exit(0);
}

if (argv[0] !== '-l' || argv[1] !== 'JavaScript') { process.stderr.write('fake: unsupported'); process.exit(2); }
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
let seq = state.seq || 1000;

const DATE_PROPS = new Set(['dueDate', 'alldayDueDate', 'remindMeDate', 'completionDate', 'creationDate']);
const toOut = (k, v) => (v == null ? null : DATE_PROPS.has(k) ? new Date(v) : v);
const toIn = (k, v) => (v == null ? null : DATE_PROPS.has(k) ? new Date(v).toISOString() : v);

// Mimic real Reminders (observed on macOS): "allday due date" reads back as the date (midnight)
// even for timed reminders; "due date" of an all-day reminder reads back as midnight; and
// changing the due date drags an existing alert along to the new date.
const midnight = (iso) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d.toISOString(); };
function readProp(r, k) {
  if (k === 'id') return r.id;
  if (k === 'alldayDueDate') return toOut(k, r.alldayDueDate ?? (r.dueDate ? midnight(r.dueDate) : null));
  if (k === 'dueDate') return toOut(k, r.dueDate ?? (r.alldayDueDate ? midnight(r.alldayDueDate) : null));
  return toOut(k, r[k] ?? null);
}
function writeProp(r, k, v) {
  if (k === 'priority' && typeof v !== 'number') throw new Error('bad priority');
  if (DATE_PROPS.has(k) && v == null && !process.env.FAKE_JXA_NULL_WORKS) return; // real Reminders ignores JXA null
  if ((k === 'dueDate' || k === 'alldayDueDate') && v != null) {
    const other = k === 'dueDate' ? 'alldayDueDate' : 'dueDate';
    r[other] = null;
    // real Reminders adds an alert at the due time (midnight for all-day) whenever a due date is set
    r.remindMeDate = k === 'alldayDueDate' ? midnight(new Date(v).toISOString()) : new Date(v).toISOString();
  }
  r[k] = toIn(k, v);
  if (k === 'dueDate' && v != null && process.env.FAKE_DUE_SHIFT_MIN) {
    r.dueDate = new Date(new Date(v).getTime() + 60000 * +process.env.FAKE_DUE_SHIFT_MIN).toISOString();
  }
  if (k === 'completed') r.completionDate = v ? new Date().toISOString() : null;
}

function remById(id) { return state.reminders.find((r) => r.id === id); }
function listById(id) { return state.lists.find((l) => l.id === id); }

function prop(getter, setter) {
  // JXA-ish: element.prop() reads; element.prop = v writes (handled by Proxy set)
  return getter;
}

function reminderEl(id) {
  return new Proxy({}, {
    get(_, k) {
      if (k === '__id') return id;
      if (k === '__listId') return undefined;
      if (k === 'container') return () => { const r = must(); return listEl(r.list); };
      return () => readProp(must(), k);
    },
    set(_, k, v) {
      writeProp(must(), k, v);
      return true;
    },
  });
  function must() { const r = remById(id); if (!r) throw new Error('Can’t get object.'); return r; }
}

function listEl(id) {
  return new Proxy({}, {
    get(_, k) {
      if (k === '__listId') return id;
      if (k === 'reminders') return coll(() => state.reminders.filter((r) => r.list === id), id);
      return () => { const l = listById(id); if (!l) throw new Error('Can’t get object.'); return l[k]; };
    },
  });
}

function coll(items, listId, isLists) {
  const base = {
    get length() { return items().length; },
    whose(q) {
      return coll(() => items().filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)), listId, isLists);
    },
    byId(id) { return isLists ? listEl(id) : reminderEl(id); },
    push(el) {
      if (isLists) { const l = { id: `L${seq++}`, name: el.__props.name }; state.lists.push(l); el.__bind(l.id); return; }
      const r = { id: `x-apple-reminder://R${seq++}`, list: listId, name: '', body: null, completed: false,
        dueDate: null, alldayDueDate: null, remindMeDate: null, priority: 0, flagged: false, completionDate: null };
      for (const [k, v] of Object.entries(el.__props)) r[k] = toIn(k, v);
      state.reminders.push(r);
      el.__bind(r.id);
    },
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      // bulk property read
      return () => items().map((r) => readProp(r, k));
    },
  });
}

function unattached(props) {
  let bound = null; let kind = null;
  const p = new Proxy({}, {
    get(_, k) {
      if (k === '__props') return props;
      if (k === '__bind') return (id) => { bound = id; kind = id.startsWith('L') ? 'L' : 'R'; };
      if (!bound) throw new Error('not attached');
      const el = kind === 'L' ? listEl(bound) : reminderEl(bound);
      return el[k];
    },
    set(_, k, v) { if (!bound) throw new Error('not attached'); reminderEl(bound)[k] = v; return true; },
  });
  return p;
}

const app = {
  lists: coll(() => state.lists, null, true),
  reminders: coll(() => state.reminders, null),
  Reminder: (props) => unattached(props),
  List: (props) => unattached(props),
  delete(el) {
    if (el.__listId) {
      state.lists = state.lists.filter((l) => l.id !== el.__listId);
      state.reminders = state.reminders.filter((r) => r.list !== el.__listId);
      return;
    }
    const id = el.id();
    state.reminders = state.reminders.filter((r) => r.id !== id);
  },
  move(el, { to }) {
    if (process.env.FAKE_MOVE_FAILS) throw new Error('AppleEvent handler failed.');
    remById(el.id()).list = to.__listId;
  },
};

const src = fs.readFileSync(argv[2], 'utf8');
const ctx = vm.createContext({ Application: (name) => { if (name !== 'Reminders') throw new Error('wrong app'); return app; }, JSON, Date, Math, Array, Object, String, Error, Set });
vm.runInContext(src, ctx);
const out = ctx.run([argv[3]]);
state.seq = seq;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
process.stdout.write(`${out}\n`);

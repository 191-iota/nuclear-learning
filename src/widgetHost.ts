import { render, type VNode } from 'preact';
import * as compat from 'preact/compat';
import * as hooks from 'preact/hooks';
import * as jsxRuntime from 'preact/jsx-runtime';

/**
 * Running a widget: JSX text in, something mounted and usable on the board out.
 *
 * A widget is the same class of object a pasted screenshot is. You put it on the
 * board where the writing about it is, drag it by its border, pull a corner to size
 * it. What is inside the border is the difference: a picture is finished, and a
 * widget is a thing you use, so its fields, sliders and checkboxes take the pointer
 * from the moment it lands. That is the whole point of it being on the board instead
 * of somewhere else, and it is why the border exists at all. Without one there would
 * be nowhere left to grab.
 *
 * The three pieces:
 *
 * 1. The dev server compiles the JSX (server/jsx.ts), because a browser cannot and
 *    shipping a transpiler to it would cost more than the whole app.
 * 2. The compiled module imports from 'react'. This file publishes a runtime under a
 *    global, wraps it in a module made at runtime, and rewrites that one specifier to
 *    point at it. Preact answers to the React names in about ten kilobytes.
 * 3. The component renders into a plain element above the ink, so it inherits the
 *    app's buttons, fields and colours and looks like it belongs on the page.
 *
 * What a widget is handed: `storage`, which reads and writes the object saved with it
 * in the note. The same object is on `window.storage` while it is mounted, which is
 * the convention most pasted components are already written against.
 */

type AnyProps = Record<string, unknown>;
type AnyComponent = (props: AnyProps) => unknown;

// ---- the runtime the widget imports ----

const GLOBAL = '__nlWidgetRuntime';

// preact/compat answers to every React name a pasted component is likely to reach
// for (hooks, memo, forwardRef, createContext), and the jsx-runtime exports are what
// the compiler's own output imports.
const RUNTIME: Record<string, unknown> = {
  ...compat,
  ...hooks,
  ...jsxRuntime,
  h: compat.createElement,
  render,
};

(globalThis as unknown as Record<string, unknown>)[GLOBAL] = RUNTIME;

/**
 * A module, written as text, that re-exports the runtime above. It reads it off the
 * global rather than importing it, because a module made at runtime has no path to
 * resolve anything relative to. Its export list is generated from the runtime object,
 * so it stays complete on its own.
 */
const SHIM = ((): string => {
  const names = Object.keys(RUNTIME).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
  return [
    `const R = globalThis.${GLOBAL};`,
    'export default R.default ?? R;',
    ...names.map((k) => `export const ${k} = R[${JSON.stringify(k)}];`),
  ].join('\n');
})();

let shimUrl = '';
function runtimeUrl(): string {
  if (!shimUrl) shimUrl = URL.createObjectURL(new Blob([SHIM], { type: 'text/javascript' }));
  return shimUrl;
}

// Everything a widget is allowed to import. One that wants a chart library or an icon
// pack is told so by name instead of failing with a network error nobody can read.
const PROVIDED = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'preact',
  'preact/compat',
  'preact/hooks',
  'preact/jsx-runtime',
]);

/**
 * Points every supported import at the runtime module and collects the rest.
 *
 * The compiler prints one statement per line, and a specifier is always the last
 * string on its statement, which is enough to find it without parsing the module a
 * second time in the browser.
 */
function rewriteImports(code: string): { code: string; missing: string[] } {
  const url = runtimeUrl();
  const missing = new Set<string>();
  const lines = code.split('\n').map((line) => {
    const imports = /^\s*import\b/.test(line);
    const reExports = /^\s*export\b[^'"]*\bfrom\b/.test(line);
    if (!imports && !reExports) return line;
    return line.replace(
      /(['"])([^'"]+)\1(\s*;?\s*)$/,
      (whole: string, quote: string, spec: string, tail: string) => {
        if (!PROVIDED.has(spec)) {
          missing.add(spec);
          return whole;
        }
        return `${quote}${url}${quote}${tail}`;
      },
    );
  });
  return { code: lines.join('\n'), missing: [...missing] };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message ? `${err.name}: ${err.message}` : err.name;
  return String(err);
}

// ---- compiling ----

async function compile(source: string): Promise<{ code?: string; error?: string }> {
  try {
    const res = await fetch('/api/jsx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!res.ok) return { error: `The compiler answered ${res.status}.` };
    return (await res.json()) as { code?: string; error?: string };
  } catch {
    return {
      error:
        'The dev server is not answering, so there is nothing to compile the JSX. Start the app with npm run dev.',
    };
  }
}

/** The default export if there is one, otherwise the last exported Capitalised function. */
function pick(mod: Record<string, unknown>): AnyComponent | null {
  if (typeof mod.default === 'function') return mod.default as AnyComponent;
  const named = Object.entries(mod).filter(
    ([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name),
  );
  const last = named[named.length - 1];
  return last ? (last[1] as AnyComponent) : null;
}

export interface WidgetBuild {
  component?: AnyComponent;
  error?: string;
}

/** Source in, something renderable out, or one sentence saying why not. */
export async function buildWidget(source: string): Promise<WidgetBuild> {
  if (!source.trim()) return {};
  const compiled = await compile(source);
  if (compiled.error) return { error: compiled.error };
  if (!compiled.code?.trim()) return {};

  const { code, missing } = rewriteImports(compiled.code);
  if (missing.length) {
    return {
      error: `This wants ${missing.join(', ')}, which a widget cannot have. Only react and preact are here.`,
    };
  }

  // A module made at runtime: the browser loads it exactly as it loads any other
  // module, so export syntax and the rest behave normally.
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } catch (err) {
    return { error: describe(err) };
  } finally {
    URL.revokeObjectURL(url);
  }

  const component = pick(mod);
  if (!component) {
    return {
      error: 'Nothing here is a component. End the code with export default function Widget() { … }',
    };
  }
  return { component };
}

// ---- mounting ----

/**
 * A widget's own failure has to stay its own: a bad render must show up as a line of
 * text under its frame and leave the board, the ink and the app standing.
 */
function Guard(props: {
  comp: AnyComponent;
  inner: AnyProps;
  onError: (m: string) => void;
}): unknown {
  const [failure] = hooks.useErrorBoundary((err: unknown) => props.onError(describe(err)));
  if (failure) return null;
  return compat.createElement(props.comp as never, props.inner);
}

export interface WidgetHandle {
  destroy(): void;
  /** Point the global `storage` back at this widget. See mountWidget. */
  claim(): void;
}

// What `window.storage` was before any widget borrowed it, so the last one to leave
// can put it back rather than each one restoring whatever the previous widget left.
let storageBorrowed = false;
let hadStorage = false;
let previousStorage: unknown;
let mounted = 0;

export function mountWidget(
  host: HTMLElement,
  component: AnyComponent,
  inner: AnyProps,
  onError: (message: string) => void,
): WidgetHandle {
  const globals = globalThis as unknown as Record<string, unknown>;

  // A component written in a chat reaches for a global `storage` rather than the prop,
  // so the prop is mirrored there. One global cannot serve two widgets at once, and the
  // one that would win is simply whichever mounted last, which is not a rule anybody
  // could work with: a widget could quietly write its rows into another's box. So the
  // claim follows the pointer instead. Mounting claims it, and touching a widget claims
  // it back (BoardWidget calls claim on the way in), which makes the widget you are
  // working in the one that owns the name for as long as you are in it.
  const claim = (): void => {
    if (!inner.storage) return;
    if (!storageBorrowed) {
      storageBorrowed = true;
      hadStorage = 'storage' in globals;
      previousStorage = globals.storage;
    }
    globals.storage = inner.storage;
  };
  claim();
  mounted += 1;

  render(
    compat.createElement(Guard as never, { comp: component, inner, onError }) as unknown as VNode,
    host,
  );

  let alive = true;
  return {
    claim,
    destroy(): void {
      try {
        render(null, host);
      } catch {
        /* a component that throws on the way out must not block the one replacing it */
      }
      if (!alive) return;
      alive = false;
      mounted -= 1;
      if (mounted === 0 && storageBorrowed) {
        storageBorrowed = false;
        if (hadStorage) globals.storage = previousStorage;
        else delete globals.storage;
      }
    },
  };
}

// ---- what a widget keeps ----

/**
 * Two ways of asking, because pasted components come from two places.
 *
 * A component written here reads `storage.get('rows', [])` and gets the rows back.
 * A component written in a chat is written against that environment's `window.storage`,
 * which is asynchronous and wraps what it returns: `(await storage.get(k))?.value`,
 * with a string on the way in and a string on the way out. Both shapes are real, both
 * arrive by paste, and a component that reaches for the wrong one does not fail loudly:
 * `r?.value` on a plain value is undefined, so every read silently comes back empty
 * while every write keeps succeeding, and the widget looks like it is losing data it
 * has actually been saving all along.
 *
 * So the number of arguments picks the shape. Two arguments means the caller wants
 * the value and has a fallback for when there is none; one argument means the caller
 * is awaiting a wrapper. Nothing has to be edited on the way in either time.
 */
export interface WidgetStorage {
  get: {
    <T>(key: string, fallback: T): T;
    (key: string): Promise<{ value: string } | null>;
  };
  set(key: string, value: unknown): Promise<{ value: string }>;
  remove(key: string): void;
  /** The async spelling of remove, for the same reason get has two. */
  delete(key: string): Promise<null>;
  keys(): string[];
  clear(): void;
}

/** What a wrapped read carries: the string form, whatever went in. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/**
 * A widget's memory is a plain object living on the widget itself, so it travels in
 * the note's own blob with the geometry and needs no key of its own anywhere. Every
 * write tells the board, which is what gets the note autosaved to disk.
 */
export function widgetStorage(
  read: () => Record<string, unknown>,
  write: (next: Record<string, unknown>) => void,
): WidgetStorage {
  function get(key: string, ...fallback: unknown[]): unknown {
    const all = read();
    const has = key in all;
    if (fallback.length > 0) return has ? all[key] : fallback[0];
    return Promise.resolve(has ? { value: asText(all[key]) } : null);
  }

  function drop(key: string): void {
    const all = { ...read() };
    delete all[key];
    write(all);
  }

  return {
    get: get as WidgetStorage['get'],
    set(key: string, value: unknown): Promise<{ value: string }> {
      const all = { ...read() };
      all[key] = value;
      write(all);
      // Resolved rather than returned bare, so `await storage.set(...)` reads as a
      // success and an ignored call costs nothing.
      return Promise.resolve({ value: asText(value) });
    },
    remove: drop,
    delete(key: string): Promise<null> {
      drop(key);
      return Promise.resolve(null);
    },
    keys(): string[] {
      return Object.keys(read());
    },
    clear(): void {
      write({});
    },
  };
}

/**
 * What a new widget starts as: something already usable, so the first thing that
 * lands on the board is a working thing rather than an empty frame and a syntax
 * error. It is also the shortest honest documentation of the two things worth
 * knowing, which is that the component is the default export and that `storage` is
 * how it remembers.
 */
export const WIDGET_SEED = `import { useState } from 'react';

// Drag the border to move this, pull a corner to size it. Everything inside the
// border is yours: it takes the pointer, so fields and sliders work straight away.
// Whatever goes into storage is saved with the note.
export default function Widget({ storage }) {
  const [items, setItems] = useState(() => storage.get('items', []));
  const [draft, setDraft] = useState('');

  function save(next) {
    setItems(next);
    storage.set('items', next);
  }

  function add(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    save([...items, { text: draft.trim(), done: false }]);
    setDraft('');
  }

  const left = items.filter((i) => !i.done).length;

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <form onSubmit={add} style={{ display: 'flex', gap: '0.35rem' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a line"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="submit">Add</button>
      </form>

      {items.map((item, i) => (
        <label key={i} style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={item.done}
            onChange={() => save(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}
          />
          <span style={{ textDecoration: item.done ? 'line-through' : 'none' }}>{item.text}</span>
        </label>
      ))}

      <p style={{ margin: 0, fontSize: '0.72rem', opacity: 0.6 }}>
        {items.length === 0 ? 'Nothing yet.' : left + ' of ' + items.length + ' left'}
      </p>
    </div>
  );
}
`;

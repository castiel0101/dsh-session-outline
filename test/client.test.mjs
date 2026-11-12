import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'

/* =====================================================================
 * This suite drives `lib/client.js` without a DOM: helpers that only need a
 * projection value are pure, and the registration surface is exercised with a
 * recording slot service. The rendering path (button, drawer, filter, jump) is
 * covered end-to-end in `dom.test.mjs` against real React.
 * ===================================================================== */

/** Evaluate the classic script against a fake window and return its exports. */
function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const captured = { factory: null }
  const windowShim = {
    __ModuleLoader__: { load: registration => { captured.factory = registration.factory } },
  }
  const requireShim = (name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useMemo: fn => fn(),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: value => ({ current: value }),
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      }
    }
    // The plugin treats react-dom as optional; a harness without it must load.
    if (name === 'react-dom') throw new Error('react-dom absent in this harness')
    throw new Error(`unexpected require(${name})`)
  }
  const runner = new Function(
    'window', 'require', 'document', 'setTimeout', 'clearTimeout', 'matchMedia',
    `${source}\n//# sourceURL=lib/client.js`,
  )
  runner(windowShim, requireShim, undefined, setTimeout, clearTimeout, undefined)
  assert.notEqual(captured.factory, null, 'client.js did not call __ModuleLoader__.load')
  const exports = captured.factory(requireShim)
  // Effects/state are no-ops here, so the shared open flag is the only state.
  return { exports, window: windowShim }
}

/* =====================================================================
 * Pure helpers.
 * ===================================================================== */

test('normalizeEntries keeps valid turns, drops duplicates, and sorts ascending', () => {
  const { exports } = loadClient()
  const rows = exports.__internals.normalizeEntries([
    { turn: 2, seq: 9, prompt: 'second', response: 'two' },
    { turn: 1, seq: 3, prompt: 'first' },
    { turn: 1, seq: 4, prompt: 'duplicate turn wins nothing' },
    { turn: 3, seq: 5.5 },
    { turn: 'x', seq: 1 },
    { turn: -1, seq: 1 },
    null,
    'nope',
  ])
  assert.deepEqual(rows, [
    { turn: 1, seq: 3, prompt: 'first', response: '' },
    { turn: 2, seq: 9, prompt: 'second', response: 'two' },
    { turn: 3, seq: null, prompt: '', response: '' },
  ])
})

test('normalizeEntries treats an absent or non-array projection as no rows', () => {
  const { exports } = loadClient()
  assert.deepEqual(exports.__internals.normalizeEntries(undefined), [])
  assert.deepEqual(exports.__internals.normalizeEntries(null), [])
  assert.deepEqual(exports.__internals.normalizeEntries({ turn: 1 }), [])
  assert.deepEqual(exports.__internals.normalizeEntries([]), [])
})

test('normalizeEntries degrades a malformed preview to an empty string', () => {
  const { exports } = loadClient()
  const rows = exports.__internals.normalizeEntries([{ turn: 1, seq: 2, prompt: 42, response: null }])
  assert.deepEqual(rows, [{ turn: 1, seq: 2, prompt: '', response: '' }])
})

test('filterEntries matches turns, prompts, and responses case-insensitively', () => {
  const { exports } = loadClient()
  const rows = [
    { turn: 10, seq: 1, prompt: 'Deploy the release', response: '' },
    { turn: 11, seq: 2, prompt: 'unrelated', response: 'shipped RELEASE notes' },
    { turn: 12, seq: 3, prompt: 'quiet turn', response: '' },
  ]
  assert.equal(exports.__internals.filterEntries(rows, '').length, 3)
  assert.equal(exports.__internals.filterEntries(rows, '   ').length, 3)
  assert.deepEqual(exports.__internals.filterEntries(rows, 'release').map(row => row.turn), [10, 11])
  assert.deepEqual(exports.__internals.filterEntries(rows, ' 12 ').map(row => row.turn), [12])
  assert.deepEqual(exports.__internals.filterEntries(rows, 'nothing-matches'), [])
})

test('canPageTo requires a usable seq', () => {
  const { exports } = loadClient()
  const { canPageTo } = exports.__internals
  assert.equal(canPageTo({ turn: 1, seq: 0 }), true)
  assert.equal(canPageTo({ turn: 1, seq: null }), false)
  assert.equal(canPageTo(undefined), false)
})

test('clampText truncates with one ellipsis and survives non-strings', () => {
  const { exports } = loadClient()
  const { clampText } = exports.__internals
  assert.equal(clampText('short'), 'short')
  assert.equal(clampText('abcdef', 3), 'abc…')
  assert.equal(clampText(undefined), '')
})

test('format substitutes known placeholders and leaves unknown ones alone', () => {
  const { exports } = loadClient()
  const { format } = exports.__internals
  assert.equal(format('第 {turn} 轮', { turn: 3 }), '第 3 轮')
  assert.equal(format('{shown}/{total} 轮', { shown: 1, total: 4 }), '1/4 轮')
  assert.equal(format('{missing}', {}), '{missing}')
})

/* =====================================================================
 * Registration surface.
 * ===================================================================== */

test('apply registers the header utility with a session-scoped jump loader', async () => {
  const { exports } = loadClient()
  const registered = []
  const effects = []
  const calls = []
  exports.apply({
    slots: {
      inject(name, fn) {
        assert.equal(name, 'conversation.session.header.utilities')
        fn()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
    effect(fn, label) {
      effects.push(label)
      fn()
    },
    sessions: {
      binding(sessionId) {
        return {
          session: {
            loadThrough(seq) {
              calls.push([sessionId, seq])
              return Promise.resolve()
            },
          },
        }
      },
    },
  })

  assert.deepEqual(effects, ['session-outline: styles'])
  assert.equal(registered.length, 1)
  const { spec, component } = registered[0]
  assert.equal(spec.name, 'conversation.session.header.utilities')
  assert.equal(spec.id, 'session-outline')
  assert.equal(spec.order, 50)
  assert.equal(typeof component, 'function')

  await spec.inject('session-1').loadThrough(42)
  assert.deepEqual(calls, [['session-1', 42]])
})

test('the injected loader rejects loudly when the sessions service is absent', async () => {
  const { exports } = loadClient()
  let spec
  exports.apply({
    slots: { inject(_name, fn) { fn() }, register(options) { spec = options; return () => {} } },
  })
  await assert.rejects(() => spec.inject('session-1').loadThrough(1), /sessions service unavailable/)
})

test('the injected loader rejects when the session has no binding', async () => {
  const { exports } = loadClient()
  let spec
  exports.apply({
    slots: { inject(_name, fn) { fn() }, register(options) { spec = options; return () => {} } },
    sessions: { binding: () => undefined },
  })
  await assert.rejects(() => spec.inject('gone').loadThrough(1), /no binding for gone/)
})

test('the open flag is module state, so a remount reopens where it left off', () => {
  const { exports } = loadClient()
  const { readOpen, writeOpen } = exports.__internals
  assert.equal(readOpen(), false)
  writeOpen(true)
  assert.equal(readOpen(), true)
  writeOpen(true)
  assert.equal(readOpen(), true)
  writeOpen(false)
  assert.equal(readOpen(), false)
})

test('jumpToTurn reports no-chat when there is no transcript and no tab to switch to', async () => {
  const { exports } = loadClient()
  const result = await exports.__internals.jumpToTurn({ turn: 1, seq: 1 }, { timeoutMs: 50 })
  assert.deepEqual(result, { ok: false, reason: 'no-chat' })
})

test('the stylesheet targets the plugin id and the theme tokens', () => {
  const { exports } = loadClient()
  const styles = exports.__internals.STYLES
  assert.match(styles, /\.so-panel\{/)
  assert.match(styles, /--dsw-alias-brand-primary/)
  assert.match(styles, /--dsw-alias-label-primary/)
  assert.match(styles, /\[data-outline-landed='true'\]/)
})

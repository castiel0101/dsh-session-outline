/**
 * DOM integration test: mount the real client bundle through the real React 18
 * renderer inside jsdom, then drive the drawer the way a reader does — open it
 * from the header button, filter it, and jump to a turn, asserting the
 * transcript scrolled to the matching `data-chat-turn` anchor.
 *
 * React and jsdom resolve from the workspace checkout; the plugin itself has no
 * dependencies because the shell provides React as a platform module.
 *
 * Peer loading is deferred until after the jsdom globals exist: react-dom
 * snapshots `canUseDOM` when it is first evaluated, and a require performed
 * before `document` existed would leave React on its IE9 `input`-event
 * polyfill, which jsdom cannot service.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const WORKSPACE = '/Volumes/JackSsd/项目/deepseek-harness'
/** Peers are hoisted beside a client package, not at the monorepo root. */
const requireFromWorkspace = createRequire(`${WORKSPACE}/packages/client/ui-chat/package.json`)

/** Resolved once, after the DOM globals of the first jsdom exist. */
let peers = null

/** Load react / react-dom lazily so they observe a live DOM. */
function loadPeers() {
  if (peers !== null) return peers
  const React = requireFromWorkspace('react')
  peers = {
    React,
    ReactDOMClient: requireFromWorkspace('react-dom/client'),
    act: React.act,
  }
  return peers
}

/**
 * Evaluate the classic client script against a jsdom document and return its
 * exports, with `react` / `react-dom` resolved to the real packages.
 */
function loadBundle(document) {
  const { React } = loadPeers()
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const captured = { factory: null }
  const windowShim = {
    __ModuleLoader__: { load: registration => { captured.factory = registration.factory } },
  }
  const requireShim = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return requireFromWorkspace('react-dom')
    throw new Error(`unexpected require(${name})`)
  }
  const runner = new Function(
    'window', 'require', 'document', 'setTimeout', 'clearTimeout', 'matchMedia',
    `${source}\n//# sourceURL=lib/client.js`,
  )
  runner(windowShim, requireShim, document, setTimeout, clearTimeout, () => ({ matches: false }))
  assert.notEqual(captured.factory, null, 'client.js did not call __ModuleLoader__.load')
  return captured.factory(requireShim)
}

/**
 * Fresh jsdom with a transcript of `turns` anchor rows already loaded, plus a
 * deterministic 100px-per-row geometry (jsdom has no layout engine).
 */
function createDocument(turns) {
  const { JSDOM } = requireFromWorkspace('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
  })
  const { document } = dom.window
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.document = document
  globalThis.window = dom.window
  globalThis.matchMedia = () => ({ matches: false })

  const scroller = document.createElement('div')
  const column = document.createElement('div')
  column.setAttribute('data-chat-flow', '')
  for (const turn of turns) {
    const row = document.createElement('div')
    row.setAttribute('data-chat-turn', String(turn))
    row.textContent = `row ${turn}`
    column.append(row)
  }
  scroller.append(column)
  document.body.append(scroller)

  let height = 0
  for (const row of column.querySelectorAll('[data-chat-turn]')) {
    const top = height
    row.getBoundingClientRect = () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 })
    height += 100
  }
  let scrollTop = 0
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop,
    set: (next) => { scrollTop = next },
    configurable: true,
  })
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { get: () => 600, configurable: true })
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 })
  scroller.scrollTo = ({ top }) => { scrollTop = top }

  return { dom, document, scroller, column, host: document.getElementById('host') }
}

/** Mount the header entry with real React; returns its root. */
async function mountEntry(exports, { turnOutline, sessionId = 'session-1', loadThrough }) {
  const { React, ReactDOMClient, act } = loadPeers()
  const container = globalThis.document.getElementById('host')
  const root = ReactDOMClient.createRoot(container)
  const Component = exports.__internals.OutlineAction
  await act(async () => {
    root.render(React.createElement(Component, {
      useProjection: key => (key === 'turnOutline' ? turnOutline : undefined),
      sessionId,
      loadThrough,
    }))
  })
  return root
}

/** Click one element inside act so effects and promises settle. */
async function click(element) {
  const { act } = loadPeers()
  await act(async () => {
    element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
  })
}

/** Type into a controlled input the way React's onChange expects. */
async function type(input, value) {
  const { act } = loadPeers()
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
}

test('the header button opens a drawer that lists, filters, and jumps to a turn', async () => {
  const { document, scroller } = createDocument([1, 2, 3, 4])
  const exports = loadBundle(document)
  exports.__internals.writeOpen(false)

  const outline = [
    { turn: 1, seq: 10, prompt: '第一个问题', response: '第一个回答' },
    { turn: 2, seq: 20, prompt: 'second prompt', response: 'second answer' },
    { turn: 3, seq: 30, prompt: 'third prompt', response: 'third answer' },
    { turn: 4, seq: 40, prompt: 'fourth prompt', response: 'fourth answer' },
  ]
  await mountEntry(exports, { turnOutline: outline, loadThrough: () => Promise.resolve() })

  const trigger = document.querySelector('.so-btn')
  assert.notEqual(trigger, null, 'header button rendered')
  assert.match(trigger.textContent, /会话大纲/)
  assert.match(trigger.textContent, /4/, 'count badge shows the turn count')
  assert.equal(document.querySelector('.so-panel'), null, 'drawer starts closed')

  await click(trigger)
  const panel = document.querySelector('.so-panel')
  assert.notEqual(panel, null, 'drawer opened')
  assert.equal(panel.querySelectorAll('.so-row').length, 4)
  assert.match(panel.textContent, /第一个问题/)
  assert.match(panel.textContent, /fourth answer/)
  // The reader sits at the top of the transcript, so turn 1 is current.
  assert.match(panel.querySelector('[data-current="true"]').textContent, /第 1 轮/)

  // Filtering narrows the list without touching the outline itself.
  const search = panel.querySelector('.so-input')
  await type(search, 'third')
  const filtered = document.querySelectorAll('.so-panel .so-row')
  assert.equal(filtered.length, 1)
  assert.match(filtered[0].textContent, /third prompt/)
  assert.match(document.querySelector('.so-meta').textContent, /1\/4 轮/)

  await type(search, 'no-such-turn')
  assert.equal(document.querySelectorAll('.so-panel .so-row').length, 0)
  assert.match(document.querySelector('.so-panel').textContent, /没有匹配的轮次/)

  // Clear, then jump to turn 4: the transcript scrolls to its anchor and flashes it.
  await type(search, '')
  const target = Array.from(document.querySelectorAll('.so-panel .so-row'))
    .find(row => row.textContent.includes('第 4 轮'))
  assert.notEqual(target, undefined)
  await click(target)
  // Row 4 sits at y=300; the jump parks it 12px under the scrollport top.
  assert.equal(scroller.scrollTop, 288, 'scrolled to the turn-4 anchor')
  assert.equal(document.querySelector('[data-chat-turn="4"]').getAttribute('data-outline-landed'), 'true')

  await click(document.querySelector('.so-x'))
  assert.equal(document.querySelector('.so-panel'), null, 'close button dismisses the drawer')
})

test('jumping to an unloaded turn pages history in through loadThrough first', async () => {
  const { document } = createDocument([1, 2])
  const exports = loadBundle(document)
  exports.__internals.writeOpen(false)

  const outline = [
    { turn: 1, seq: 10, prompt: 'kept', response: '' },
    { turn: 7, seq: 70, prompt: 'unloaded turn', response: '' },
  ]
  const calls = []
  // The paging request lands the row, imitating the Chat view's prepend.
  const loadThrough = (seq) => {
    calls.push(seq)
    const column = document.querySelector('[data-chat-flow]')
    const row = document.createElement('div')
    row.setAttribute('data-chat-turn', '7')
    row.getBoundingClientRect = () => ({ top: 200, bottom: 300, left: 0, right: 100, width: 100, height: 100 })
    column.append(row)
    return Promise.resolve()
  }
  await mountEntry(exports, { turnOutline: outline, loadThrough })

  await click(document.querySelector('.so-btn'))
  const target = Array.from(document.querySelectorAll('.so-panel .so-row'))
    .find(row => row.textContent.includes('第 7 轮'))
  await click(target)
  assert.deepEqual(calls, [70], 'the outline seq drove the paging request')
  assert.equal(document.querySelector('[data-chat-turn="7"]').getAttribute('data-outline-landed'), 'true')
})

test('a turn that never loads reports a failure instead of spinning forever', async () => {
  const { document } = createDocument([1])
  const exports = loadBundle(document)
  exports.__internals.writeOpen(false)
  const result = await exports.__internals.jumpToTurn(
    { turn: 9, seq: 90 },
    { loadThrough: () => Promise.reject(new Error('refused')), timeoutMs: 200 },
  )
  assert.deepEqual(result, { ok: false, reason: 'not-loaded' })
})

test('a row the drawer cannot locate without a seq still reports instead of jumping blind', async () => {
  const { document } = createDocument([1])
  const exports = loadBundle(document)
  exports.__internals.writeOpen(false)
  const calls = []
  const result = await exports.__internals.jumpToTurn(
    { turn: 5, seq: null },
    { loadThrough: (seq) => { calls.push(seq); return Promise.resolve() }, timeoutMs: 100 },
  )
  assert.deepEqual(result, { ok: false, reason: 'not-loaded' })
  assert.deepEqual(calls, [], 'no seq, no paging request')
})

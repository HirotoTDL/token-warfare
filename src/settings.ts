/** ユーザー設定(localStorage永続化) */
export interface Settings {
  sens: number // マウス感度倍率 0.3〜2.5
  se: number   // 効果音音量 0〜1
  bgm: number  // BGM音量 0〜1
  lowSpec: boolean // 軽量モード(低スペックGPU向け。キャラを簡略化LODで描画。次回起動から有効)
}

const KEY = 'tw-settings'

const DEFAULTS: Settings = { sens: 1.0, se: 1.0, bgm: 1.0, lowSpec: false }

export const settings: Settings = { ...DEFAULTS }

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  if (typeof saved.sens === 'number' && isFinite(saved.sens)) settings.sens = saved.sens
  if (typeof saved.se === 'number' && isFinite(saved.se)) settings.se = saved.se
  if (typeof saved.bgm === 'number' && isFinite(saved.bgm)) settings.bgm = saved.bgm
  if (typeof saved.lowSpec === 'boolean') settings.lowSpec = saved.lowSpec
} catch {
  /* 破損時はデフォルト */
}

type Listener = (s: Settings) => void
const listeners: Listener[] = []

export function onSettingsChange(fn: Listener) {
  listeners.push(fn)
}

export function updateSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch)
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* プライベートモード等では保存できなくてもよい */
  }
  for (const fn of listeners) fn(settings)
}

// ===== キーバインド(ユーザーがリバインド可能) =====
export type KeyAction =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'charge' | 'skill'
  | 'deploy1' | 'deploy2' | 'deploy3' | 'deploy4'

/** 既定キー割当。スキルはユーザー指定でE→Qに変更。 */
export const DEFAULT_KEYBINDS: Record<KeyAction, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', charge: 'KeyR', skill: 'KeyQ',
  deploy1: 'Digit1', deploy2: 'Digit2', deploy3: 'Digit3', deploy4: 'Digit4',
}
/** 表示名(設定UI用) */
export const KEYBIND_LABELS: Record<KeyAction, string> = {
  forward: '前進', back: '後退', left: '左移動', right: '右移動',
  jump: 'ジャンプ', sprint: 'ダッシュ', charge: 'チャージ', skill: 'スキル',
  deploy1: '配備1', deploy2: '配備2', deploy3: '配備3', deploy4: '配備4',
}

const KB_KEY = 'tw-keybinds'
export const keybinds: Record<KeyAction, string> = { ...DEFAULT_KEYBINDS }
try {
  const saved = JSON.parse(localStorage.getItem(KB_KEY) ?? '{}')
  for (const a of Object.keys(DEFAULT_KEYBINDS) as KeyAction[]) {
    if (typeof saved[a] === 'string' && saved[a]) keybinds[a] = saved[a]
  }
} catch { /* 破損時はデフォルト */ }

function saveKeybinds() { try { localStorage.setItem(KB_KEY, JSON.stringify(keybinds)) } catch { /* noop */ } }
// 設定パネルは複数(タイトル/ポーズ)が同時に存在しうるので、変更を全パネルへ反映する
const keybindRefreshers = new Set<() => void>()
function notifyKeybindChange() { for (const fn of keybindRefreshers) fn() }
export function setKeybind(action: KeyAction, code: string) { keybinds[action] = code; saveKeybinds(); notifyKeybindChange() }
export function resetKeybinds() { Object.assign(keybinds, DEFAULT_KEYBINDS); saveKeybinds(); notifyKeybindChange() }

/** キーコードを読みやすい表示名に(KeyW→W, Digit1→1, Space→Space 等) */
export function keyLabel(code: string): string {
  if (!code) return '—'
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6)
  const m: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'Shift', ShiftRight: '右Shift', ControlLeft: 'Ctrl', ControlRight: '右Ctrl',
    AltLeft: 'Alt', AltRight: '右Alt', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'Caps', Enter: 'Enter',
  }
  return m[code] ?? code
}

/** 設定パネルのDOMを組み立てて返す(タイトル/ポーズ画面で共用) */
export function buildSettingsPanel(): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'settings-panel'
  panel.innerHTML = `
    <h3>設定</h3>
    <label class="set-row">
      <span>マウス感度</span>
      <input type="range" min="0.1" max="2.5" step="0.02" data-key="sens" />
      <b data-val="sens"></b>
    </label>
    <label class="set-row">
      <span>効果音</span>
      <input type="range" min="0" max="1" step="0.05" data-key="se" />
      <b data-val="se"></b>
    </label>
    <label class="set-row">
      <span>BGM</span>
      <input type="range" min="0" max="1" step="0.05" data-key="bgm" />
      <b data-val="bgm"></b>
    </label>
    <label class="set-row">
      <span>軽量モード(低スペック機向け・次回起動から有効)</span>
      <input type="checkbox" data-key="lowSpec" />
    </label>
  `
  const sync = () => {
    panel.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      const k = inp.dataset.key as keyof Settings
      if (inp.type === 'checkbox') inp.checked = !!settings[k]
      else inp.value = String(settings[k])
    })
    panel.querySelectorAll<HTMLElement>('b[data-val]').forEach((b) => {
      const k = b.dataset.val as 'sens' | 'se' | 'bgm'
      b.textContent = k === 'sens' ? settings[k].toFixed(2) : `${Math.round(settings[k] * 100)}%`
    })
  }
  const onChange = (e: Event) => {
    const inp = e.target as HTMLInputElement
    if (!inp.dataset.key) return
    const v = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value)
    updateSettings({ [inp.dataset.key]: v } as Partial<Settings>)
    sync()
  }
  panel.addEventListener('input', onChange)
  panel.addEventListener('change', onChange) // checkbox は change でも拾う
  // クリックがポインタロック要求等に伝播しないように
  panel.addEventListener('click', (e) => e.stopPropagation())
  sync()

  // ===== キーバインド再割当 =====
  const kb = document.createElement('div')
  kb.className = 'keybind-section'
  kb.innerHTML = '<h4>キー設定 <small>(ボタンを押して新しいキーを入力 / Escでキャンセル)</small></h4>'
  const grid = document.createElement('div')
  grid.className = 'keybind-grid'
  kb.appendChild(grid)
  let rebinding: KeyAction | null = null
  const btns: Partial<Record<KeyAction, HTMLButtonElement>> = {}
  const refreshBtns = () => {
    for (const a of Object.keys(KEYBIND_LABELS) as KeyAction[]) {
      const b = btns[a]
      if (b) b.textContent = a === rebinding ? '…' : keyLabel(keybinds[a])
    }
  }
  for (const a of Object.keys(KEYBIND_LABELS) as KeyAction[]) {
    const row = document.createElement('div')
    row.className = 'keybind-row'
    const lbl = document.createElement('span')
    lbl.textContent = KEYBIND_LABELS[a]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'keybind-btn'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      rebinding = a
      refreshBtns()
    })
    btns[a] = btn
    row.appendChild(lbl)
    row.appendChild(btn)
    grid.appendChild(row)
  }
  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'keybind-reset'
  resetBtn.textContent = 'デフォルトに戻す'
  resetBtn.addEventListener('click', (e) => { e.stopPropagation(); resetKeybinds(); refreshBtns() })
  kb.appendChild(resetBtn)
  // 再割当中の次のキー入力を捕捉(captureフェーズでゲームより先に拾い、伝播を止める)
  const onRebindKey = (e: KeyboardEvent) => {
    if (!rebinding) return
    e.preventDefault()
    e.stopPropagation()
    if (e.code !== 'Escape') {
      // 同じキーが他アクションに割当済みなら入れ替え(重複回避)
      for (const a of Object.keys(keybinds) as KeyAction[]) {
        if (a !== rebinding && keybinds[a] === e.code) keybinds[a] = keybinds[rebinding]
      }
      setKeybind(rebinding, e.code)
    }
    rebinding = null
    refreshBtns()
  }
  window.addEventListener('keydown', onRebindKey, true)
  keybindRefreshers.add(refreshBtns) // 他パネルでの変更・リセットも反映
  refreshBtns()
  panel.appendChild(kb)
  return panel
}

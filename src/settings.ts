/** ユーザー設定(localStorage永続化) */
export interface Settings {
  sens: number // マウス感度倍率 0.3〜2.5
  se: number   // 効果音音量 0〜1
  bgm: number  // BGM音量 0〜1
}

const KEY = 'tw-settings'

const DEFAULTS: Settings = { sens: 1.0, se: 1.0, bgm: 1.0 }

export const settings: Settings = { ...DEFAULTS }

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (typeof saved[k] === 'number' && isFinite(saved[k])) settings[k] = saved[k]
  }
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

/** 設定パネルのDOMを組み立てて返す(タイトル/ポーズ画面で共用) */
export function buildSettingsPanel(): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'settings-panel'
  panel.innerHTML = `
    <h3>設定</h3>
    <label class="set-row">
      <span>マウス感度</span>
      <input type="range" min="0.3" max="2.5" step="0.05" data-key="sens" />
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
  `
  const sync = () => {
    panel.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      const k = inp.dataset.key as keyof Settings
      inp.value = String(settings[k])
    })
    panel.querySelectorAll<HTMLElement>('b[data-val]').forEach((b) => {
      const k = b.dataset.val as keyof Settings
      b.textContent = k === 'sens' ? settings[k].toFixed(2) : `${Math.round(settings[k] * 100)}%`
    })
  }
  panel.addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement
    if (!inp.dataset.key) return
    updateSettings({ [inp.dataset.key]: parseFloat(inp.value) } as Partial<Settings>)
    sync()
  })
  // クリックがポインタロック要求等に伝播しないように
  panel.addEventListener('click', (e) => e.stopPropagation())
  sync()
  return panel
}

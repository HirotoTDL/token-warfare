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
  return panel
}

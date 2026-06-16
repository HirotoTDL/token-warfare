import type { CharacterDef } from './types'
import type { TokenDef } from './tokens'
import { Minimap } from './minimap'
import { keybinds, keyLabel } from './settings'

export interface HudState {
  hp: number
  maxHp: number
  energy: number
  charging: boolean
  /** チャージ武器(garo等): energyは溜め量(0..100)を表す。HUDは溜めバー表示に切替える */
  charger?: boolean
  tp: number
  tpMax: number
  skillCdLeft: number
  skillActive: boolean
  stealthed: boolean
  timer: number
  scoreBlue: number
  scoreRed: number
  momentum: boolean
  overtime: boolean
  suddenDeath: boolean
  deadCountdown: number | null
  slots: { def: TokenDef; count: number; affordable: boolean }[]
  /** スフィア占有状態(占領モード): 青陣/中央/敵陣の所有 */
  spheres?: { id: string; owner: 'blue' | 'red' | null; contested: boolean }[]
  countGoal?: number
}

export class HUD {
  minimap = new Minimap()
  private root: HTMLElement
  private els: Record<string, HTMLElement> = {}
  private slotEls: { root: HTMLElement; count: HTMLElement }[] = []
  private msgTimer = 0
  private warnTimer = 0
  private tipTimer = 0
  private lastTimerText = ''

  constructor(root: HTMLElement, char: CharacterDef, loadout: TokenDef[]) {
    this.root = root
    root.innerHTML = `
      <div class="hud-top">
        <div class="score-plate">
          <span class="score blue" id="h-score-blue">0</span>
          <div class="timer-box">
            <span id="h-timer">3:00</span>
            <span class="ot-label" id="h-ot">OVERTIME</span>
          </div>
          <span class="score red" id="h-score-red">0</span>
        </div>
        <div class="sphere-status" id="h-spheres" style="display:flex;gap:14px;justify-content:center;align-items:center;margin-top:4px;">
          <span class="sph-label" style="font-size:11px;opacity:0.8;color:#fff;">占領</span>
          <span id="h-sph-blueBase" title="青陣スフィア" style="width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.5);background:#3da8ff;"></span>
          <span id="h-sph-center" title="中央スフィア" style="width:18px;height:18px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.7);background:#cccccc;"></span>
          <span id="h-sph-redBase" title="赤陣スフィア" style="width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.5);background:#ff5040;"></span>
          <span class="sph-goal" style="font-size:11px;opacity:0.8;color:#ffd23e;">/30で勝利</span>
        </div>
      </div>
      <div id="h-warn"></div>
      <div id="h-crosshair"><i></i><i></i><i></i><i></i><span class="dot"></span></div>
      <div id="h-hitmarker"><i></i><i></i><i></i><i></i></div>
      <div id="h-vignette"></div>
      <div id="h-stealth"></div>
      <div id="h-dead"><div class="dead-inner"><span>撃破された…</span><b id="h-dead-count"></b></div></div>
      <div class="hud-bl">
        <div class="hp-row">
          <span class="hp-num" id="h-hp"></span>
          <div class="bar hp-bar"><div class="fill" id="h-hp-fill"></div></div>
        </div>
        <div class="energy-row">
          <span class="energy-label" id="h-en-label">EN</span>
          <div class="bar energy-bar"><div class="fill" id="h-en-fill"></div></div>
          <span class="energy-state" id="h-en-state"></span>
        </div>
        <div class="skill-box" id="h-skill">
          <span class="key">${keyLabel(keybinds.skill)}</span>
          <span class="skill-name">${char.skill.name}</span>
          <span class="skill-cd" id="h-skill-cd"></span>
        </div>
      </div>
      <div class="hud-br">
        <div class="weapon-name">${char.weapon.name}</div>
        <div class="momentum" id="h-momentum">MOMENTUM</div>
      </div>
      <div class="hud-bc">
        <div class="tp-row">
          <span class="tp-label">TP</span>
          <div class="bar tp-bar"><div class="fill" id="h-tp-fill"></div></div>
          <span class="tp-num" id="h-tp"></span>
        </div>
        <div class="slots" id="h-slots"></div>
      </div>
      <div id="h-feed"></div>
      <div id="h-msg"></div>
      <div id="h-tip"></div>
      <div id="h-killbanner"></div>
      <div id="h-minimap-slot"></div>
      <div id="h-ping" style="position:absolute;top:8px;left:8px;font-size:11px;font-weight:700;letter-spacing:0.3px;padding:2px 7px;border-radius:6px;background:rgba(10,14,24,0.6);color:#7dffd0;display:none;pointer-events:none;">PING --</div>
    `
    const ids = ['h-score-blue', 'h-score-red', 'h-timer', 'h-ot', 'h-warn', 'h-hp', 'h-hp-fill',
      'h-sph-blueBase', 'h-sph-center', 'h-sph-redBase',
      'h-en-fill', 'h-en-label', 'h-en-state', 'h-skill', 'h-skill-cd', 'h-momentum',
      'h-tp-fill', 'h-tp', 'h-slots', 'h-feed', 'h-msg', 'h-crosshair', 'h-hitmarker',
      'h-vignette', 'h-stealth', 'h-dead', 'h-dead-count', 'h-minimap-slot', 'h-killbanner', 'h-tip', 'h-ping']
    for (const id of ids) this.els[id] = root.querySelector(`#${id}`) as HTMLElement
    this.els['h-minimap-slot'].appendChild(this.minimap.canvas)

    const slotsRoot = this.els['h-slots']
    loadout.forEach((def, i) => {
      const el = document.createElement('div')
      el.className = 'slot'
      el.innerHTML = `
        <span class="key">${keyLabel(keybinds[`deploy${i + 1}` as keyof typeof keybinds])}</span>
        <span class="tname">${def.name}</span>
        <span class="cost">${def.cost}</span>
        <span class="count"></span>
      `
      slotsRoot.appendChild(el)
      this.slotEls.push({ root: el, count: el.querySelector('.count') as HTMLElement })
    })
  }

  update(s: HudState, dt: number) {
    this.els['h-score-blue'].textContent = `${s.scoreBlue}`
    this.els['h-score-red'].textContent = `${s.scoreRed}`
    // スフィア占有状態(色: 青/赤/無色グレー。係争中はパルス)
    if (s.spheres) {
      for (const sp of s.spheres) {
        const el = this.els[`h-sph-${sp.id}`]
        if (!el) continue
        el.style.background = sp.owner === 'blue' ? '#3da8ff' : sp.owner === 'red' ? '#ff5040' : '#bbbbbb'
        el.style.boxShadow = sp.contested ? '0 0 8px 2px #ffd23e' : 'none'
      }
    }
    const t = Math.max(0, s.timer)
    const timerText = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
    if (timerText !== this.lastTimerText) {
      this.lastTimerText = timerText
      this.els['h-timer'].textContent = timerText
    }
    this.els['h-timer'].classList.toggle('urgent', t < 30)
    this.els['h-ot'].textContent = s.suddenDeath ? 'SUDDEN DEATH' : 'OVERTIME'
    this.els['h-ot'].classList.toggle('show', s.overtime || s.suddenDeath)

    this.els['h-hp'].textContent = `${Math.ceil(Math.max(0, s.hp))}`
    const hpFrac = Math.max(0, s.hp / s.maxHp)
    this.els['h-hp-fill'].style.width = `${hpFrac * 100}%`
    this.els['h-hp-fill'].classList.toggle('low', hpFrac < 0.35)

    this.els['h-en-fill'].style.width = `${s.energy}%`
    if (s.charger) {
      // チャージ武器: エネルギーバーを「溜めゲージ」として流用。フルで発光・FULL表示、照準も光らせる
      const full = s.energy >= 99
      this.els['h-en-fill'].classList.toggle('charging', s.charging && !full)
      this.els['h-en-fill'].classList.toggle('full', full)
      this.els['h-en-fill'].classList.remove('low')
      this.els['h-en-label'].textContent = '溜'
      this.els['h-en-state'].textContent = full ? 'FULL! 離して発射' : s.charging ? '溜め中…' : '左クリック長押しで溜め'
      this.els['h-crosshair'].classList.toggle('charged', full)
      this.els['h-crosshair'].classList.toggle('charging', s.charging && !full)
    } else {
      this.els['h-en-fill'].classList.toggle('charging', s.charging)
      this.els['h-en-fill'].classList.toggle('low', s.energy < 25 && !s.charging)
      this.els['h-en-fill'].classList.remove('full')
      this.els['h-en-label'].textContent = 'EN'
      this.els['h-en-state'].textContent = s.charging ? 'チャージ中…' : s.energy < 25 ? `${keyLabel(keybinds.charge)}長押しでチャージ` : ''
    }

    this.els['h-tp-fill'].style.width = `${(s.tp / s.tpMax) * 100}%`
    this.els['h-tp'].textContent = `${Math.floor(s.tp)}`

    const skill = this.els['h-skill']
    skill.classList.toggle('ready', s.skillCdLeft <= 0)
    skill.classList.toggle('active', s.skillActive)
    this.els['h-skill-cd'].textContent = s.skillCdLeft > 0 ? `${s.skillCdLeft.toFixed(1)}` : 'READY'

    s.slots.forEach((slot, i) => {
      const el = this.slotEls[i]
      if (!el) return
      el.root.classList.toggle('na', !slot.affordable || slot.count >= slot.def.maxActive)
      el.count.textContent = `${slot.count}/${slot.def.maxActive}`
    })

    this.els['h-momentum'].classList.toggle('show', s.momentum)
    this.els['h-stealth'].style.opacity = s.stealthed ? '1' : '0'

    const dead = this.els['h-dead']
    if (s.deadCountdown !== null) {
      dead.classList.add('show')
      this.els['h-dead-count'].textContent = s.deadCountdown.toFixed(1)
    } else {
      dead.classList.remove('show')
    }

    if (this.msgTimer > 0) {
      this.msgTimer -= dt
      if (this.msgTimer <= 0) this.els['h-msg'].classList.remove('show')
    }
    if (this.warnTimer > 0) {
      this.warnTimer -= dt
      if (this.warnTimer <= 0) this.els['h-warn'].classList.remove('show')
    }
    if (this.tipTimer > 0) {
      this.tipTimer -= dt
      if (this.tipTimer <= 0) this.els['h-tip'].classList.remove('show')
    }
  }

  /** チュートリアルTIP(初心者向けの文脈ヘルプ) */
  tip(text: string, sec = 5) {
    const el = this.els['h-tip']
    el.innerHTML = `<b>TIP</b> ${text}`
    el.classList.add('show')
    this.tipTimer = sec
  }

  message(text: string, sec = 1.6) {
    const el = this.els['h-msg']
    el.textContent = text
    el.classList.add('show')
    this.msgTimer = sec
  }

  /** ネットワーク品質表示(オンライン対戦のping)。show=falseで非表示(オフライン/host計測なし)。色=緑<80/黄<160/赤 */
  setNet(pingMs: number, show: boolean) {
    const el = this.els['h-ping']
    if (!el) return
    if (!show) { el.style.display = 'none'; return }
    el.style.display = 'block'
    const p = Math.round(pingMs)
    el.textContent = `PING ${p}ms`
    el.style.color = p < 80 ? '#7dffd0' : p < 160 ? '#ffd23e' : '#ff6a5a'
  }

  /** 重要警告(位置捕捉・オーバータイム等) */
  warn(text: string, sec = 2.5) {
    const el = this.els['h-warn']
    el.textContent = text
    el.classList.add('show')
    this.warnTimer = sec
  }

  /** 撃破/被撃破の大型バナー */
  killBanner(text: string, good: boolean) {
    const el = this.els['h-killbanner']
    el.textContent = text
    el.className = good ? 'good' : 'bad'
    el.classList.remove('pop')
    void el.offsetWidth
    el.classList.add('pop')
  }

  hitmarker() {
    const el = this.els['h-hitmarker']
    el.classList.remove('show')
    void el.offsetWidth
    el.classList.add('show')
  }

  damage() {
    const el = this.els['h-vignette']
    el.classList.remove('show')
    void el.offsetWidth
    el.classList.add('show')
  }

  feed(text: string) {
    const root = this.els['h-feed']
    const line = document.createElement('div')
    line.className = 'feed-line'
    line.textContent = text
    root.prepend(line)
    while (root.children.length > 5) root.removeChild(root.lastChild!)
    setTimeout(() => {
      line.classList.add('fade')
      setTimeout(() => line.remove(), 600)
    }, 3500)
  }

  destroy() {
    this.root.innerHTML = ''
  }
}

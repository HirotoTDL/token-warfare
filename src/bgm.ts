/**
 * BGM管理(SUNO製の楽曲を public/bgm/ に置くと自動で使われる。
 * ファイルが無い間は無音で動作し、エラーも出さない)
 */
const TRACKS = {
  title: 'bgm/bgm_title.mp3',
  select: 'bgm/bgm_select.mp3',
  battle_a: 'bgm/bgm_battle_a.mp3',
  battle_b: 'bgm/bgm_battle_b.mp3',
  overtime: 'bgm/bgm_overtime.mp3',
  win: 'bgm/jingle_win.mp3',
  lose: 'bgm/jingle_lose.mp3',
  draw: 'bgm/jingle_draw.mp3',
} as const

export type TrackName = keyof typeof TRACKS

export class Bgm {
  volume = 0.45

  setVolume(mul: number) {
    this.volume = 0.45 * mul
    if (this.current && !this.current.paused) this.current.volume = this.volume
  }
  private tracks = new Map<TrackName, HTMLAudioElement | null>()
  private current: HTMLAudioElement | null = null
  private currentName: TrackName | null = null
  private unlocked = false
  private pending: TrackName | null = null
  private fadeTimer: number | null = null

  constructor() {
    for (const [name, src] of Object.entries(TRACKS) as [TrackName, string][]) {
      const a = new Audio()
      a.preload = 'auto'
      a.addEventListener('error', () => this.tracks.set(name, null))
      a.src = src
      this.tracks.set(name, a)
    }
  }

  /** ユーザー操作後に呼ぶ(ブラウザの自動再生制限解除) */
  unlock() {
    if (this.unlocked) return
    this.unlocked = true
    if (this.pending) {
      const p = this.pending
      this.pending = null
      this.play(p)
    }
  }

  play(name: TrackName, loop = true) {
    if (!this.unlocked) {
      this.pending = name
      return
    }
    if (this.currentName === name && this.current && !this.current.paused) return
    this.stop()
    const a = this.tracks.get(name)
    if (!a) return
    a.loop = loop
    a.volume = this.volume
    a.currentTime = 0
    a.play().catch(() => this.tracks.set(name, null))
    this.current = a
    this.currentName = name
  }

  /** ジングル(現行BGMを止めて1回だけ再生) */
  jingle(name: TrackName) {
    this.play(name, false)
  }

  stop(fadeSec = 0.5) {
    if (this.fadeTimer !== null) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
    const a = this.current
    this.current = null
    this.currentName = null
    if (!a || a.paused) return
    if (fadeSec <= 0) {
      a.pause()
      return
    }
    const step = a.volume / (fadeSec * 20)
    this.fadeTimer = window.setInterval(() => {
      a.volume = Math.max(0, a.volume - step)
      if (a.volume <= 0.001) {
        a.pause()
        if (this.fadeTimer !== null) {
          clearInterval(this.fadeTimer)
          this.fadeTimer = null
        }
      }
    }, 50)
  }
}

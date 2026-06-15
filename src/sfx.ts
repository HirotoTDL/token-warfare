/** WebAudioによるプロシージャル効果音(外部アセット不要) */
export class Sfx {
  private ctx: AudioContext | null = null
  private noiseBuf: AudioBuffer | null = null
  private master: GainNode | null = null
  private volMul = 1
  // 多層の銃声を起動時に一度だけAudioBufferへ焼き、発砲時は単発BufferSourceで再生する
  // (毎発の多ノード生成=主スレッドコストを排し、連射/撃ち合いのラグを解消。豊かな音は焼き込み済み)
  private shotBufs: { light: AudioBuffer | null; heavy: AudioBuffer | null; far: AudioBuffer | null } = { light: null, heavy: null, far: null }

  setVolume(mul: number) {
    this.volMul = mul
    if (this.master) this.master.gain.value = 0.62 * mul
  }

  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        // 0.5→0.62。後段のリミッターでピークを抑えるので、ベース音量を上げても歪まない=知覚的に強くなる。
        this.master.gain.value = 0.62 * this.volMul
        // マスターのグルー・リミッター: 多数のSEが重なってもクリップさせず、知覚音量を底上げして
        // 「強く・締まった」鳴りにする(撃ち合いで銃声が団子になっても迫力が崩れない)。
        const comp = this.ctx.createDynamicsCompressor()
        comp.threshold.value = -12
        comp.knee.value = 8
        comp.ratio.value = 10
        comp.attack.value = 0.002
        comp.release.value = 0.14
        this.master.connect(comp)
        comp.connect(this.ctx.destination)
        const len = this.ctx.sampleRate * 1
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
        const d = this.noiseBuf.getChannelData(0)
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
        this.prerenderShots() // 銃声をバッファへ事前レンダリング(非同期、完了まではライブ合成にフォールバック)
      } catch {
        this.ctx = null
      }
    }
    this.ctx?.resume()
  }

  /** 銃声3種(軽/重/遠)をOfflineAudioContextで一度だけAudioBufferに焼く。発砲時の多ノード生成を排除する。 */
  private prerenderShots() {
    if (!this.ctx || typeof OfflineAudioContext === 'undefined') return
    const render = (kind: 'light' | 'heavy' | 'far') =>
      this.renderShot(kind).then((b) => { this.shotBufs[kind] = b }).catch(() => {})
    render('light'); render('heavy'); render('far')
  }

  private renderShot(kind: 'light' | 'heavy' | 'far'): Promise<AudioBuffer> {
    const sr = this.ctx!.sampleRate
    const dur = kind === 'far' ? 0.16 : 0.36
    const oc = new OfflineAudioContext(1, Math.ceil(sr * dur), sr)
    // このオフラインctx用のノイズ源(一度きり)
    const nlen = Math.ceil(sr * 0.4)
    const nbuf = oc.createBuffer(1, nlen, sr)
    const nd = nbuf.getChannelData(0)
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1
    const mkNoise = (d: number, vol: number, freq: number, q: number, type: BiquadFilterType) => {
      const src = oc.createBufferSource(); src.buffer = nbuf
      const f = oc.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q
      const g = oc.createGain(); g.gain.setValueAtTime(vol, 0); g.gain.exponentialRampToValueAtTime(0.001, d)
      src.connect(f).connect(g).connect(oc.destination); src.start(0, Math.random() * 0.5, d + 0.05)
    }
    const mkTone = (f0: number, f1: number, d: number, vol: number, type: OscillatorType) => {
      const o = oc.createOscillator(); o.type = type
      o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), d)
      const g = oc.createGain(); g.gain.setValueAtTime(vol, 0); g.gain.exponentialRampToValueAtTime(0.001, d)
      o.connect(g).connect(oc.destination); o.start(0); o.stop(d + 0.05)
    }
    if (kind === 'heavy') {
      mkNoise(0.025, 0.6, 2800, 0.5, 'highpass'); mkNoise(0.28, 0.8, 600, 0.7, 'bandpass')
      mkTone(440, 70, 0.18, 0.5, 'sawtooth'); mkTone(155, 46, 0.26, 0.5, 'sine')
    } else if (kind === 'light') {
      mkNoise(0.016, 0.55, 3600, 0.5, 'highpass'); mkNoise(0.1, 0.62, 1450, 0.8, 'bandpass')
      mkTone(950, 200, 0.06, 0.42, 'square'); mkTone(185, 60, 0.1, 0.4, 'sine')
    } else {
      // far: 基準vol=1で焼き、再生時に要求volでスケール(noise=1/tone=0.55 はライブ版と同比)
      mkNoise(0.08, 1.0, 900, 1, 'bandpass'); mkTone(320, 120, 0.07, 0.55, 'square')
    }
    return oc.startRendering()
  }

  /** 事前レンダリング済みバッファを単発BufferSourceで再生(主スレッドコスト最小)。rateで微妙な音程ゆらぎ。 */
  private playBuffer(buf: AudioBuffer, gain: number, rateJitter: number) {
    if (!this.ctx || !this.master) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * rateJitter
    if (gain === 1) {
      src.connect(this.master)
    } else {
      const g = this.ctx.createGain(); g.gain.value = gain
      src.connect(g).connect(this.master)
    }
    src.start()
  }

  private noise(dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass') {
    if (!this.ctx || !this.noiseBuf || !this.master) return
    const t = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuf
    const filt = this.ctx.createBiquadFilter()
    filt.type = type
    filt.frequency.value = freq
    filt.Q.value = q
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(filt).connect(g).connect(this.master)
    src.start(t, Math.random() * 0.5, dur + 0.05)
  }

  private tone(freq0: number, freq1: number, dur: number, vol: number, type: OscillatorType = 'sine') {
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq0, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  shot(heavy = false) {
    // 事前レンダリング済みバッファを単発再生(連射でも主スレッドが軽い)。未レンダリング時のみライブ多層合成。
    const buf = heavy ? this.shotBufs.heavy : this.shotBufs.light
    if (buf) { this.playBuffer(buf, 1, 0.06); return }
    // フォールバック: 爽快感のある多層構成 ①鋭いクラック ②太い本体 ③下降スナップ ④サブ低域
    if (heavy) {
      this.noise(0.025, 0.6, 2800, 0.5, 'highpass')
      this.noise(0.28, 0.8, 600, 0.7)
      this.tone(440, 70, 0.18, 0.5, 'sawtooth')
      this.tone(155, 46, 0.26, 0.5, 'sine')
    } else {
      this.noise(0.016, 0.55, 3600, 0.5, 'highpass')
      this.noise(0.1, 0.62, 1450, 0.8)
      this.tone(950, 200, 0.06, 0.42, 'square')
      this.tone(185, 60, 0.1, 0.4, 'sine')
    }
  }

  /** 遠くの銃声(敵・トークン)。事前レンダリング済みなら単発再生(トークン多数の連射でも軽い)。 */
  shotFar(vol = 0.12) {
    const buf = this.shotBufs.far
    if (buf) { this.playBuffer(buf, vol, 0.04); return }
    this.noise(0.08, vol, 900, 1)
    this.tone(320, 120, 0.07, vol * 0.55, 'square') // 遠くの「パンッ」の芯を薄く重ねて存在感を出す
  }

  hitmarker() {
    this.tone(1400, 900, 0.06, 0.16, 'square')
  }

  damaged() {
    this.noise(0.15, 0.3, 300, 0.7, 'lowpass')
    this.tone(180, 90, 0.15, 0.2, 'sawtooth')
  }

  explosion() {
    this.noise(0.7, 0.7, 150, 0.5, 'lowpass')
    this.tone(110, 30, 0.5, 0.4, 'triangle')
  }

  reload() {
    this.tone(500, 700, 0.05, 0.12, 'square')
    setTimeout(() => this.tone(700, 500, 0.05, 0.12, 'square'), 120)
  }

  deploy() {
    this.tone(400, 900, 0.18, 0.2, 'triangle')
    this.noise(0.12, 0.12, 2500, 2)
  }

  skill() {
    this.tone(300, 1200, 0.35, 0.22, 'sawtooth')
  }

  denied() {
    this.tone(220, 160, 0.12, 0.18, 'square')
  }

  kill() {
    this.tone(880, 1320, 0.12, 0.2, 'triangle')
    setTimeout(() => this.tone(1320, 1760, 0.12, 0.16, 'triangle'), 90)
  }

  /** ジャンプ(軽い踏み切り) */
  jump() {
    this.tone(420, 680, 0.09, 0.1, 'sine')
    this.noise(0.05, 0.06, 1400, 1.4)
  }

  /** 着地(落下の強さ0..1で重さが変わる) */
  land(impact = 0.5) {
    const v = 0.12 + impact * 0.28
    this.noise(0.1 + impact * 0.08, v, 150, 0.8, 'lowpass')
    this.tone(150, 60, 0.1 + impact * 0.06, 0.1 + impact * 0.12, 'triangle')
  }

  /** 足音(控えめ。歩/走で音量) */
  footstep(vol = 0.05) {
    this.noise(0.045, vol, 480 + Math.random() * 220, 1.4, 'bandpass')
  }

  /** コア回収 */
  core() {
    this.tone(660, 1320, 0.14, 0.2, 'triangle')
    setTimeout(() => this.tone(990, 1760, 0.12, 0.14, 'triangle'), 70)
  }

  /** 位置捕捉警告(捕捉された側に必ず聞かせる) */
  warn() {
    this.tone(880, 660, 0.18, 0.22, 'square')
    setTimeout(() => this.tone(880, 660, 0.18, 0.18, 'square'), 220)
  }

  /** オーバータイム開始 */
  overtime() {
    const seq = [523, 659, 784]
    seq.forEach((f, i) => setTimeout(() => this.tone(f, f * 1.02, 0.18, 0.2, 'square'), i * 110))
  }

  sting(win: boolean) {
    if (win) {
      const seq = [523, 659, 784, 1047]
      seq.forEach((f, i) => setTimeout(() => this.tone(f, f, 0.3, 0.22, 'triangle'), i * 140))
    } else {
      const seq = [392, 330, 262, 196]
      seq.forEach((f, i) => setTimeout(() => this.tone(f, f * 0.97, 0.4, 0.2, 'sawtooth'), i * 180))
    }
  }
}

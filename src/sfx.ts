/** WebAudioによるプロシージャル効果音(外部アセット不要) */
export class Sfx {
  private ctx: AudioContext | null = null
  private noiseBuf: AudioBuffer | null = null
  private master: GainNode | null = null
  private volMul = 1

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
      } catch {
        this.ctx = null
      }
    }
    this.ctx?.resume()
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
    // 爽快感のある銃声の定石=多層構成: ①鋭いクラック(立ち上がり) ②太い本体 ③下降スナップ(芯) ④サブ低域(重み)
    if (heavy) {
      this.noise(0.025, 0.6, 2800, 0.5, 'highpass') // クラック(空気を切る鋭さ)
      this.noise(0.28, 0.8, 600, 0.7) // 本体(ビーム放出の太い芯)
      this.tone(440, 70, 0.18, 0.5, 'sawtooth') // 下降スナップ「ドゥンッ」
      this.tone(155, 46, 0.26, 0.5, 'sine') // サブ(胸に来る重み)
    } else {
      this.noise(0.016, 0.55, 3600, 0.5, 'highpass') // 鋭いクラック
      this.noise(0.1, 0.62, 1450, 0.8) // 本体テクスチャ
      this.tone(950, 200, 0.06, 0.42, 'square') // 「ピシュッ」と下がるスナップ
      this.tone(185, 60, 0.1, 0.4, 'sine') // サブの芯(従来薄かった軽射に重みを付与)
    }
  }

  /** 遠くの銃声(敵・トークン) */
  shotFar(vol = 0.12) {
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

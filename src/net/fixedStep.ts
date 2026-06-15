// 固定タイムステップ累積器。可変フレーム(THREE.Clock.getDelta)を一定dt(既定1/60)の刻みに変換する。
// オンライン時はホスト/クライアントが同じ刻みでsimを進めることで、スナップショット境界と挙動を安定させる。
// (現状simは非決定論だが、ホスト権威では刻みを揃えるだけで十分=ロールバック不要。設計はNETCODE_DESIGN.md)
export class FixedStep {
  readonly dt: number
  private acc = 0
  private readonly maxSteps: number

  constructor(dt = 1 / 60, maxSteps = 5) {
    this.dt = dt
    this.maxSteps = maxSteps // 1フレームでまとめて進める上限(スパイク時の暴走=死のスパイラル防止)
  }

  /** frameDt を貯め、固定dtで step を必要回数呼ぶ。余りは次フレームへ繰り越す。実行したstep数を返す。 */
  run(frameDt: number, step: (dt: number) => void): number {
    this.acc += frameDt
    let n = 0
    while (this.acc >= this.dt && n < this.maxSteps) {
      step(this.dt)
      this.acc -= this.dt
      n++
    }
    // 上限到達で貯まりすぎたら捨てる(復帰不能なスパイラルを避ける)
    if (this.acc > this.dt * this.maxSteps) this.acc = 0
    return n
  }

  /** 次stepまでの補間係数[0,1)。描画の見た目補間に使える(任意) */
  alpha(): number {
    return this.acc / this.dt
  }

  reset(): void {
    this.acc = 0
  }
}

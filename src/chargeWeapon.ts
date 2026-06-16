import type { ChargerDef } from './types'

/** チャージ量(frac)から実際の発射パラメータを算出。frac は [minFrac,1] にクランプし min→max を線形補間。 */
export interface ChargeShot {
  frac: number
  damage: number
  speed: number
  range: number
  pierce: boolean
}

export function chargeShotParams(cd: ChargerDef, frac: number): ChargeShot {
  const f = Math.max(cd.minFrac, Math.min(1, frac))
  const t = (f - cd.minFrac) / Math.max(1e-3, 1 - cd.minFrac) // [minFrac,1]→[0,1]
  return {
    frac: f,
    damage: cd.minDamage + (cd.maxDamage - cd.minDamage) * t,
    speed: cd.minSpeed + (cd.maxSpeed - cd.minSpeed) * t,
    range: cd.minRange + (cd.maxRange - cd.minRange) * t,
    pierce: cd.pierceAtFull && f >= 0.999,
  }
}

/** トリガーホールド→溜め→離す/フル維持超過で発射、という人間操作のチャージを共通処理する小ステート。
 *  毎フレーム step(cd, triggerDown, dt) を呼ぶ。戻り値>0 のときは「このフレームで戻り値fracで発射せよ」。
 *  player.ts(ローカル)と net/remoteCommander.ts(ホスト側の相手駆動)で共有する。 */
export class ChargeState {
  level = 0          // 現在のチャージ量 0..1(HUD表示用)
  private fullHold = 0 // フルチャージを維持している秒
  private wasDown = false
  private recover = 0 // 発射後の硬直(この間は再チャージしない)

  /** @returns 発射するなら発射frac(>=minFrac)。しないなら 0。 */
  step(cd: ChargerDef, down: boolean, dt: number): number {
    if (this.recover > 0) {
      this.recover -= dt
      this.wasDown = down
      this.level = 0
      return 0
    }
    let fire = 0
    if (down) {
      this.level = Math.min(1, this.level + dt / cd.chargeTime)
      if (this.level >= 1) {
        this.fullHold += dt
        if (this.fullHold >= cd.holdTime) fire = 1 // フル維持超過=自動放電
      } else {
        this.fullHold = 0
      }
    } else {
      if (this.wasDown && this.level >= cd.minFrac) fire = this.level // 離した瞬間に発射
      this.level = 0
      this.fullHold = 0
    }
    this.wasDown = down
    if (fire > 0) {
      this.level = 0
      this.fullHold = 0
      this.recover = cd.fireRecover
    }
    return fire
  }

  reset() {
    this.level = 0
    this.fullHold = 0
    this.wasDown = false
    this.recover = 0
  }
}

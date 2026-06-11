import * as THREE from 'three'
import { World } from './world'

/**
 * ミニマップ。
 * - 両軍トークンは全て表示(トークン=盤面情報網)
 * - 敵将は原則非表示。world.revealT が立っている間だけ点滅表示
 */
export class Minimap {
  canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size = 200
  private staticC: HTMLCanvasElement

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = this.size
    this.canvas.className = 'minimap'
    this.ctx = this.canvas.getContext('2d')!
    this.staticC = document.createElement('canvas')
    this.staticC.width = this.staticC.height = this.size
  }

  /** 障害物レイヤーを事前描画 */
  buildStatic(world: World) {
    const c = this.staticC.getContext('2d')!
    const s = this.size
    c.clearRect(0, 0, s, s)
    c.fillStyle = 'rgba(10, 14, 24, 0.78)'
    c.beginPath()
    c.roundRect(0, 0, s, s, 10)
    c.fill()
    c.strokeStyle = 'rgba(140, 200, 255, 0.5)'
    c.lineWidth = 2
    c.beginPath()
    c.roundRect(1, 1, s - 2, s - 2, 9)
    c.stroke()
    c.fillStyle = 'rgba(160, 180, 205, 0.45)'
    for (const box of world.colliders) {
      const x = this.toMap(box.min.x)
      const y = this.toMap(box.min.z)
      const w = Math.max(2, ((box.max.x - box.min.x) / (world.arenaHalf * 2)) * s)
      const h = Math.max(2, ((box.max.z - box.min.z) / (world.arenaHalf * 2)) * s)
      c.fillRect(x, y, w, h)
    }
  }

  private toMap(v: number, half = 40) {
    return ((v + half) / (half * 2)) * this.size
  }

  draw(world: World, playerPos: THREE.Vector3, playerYaw: number, time: number) {
    const ctx = this.ctx
    const s = this.size
    ctx.clearRect(0, 0, s, s)
    ctx.drawImage(this.staticC, 0, 0)

    // エナジーコア
    for (const core of world.cores) {
      const x = this.toMap(core.pos.x)
      const y = this.toMap(core.pos.z)
      ctx.fillStyle = core.small ? '#7dffd0' : '#ffd23e'
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      const r = core.small ? 2.6 : 3.6
      ctx.fillRect(-r, -r, r * 2, r * 2)
      ctx.restore()
    }

    // ユニット(トークンは両軍とも表示。将は原則非表示)
    for (const u of world.units) {
      if (!u.alive) continue
      const x = this.toMap(u.group.position.x)
      const y = this.toMap(u.group.position.z)
      if (u.isCommander) {
        if (u.team === 'blue') continue // 自分は別描画
        if (world.revealT[u.team] > 0) {
          // リビール中の敵将: 点滅する大きめマーカー
          const blink = Math.sin(time * 10) > -0.2
          if (blink) {
            ctx.fillStyle = '#ff3030'
            ctx.beginPath()
            ctx.arc(x, y, 5.5, 0, Math.PI * 2)
            ctx.fill()
            ctx.strokeStyle = '#ffd0d0'
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.arc(x, y, 8, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        continue
      }
      if (u.kind === 'decoy') {
        // デコイは敵には将に見える(=赤デコイは表示しない。青デコイは敵を騙すため赤将と同様に非表示)
        continue
      }
      ctx.fillStyle = u.team === 'blue' ? '#4db8ff' : '#ff6a5a'
      const stationary = ['sentry', 'wallpod', 'booster', 'jammer', 'bomber'].includes(u.kind)
      if (stationary) {
        ctx.fillRect(x - 3, y - 3, 6, 6)
      } else {
        ctx.beginPath()
        ctx.arc(x, y, 2.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // 自分(向き付き三角)
    const px = this.toMap(playerPos.x)
    const py = this.toMap(playerPos.z)
    const fx = -Math.sin(playerYaw)
    const fy = -Math.cos(playerYaw)
    const ang = Math.atan2(fy, fx)
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(ang)
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(7, 0)
    ctx.lineTo(-4, 4.6)
    ctx.lineTo(-4, -4.6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

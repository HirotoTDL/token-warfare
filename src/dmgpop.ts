import * as THREE from 'three'
import type { Unit } from './types'

interface Popup {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  tex: THREE.CanvasTexture
  canvas: HTMLCanvasElement
  value: number
  life: number
  pos: THREE.Vector3
}

/**
 * ダメージ数字ポップ(プレイヤーの与ダメージのみ表示)。
 * 同一ターゲットへの連続ヒットは合算して1つの数字が育つ。
 */
export class DamagePopups {
  private group = new THREE.Group()
  private items = new Map<number, Popup>()

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
  }

  show(victim: Unit, amount: number) {
    let it = this.items.get(victim.id)
    if (it && it.life > 0) {
      it.value += amount
      it.life = 0.8
      it.pos.copy(victim.group.position)
      it.pos.y += victim.height + 0.45
      this.redraw(it)
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 72
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(1.5, 0.675, 1)
    const pos = victim.group.position.clone()
    pos.y += victim.height + 0.45
    sprite.position.copy(pos)
    this.group.add(sprite)
    it = { sprite, mat, tex, canvas, value: amount, life: 0.8, pos }
    this.items.set(victim.id, it)
    this.redraw(it)
  }

  private redraw(it: Popup) {
    const ctx = it.canvas.getContext('2d')!
    ctx.clearRect(0, 0, 160, 72)
    const v = Math.round(it.value)
    // ダメージ量で色が育つ(白→黄→オレンジ→赤)
    const color = v >= 80 ? '#ff5040' : v >= 45 ? '#ff9030' : v >= 20 ? '#ffd23e' : '#ffffff'
    ctx.font = `900 ${v >= 45 ? 46 : 38}px "Arial Black", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 7
    ctx.strokeStyle = 'rgba(10, 8, 20, 0.9)'
    ctx.strokeText(`${v}`, 80, 36)
    ctx.fillStyle = color
    ctx.fillText(`${v}`, 80, 36)
    it.tex.needsUpdate = true
  }

  update(dt: number) {
    for (const [id, it] of this.items) {
      it.life -= dt
      if (it.life <= 0) {
        this.group.remove(it.sprite)
        it.tex.dispose()
        it.mat.dispose()
        this.items.delete(id)
        continue
      }
      it.pos.y += dt * 0.9
      it.sprite.position.copy(it.pos)
      it.mat.opacity = Math.min(1, it.life / 0.3)
    }
  }

  dispose() {
    for (const it of this.items.values()) {
      this.group.remove(it.sprite)
      it.tex.dispose()
      it.mat.dispose()
    }
    this.items.clear()
  }
}

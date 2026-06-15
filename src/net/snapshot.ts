import * as THREE from 'three'
import type { Team, Unit } from '../types'
import { getModel } from '../modelLoader'

// ホスト権威simの状態をクライアントへ送る差分なしスナップショット(~20Hz)。
// クライアントはこれを PuppetManager で「見た目だけのユニット」に反映する(権威simは回さない)。
// 設計は docs/NETCODE_DESIGN.md。projectile発射はイベント、定常状態はこのスナップショット。

export interface UnitSnap {
  id: number
  kind: string // 'commander' | token種 | 'decoy'
  team: Team
  ck?: string // charKey(将/デコイのモデル選択用)
  x: number
  y: number
  z: number
  yaw: number
  hp: number
  mhp: number
  alive: boolean
  st?: boolean // stealthed
  tp?: number // 将のTP(クライアントの自機TP HUDを権威化)
}

export interface Snapshot {
  t: number // ホスト時刻(補間/順序用)
  units: UnitSnap[]
  spheres: number[] // [center, blueBase, redBase] の charge[-1,1]
  score: [number, number] // [blue, red]
  timer: number
  sd?: boolean // サドンデス中か(クライアントのフェーズ告知/HUD表示用。ホスト権威)
}

/** ホストのworld/objectivesから現在のスナップショットを作る(権威側で毎送信フレーム呼ぶ) */
export function encodeSnapshot(units: Unit[], spheres: number[], score: [number, number], timer: number, t: number, sd = false): Snapshot {
  const us: UnitSnap[] = []
  for (const u of units) {
    if (!u.alive && u.kind === 'commander') {
      // 死亡中の将も位置は送る(リスポーン演出はクライアントが補間)。トークンは死んだら送らない=puppet削除。
    } else if (!u.alive) {
      continue
    }
    const p = u.group.position
    us.push({
      id: u.id,
      kind: u.kind,
      team: u.team,
      ck: (u as any).char?.key,
      x: +p.x.toFixed(2),
      y: +p.y.toFixed(2),
      z: +p.z.toFixed(2),
      yaw: +u.group.rotation.y.toFixed(3),
      hp: Math.round(u.hp),
      mhp: Math.round(u.maxHp),
      alive: u.alive,
      st: u.stealthed || undefined,
      tp: u.isCommander ? Math.round((u as any).tp ?? 0) : undefined,
    })
  }
  return { t, units: us, spheres, score, timer, sd: sd || undefined }
}

interface Sample {
  t: number // クライアント補間クロックでの受信時刻
  x: number
  y: number
  z: number
  yaw: number
}
interface Puppet {
  group: THREE.Group
  buffer: Sample[] // 受信サンプル列(render-behind補間用。古い順)
  seen: number // 最終受信のクロック(未受信=削除判定用)
  hp: number
  mhp: number
  fill: THREE.Sprite // HPバーの残量(scale.xで増減・色で残量表現)
  fillMat: THREE.SpriteMaterial
}

/**
 * クライアント側で、受信スナップショットを「見た目専用ユニット(puppet)」に反映する。
 * 権威simを走らせず、idごとにモデルを生成/更新/削除し、受信間を補間して滑らかに見せる。
 * skipId(自機)は対象外(自機はローカル予測でレンダリングする)。
 */
export class PuppetManager {
  private puppets = new Map<number, Puppet>()
  private group = new THREE.Group()
  private localTeam: Team | null = null // この陣営の将=自機(クライアント本人)なのでpuppet化しない
  private clock = 0 // クライアント補間用クロック(update(dt)で進む)
  private readonly interpDelay = 0.1 // render-behind量(s)。受信間より大きく取りジッタ/欠落を吸収して滑らかに描く

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
  }

  /** 自機(クライアント本人)の陣営。その将はローカル一人称で描くのでpuppetにしない。 */
  setLocalCommanderTeam(team: Team) {
    this.localTeam = team
  }

  private isLocal(u: UnitSnap) {
    return u.kind === 'commander' && u.team === this.localTeam
  }

  /** スナップショット受信時: puppetの目標transformを更新し、居なくなったidは削除 */
  ingest(snap: Snapshot) {
    const present = new Set<number>()
    for (const u of snap.units) {
      if (this.isLocal(u)) continue
      present.add(u.id)
      let p = this.puppets.get(u.id)
      if (!p) {
        const model = this.buildModel(u)
        const bar = this.buildHpBar(u.kind)
        model.add(bar.group)
        this.group.add(model)
        p = { group: model, buffer: [], seen: this.clock, hp: u.hp, mhp: u.mhp, fill: bar.fill, fillMat: bar.fillMat }
        this.puppets.set(u.id, p)
        model.position.set(u.x, u.y, u.z)
        model.rotation.y = u.yaw
      }
      // 受信サンプルをクライアントクロックでスタンプしてバッファへ(update()がinterpDelay分だけ過去を再生)
      p.buffer.push({ t: this.clock, x: u.x, y: u.y, z: u.z, yaw: u.yaw })
      if (p.buffer.length > 8) p.buffer.shift()
      p.seen = this.clock
      p.hp = u.hp; p.mhp = u.mhp
      p.group.visible = u.alive
    }
    // スナップに居ないpuppet(撃破/退場)は削除
    for (const [id, p] of this.puppets) {
      if (!present.has(id)) {
        this.group.remove(p.group)
        this.puppets.delete(id)
      }
    }
  }

  /** 毎フレーム: render-behind補間で滑らかに描画する(interpDelay分だけ過去の2サンプル間を線形補間) */
  update(dt: number) {
    this.clock += dt
    const renderT = this.clock - this.interpDelay
    for (const p of this.puppets.values()) {
      const buf = p.buffer
      if (buf.length > 0) {
        // renderTを挟む2サンプルを探す(古い順)。無ければ端にクランプ。
        let a = buf[0]
        let b = buf[buf.length - 1]
        if (renderT <= buf[0].t) { a = b = buf[0] } // バッファより過去(まだ溜まっていない)→最古へ
        else if (renderT >= buf[buf.length - 1].t) { a = b = buf[buf.length - 1] } // 最新を追い越し(欠落)→最新で停止
        else {
          for (let i = 0; i < buf.length - 1; i++) {
            if (renderT >= buf[i].t && renderT <= buf[i + 1].t) { a = buf[i]; b = buf[i + 1]; break }
          }
        }
        const span = b.t - a.t
        const f = span > 1e-5 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 0
        p.group.position.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)
        let d = (b.yaw - a.yaw) % (Math.PI * 2)
        if (d > Math.PI) d -= Math.PI * 2
        if (d < -Math.PI) d += Math.PI * 2
        p.group.rotation.y = a.yaw + d * f
      }
      // HPバー: 残量で幅(中央アンカー)と色(緑→黄→赤)を更新(Spriteは常にカメラ向き。頭上x=z=0で回転に強い)
      const ratio = Math.max(0, Math.min(1, p.mhp > 0 ? p.hp / p.mhp : 0))
      p.fill.scale.x = Math.max(0.001, 1.0 * ratio)
      p.fillMat.color.setRGB(ratio < 0.5 ? 1 : 2 * (1 - ratio), ratio > 0.5 ? 1 : 2 * ratio, 0.15)
      p.group.updateMatrixWorld()
    }
  }

  /** 頭上のHPバー(背景＋残量の2スプライト。Spriteは常時カメラを向く) */
  private buildHpBar(kind: string): { group: THREE.Group; fill: THREE.Sprite; fillMat: THREE.SpriteMaterial } {
    const g = new THREE.Group()
    g.position.y = kind === 'commander' || kind === 'decoy' ? 2.2 : 1.1
    const bgMat = new THREE.SpriteMaterial({ color: 0x101018, transparent: true, opacity: 0.7, depthTest: false })
    const bg = new THREE.Sprite(bgMat)
    bg.scale.set(1.06, 0.18, 1)
    bg.renderOrder = 998
    g.add(bg)
    const fillMat = new THREE.SpriteMaterial({ color: 0x49ff6a, transparent: true, depthTest: false })
    const fill = new THREE.Sprite(fillMat)
    fill.scale.set(1.0, 0.12, 1)
    fill.position.z = 0.01
    fill.renderOrder = 999
    g.add(fill)
    return { group: g, fill, fillMat }
  }

  /** id→puppetの現在HP等(HUD/ヘルスバー用に必要なら拡張)。今は本体位置のみ。 */
  has(id: number) {
    return this.puppets.has(id)
  }

  private buildModel(u: UnitSnap): THREE.Group {
    const key = u.kind === 'commander' || u.kind === 'decoy' ? `char_${u.ck ?? 'renji'}` : `token_${u.kind}`
    const m = getModel(key, u.team)
    if (m) return m
    // フォールバック: 種別が分かる簡易プレースホルダ(GLB未ロード/未知kind時)
    const g = new THREE.Group()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, u.kind === 'commander' ? 1.7 : 0.8, 0.6),
      new THREE.MeshStandardMaterial({ color: u.team === 'blue' ? 0x3da8ff : 0xff5040 }),
    )
    box.position.y = (u.kind === 'commander' ? 1.7 : 0.8) / 2
    g.add(box)
    return g
  }

  dispose() {
    for (const p of this.puppets.values()) this.group.remove(p.group)
    this.puppets.clear()
    this.group.parent?.remove(this.group)
  }
}

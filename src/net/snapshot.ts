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
}

export interface Snapshot {
  t: number // ホスト時刻(補間/順序用)
  units: UnitSnap[]
  spheres: number[] // [center, blueBase, redBase] の charge[-1,1]
  score: [number, number] // [blue, red]
  timer: number
}

/** ホストのworld/objectivesから現在のスナップショットを作る(権威側で毎送信フレーム呼ぶ) */
export function encodeSnapshot(units: Unit[], spheres: number[], score: [number, number], timer: number, t: number): Snapshot {
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
    })
  }
  return { t, units: us, spheres, score, timer }
}

interface Puppet {
  group: THREE.Group
  lastX: number
  lastY: number
  lastZ: number
  lastYaw: number
  tgtX: number
  tgtY: number
  tgtZ: number
  tgtYaw: number
  seen: number // 最終受信スナップのt(未受信=削除判定用)
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
        this.group.add(model)
        p = { group: model, lastX: u.x, lastY: u.y, lastZ: u.z, lastYaw: u.yaw, tgtX: u.x, tgtY: u.y, tgtZ: u.z, tgtYaw: u.yaw, seen: snap.t }
        this.puppets.set(u.id, p)
        model.position.set(u.x, u.y, u.z)
        model.rotation.y = u.yaw
      }
      // 現在位置を「前回」に、新規受信を「目標」に(update()で補間)
      p.lastX = p.group.position.x; p.lastY = p.group.position.y; p.lastZ = p.group.position.z; p.lastYaw = p.group.rotation.y
      p.tgtX = u.x; p.tgtY = u.y; p.tgtZ = u.z; p.tgtYaw = u.yaw
      p.seen = snap.t
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

  /** 毎フレーム: 受信間を補間して滑らかに移動させる(render-behind簡易補間) */
  update(lerp: number) {
    const k = Math.min(1, lerp)
    for (const p of this.puppets.values()) {
      p.group.position.x += (p.tgtX - p.group.position.x) * k
      p.group.position.y += (p.tgtY - p.group.position.y) * k
      p.group.position.z += (p.tgtZ - p.group.position.z) * k
      let d = (p.tgtYaw - p.group.rotation.y) % (Math.PI * 2)
      if (d > Math.PI) d -= Math.PI * 2
      if (d < -Math.PI) d += Math.PI * 2
      p.group.rotation.y += d * k
      p.group.updateMatrixWorld()
    }
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

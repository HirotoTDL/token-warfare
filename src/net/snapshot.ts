import * as THREE from 'three'
import type { Team, Unit } from '../types'
import { getModel } from '../modelLoader'
import { buildProceduralUnit } from '../models'

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
  o?: boolean // wallpodの向き(x軸沿いに伸びるか=alongX)。クライアントが壁を正しい向きで組むために送る
}

export interface Snapshot {
  t: number // ホスト時刻(補間/順序用)
  units: UnitSnap[]
  spheres: number[] // [center, blueBase, redBase] の charge[-1,1]
  cont?: boolean[] // [center, blueBase, redBase] の係争中フラグ(ホスト権威。クライアントは自前導出できないため送る)
  score: [number, number] // [blue, red]
  timer: number
  sd?: boolean // サドンデス中か(クライアントのフェーズ告知/HUD表示用。ホスト権威)
}

/** ホストのworld/objectivesから現在のスナップショットを作る(権威側で毎送信フレーム呼ぶ) */
export function encodeSnapshot(units: Unit[], spheres: number[], score: [number, number], timer: number, t: number, sd = false, cont: boolean[] = []): Snapshot {
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
      ck: (u as any).char?.key ?? (u as any).charKey, // 将=char.key / デコイ=charKey(偽装元)。デコイが常にレンジ姿になる不具合の解消

      x: +p.x.toFixed(2),
      y: +p.y.toFixed(2),
      z: +p.z.toFixed(2),
      yaw: +u.group.rotation.y.toFixed(3),
      hp: Math.round(u.hp),
      mhp: Math.round(u.maxHp),
      alive: u.alive,
      st: u.stealthed || undefined,
      tp: u.isCommander ? Math.round((u as any).tp ?? 0) : undefined,
      o: u.kind === 'wallpod' ? (u as any).alongX : undefined,
    })
  }
  return { t, units: us, spheres, cont: cont.some((c) => c) ? cont : undefined, score, timer, sd: sd || undefined }
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
  barGroup: THREE.Group // HPバー親(ステルス中は隠す)
  stealthMats: { m: THREE.Material; baseOpacity: number }[] // ステルス時に半透明化するモデル素材
  st: boolean // 現在ステルス中か(snapshotのstを反映)
  alive: boolean // 前フレームの生存(リスポーン検出=補間バッファ打ち切り用)
  modelKey: string // 採用すべきGLBキー(char_*/token_*)。代替表示からの差し替え判定用
  team: Team // 差し替え時に getModel へ渡す陣営
  kind: string // HPバー再生成用
  placeholder: boolean // 実GLB未ロードで代替(箱)を出しているか。trueの間は実モデルが読めたら差し替える
}

const STEALTH_OPACITY = 0.13 // ステルス時のpuppet不透明度(BotCommander.setStealthVisualと同値)
const RESPAWN_JUMP = 5 // この水平距離を超える瞬間移動は補間せず瞬間移動扱い(リスポーンの滑り防止)

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
    if (!snap || !Array.isArray(snap.units)) return // 不正スナップは丸ごと破棄
    const present = new Set<number>()
    for (const u of snap.units) {
      if (this.isLocal(u)) continue
      // 非信頼peer(host)由来の座標を検証: NaN/Infをpuppet行列に入れるとThREEのフラスタムカリングが壊れ画面が凍結する。
      // client→host(input/fire)と同じ「不正フレームは捨てる」方針をstateにも適用(非有限ユニットはスキップ=残留もさせない)。
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.z) || !Number.isFinite(u.yaw) ||
          !Number.isFinite(u.hp) || !Number.isFinite(u.mhp)) continue
      present.add(u.id)
      let p = this.puppets.get(u.id)
      if (!p) {
        const built = this.buildModelFor(u)
        const stealthMats = this.collectMats(built.group) // バー追加前にモデル素材だけ収集
        const bar = this.buildHpBar(u.kind)
        built.group.add(bar.group)
        this.group.add(built.group)
        p = {
          group: built.group, buffer: [], seen: this.clock, hp: u.hp, mhp: u.mhp,
          fill: bar.fill, fillMat: bar.fillMat, barGroup: bar.group, stealthMats, st: !!u.st, alive: u.alive,
          modelKey: this.keyFor(u), team: u.team, kind: u.kind, placeholder: built.placeholder,
        }
        this.puppets.set(u.id, p)
        built.group.position.set(u.x, u.y, u.z)
        built.group.rotation.y = u.yaw
      } else if (p.placeholder) {
        // 対戦開始時にGLB未ロードで代替(箱)を出していた場合、実モデルが読めたら差し替える(=参加者側で敵が箱のままになる不具合の解消)
        this.tryUpgrade(p)
      }
      // リスポーン(死→生)や大ジャンプは補間すると死亡地点→基地へ滑って見えるので、バッファを打ち切り瞬間移動にする
      const last = p.buffer[p.buffer.length - 1]
      const jumped = (!p.alive && u.alive) || (last && Math.hypot(u.x - last.x, u.z - last.z) > RESPAWN_JUMP)
      if (jumped) p.buffer.length = 0
      // 受信サンプルをクライアントクロックでスタンプしてバッファへ(update()がinterpDelay分だけ過去を再生)
      p.buffer.push({ t: this.clock, x: u.x, y: u.y, z: u.z, yaw: u.yaw })
      if (p.buffer.length > 8) p.buffer.shift()
      p.seen = this.clock
      p.hp = u.hp; p.mhp = u.mhp
      p.st = !!u.st
      p.alive = u.alive
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
      // ステルス: モデルを半透明化しHPバーを隠す(cloak/decoyを相手画面でも有効に。decoyは実体側stが無いので薄くならず本体識別が困難になる)
      const stealth = p.st
      for (const s of p.stealthMats) {
        const want = stealth ? STEALTH_OPACITY : s.baseOpacity
        if (s.m.opacity !== want) { s.m.opacity = want; s.m.needsUpdate = true }
      }
      p.barGroup.visible = !stealth
      // HPバー: 残量で幅(中央アンカー)と色(緑→黄→赤)を更新(Spriteは常にカメラ向き。頭上x=z=0で回転に強い)
      const ratio = Math.max(0, Math.min(1, p.mhp > 0 ? p.hp / p.mhp : 0))
      p.fill.scale.x = Math.max(0.001, 1.0 * ratio)
      p.fillMat.color.setRGB(ratio < 0.5 ? 1 : 2 * (1 - ratio), ratio > 0.5 ? 1 : 2 * ratio, 0.15)
      p.group.updateMatrixWorld()
    }
  }

  /** モデル配下の全マテリアルを収集し透過可能にする(ステルス半透明化用。HPバー追加前に呼ぶこと) */
  private collectMats(group: THREE.Group): { m: THREE.Material; baseOpacity: number }[] {
    const out: { m: THREE.Material; baseOpacity: number }[] = []
    group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) { m.transparent = true; out.push({ m, baseOpacity: m.opacity ?? 1 }) }
    })
    return out
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

  /** team/kind の生存puppet数(クライアントのトークンスロットHUD用。自配備トークンはworld.units外でpuppetとして保持されるため) */
  countActive(team: Team, kind: string): number {
    let n = 0
    for (const p of this.puppets.values()) if (p.team === team && p.kind === kind && p.group.visible) n++
    return n
  }

  /** このユニットが採用すべきGLBキー(char_ または token_ 接頭) */
  private keyFor(u: UnitSnap): string {
    return u.kind === 'commander' || u.kind === 'decoy' ? `char_${u.ck ?? 'renji'}` : `token_${u.kind}`
  }

  /**
   * 実GLBがあればそれを、無ければホストと同一のプロシージャル・モデルを返す(placeholder=実GLB未使用)。
   * 以前は代替として「色付きの箱」を出していたが、token_sentry/wallpod/mine はGLBが存在せずホストは
   * プロシージャル組み立てで描くため、クライアントだけ箱になっていた(=参加者側でトークンが四角い不具合)。
   * buildProceduralUnit でホストの resolveModel fallback と同じ見た目を出して解消する。
   * GLBを持つトークンが未ロードの間も一旦プロシージャルで描き、読めたら tryUpgrade でGLBへ差し替える。
   */
  private buildModelFor(u: UnitSnap): { group: THREE.Group; placeholder: boolean } {
    const m = getModel(this.keyFor(u), u.team)
    if (m) return { group: m, placeholder: false }
    return { group: buildProceduralUnit(u.kind, u.team, u.ck, u.o !== false), placeholder: true }
  }

  /** 代替表示中のpuppetを、実GLBが読み込めたら本物に差し替える(transform/可視/HPバーを引き継ぐ) */
  private tryUpgrade(p: Puppet) {
    const real = getModel(p.modelKey, p.team)
    if (!real) return // まだ読み込めていない→次のスナップショットで再試行
    const stealthMats = this.collectMats(real) // 新モデルの素材を収集(バー追加前)
    const bar = this.buildHpBar(p.kind)
    real.add(bar.group)
    real.position.copy(p.group.position)
    real.rotation.y = p.group.rotation.y
    real.visible = p.group.visible
    this.group.remove(p.group)
    this.group.add(real)
    p.group = real
    p.fill = bar.fill
    p.fillMat = bar.fillMat
    p.barGroup = bar.group
    p.stealthMats = stealthMats // 差し替え後もステルス半透明を維持(update が p.st を即反映)
    p.placeholder = false
  }

  dispose() {
    for (const p of this.puppets.values()) this.group.remove(p.group)
    this.puppets.clear()
    this.group.parent?.remove(this.group)
  }
}

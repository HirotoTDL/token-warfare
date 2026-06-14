import * as THREE from 'three'
import { World, type Core } from './world'
import { buildArena, MAPS } from './arena'
import { createSky, SKY_DAY, SKY_DUSK } from './sky'
import { Effects, Combat } from './combat'
import { Sfx } from './sfx'
import { Bgm } from './bgm'
import { Input } from './input'
import {
  CHARACTERS, TEAM_NAME, characterByKey,
  MATCH_TIME, OVERTIME_AT, RESPAWN_TIME, RESPAWN_TIME_OT, RESPAWN_INVULN,
  TP_MOMENTUM_MUL, CORE_TP, CORE_TP_MOMENTUM_BONUS, SMALL_CORE_TP,
  type Team, type CharacterDef,
} from './types'
import { PlayerCommander } from './player'
import { BotCommander, botParams } from './bot'
import { HUD } from './hud'
import { TOKENS } from './tokens'
import { buildCore, buildMonsterCommander } from './models'
import { preloadModels, MODEL_MANIFEST, getModel, animateSkeleton, animateGlbBody } from './modelLoader'
import { buildSettingsPanel, settings, onSettingsChange } from './settings'
import { simulateMatch, simulateMatrix, summarize } from './sim'
import { Objectives, CAPTURE_TO_WIN } from './objectives'
import { DamagePopups } from './dmgpop'
import { PostFX } from './postfx'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

// --- 基盤 ---
const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.98
app.appendChild(renderer.domElement)

const postfx = new PostFX(renderer)
// IBL環境マップ(PBRマテリアルに艶と環境光を与える)
const pmrem = new THREE.PMREMGenerator(renderer)
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

const input = new Input(renderer.domElement)
const sfx = new Sfx()
const bgm = new Bgm()
bgm.play('title') // 最初のクリックで解禁されるまで保留される
preloadModels(MODEL_MANIFEST) // public/models/*.glb があれば自動採用

// 設定(感度・音量)
sfx.setVolume(settings.se)
bgm.setVolume(settings.bgm)
onSettingsChange((s) => {
  sfx.setVolume(s.se)
  bgm.setVolume(s.bgm)
})
document.getElementById('settings-title')!.appendChild(buildSettingsPanel())
document.getElementById('settings-pause')!.appendChild(buildSettingsPanel())

const hudRoot = document.getElementById('hud')!
const screens = {
  title: document.getElementById('screen-title')!,
  mode: document.getElementById('screen-mode')!,
  select: document.getElementById('screen-select')!,
  result: document.getElementById('screen-result')!,
}
const resumeOverlay = document.getElementById('resume-overlay')!

function showScreen(name: keyof typeof screens | null) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', k !== name)
  }
  // キャラ選択中はメニュー背景をショーケースカメラに
  if (view instanceof MenuView) {
    view.setShowcase(name === 'select')
    // 選択画面に入ったら現在の選択キャラを中央ステージへフォーカス(連動が切れて中央に出ない不具合の修正)
    if (name === 'select') view.focusChar(selectedIdx)
  }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial
      sm.map?.dispose()
      m.dispose()
    }
  })
}

interface View {
  update(dt: number): void
  render(): void
  resize(): void
  dispose(): void
}

// --- メニュー背景(キャラ選択時は8人のショーケース) ---
class MenuView implements View {
  private world = new World()
  private camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1200)
  private sky: { update(t: number): void }
  private arena: { update(dt: number, t: number): void; sunDir: THREE.Vector3 }
  private t = 0
  private showcase = false
  private monsters: THREE.Group[] = []
  private monsterIsGlb: boolean[] = []
  private focusIdx: number | null = null
  private hopV: number[] = []
  private pedestals: THREE.Mesh[] = []
  private fieldFog: THREE.Fog | null = null // 通常時のフォグを退避(ショーケースで濃霧に差し替え)
  private fieldBg: THREE.Color | THREE.Texture | null = null

  constructor() {
    this.arena = buildArena(this.world)
    this.sky = createSky(this.world.scene, this.arena.sunDir)
    this.world.scene.environment = envTex
    ;(this.world.scene as any).environmentIntensity = 0.18
    // ショーケース: 8人が一列に並ぶ(キャラ選択画面の背景)。GLBがあれば使い、無ければプロシージャル
    CHARACTERS.forEach((c, i) => {
      const glb = getModel(`char_${c.key}`, 'blue')
      const m = glb ?? buildMonsterCommander(c, 'blue')
      this.monsterIsGlb.push(!!glb)
      m.position.set((i - 3.5) * 2.4, 0, 8)
      m.rotation.y = 0 // +z(カメラ側)を向く
      this.world.scene.add(m)
      this.monsters.push(m)
      this.hopV.push(0)
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.95, 0.14, 20),
        new THREE.MeshStandardMaterial({ color: 0x39414e, roughness: 0.5, metalness: 0.4 }),
      )
      ped.position.set((i - 3.5) * 2.4, 0.07, 8)
      ped.receiveShadow = true
      this.world.scene.add(ped)
      this.pedestals.push(ped)
    })
  }

  setShowcase(on: boolean) {
    this.showcase = on
    const sc = this.world.scene
    if (on) {
      this.refreshGlbModels()
      // フィールドから切り離す: 濃い霧＋クリアな背景でアリーナを覆い隠し、選択キャラだけを浮遊表示
      if (!this.fieldFog) this.fieldFog = sc.fog as THREE.Fog
      if (this.fieldBg === null) this.fieldBg = sc.background as THREE.Color | THREE.Texture
      const bg = new THREE.Color(0x171428)
      sc.background = bg
      sc.fog = new THREE.Fog(0x171428, 5, 17)
      for (const p of this.pedestals) p.visible = false
    } else {
      this.focusIdx = null
      if (this.fieldFog) sc.fog = this.fieldFog
      if (this.fieldBg !== null) sc.background = this.fieldBg
      for (const p of this.pedestals) p.visible = true
      for (const m of this.monsters) m.visible = true
    }
  }

  /** 起動時に未ロードだったGLBが揃ったら、プロシージャル表示を差し替える */
  private refreshGlbModels() {
    CHARACTERS.forEach((c, i) => {
      if (this.monsterIsGlb[i]) return
      const glb = getModel(`char_${c.key}`, 'blue')
      if (!glb) return
      const old = this.monsters[i]
      glb.position.copy(old.position)
      glb.position.y = 0
      this.world.scene.remove(old)
      this.world.scene.add(glb)
      this.monsters[i] = glb
      this.monsterIsGlb[i] = true
    })
  }

  focusChar(i: number | null) {
    if (i !== null && this.focusIdx !== i && this.monsters[i]) {
      this.hopV[i] = 3.2 // 注目されたらぴょこんと跳ねる
      sfx.hitmarker()
    }
    this.focusIdx = i
  }

  update(dt: number) {
    this.t += dt
    this.world.time = this.t
    this.sky.update(this.t)
    this.arena.update(dt, this.t)

    // 起動時に未ロードだったGLBが揃い次第、プロシージャル表示をフェアリィGLBへ差し替える
    // (タイトル/ホーム画面でも反映されるよう、全員GLBになるまで毎フレーム試行)
    if (this.monsterIsGlb.some((b) => !b)) this.refreshGlbModels()

    // キャラのステージ挙動: 選択中は中央ステージへせり出して大きく見せる(盛り上げ演出)
    const stageZ = 11
    this.monsters.forEach((m, i) => {
      const focused = this.showcase && this.focusIdx === i
      // ショーケース(キャラセレクト)は選択キャラのみ表示。タイトル背景では全員表示。
      m.visible = !this.showcase || focused
      const homeX = (i - 3.5) * 2.4
      // 目標位置: 注目中は中央ステージ(カメラ側へ前進)、それ以外は後列
      const tx = focused ? 0 : homeX
      const tz = focused ? stageZ : 8
      const k = Math.min(1, dt * 6)
      m.position.x += (tx - m.position.x) * k
      m.position.z += (tz - m.position.z) * k
      if (focused) {
        // フィールドから切り離してフローティング表示(緩やかに上下＋傾き)
        m.position.y += (2.3 - m.position.y) * Math.min(1, dt * 4) + Math.sin(this.t * 1.1) * 0.012
        this.hopV[i] = 0
      } else {
        // 上下(選択時のホップ＋接地)
        let baseY = Math.max(0, m.position.y + this.hopV[i] * dt)
        if (this.hopV[i] !== 0 || baseY > 0) {
          this.hopV[i] -= 14 * dt
          if (baseY <= 0) { baseY = 0; this.hopV[i] = 0 }
          m.position.y = baseY
        }
      }
      // スケール: 注目中は大きく、ショーケースの非選択は控えめに後退
      const ts = focused ? 1.2 : this.showcase ? 0.8 : 1.0
      const s = m.scale.x + (ts - m.scale.x) * k
      m.scale.setScalar(s)
      // 向き: 選択画面ではカメラ側(正面)を向かせる(モデル正面が-Zのため+π)。
      // 注目中はゆったり見回し、それ以外は控えめスウェイ。
      const faceBase = this.showcase ? Math.PI : 0
      m.rotation.y = faceBase + (focused ? Math.sin(this.t * 0.7) * 0.35 : Math.sin(this.t * 1.6 + i * 1.3) * 0.06)
      m.rotation.z = focused ? 0 : Math.sin(this.t * 2 + i) * 0.015
      // モーション: リグ済みは関節アニメ、無リグは体アニメ。注目中は活発に動かす
      const amp = focused ? 0.55 : this.showcase ? 0.1 : 0.14
      if (m.userData.bones) animateSkeleton(m, this.t * 2.2 + i, amp)
      else animateGlbBody(m, this.t * 2.0 + i, amp)
    })

    if (this.showcase) {
      // ショーケースカメラ: 中央ステージのキャラを正面・大きめに捉える
      const target = new THREE.Vector3()
      const look = new THREE.Vector3()
      if (this.focusIdx !== null && this.monsters[this.focusIdx]) {
        // 浮遊する選択キャラを正面・やや見上げで捉える
        target.set(0, 2.7, stageZ + 4.0)
        look.set(0, 2.2, stageZ)
      } else {
        target.set(Math.sin(this.t * 0.12) * 2.5, 3.0, 16.5)
        look.set(0, 1.2, 9)
      }
      this.camera.position.lerp(target, Math.min(1, dt * 3.5))
      this.camera.lookAt(look)
    } else {
      const a = this.t * 0.08
      this.camera.position.set(Math.cos(a) * 40, 14 + Math.sin(this.t * 0.3) * 2, Math.sin(a) * 40)
      this.camera.lookAt(0, 2.5, 0)
    }
  }

  render() {
    postfx.render(this.world.scene, this.camera)
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    disposeScene(this.world.scene)
  }
}

export interface MatchConfig {
  charKey: string
  botLevel: number
  practice: boolean
  mapKey: string
}

// --- 戦闘(3分スコアアタック) ---
class BattleView implements View {
  world = new World()
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 1200)
  player: PlayerCommander
  bot: BotCommander
  hud: HUD
  over = false
  everLocked = false
  timer = MATCH_TIME
  objectives!: Objectives
  scores: Record<Team, number> = { blue: 0, red: 0 } // スフィア占領カウント(整数表示)
  private respawnT: Partial<Record<Team, number>> = {}
  private fx: Effects
  private combat: Combat
  private popups: DamagePopups
  private sky: { update(t: number): void }
  private arena: { update(dt: number, t: number): void; sunDir: THREE.Vector3 }
  private t = 0
  private coreSpawnT = 4
  private overtimeAnnounced = false
  private suddenDeath = false
  private endTimer = -1
  private hitstopT = 0
  /** プレイヤー戦績 */
  stats = { dmgDealt: 0, dmgTaken: 0, tokenKills: 0, cores: 0, tpEarned: 0 }
  /** チュートリアルTIP(最初の3試合のみ、各1回) */
  private tipsEnabled = false
  private tipsShown = new Set<string>()

  constructor(public config: MatchConfig, private onEnd: (scores: Record<Team, number>) => void) {
    this.arena = buildArena(this.world, config.mapKey)
    this.sky = createSky(this.world.scene, this.arena.sunDir, (this.arena as any).dusk ? SKY_DUSK : SKY_DAY)
    this.world.scene.environment = envTex
    ;(this.world.scene as any).environmentIntensity = (this.arena as any).dusk ? 0.28 : 0.18
    this.fx = new Effects(this.world.scene)
    this.combat = new Combat(this.world, this.fx, sfx)
    this.popups = new DamagePopups(this.world.scene)
    this.world.scene.add(this.camera)
    // スフィア占領目標: 中央＋両陣に配置(charge式で奪い合う)
    this.objectives = new Objectives(this.world.scene, new THREE.Vector3(0, 3, 0), this.world.basePos)
    this.world.objectives = this.objectives

    const char = characterByKey(config.charKey)
    const others = CHARACTERS.filter((c) => c.key !== config.charKey)
    const botChar = others[Math.floor(Math.random() * others.length)]

    this.player = new PlayerCommander(this.world, this.combat, sfx, input, char, this.world.basePos.blue, this.camera)
    this.world.addUnit(this.player)
    this.bot = new BotCommander(this.world, this.combat, sfx, botChar, this.world.basePos.red, botParams(config.botLevel))
    this.world.addUnit(this.bot)

    this.hud = new HUD(hudRoot, char, this.player.loadout.map((k) => TOKENS[k]))
    this.hud.minimap.buildStatic(this.world)
    hudRoot.classList.remove('hidden')
    this.player.onHit = () => this.hud.hitmarker()
    this.player.onDamaged = () => this.hud.damage()
    this.player.onMessage = (m) => this.hud.message(m)

    this.world.onDamage = (victim, attacker, amount) => {
      if (attacker === this.player) {
        this.stats.dmgDealt += amount
        if (victim !== this.player) this.popups.show(victim, amount)
      }
      if (victim === this.player) this.stats.dmgTaken += amount
    }

    this.world.onReveal = (team) => {
      if (team === 'blue') {
        this.hud.warn('⚠ 敵に位置を捕捉された!(5秒)')
        sfx.warn()
      }
    }

    this.world.onKill = (victim, killer) => {
      if (victim.isCommander) {
        // 占領モード: 撃破はスコアではなく「盤面の主導権」を取る手段。倒して占領を妨げる/通す。
        sfx.kill()
        this.hitstopT = 0.4 // ヒットストップ(一瞬のスロー演出)
        this.hud.killBanner(victim.team === 'red' ? '敵将を撃破!' : 'やられた…', victim.team === 'red')
        this.hud.feed(victim.team === 'red' ? `敵将${victim.name}を撃破! 占領のチャンス` : `${victim.name}、討たれる…`)
        const rt = this.timer <= OVERTIME_AT ? RESPAWN_TIME_OT : RESPAWN_TIME
        this.respawnT[victim.team] = rt
        return
      }
      if (victim.kind === 'decoy') {
        this.hud.feed(`${TEAM_NAME[victim.team]}のデコイが消滅`)
        return
      }
      this.hud.feed(`${victim.name}(${TEAM_NAME[victim.team]})撃破`)
      // 撃破地点に小コアをドロップ(回収しに行く動機)
      this.dropCore(victim.group.position.clone(), true)
      if (killer === this.player) {
        this.stats.tokenKills++
        sfx.hitmarker()
      }
    }

    this.hud.message(`中央＋敵スフィアを確保してカウントを稼げ! 先に${CAPTURE_TO_WIN}で勝利`, 3)

    // 最初の3試合だけチュートリアルTIPを出す
    try {
      const played = parseInt(localStorage.getItem('tw-matches') ?? '0', 10)
      this.tipsEnabled = played < 3
      localStorage.setItem('tw-matches', String(played + 1))
    } catch {
      this.tipsEnabled = false
    }
  }

  /** 条件を満たしたTIPを1度だけ表示 */
  private tip(key: string, text: string) {
    if (!this.tipsEnabled || this.tipsShown.has(key)) return
    this.tipsShown.add(key)
    this.hud.tip(text)
  }

  // --- エナジーコア ---
  private spawnCore() {
    const bigCores = this.world.cores.filter((c) => !c.small)
    if (bigCores.length >= 4) return
    const used = new Set(bigCores.map((c) => `${Math.round(c.pos.x)},${Math.round(c.pos.z)}`))
    const free = this.world.coreSpots.filter((s) => !used.has(`${Math.round(s.x)},${Math.round(s.z)}`))
    if (!free.length) return
    const spot = free[Math.floor(Math.random() * free.length)]
    this.dropCore(spot.clone(), false)
  }

  private dropCore(pos: THREE.Vector3, small: boolean) {
    pos.y = 0
    const mesh = buildCore(small)
    mesh.position.copy(pos)
    this.world.scene.add(mesh)
    this.world.cores.push({ pos, mesh, tp: small ? SMALL_CORE_TP : CORE_TP, small, life: small ? 20 : Infinity })
  }

  private collectCore(core: Core, collector: PlayerCommander | BotCommander, behind: boolean) {
    let tp = core.tp
    if (behind && !core.small) tp += CORE_TP_MOMENTUM_BONUS
    collector.tp = Math.min(100, collector.tp + tp)
    this.world.scene.remove(core.mesh)
    const i = this.world.cores.indexOf(core)
    if (i >= 0) this.world.cores.splice(i, 1)
    this.fx.ring(core.pos.clone(), core.small ? 0x7dffd0 : 0xffd23e)
    if (collector === this.player) {
      this.stats.cores++
      this.stats.tpEarned += tp
      sfx.core()
      this.hud.message(`コア回収 +${tp}TP`)
    }
  }

  private updateCores(dt: number) {
    const overtime = this.timer <= OVERTIME_AT
    this.coreSpawnT -= dt
    if (this.coreSpawnT <= 0) {
      this.coreSpawnT = (overtime ? 6 : 12) * (0.8 + Math.random() * 0.4)
      this.spawnCore()
    }
    const behindTeam: Team | null =
      this.scores.blue < this.scores.red ? 'blue' : this.scores.red < this.scores.blue ? 'red' : null
    for (const core of [...this.world.cores]) {
      core.mesh.rotation.y += dt * 2
      const crystal = core.mesh.userData.crystal as THREE.Object3D | undefined
      if (crystal) crystal.position.y = (core.small ? 0.5 : 0.7) + Math.sin(this.t * 2.5) * 0.1
      if (core.life !== Infinity) {
        core.life -= dt
        if (core.life <= 0) {
          this.world.scene.remove(core.mesh)
          const i = this.world.cores.indexOf(core)
          if (i >= 0) this.world.cores.splice(i, 1)
          continue
        }
      }
      // 回収判定(両将)
      for (const cmd of [this.player, this.bot] as const) {
        if (!cmd.alive) continue
        const cp = cmd === this.player ? this.player.pos : this.bot.group.position
        const dx = cp.x - core.pos.x
        const dz = cp.z - core.pos.z
        if (dx * dx + dz * dz < 1.4 * 1.4) {
          this.collectCore(core, cmd, behindTeam === cmd.team)
          break
        }
      }
    }
  }

  private finish() {
    if (this.over) return
    this.over = true
    this.endTimer = 1.2
    sfx.sting(this.scores.blue >= this.scores.red)
    bgm.jingle(this.scores.blue === this.scores.red ? 'draw' : this.scores.blue > this.scores.red ? 'win' : 'lose')
    input.exitLock()
  }

  update(dt: number) {
    const paused = this.everLocked && !input.locked && !this.over && this.player.alive
    resumeOverlay.classList.toggle('hidden', !paused)
    this.t += dt
    this.world.time = this.t
    this.sky.update(this.t)
    this.arena.update(dt, this.t)
    if (paused) return

    if (!this.over) {
      // スフィア占領カウント更新(中央＋敵陣を確保している側が加算)
      const obj = this.objectives.update(dt)
      this.scores.blue = Math.floor(this.objectives.count.blue)
      this.scores.red = Math.floor(this.objectives.count.red)
      if (obj.ticked) {
        sfx.core()
        this.hud.warn(`占領カウント ${this.scores.blue} - ${this.scores.red}`, 1)
      }
      if (this.objectives.winner) {
        this.hud.killBanner(this.objectives.winner === 'blue' ? '占領完了 勝利!' : '占領され敗北…', this.objectives.winner === 'blue')
        this.finish()
      }

      this.timer -= dt
      if (this.timer <= 0) {
        if (!this.suddenDeath && this.scores.blue === this.scores.red) {
          // 同点ならサドンデス(45秒・先にリードした側が勝ち)
          this.suddenDeath = true
          this.timer = 45
          this.hud.warn('🔥 サドンデス — 先にカウントを進めた方が勝ち!', 4)
          sfx.overtime()
          bgm.play('overtime')
        } else {
          this.timer = 0
          this.finish()
        }
      }
      // サドンデス中: どちらかが少しでもリードしたら即決着
      if (this.suddenDeath && this.scores.blue !== this.scores.red) this.finish()
      // オーバータイム告知
      if (!this.overtimeAnnounced && this.timer <= OVERTIME_AT) {
        this.overtimeAnnounced = true
        this.hud.warn('⚡ OVERTIME — TP回復2倍・コア増加!', 3)
        sfx.overtime()
        bgm.play('overtime')
      }
      // モメンタム(ビハインド側のTP回復ブースト)+ OT全体ブースト
      const otMul = this.timer <= OVERTIME_AT ? 2 : 1
      const blueBehind = this.scores.blue < this.scores.red
      const redBehind = this.scores.red < this.scores.blue
      this.player.tpRegenMul = (blueBehind ? TP_MOMENTUM_MUL : 1) * otMul
      this.bot.tpRegenMul = (redBehind ? TP_MOMENTUM_MUL : 1) * otMul

      // リスポーン処理
      for (const team of ['blue', 'red'] as Team[]) {
        const t = this.respawnT[team]
        if (t === undefined) continue
        const next = t - dt
        if (next <= 0) {
          delete this.respawnT[team]
          const base = this.world.basePos[team]
          if (team === 'blue') {
            this.player.respawn(base, RESPAWN_INVULN)
            this.hud.message(`リスポーン — ${RESPAWN_INVULN}秒無敵`, 2)
          } else {
            this.bot.respawn(base, RESPAWN_INVULN)
          }
          // ワープイン演出
          this.fx.column(base.clone(), team === 'blue' ? 0x4db8ff : 0xff6a5a)
          this.fx.ring(base.clone(), team === 'blue' ? 0x4db8ff : 0xff6a5a)
          sfx.deploy()
        } else {
          this.respawnT[team] = next
        }
      }

      this.updateCores(dt)
      // リビールタイマー減衰
      for (const team of ['blue', 'red'] as Team[]) {
        this.world.revealT[team] = Math.max(0, this.world.revealT[team] - dt)
      }

      // チュートリアルTIP(文脈に応じて1回ずつ)
      if (this.tipsEnabled) {
        const elapsed = MATCH_TIME - this.timer
        if (elapsed > 2.5) this.tip('deploy', 'キー1〜4で照準先にトークンを配備して盤面を作ろう')
        if (elapsed > 12) this.tip('skill', `Eでスキル「${this.player.char.skill.name}」を使える`)
        if (this.player.energy < 30 && this.player.alive) this.tip('energy', 'エネルギー残量に注意 — R長押しでチャージ(無防備になる)')
        if (this.world.cores.some((c) => !c.small)) this.tip('core', 'フィールドのコア(ミニマップの黄色◆)を回収するとTP+20')
        if (this.player.hp < this.player.maxHp * 0.45 && this.player.alive) this.tip('retreat', 'ピンチの時は遮蔽に隠れて6秒で自動回復が始まる')
      }
    }

    // ヒットストップ中はゲーム世界だけスローになる
    const udt = this.hitstopT > 0 ? dt * 0.25 : dt
    this.hitstopT = Math.max(0, this.hitstopT - dt)
    for (const u of [...this.world.units]) u.update(udt)
    this.fx.update(udt)
    this.combat.update(udt)
    this.popups.update(udt)

    if (!this.over) {
      this.hud.update(
        {
          hp: this.player.hp,
          maxHp: this.player.maxHp,
          energy: this.player.energy,
          charging: this.player.charging,
          tp: this.player.tp,
          tpMax: this.player.tpMax,
          skillCdLeft: this.player.skillCd,
          skillActive: this.player.skillActiveT > 0,
          stealthed: this.player.stealthed,
          timer: this.timer,
          scoreBlue: this.scores.blue,
          scoreRed: this.scores.red,
          momentum: this.player.tpRegenMul > (this.timer <= OVERTIME_AT ? 2 : 1),
          overtime: this.timer <= OVERTIME_AT && !this.suddenDeath,
          suddenDeath: this.suddenDeath,
          deadCountdown: this.respawnT.blue ?? null,
          slots: this.player.loadout.map((k) => ({
            def: TOKENS[k],
            count: this.world.countActive('blue', k),
            affordable: this.player.tp >= TOKENS[k].cost,
          })),
        },
        dt,
      )
      this.hud.minimap.draw(this.world, this.player.pos, this.player.yaw, this.t)
    }
    if (this.endTimer > 0) {
      this.endTimer -= dt
      if (this.endTimer <= 0) this.onEnd(this.scores)
    }
  }

  render() {
    postfx.render(this.world.scene, this.camera)
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.hud.destroy()
    hudRoot.classList.add('hidden')
    this.fx.dispose()
    this.combat.dispose()
    this.popups.dispose()
    disposeScene(this.world.scene)
  }
}

// --- 状態遷移 ---
let view: View = new MenuView()
let battle: BattleView | null = null
let lastChar = 'renji'
let pendingMode: { botLevel: number; practice: boolean } = { botLevel: 6, practice: false }
let pendingMap = 'skyhaven'

input.onLockChange = (locked) => {
  if (locked && battle) battle.everLocked = true
  if (locked) resumeOverlay.classList.add('hidden')
}

function startBattle(charKey: string) {
  lastChar = charKey
  view.dispose()
  battle = new BattleView(
    { charKey, botLevel: pendingMode.botLevel, practice: pendingMode.practice, mapKey: pendingMap },
    (scores) => {
      const win = scores.blue > scores.red
      const draw = scores.blue === scores.red
      const label = document.getElementById('result-label')!
      label.textContent = draw ? 'DRAW' : win ? 'WIN' : 'LOSE'
      label.className = draw ? 'draw' : win ? 'win' : 'lose'
      document.getElementById('result-score')!.textContent = `${scores.blue} - ${scores.red}`
      // 戦績詳細
      const b = battle!
      const acc = b.player.shotsFired > 0 ? Math.round((b.player.shotsHit / b.player.shotsFired) * 100) : 0
      document.getElementById('result-stats')!.innerHTML = [
        ['与ダメージ', Math.round(b.stats.dmgDealt)],
        ['被ダメージ', Math.round(b.stats.dmgTaken)],
        ['命中率', `${acc}%`],
        ['トークン撃破', b.stats.tokenKills],
        ['配備', b.player.deploysCount],
        ['コア回収', `${b.stats.cores}(+${b.stats.tpEarned}TP)`],
      ]
        .map(([k, v]) => `<div class="rs-item"><span>${k}</span><b>${v}</b></div>`)
        .join('')
      document.getElementById('result-sub')!.textContent = draw
        ? '互角。次は盤面で上回れ。'
        : win
          ? '盤面とエイム、両方の勝利だ。'
          : '盤面を立て直し、コアを制せ。'
      showScreen('result')
    },
  )
  view = battle
  showScreen(null)
  resumeOverlay.classList.add('hidden')
  bgm.play(Math.random() < 0.5 ? 'battle_a' : 'battle_b')
  input.requestLock()
}

function backToMenu(target: 'title' | 'mode' | 'select') {
  view.dispose()
  battle = null
  view = new MenuView()
  showScreen(target)
  bgm.play(target === 'title' ? 'title' : 'select')
}

// マップ選択チップ
const mapRow = document.getElementById('map-row')!
for (const m of MAPS) {
  const chip = document.createElement('button')
  chip.className = 'map-chip' + (m.key === pendingMap ? ' sel' : '')
  chip.innerHTML = `<b>${m.name}</b><span>${m.desc}</span>`
  chip.addEventListener('click', () => {
    pendingMap = m.key
    mapRow.querySelectorAll('.map-chip').forEach((c) => c.classList.remove('sel'))
    chip.classList.add('sel')
    sfx.unlock()
  })
  mapRow.appendChild(chip)
}

// モード選択
document.getElementById('btn-versus')!.addEventListener('click', () => {
  sfx.unlock()
  pendingMode = { botLevel: 6, practice: false }
  showScreen('select')
})
const levelGrid = document.getElementById('level-grid')!
for (let lv = 1; lv <= 10; lv++) {
  const b = document.createElement('button')
  b.className = 'level-btn'
  b.textContent = `${lv}`
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    sfx.unlock()
    pendingMode = { botLevel: lv, practice: true }
    showScreen('select')
  })
  levelGrid.appendChild(b)
}

// キャラ選択(ロスター＋大プレビュー＋詳細パネル＋出撃)
const rosterRoot = document.getElementById('char-roster')!
const previewWrap = document.getElementById('char-preview')!
const previewName = document.getElementById('preview-name')!
const previewRole = document.getElementById('preview-role')!
const previewTitle = document.getElementById('preview-title')!
const detailsRoot = document.getElementById('char-details')!
const rosterThumbs: HTMLElement[] = []
let selectedChar = CHARACTERS[0]
let selectedIdx = 0

function selectCharacter(c: CharacterDef, idx: number) {
  selectedChar = c
  selectedIdx = idx
  const colorHex = `#${c.color.toString(16).padStart(6, '0')}`
  // 名前タグ(3Dモデルは中央ステージで見せる)
  previewWrap.style.setProperty('--cc', colorHex)
  previewWrap.classList.remove('swap')
  void previewWrap.offsetWidth
  previewWrap.classList.add('swap')
  previewName.textContent = c.name
  previewRole.textContent = c.role
  previewTitle.textContent = c.title
  // 詳細パネル
  detailsRoot.style.setProperty('--cc', colorHex)
  detailsRoot.innerHTML = `
    <div class="detail-hp"><span>HP</span><b>${c.hp}</b></div>
    <div class="detail-block"><span class="dl">武器</span><b>${c.weapon.name}</b><p>${c.weapon.desc}</p></div>
    <div class="detail-block"><span class="dl">スキル</span><b>${c.skill.name}</b><p>${c.skill.desc}</p></div>
    <div class="detail-block"><span class="dl">固有トークン</span><b>${TOKENS[c.uniqueToken].name}</b><p>${TOKENS[c.uniqueToken].desc}</p></div>
  `
  // ロスターのハイライト＋3Dショーケースのフォーカス
  rosterThumbs.forEach((t, i) => t.classList.toggle('sel', i === idx))
  if (view instanceof MenuView) view.focusChar(idx)
}

CHARACTERS.forEach((c, idx) => {
  const colorHex = `#${c.color.toString(16).padStart(6, '0')}`
  const thumb = document.createElement('button')
  thumb.className = `roster-thumb ${c.key} ${c.gender}`
  thumb.style.setProperty('--cc', colorHex)
  thumb.innerHTML = `<span class="rt-frame"><img src="art/portrait_${c.key}.png" alt="${c.name}" loading="lazy" /></span><span class="rt-name">${c.name}</span>`
  thumb.addEventListener('click', () => { sfx.unlock(); selectCharacter(c, idx) })
  thumb.addEventListener('dblclick', () => { sfx.unlock(); startBattle(c.key) })
  thumb.addEventListener('mouseenter', () => { if (view instanceof MenuView) view.focusChar(idx) })
  thumb.addEventListener('mouseleave', () => { if (view instanceof MenuView) view.focusChar(selectedIdx) })
  rosterRoot.appendChild(thumb)
  rosterThumbs.push(thumb)
})

document.getElementById('btn-sortie')!.addEventListener('click', () => { sfx.unlock(); startBattle(selectedChar.key) })
selectCharacter(CHARACTERS[0], 0) // 初期選択

document.getElementById('btn-start')!.addEventListener('click', () => {
  sfx.unlock()
  bgm.unlock()
  bgm.play('select')
  showScreen('mode')
})
document.getElementById('btn-rematch')!.addEventListener('click', () => {
  sfx.unlock()
  startBattle(lastChar)
})
document.getElementById('btn-reselect')!.addEventListener('click', () => {
  sfx.unlock()
  backToMenu('select')
})
document.getElementById('btn-remode')!.addEventListener('click', () => {
  sfx.unlock()
  backToMenu('mode')
})
resumeOverlay.addEventListener('click', () => {
  sfx.unlock()
  input.requestLock()
})

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  postfx.resize(window.innerWidth, window.innerHeight)
  view.resize()
})

// 開発用デバッグフック
;(window as any).__tw = {
  get battle() {
    return battle
  },
  startBattle,
  setMode(botLevel: number, practice = true) {
    pendingMode = { botLevel, practice }
  },
  TOKENS,
  sfx,
  bgm,
  sim: simulateMatch,
  simMatrix: simulateMatrix,
  simSummary: summarize,
}

// --- メインループ ---
const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(0.05, clock.getDelta())
    view.update(dt)
    view.render()
    input.endFrame()
  } catch (e) {
    console.error('[loop error]', e)
  }
})

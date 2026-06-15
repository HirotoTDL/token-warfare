# TOKEN WARFARE — オンライン対戦 ネットコード設計

> 確定方針: **WebRTC P2P ホスト権威**（2026-06-15 ユーザー承認）。
> 多エージェント偵察(workflow `online-netcode-design`)＋本人統合。設計エージェントは一時的なAPI過負荷で再実行待ちのため、確定済みReconに基づき統合。

## 1. なぜ WebRTC P2P ホスト権威か

| 観点 | P2Pホスト権威(採用) | ロールバック | WSサーバ権威 |
|---|---|---|---|
| ホスティング | **不要 / GitHub Pagesのみ** | 不要 | 必須・月額/無料枠制限 |
| sim非決定論との相性 | **問題なし**(ホストが唯一のsim) | 致命的(全乱数+可変dt書換要) | 問題なし |
| 既存改修量 | 中 | 特大 | 中〜大 |
| チート耐性 | 低(カジュアル向け) | 中 | 高 |
| コスト | **¥0** | ¥0 | サーバ代 |
| 低スペック適性 | **良**(client=描画+補間のみ) | 不可(両者フルsim) | 良 |

決め手: ①無償・Pages完結 ②**既存の非決定論sim(`Math.random` 43箇所・可変timestep)をそのまま権威として使える**＝ロールバックが要求する決定論化の地雷を回避 ③`Commander`/`Unit`分離をそのまま活用。
将来ランク戦/チート対策が要るならサーバ権威へ移行 —— そのため **トランスポート抽象** を最初に挟み、ゲームロジックを書き換えずに差し替え可能にする。

## 2. Recon（実コード偵察）の確定事実

### 2.1 ゲームループ / 決定論性 (`main.ts`)
- `setAnimationLoop` + `THREE.Clock.getDelta()` の**可変timestep**(0.05クランプ)。
- simは**非決定論的**: `Math.random` が全体で約43箇所(bot思考間隔/射撃拡散/コア生成/配備など)、シード不可。`sim.ts` も同じ乱数を使うため再現性ゼロ。
- → **ロールバック/ロックステップは不可**(全乱数のシード化+固定timestep+整数/固定小数物理への全面改修が必要)。ホスト権威ならこの問題は発生しない（ホストの結果が唯一の真実）。
- マッチは単一プロセスで完結。`MenuView`↔`BattleView` 遷移時に `World` 再生成。

### 2.2 同期対象の状態 (`world.ts`/`combat.ts`/`objectives.ts`/`types.ts`)
帯域試算: **平常 6〜8KB/s・最大 15KB/s**（WebRTC DataChannelで余裕）。

| 対象 | 内容 | 同期方式 | サイズ感 |
|---|---|---|---|
| Unit | position(12B)+rotation(yaw 2B)+hp+状態flags | スナップショット ~20Hz | 16B×最大6体 ≈ 5.8KB/s |
| Bolt | origin+dir+BoltOpts | **発射イベント** | ~45B×30/s ≈ 1.35KB/s |
| Bolt着弾 | hitUnitId+point+damage | イベント | ~20B×hit |
| Sphere | charge×3 / score / penalty | charge定期(1〜数Hz)+奪取イベント | 数B |
| World | time / revealT | 1Hz定期 + イベント | 4B/s |
| Core | tp / life | 配備・生成・消滅イベント | 低頻度 |

権威分配: **ホストが全状態の真実**。clientは描画+補間のみ(+自機のみ予測)。
注意リスク: Bolt物理の浮動小数誤差(発射再計算はせずホスト着弾結果をイベントで送る)、ダメージ/占領の順序制御はホスト側で確定。

### 2.3 入力 / コマンド (`input.ts`/`player.ts`/`bot.ts`)
- `Input` は2層: `keys`(持続) + `pressed`(立ち上がり) + `mouseDX/DY`(相対) + `mouseDown/Right`。`endFrame()`で毎フレームクリア。
- `PlayerCommander` が mouselook+WASD+射撃+チャージ+配備+スキル を毎フレーム駆動。
- `BotCommander implements Unit` は入力を使わず自律駆動(`think/acquireTarget/shoot/moveUpdate`)。
- **キーになる構造**: `Commander`(player/bot) と `Unit` が分離 → リモートプレイヤーは **`RemoteCommander`** として、受信入力でUnitを駆動できる(botと同型 `update(dt)`)。
- 入力ペイロード: move(4bit)+mouseDelta(i8×2)+flags+events ≈ **6.75B / 50Hz**。

### 2.4 UI / マッチ統合点 (`main.ts`/`index.html`)
- `MatchConfig = {charKey, botLevel, practice, mapKey}`、`startBattle(charKey)` が唯一の戦闘入口。
- 画面: title / mode / select / result(`showScreen`)。`pendingMode`/`pendingMap` がselectまで保持。
- **差し込み**: ①`screen-mode`直後に `screen-lobby`(ホスト作成/コード入力/接続待ち)を新設 ②`startBattle()`をラップしてWebRTC接続を統合 ③`BattleView`の対戦相手を `bot | RemoteCommander` で条件分岐。`MatchConfig` に `online`/`role`/`roomId` を追加。

## 3. アーキテクチャ

```
[ Host browser ]                         [ Client browser ]
 PlayerCommander(自機) ──┐                 PlayerCommander(自機/予測) ──┐
 RemoteCommander(相手) ←─┼ 入力受信          (相手=ホスト自機の表示)        │ 入力送信
 World/Combat/Objectives │                 World(描画用・simしない)        │
   = 権威sim ────────────┘                  ←─ スナップショット/イベント受信 ─┘
   └─ スナップショット送信 ─────────────────→ 補間レンダリング
```

- **ホスト**: 現状どおり完全simを実行。相手Unitは `RemoteCommander` が受信入力で駆動。20Hzでスナップショット送信＋イベント送信。
- **クライアント**: simを走らせない。受信スナップショットを補間(render-behind ~100ms バッファ)。自機のみ**クライアント予測**(入力即時適用→ホストスナップショットで補正)。

## 4. トランスポート抽象（差し替え可能に）

```ts
// src/net/transport.ts
export type NetRole = 'host' | 'client' | 'local'
export interface NetTransport {
  role: NetRole
  send(channel: 'state' | 'input' | 'event', data: ArrayBuffer | object): void
  onMessage(cb: (channel: string, data: any) => void): void
  onState(cb: (s: 'connecting'|'open'|'closed'|'failed') => void): void
  close(): void
}
```
- `LoopbackTransport`: 同一ページ内で host↔client を直結(ネット無しでPhase 0検証)。
- `WebRtcTransport`: PeerJS(無償ブローカー)でシグナリング → DataChannel。公開STUNでNAT越え。

## 5. 段階計画

| Phase | 目標 | 触るファイル | 検証 |
|---|---|---|---|
| **0** | オンライン対応の土台。`NetTransport`/`LoopbackTransport`/`RemoteCommander`/固定timestep累積器。`BattleView`の相手をCommander抽象化 | `src/net/transport.ts`(新)、`src/net/remoteCommander.ts`(新)、`main.ts`、`bot.ts`(共通I/F抽出) | ローカルループバックで2コマンダー駆動・既存挙動不変をビルド+プレビュー |
| **1** | WebRTC(PeerJS+STUN)＋ロビーUI(ホスト=コード発行/参加=入力)。2ブラウザ接続 | `src/net/webrtc.ts`(新)、`index.html`(screen-lobby)、`main.ts` | 別タブ/別PCで接続成立 |
| **2** | スナップショット同期(20Hz)＋client補間。発射/着弾/配備/スキルはイベント | `src/net/snapshot.ts`(新)、`world.ts`、`combat.ts`、`objectives.ts` | 2クライアントで状態一致・滑らかな相手表示 |
| **3** | 自機クライアント予測＋ホスト整合(reconciliation) | `player.ts`、`src/net/*` | 高遅延でも自機が即応・テレポートしない |
| **4** | 再接続・ヒット判定ラグ補償・切断処理 → 4v4拡張 | `src/net/*`、`world.ts` | 擬似遅延/切断テスト |

## 6. 決定ログ / 残る判断
- **[確定] アーキ = WebRTC P2P ホスト権威**（ユーザー承認 2026-06-15）。
- **[Phase 1で判断] TURN中継**: 公開STUNのみ＝接続成功率 約85〜90%(対称NATで失敗)。完全網羅はTURN(有償帯域)。→ まずSTUN無償運用、実ユーザーが失敗したらTURN追加。
- **[将来] チート耐性**: ホスト権威はホスト有利・改竄余地あり=カジュアル前提。ランク戦が必要になったらサーバ権威へ(トランスポート抽象で移行容易)。
- **[4v4] bot穴埋め**: 空きスロットはbotで埋める想定(Commander抽象がそのまま活用可)。

## 7. firstStepNow（ユーザー判断不要・着手可）
Phase 0 = トランスポート抽象＋`RemoteCommander`＋`LoopbackTransport`＋固定timestep累積器。ネットワーク無しでローカル検証でき、既存のオフライン挙動を壊さない可逆リファクタ。

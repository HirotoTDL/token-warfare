// オンライン対戦のトランスポート抽象。
// ゲームロジックは NetTransport にのみ依存させ、実体(ローカルループバック / WebRTC / 将来のWSサーバ)を
// 差し替え可能にする。これにより「まずP2P→将来サーバ権威」への移行をロジック改変なしで行える。
// 設計の全体像は docs/NETCODE_DESIGN.md を参照。

export type NetRole = 'host' | 'client' | 'local'
/** state=権威スナップショット, input=操作入力, event=単発イベント(発射/着弾/配備/占領奪取など) */
export type NetChannel = 'state' | 'input' | 'event'
export type NetState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed'

export interface NetTransport {
  readonly role: NetRole
  readonly state: NetState
  send(ch: NetChannel, data: unknown): void
  onMessage(cb: (ch: NetChannel, data: any) => void): void
  onStateChange(cb: (s: NetState) => void): void
  close(): void
  /** state に関わらず下層資源(peer/conn等)を確実に破棄する。close()の冪等ガードで破棄が抜ける状況の保険(任意実装) */
  dispose?(): void
}

/**
 * ローカルループバック: 同一プロセス内で host↔client を直結する。
 * ネットワーク無しで Phase 0(トランスポート抽象/RemoteCommander/補間)を検証するためのもの。
 * 疑似片道遅延(latencyMs)を与えて補間・予測の挙動も確認できる。
 */
export class LoopbackTransport implements NetTransport {
  readonly role: NetRole
  state: NetState = 'idle'
  private peer: LoopbackTransport | null = null
  private msgCb: ((ch: NetChannel, data: any) => void) | null = null
  private stateCb: ((s: NetState) => void) | null = null
  private latencyMs: number
  private jitterMs: number
  private deterministic: boolean
  private clockMs = 0
  private lastEnqueueAt = 0 // このキューに積んだ最後の配送時刻(FIFO単調化=信頼/順序保証チャネルのhead-of-line再現)
  private rng: number // 決定的ジッタ用LCG状態(再現可能なテストのためMath.randomは使わない)
  private queue: { at: number; ch: NetChannel; data: any }[] = [] // 決定的モードの受信待ち行列(配送論理時刻付き)

  constructor(role: NetRole, latencyMs = 0, deterministic = false, jitterMs = 0) {
    this.role = role
    this.latencyMs = latencyMs
    this.jitterMs = jitterMs
    this.deterministic = deterministic
    this.rng = role === 'host' ? 0x1234567 : 0x89abcde // 役割でシードを変え host/client のジッタ列を別にする
  }

  /**
   * 相互接続済みの [host, client] ペアを生成して open にする。
   * deterministic=true で疑似遅延を論理クロック方式にする(同期テストループで advance(dtMs) を毎フレーム呼んで再生)。
   * jitterMs>0 で片側ジッタ(0〜jitterMsの追加遅延)を与える。配送はFIFO順序保証(実DataChannelと同じ=遅延した先頭が後続を待たせるhead-of-line)。
   * 既定(false)は setTimeout 方式で実時間動作。
   */
  static pair(latencyMs = 0, deterministic = false, jitterMs = 0): [LoopbackTransport, LoopbackTransport] {
    const h = new LoopbackTransport('host', latencyMs, deterministic, jitterMs)
    const c = new LoopbackTransport('client', latencyMs, deterministic, jitterMs)
    h.peer = c
    c.peer = h
    h.setState('open')
    c.setState('open')
    return [h, c]
  }

  /** 0〜jitterMs の決定的ジッタ(LCG)。再現可能。 */
  private nextJitter(): number {
    if (this.jitterMs <= 0) return 0
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0
    return ((this.rng & 0x7fffffff) / 0x7fffffff) * this.jitterMs
  }

  /**
   * 決定的モード: 論理クロックを dtMs 進め、配送時刻に達した受信メッセージを「FIFO順」に配送する(テストが毎フレーム呼ぶ)。
   * 先頭が未到達なら後続も待たせる(信頼/順序保証チャネルのhead-of-line)。queueは積んだ順=at単調(lastEnqueueAtで保証)。
   */
  advance(dtMs: number) {
    if (!this.deterministic) return
    this.clockMs += dtMs
    while (this.queue.length > 0 && this.queue[0].at <= this.clockMs) {
      const m = this.queue.shift()!
      this.deliver(m.ch, m.data)
    }
  }

  private setState(s: NetState) {
    this.state = s
    this.stateCb?.(s)
  }

  send(ch: NetChannel, data: unknown): void {
    const peer = this.peer
    if (!peer || this.state !== 'open') return
    // 構造化複製を模してJSONラウンドトリップ(送信側の参照を受信側が共有して壊す事故を防ぐ=実トランスポートと同じ意味論)
    const copy = typeof data === 'object' && data !== null ? JSON.parse(JSON.stringify(data)) : data
    if (this.latencyMs <= 0) peer.deliver(ch, copy)
    else if (this.deterministic) {
      // 受信側クロック基準で 片道遅延+ジッタ 後に配送。FIFO単調化(max(lastEnqueueAt,…))で順序保証=ジッタは到着のバースト化として現れる。
      const at = Math.max(peer.clockMs + this.latencyMs + this.nextJitter(), peer.lastEnqueueAt)
      peer.lastEnqueueAt = at
      peer.queue.push({ at, ch, data: copy })
    } else setTimeout(() => peer.deliver(ch, copy), this.latencyMs)
  }

  private deliver(ch: NetChannel, data: any) {
    this.msgCb?.(ch, data)
  }

  onMessage(cb: (ch: NetChannel, data: any) => void): void {
    this.msgCb = cb
  }

  onStateChange(cb: (s: NetState) => void): void {
    this.stateCb = cb
  }

  close(): void {
    if (this.state === 'closed') return
    this.setState('closed')
    const peer = this.peer
    this.peer = null
    if (peer && peer.state === 'open') peer.close()
  }
}

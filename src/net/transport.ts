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

  constructor(role: NetRole, latencyMs = 0) {
    this.role = role
    this.latencyMs = latencyMs
  }

  /** 相互接続済みの [host, client] ペアを生成して open にする */
  static pair(latencyMs = 0): [LoopbackTransport, LoopbackTransport] {
    const h = new LoopbackTransport('host', latencyMs)
    const c = new LoopbackTransport('client', latencyMs)
    h.peer = c
    c.peer = h
    h.setState('open')
    c.setState('open')
    return [h, c]
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
    if (this.latencyMs > 0) setTimeout(() => peer.deliver(ch, copy), this.latencyMs)
    else peer.deliver(ch, copy)
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

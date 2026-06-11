export class Input {
  keys = new Set<string>()
  pressed = new Set<string>()
  mouseDown = false
  mouseRight = false
  mousePressed = false
  mouseDX = 0
  mouseDY = 0
  locked = false
  onLockChange: ((locked: boolean) => void) | null = null

  private el: HTMLElement

  constructor(el: HTMLElement) {
    this.el = el
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
      this.pressed.add(e.code)
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => {
      this.keys.clear()
      this.mouseDown = false
      this.mouseRight = false
    })
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.mouseDX += e.movementX
      this.mouseDY += e.movementY
    })
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return
      if (e.button === 0) {
        this.mouseDown = true
        this.mousePressed = true
      }
      if (e.button === 2) this.mouseRight = true
    })
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false
      if (e.button === 2) this.mouseRight = false
    })
    document.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el
      if (!this.locked) {
        this.mouseDown = false
        this.mouseRight = false
      }
      this.onLockChange?.(this.locked)
    })
  }

  requestLock() {
    if (this.locked) return
    try {
      const p: any = this.el.requestPointerLock()
      if (p && p.catch) p.catch(() => {})
    } catch {
      /* ポインタロック不可環境でも続行 */
    }
  }

  exitLock() {
    if (this.locked) document.exitPointerLock()
  }

  /** フレーム末に呼ぶ。押下イベントとマウス移動量をクリア */
  endFrame() {
    this.pressed.clear()
    this.mousePressed = false
    this.mouseDX = 0
    this.mouseDY = 0
  }

  consume(code: string): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code)
      return true
    }
    return false
  }
}

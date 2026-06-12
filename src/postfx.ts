import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/**
 * ポストプロセス(商業ルックの要)。
 * HDRバッファに描画 → ブルーム(発光) → トーンマッピング出力。
 * エミッシブ・エネルギー弾・ネオンが実際に「光る」ようになる。
 */
export class PostFX {
  private composer: EffectComposer
  private renderPass: RenderPass
  bloom: UnrealBloomPass

  constructor(renderer: THREE.WebGLRenderer) {
    this.composer = new EffectComposer(renderer)
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera())
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.5,  // strength
      0.5,  // radius
      1.0,  // threshold(輝度1.0超=HDRなエミッシブ/弾/太陽のみ光らせる)
    )
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderPass.scene = scene
    this.renderPass.camera = camera
    this.composer.render()
  }

  resize(w: number, h: number) {
    this.composer.setSize(w, h)
  }
}

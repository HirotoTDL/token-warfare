import * as THREE from 'three'

const NOISE_GLSL = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
`

export interface SkyPalette {
  zenith: THREE.Color
  horizon: THREE.Color
}

export const SKY_DAY: SkyPalette = {
  zenith: new THREE.Color(0.16, 0.42, 0.88),
  horizon: new THREE.Color(0.98, 0.86, 0.94),
}

/** 夕暮れパンク(ネオンドックス用) */
export const SKY_DUSK: SkyPalette = {
  zenith: new THREE.Color(0.15, 0.1, 0.4),
  horizon: new THREE.Color(1.0, 0.55, 0.65),
}

/** シェーダースカイドーム+雲海。update(t)で雲が流れる */
export function createSky(scene: THREE.Scene, sunDir: THREE.Vector3, palette: SkyPalette = SKY_DAY) {
  // --- 空ドーム ---
  const skyUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDir.clone().normalize() },
    uZenith: { value: palette.zenith },
    uHorizon: { value: palette.horizon },
  }
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      varying vec3 vPos;
      ${NOISE_GLSL}
      void main() {
        vec3 dir = normalize(vPos);
        float h = clamp(dir.y, -1.0, 1.0);
        vec3 zenith = uZenith;
        vec3 horizon = uHorizon;
        vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
        if (h < 0.0) col = mix(horizon, vec3(0.55, 0.65, 0.78), min(1.0, -h * 3.0));
        float sunD = max(dot(dir, normalize(uSunDir)), 0.0);
        col += vec3(1.0, 0.92, 0.72) * pow(sunD, 700.0) * 6.0;
        col += vec3(1.0, 0.85, 0.6) * pow(sunD, 8.0) * 0.22;
        if (h > 0.005) {
          vec2 uv = dir.xz / (dir.y + 0.18) * 1.5 + vec2(uTime * 0.009, uTime * 0.004);
          float c = fbm(uv);
          float cl = smoothstep(0.5, 0.8, c) * smoothstep(0.0, 0.2, h);
          col = mix(col, vec3(0.97, 0.98, 1.0), cl * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat)
  sky.renderOrder = -10
  scene.add(sky)

  // --- 雲海(アリーナ下面に広がる) ---
  const seaUniforms = { uTime: { value: 0 } }
  const seaMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: seaUniforms,
    vertexShader: `
      varying vec2 vXZ;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vXZ = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vXZ;
      ${NOISE_GLSL}
      void main() {
        vec2 uv = vXZ * 0.012 + vec2(uTime * 0.014, uTime * 0.006);
        float f = fbm(uv);
        float a = smoothstep(0.32, 0.72, f);
        float fade = 1.0 - smoothstep(220.0, 470.0, length(vXZ));
        vec3 col = mix(vec3(0.72, 0.8, 0.92), vec3(1.0, 1.0, 1.0), f);
        gl_FragColor = vec4(col, a * fade * 0.95);
      }
    `,
  })
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000, 1, 1), seaMat)
  sea.rotation.x = -Math.PI / 2
  sea.position.y = -17
  sea.renderOrder = -9
  scene.add(sea)

  return {
    update(t: number) {
      skyUniforms.uTime.value = t
      seaUniforms.uTime.value = t
    },
  }
}

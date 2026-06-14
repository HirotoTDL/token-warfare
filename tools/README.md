# tools/ — ローカル3Dパイプライン(Blender headless)

課金サービスに頼らず、手元のBlender(ポータブル版)でキャラ3Dにスケルトンを付与する。

## bl_autorig.py — 自動リグ＆スキニング
未リグのキャラGLB(Tripo出力等)に、bbox比率から humanoid アーマチュアを新規生成し、
numpyの距離ベース・スキニング(各頂点を最近傍3ボーンに逆二乗ウェイト)で結合してGLBを書き出す。
Blender標準のボーンヒート・ウェイトはTripoの高ポリ/交差メッシュで失敗するため、自前スキニングで回避。
ボーン名は src/modelLoader.ts の animateSkeleton が駆動する名前(L_Thigh, L_Calf, L_Upperarm…)に一致させてある。

使い方(meshopt圧縮GLBは先に解凍が必要):
  npx @gltf-transform/cli dedup public/models/char_X.glb stage/X_raw.glb   # meshopt解凍
  blender --background --python tools/bl_autorig.py -- stage/X_raw.glb out/X_rigged.glb ""   # 第3引数に画像パスを渡すと検証レンダ
  npx @gltf-transform/cli optimize out/X_rigged.glb public/models/char_X.glb \
    --texture-compress webp --texture-size 1024 --compress meshopt --simplify false   # スキン保持で再圧縮

注意: Blenderは日本語パスで失敗するためASCIIパスで作業する。各キャラは個別コマンドで実行(bashのfor-loopで連続実行するとnpx/Blenderが落ちる)。

## bl_render_test.py — ヘッドレス検証レンダ
GLBを読み込みEEVEE(BLENDER_EEVEE_NEXT)でPNGに出す確認用。

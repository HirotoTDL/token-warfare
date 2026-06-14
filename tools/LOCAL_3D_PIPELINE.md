# ローカル3Dパイプライン ノウハウ集（Blender headless / 完全無償）

課金サービス（Tripo等）に頼らず、手元のBlenderポータブル版だけでキャラ3Dや構造物を
「作る・いじる・動かす」ための再利用ノウハウ。すべて headless（GUIなし・コマンド実行）で動く。

---

## 0. 環境

- **Blender**: `C:\Users\Luck\blender_portable\blender-4.2.9-windows-x64\blender.exe`（4.2.9 LTS ポータブル）
- **呼び出し方**: `blender.exe --background --python <script.py> -- <引数...>`
  - `--background` でGUIなし。`--` 以降がスクリプトへの引数（`sys.argv[sys.argv.index("--")+1:]` で取得）
- **Python同梱**: numpy / PIL も Blender 同梱Pythonから使える（`import numpy as np` 可）
- **レンダエンジン**: `BLENDER_EEVEE_NEXT`（4.2では `BLENDER_EEVEE` は廃止）

### 鉄則（ハマりどころ）
1. **日本語パスNG**: Blenderは日本語を含むパスで黙って失敗する。**作業はASCIIパスで**（このプロジェクトは
   `tools/stage/` に半角ステージを置くか、`C:\Users\Luck\blender_portable\` を使う）。
   ※ 本プロジェクトのパス自体に日本語（作業フォルダ）が含まれるが、import/exportは動く。
   レンダ出力先だけは特に確実にASCIIにすること。
2. **meshopt圧縮GLBは読めない**: ゲームの `public/models/*.glb` は meshopt 圧縮済み。Blenderに入れる前に
   `npx @gltf-transform/cli dedup in.glb out.glb` で**解凍**する（dedupは読込時にmeshoptをデコードし無圧縮で書く）。
3. **for-loopで連続実行すると落ちる**: bashの `for c in ...; do blender ...; done` だと
   npx/Blenderが `Error: Please select a file` 等で落ちることがある。**1キャラ＝1コマンド**で個別実行する
   （並列なら別々のツールコールで投げる）。
4. **出力GLBの再圧縮**: Blenderから出したGLBは無圧縮で大きい（15〜20MB）。ゲームに戻す前に
   `npx @gltf-transform/cli optimize in.glb public/models/char_X.glb --texture-compress webp --texture-size 1024 --compress meshopt --simplify false`
   で再圧縮（**`--simplify false` でスキン破壊を防ぐ**。2〜3MBになる）。

### 標準サイクル
```
public/models/char_X.glb  --dedup-->  stage/X_dec.glb  --blender script-->  stage/X_out.glb  --optimize-->  public/models/char_X.glb
```

---

## 1. できること一覧（実証済み）

| 能力 | スクリプト | 実証 |
|------|-----------|------|
| 自動リグ＆スケルタル・モーション | `bl_autorig.py` | 全8キャラを無償リグ→歩行/アイドルで稼働 |
| リカラー（色違い・チーム色） | `bl_recolor.py` | ガロを色相シフトで別カラー化 |
| メッシュ変形（体型バリエ） | `bl_reshape.py` | ガロをチビ体型化（頭拡大＋脚短縮） |
| 構造物をゼロから生成 | `bl_build_tower.py` | フェアリィの塔をコードで建築 |
| 検証レンダ | `bl_render_test.py` | 任意GLBをPNG確認 |

---

## 2. 自動リグ `bl_autorig.py`

未リグのキャラGLBにスケルトンを付けて、ゲームの `animateSkeleton` で動くようにする。

- **方式**: モデルのbbox高さ比率から humanoid アーマチュア（20ボーン）を新規生成し、
  **numpyの距離ベース・スキニング**（各頂点を最近傍3ボーンに逆二乗ウェイトでブレンド）で結合。
- **なぜ自前スキニングか**: Blender標準の `parent_set(ARMATURE_AUTO)` のボーンヒート・ウェイトは、
  Tripo由来の高ポリ（17万頂点）・交差/非多様体メッシュで `failed to find solution` となり**全ウェイト0**になる。
  別モデルからの骨転送もスケール不一致＋座標系変換で破綻した。距離スキニングはメッシュ品質に依存せず確実。
- **ボーン名**は `src/modelLoader.ts` の `animateSkeleton` が回す名前に一致させてある：
  `Hip/Waist/Spine01/Spine02/NeckTwist01/Head` ＋ 左右 `Clavicle/Upperarm/Forearm/Hand/Thigh/Calf/Foot`。
```
# meshopt解凍 → リグ → 再圧縮配置
npx @gltf-transform/cli dedup public/models/char_X.glb stage/X_dec.glb
blender --background --python tools/bl_autorig.py -- stage/X_dec.glb stage/X_rig.glb ""   # 第3引数に画像パスを渡すと検証レンダ
npx @gltf-transform/cli optimize stage/X_rig.glb public/models/char_X.glb --texture-compress webp --texture-size 1024 --compress meshopt --simplify false
```
- ゲーム側は `group.userData.bones` の有無で `animateSkeleton`/`animateGlbBody` を自動切替（`bot.ts`/`main.ts`/`tokens.ts`）。

## 3. リカラー `bl_recolor.py`

各マテリアルのベースカラー画像に **Hue/Saturation/Value ノード**を挿し込んで色相を回す。単色マテリアルはHSV直接変換。
```
blender --background --python tools/bl_recolor.py -- stage/X_dec.glb stage/X_alt.glb stage/X_alt.png <hue> <sat>
#   hue: 0.0=無変化, 0.33≒+120°, 0.5≒+180°   sat: 1.0=据置, >1で鮮やか
```
用途: 敵味方の色違い、コスチューム違い、レアリティ違いを1モデルから量産。

## 4. メッシュ変形 `bl_reshape.py`

リグの**頂点グループ**を使って部位ごとに直接頂点を動かす（例: `Head`重みで頭を膨らませ、`Thigh/Calf`重みで脚を縦圧縮→チビ体型）。
numpyで `co += (co - 部位重心) * weight * 係数` の形。lattice/SimpleDeform も同様に使える。
```
blender --background --python tools/bl_reshape.py -- stage/X_dec.glb stage/X_chibi.glb stage/X_chibi.png
```
用途: 体型バリエ（チビ/スリム/マッチョ）、頭身調整、「足が長すぎる」等の比率微修正。

## 5b. 商業レベル構造物ビルダー `bl_structures.py`（本命）

kind引数で構造物を切替生成する汎用ビルダー。pillar/canopy/gate/railing/island/brazier/obelisk を実装済み。
プリミティブ＋bevel＋既存/発注テクスチャの**BOX投影タイル貼り**(UV展開不要)で作る。
```
blender --background --python tools/bl_structures.py -- <kind> stage/struct_<kind>.glb stage/<kind>.png
npx @gltf-transform/cli optimize stage/struct_<kind>.glb public/models/struct_<kind>.glb --texture-compress webp --texture-size 512 --compress meshopt
```
- `tex_mat(name,tex,scale,rough,metal,emit_from_tex)`: BOX投影でタイル。`emit_from_tex>0`でテクスチャ明部(発光ルーン等)を自発光。
- **円柱はBOX投影だと模様が横に滲む** → タイルscaleを上げる(柱は3.0)と縦縞/フルート感が出る。平面が多い形状(4角オベリスク)はscale 1.0でOK。
- ゲーム配置: `MODEL_MANIFEST`登録→`craftedSwap`(高所はbaseY指定)で手続きメッシュの視覚を差し替え(コライダー維持)、または`placeDeco`(arena.ts)で装飾を遅延配置。

### GPTテクスチャ発注フロー（Claude in Chrome）
構造物専用テクスチャはChatGPTで発注([[token-warfare-texture-gpt-rule]])。要点:
1. CLAUDE.mdの手順でブラウザ選択(hostname→HomePC、2台時はAskUserQuestion必須)。
2. chatgpt.com→「画像を作成」モード。**コンポーザーをクリックしてから1〜2秒待って入力**(待たないと先頭文字が落ちる)。Enterで送らず**送信ボタンをクリック**。
3. プロンプト型: 「テクスチャ画像を生成。シームレスにタイルできる正方形、真上から見た平面。<内容>。フェアリーテールのパステル世界観、写実的PBR。文字やロゴ無し、1枚のみ。」
4. 生成(~40s)→ 画像の共有/DLアイコン→「ダウンロードする」(SNS共有はしない)→ `~/Downloads`。
5. `PIL`で512pxに縮小して`public/art/tex_*.png`へ保存。

## 5. 構造物をゼロから生成 `bl_build_tower.py`（テンプレート）

プリミティブ（円柱/円錐/トーラス/球/キューブ）＋ modifier（`BEVEL` でソフトに、array的な配置はforループ）で組み、
`Principled BSDF` のマテリアルを割り当ててGLB出力。塔を例に、段積み胴体・装飾リング・円錐屋根・宝珠・窓・バルコニーを生成。
```
blender --background --python tools/bl_build_tower.py -- stage/tower.glb stage/tower.png
```
→ できたGLBは `public/models/struct_*.glb` に置き、`MODEL_MANIFEST` に登録 → `getScenery()` でステージ配置。
これを雛形に、家・橋・門・祭壇・プラットフォーム等を量産できる。

---

## 6. レンダ（見栄え）のコツ

- **トーンマッピング**: `scene.view_settings.view_transform='AgX'`（ハイライトが綺麗に丸まる）。
  `'Standard'` は明部が硬くすぐ白飛びする。露出は `view_settings.exposure` で微調整（-0.3〜-0.5）。
- **光が強すぎると白飛び**: SUN は energy 2.5〜3 が目安。フィル光は 0.5前後。ワールド背景色も明るさに効くので
  `(0.4〜0.7)` 程度に。最初に強すぎて真っ白になったら energy と world を下げる。
- **カメラ自動フレーミング**: 対象のbbox中心と高さ `h` を出し、`location=(cx, cy - h*2.2, cz + h*0.1)` あたりから
  `to_track_quat('-Z','Y')` で中心を向かせると全身が入る。寄りすぎたら距離(`h*係数`)を増やす。
- **タブが隠れているとブラウザのスクショがタイムアウト**する（rAFが止まる）。実機確認は `preview_eval` で状態を読むか、
  タブを前面にしてから `preview_screenshot`。Blenderレンダはこの制約と無関係なので確実。

## 7. ゲームへの接続

- モデルは `public/models/<key>.glb`。`src/modelLoader.ts` の `MODEL_MANIFEST` に `{key, height}` を追加すると
  `preloadModels` が読み、`getModel`(キャラ/トークン=チームリング付き) か `getScenery`(構造物=リング無し) で取得。
- 正規化は `normalize()` が高さ `height` に自動スケール＋足元接地するので、Blender側の絶対スケールは気にしなくてよい。
- スキン付きは `normalize` が `userData.skinned=true` を立て、`getModel` が `userData.bones` を集める→`animateSkeleton`が回す。

---

## まとめ：このローカル環境でできること

- ✅ **作る**: キャラも構造物もコードでゼロから生成・改変できる
- ✅ **いじる**: 色（リカラー）・形（メッシュ変形/頭身）・骨（リグ）すべて編集可能
- ✅ **動かす**: 自前スキニング＋コード駆動の関節アニメで生き生き動く
- ✅ **無償**: 全工程がローカルBlender＋npx gltf-transform のみ。クレジット消費ゼロ

テクスチャ生成だけは引き続きChatGPT（GPT）を使う方針（[[token-warfare-texture-gpt-rule]] 参照）。
形・骨・色・配置はローカルで完結する。

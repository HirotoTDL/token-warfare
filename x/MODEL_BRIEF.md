# TOKEN WARFARE 3Dモデル発注書(AI 3D生成用)

キャラ・トークンの3DモデルをAI 3D生成サービスで作り、ゲームに組み込むための発注書。
**ゲーム側のGLB自動読込パイプラインは実装済み** — `public/models/<キー>.glb` に置くだけで即反映され、
無い間は現行のプロシージャルモデルで動く(BGM/テクスチャと同じ差し替え方式)。

## 推奨サービス

| サービス | 特徴 | 備考 |
|---|---|---|
| **Meshy**(meshy.ai) | テキスト/画像→3D。スタイル指定可、GLB出力 | 無料枠あり。品質安定 |
| **Tripo**(tripo3d.ai) | 高速・キャラ向き。GLB出力 | 無料枠あり |
| Rodin (hyper3d.ai) | 高品質志向 | クレジット高め |

おすすめフロー: **codex/GPTでキャラ画像(x/ART_BRIEF.md)を先に生成 → その画像をMeshy/Tripoの image-to-3D に入力**。
画風の統一が取りやすく、テキストから直接作るよりブレが少ない。アカウントがあればClaude in Chrome経由でこちらが操作可能。

## 技術要件(全モデル共通)

- フォーマット: **GLB(テクスチャ埋め込み)**
- ポリゴン数: キャラ 15k〜40k tris / トークン 5k〜20k tris
- ポーズ: 立ちポーズ(Aポーズ/自然な直立)。アニメーション不要(v0.3ではスケール/バウンドで動かす)
- 向き・スケールはゲーム側で自動正規化するので不問(高さ・足元・中心を自動調整)
- チーム識別はゲーム側で足元の発光リングを自動追加(青/赤)
- スタイル: ポップでビビット、太いアウトライン感、可愛い人型モンスター(ART_BRIEF.mdの共通スタイルに準拠)

## ファイル配置

| 配置先 | キー |
|---|---|
| `public/models/char_renji.glb` 〜 `char_yume.glb` | キャラ8人(ART_BRIEF.mdの各キャラ指定と同一の外見) |
| `public/models/token_gunner.glb` など | トークン11種(ウォールポッドはプロシージャル固定のため不要) |

トークンのキー: gunner / sentry / healer / striker / mine / booster / chaser / bomber / jammer / sniperdrone

## プロンプト例(Meshy/Tripo text-to-3D の場合)

共通接頭辞:
> cute chibi humanoid monster, vivid pop art style, bold colors, toy-like, game character, standing pose, clean topology

- char_renji: "+ orange and yellow body, two small horns, headband, confident grin"
- char_garo: "+ green bulky body, bear ears, sturdy build"
- char_jin: "+ cyan slim body, glowing visor eye, antenna"
- char_doku: "+ yellow body, goggles on forehead, mechanic vibe"
- char_mimi: "+ hot pink body, long rabbit ears, energetic"
- char_nanase: "+ purple body, headphones, one horn, cool"
- char_riko: "+ red and black body, fox ears, big fluffy tail, smirk"
- char_yume: "+ blue lavender body, halo ring, star hairpin, serene"

トークン例:
- token_gunner: "small cute robot soldier, rounded, vivid pop style"
- token_sentry: "small turret robot with rotating head, cute, pop style"
- token_chaser: "small robotic dog, fast looking, cute, vivid pop style"
(以下同様に各トークンの説明文をTOKENS定義から流用)

## 品質チェック(Claude側で実施)

1. ゲームに配置して視認性確認(遠距離で誰か分かるか、チームリングと喧嘩しないか)
2. ポリゴン数・描画負荷(60fps維持)
3. 画風の統一感
4. NGなら当該プロンプトを修正して再生成(**1体ずつ。グリッド生成禁止**)

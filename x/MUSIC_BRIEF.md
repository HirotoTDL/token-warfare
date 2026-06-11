# TOKEN WARFARE 音楽発注書(SUNO用)

**BGM・楽曲は全てSUNOで作成する**(ユーザー方針)。SUNOでの生成はユーザー操作(またはClaude in Chrome経由)で行い、
生成物は `token-warfare/public/bgm/` に mp3 で配置 → Claudeがゲームに組み込む。

## 共通トーン

世界観ワード: **パンク、ストリート、ビビット、ポップ、かっこいい、親しみ**。
エレクトロ/シンセ主体で、生楽器のパンクの勢いを混ぜる。可愛さと攻撃性の両立。歌詞なし(インスト)推奨。
ループ前提の曲は「イントロ短め・終端がループしやすい構造」と指定する。

## 発注リスト

| ファイル名 | 用途 | 長さ | SUNOプロンプト(英語推奨) |
|---|---|---|---|
| bgm_title.mp3 | タイトル/メニュー | 1:30ループ | "Upbeat electro-pop punk instrumental, neon street vibes, catchy synth lead, mid-tempo 105bpm, playful but cool, game title screen, loopable, no vocals" |
| bgm_battle_a.mp3 | 戦闘メイン1 | 2:00ループ | "High-energy synth punk battle theme, driving bass, 140bpm, vivid arcade energy, aggressive but fun, electric guitar stabs, loopable instrumental" |
| bgm_battle_b.mp3 | 戦闘メイン2(曲替え用) | 2:00ループ | "Energetic drum and bass with pop hooks, 150bpm, street graffiti vibes, bouncy synth, competitive shooter game, loopable instrumental" |
| bgm_overtime.mp3 | オーバータイム(残り30秒) | 0:40ループ | "Frantic intense electro punk, rising tension, 160bpm, sirens and risers, final countdown energy, loopable instrumental" |
| jingle_win.mp3 | 勝利ジングル | 0:08 | "Triumphant short victory jingle, bright synth fanfare, pop punk energy, 8 seconds" |
| jingle_lose.mp3 | 敗北ジングル | 0:08 | "Short defeat jingle, deflated but cute synth, minor key, hopeful ending note, 8 seconds" |
| jingle_draw.mp3 | 引き分け | 0:06 | "Short neutral game jingle, curious synth phrase, unresolved ending, 6 seconds" |
| bgm_select.mp3 | キャラ選択 | 1:00ループ | "Groovy chill electro funk, character select screen, head-nodding beat, 100bpm, playful synth, loopable instrumental" |

## 組み込み手順(生成後にClaudeが実施)

1. `public/bgm/` に配置
2. `src/bgm.ts` を新設(HTMLAudioElementでループ管理、シーン遷移でクロスフェード、音量設定)
3. オーバータイム移行時に bgm_overtime へ切替、決着でジングル
4. 効果音(射撃・爆発等)は現行のWebAudioプロシージャルを継続使用(BGMのみSUNO)

## 品質基準

- ループの継ぎ目が目立たないこと
- 戦闘曲は効果音(射撃音)と帯域が喧嘩しないこと(中低域を空け気味に)
- タイトル曲は「親しみ」寄り、戦闘曲は「かっこいい」寄りのバランス

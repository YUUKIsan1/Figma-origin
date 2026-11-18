# Browser Renderingを使わないPNG生成の調査

Issue [#7](https://github.com/YUUKIsan1/Figma-origin/issues/7) の調査記録。確認日: 2026-11-18。

## 判断

`@resvg/resvg-wasm@2.6.2` と同梱の Noto Sans JP を使う SVG → PNG 方式を試したが、Workers Free の **1リクエスト10msのCPU枠**で安定する代替としては採用しない。CPU枠の緩和（Workers Paidなど）を検討する必要がある。

Issueの「有料プランや有料APIが必要なら、実装前に報告して止める」に従い、調査結果をIssueへ報告して実装を止める。この調査で無料方式がすべて不可能と証明したわけではないが、今回確認した候補で受け入れ条件を満たせる根拠は得られていない。

Issue #7は未完了。Workerの描画処理・依存関係・設定にはこの方式を追加していない。追加の課金設定やサービスも不要。本番計測やデプロイも行っていない。

## CPUの測定

ローカルの Linux / Node.js v24.22.1 で `process.threadCpuUsage()` によるメインスレッドCPU時間を測定した。WASM初期化と最初の描画を分け、さらに8回ウォームアップしてから各条件を20回測定する。

入力は背景、300×150pxの角丸カード、日本語テキスト「今日のアイデア」だけのSVG。影ありではオフセット4px・標準偏差4pxの `feDropShadow` を加える。フォントは `public/fonts/NotoSansJP.ttf` をメモリから渡し、各回とも指定寸法のPNGを実際に生成する。HTMLからの変換、文字の折り返し、ノード展開、認証、D1/R2、フォントの読み込み、base64化、オブジェクト解放は測定に含まない。

| フレーム | 影   |  CPU最小 | CPU中央値 |  CPU p95 | PNG化のみのCPU中央値 |
| -------- | ---- | -------: | --------: | -------: | -------------------: |
| 390×844  | なし |  7.990ms |   8.011ms | 12.010ms |              7.996ms |
| 390×844  | あり | 67.989ms |  71.995ms | 94.500ms |              7.997ms |
| 1440×900 | なし | 26.611ms |  28.003ms | 32.001ms |             23.996ms |
| 1440×900 | あり | 87.940ms |  91.989ms | 95.994ms |             23.998ms |

別途、WASM初期化のメインスレッドCPU時間は21.587msだった。最初のモバイル描画（影なし）は83.950msだった。

これは本番WorkersのCPU時間ではなく、実行機・JIT・OSの計測粒度によって変動するローカルの値。段階ごとの測定が0msになる場合もあり、CPU中央値を本番の正確な予測には使わない。一方、ウォームアップ後のPCフレームはPNG化だけでも10msを超え、影ありのモバイルもCPU予算を大きく超えた。現行モデルの上限（800万画素・1000ノード）よりかなり小さい例であり、無料枠で安定すると判断できる余裕がない。

SVGをラスタライズする部分だけの試作なので、プレビューとの描画一致・日本語の字形・折り返し・画像・不透明度・入れ子の正しさを受け入れ検証したものではない。

## 再現

Node.js 24.6以降を使う。リポジトリのルートから以下を実行する。ライブラリは一時ディレクトリにのみインストールし、アプリの `package.json` / ロックファイルには追加しない。インストールにはネット接続が必要だが、測定スクリプト自体は外部通信せず、トークンやCloudflare設定も使わない。

```sh
benchmark_prefix=$(mktemp -d)
npm install --prefix "$benchmark_prefix" --no-save --ignore-scripts --package-lock=false @resvg/resvg-wasm@2.6.2
node scripts/benchmark-png.mjs "$benchmark_prefix"
```

出力はJSON行。初期化のCPU時間、各寸法・影有無の最初の描画、ウォームアップ後20回の最小・中央値・p95、パース・ラスタライズ・PNG化の中央値を表示する。各回のPNGシグネチャと寸法も検査する。通常のテスト・CI・デプロイからは実行しない。

## 他の候補と制約

| 候補                             | 確認結果                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workers内のSVG→PNG（resvg WASM） | 追加の外部サービスは不要だが、上記のCPU予算が障害。日本語フォント、折り返し、画像、影などを既存HTMLと合わせる実装も別途必要。 |
| Cloudflare Imagesの無料変換      | 月5,000件の無料変換はあるが、SVGは最適化パラメータを無視し、サニタイズしたSVGとして配信する仕様。SVG→PNGの代替には使えない。  |
| 既存のBrowser Rendering          | HTMLプレビューと同じ方針で描画でき、版別R2キャッシュもあるが、ブラウザ起動の失敗・利用上限時のPNG生成は解決しない。           |

Workersではネットワーク待機はCPU時間に含まれないが、WASMの計算やPNG圧縮はCPUを使う。`await` で処理を区切るだけでは同じリクエストのCPU予算は増えない。リソース上限でWorkerが打ち切られる場合、`try/catch` で確実に既存ブラウザ描画へ戻す設計にはできない。

R2の版別キャッシュは同じ版の再生成を避ける。ただし新規フレーム・版変更・キャッシュ削除後は初回描画が必要なので、CPU予算の問題を解消しない。

## 再開する場合

無料枠を維持するなら、ブラウザが使えない場合にも新規のモバイル・PCフレームを日本語・角丸・影・トークン色付きで描画でき、CPUとメモリに収まる別方式の根拠が必要。単に解像度や影を落として要件を満たしたことにはしない。

CPU枠の緩和を選ぶ場合は、所有者が費用と方針を判断してから別PRで実装する。SVGへの変換・画像と日本語の描画比較・同一版キャッシュ・上限時の応答・実際のWorkerでのCPU/メモリ確認を含める。この調査PRのマージだけで課金設定や描画方式は変わらない。

## 参照

- [WorkersのCPU時間制限](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) — FreeはHTTPリクエストあたり10ms、ネットワーク待機は対象外
- [Workersのメモリ制限](https://developers.cloudflare.com/workers/platform/limits/#memory) — isolateあたり128MB
- [Cloudflare ImagesのSVG制約](https://developers.cloudflare.com/images/get-started/limits/#svg)
- [Cloudflare Imagesの無料枠](https://developers.cloudflare.com/images/pricing/#images-free)
- [resvg-js / WASM](https://github.com/yisibl/resvg-js) — 2.6.2、MPL-2.0

調査時にはCloudflare公式ドキュメントの[ソース](https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs)も確認した。料金・上限の変更があり得るため、実装再開時に再確認する。

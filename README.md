# Canvas Note

Grok BotなどのMCPクライアントが画面を描き、人がスマホで確認する最小デザインツール。Issue #1の実装です。人間向けの編集キャンバスや共同編集はありません。

Cloudflare Workers + D1（ファイル・履歴・認証）+ R2（画像・PNGキャッシュ）+ Browser Rendering（PNG）を使用します。ビューアとPNGは同じHTML描画関数を使います。外部画像URL・任意HTML・スクリプトは受け付けません。

## セットアップ

Node.js 24以上、npm、Cloudflareアカウントが必要です。

```sh
npm ci
cp .env.example .dev.vars
```

`.dev.vars` の `ADMIN_TOKEN`、`VIEWER_PASSWORD`、`SESSION_SECRET` を設定してください。`ADMIN_TOKEN`、`VIEWER_PASSWORD`、`SESSION_SECRET` はいずれも32文字以上のランダム値にします。未設定・短い値の場合、Workerは503を返してリクエスト処理を開始しません。例: `openssl rand -hex 32`。実値はコミットしません。`.env.example` には変数名のみ記載しています。Workersはローカル開発時に `.dev.vars` を読みます。

```sh
npm run db:migrate
npm run dev
```

このバックエンドPR単独では、トップページのログイン画面は含まれません。閲覧UIは **PR #3のマージ後** に利用できます。ローカルでは `http://localhost:8787/mcp`、または `POST http://localhost:8787/api/tools/<tool名>` をBearer認証で呼び出して確認します。例えば、ローカル環境に設定した管理者トークンをシェル変数 `ADMIN_TOKEN` に安全に読み込んだ状態で:

```sh
curl -X POST http://localhost:8787/api/tools/list_files \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

D1/R2はローカル環境に保存されます。Browser Renderingのローカル動作はWranglerの対応状況に依存するため、PNGの開発検証には下記のChromium統合テストも用意しています。

## 本番の設定・公開（所有者が実行）

本番設定、シークレット登録、デプロイ、マージは所有者が行います。

```sh
npx wrangler login
npx wrangler d1 create canvas-note
npx wrangler r2 bucket create canvas-note-images
```

作成したD1のIDを `wrangler.jsonc` の `database_id` に設定します。必要に応じてWorker名・D1名・R2名も変更してください。CloudflareダッシュボードでR2とBrowser Renderingの利用を有効にします。

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put VIEWER_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler d1 migrations apply canvas-note --remote
npm run deploy
```

WorkersのHTTPS URLの `/mcp` がStreamable HTTPエンドポイントです。PR #3のマージ後は、同じHTTPS URLのトップページがビューアになります。`ADMIN_TOKEN` は管理専用に保管し、Botには以下で発行するトークンを渡してください。

### 無料枠

有料プランを前提としません。Browser RenderingはWorkers Freeで **1日10分・同時3ブラウザ**。PNGはファイルの版ごとにR2へキャッシュします。D1・R2・Workersにも無料枠上限があります。大量描画、フォント転送、PNGキャッシュの蓄積で上限に達する場合は、利用量を確認して調整してください。無料枠内の運用・実性能は本番で確認が必要です。R2有効化時に支払い方法の登録を求められる場合があります。

未キャッシュのPNG描画は、約9.6MBの可変日本語フルフォント（Noto Sans JP）の転送を含み、描画ごとに新しいブラウザを起動します。Workers Freeの1リクエスト10msというCPU上限に対し、ファイルのJSON処理・PNGのbase64化のCPU時間は未計測です。無料枠内の性能・稼働を保証するものではありません。フォント転送の削減とBrowser Rendering依存の緩和はIssue #7で扱います。

- [Browser Rendering料金](https://developers.cloudflare.com/browser-rendering/pricing/)
- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2料金](https://developers.cloudflare.com/r2/pricing/)

古いPNGは `renders/` プレフィックス配下です。必要に応じてR2ライフサイクルで削除できます（再生成可能）。元画像を削除すると、過去の版から参照される画像も失われるため削除しないでください。

## Bot用Bearerトークンの発行・失効

以下のシェル変数は利用者が設定します。`ADMIN_TOKEN` をチャットやリポジトリへ貼らないでください。

```sh
curl -X POST "$BASE_URL/admin/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Grok Bot"}'
```

返却される `token` はこの一度だけ表示されます。D1にはSHA-256ハッシュのみ保存します。`id` は失効用です。トークンは全ファイルへの読み書き権限を持ちます（MVPは所有者1人の共有ワークスペース）。

```sh
curl "$BASE_URL/admin/tokens" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X DELETE "$BASE_URL/admin/tokens/$TOKEN_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
```

レート制限はD1ではなく、Cloudflare標準のWorkers Rate Limiting bindingを使用します。カウンタのためのD1読み書きはありません。失敗したログインでもD1にアクセスしません。不正Bearerは制限内のみトークン照合のD1読み取りを行い、制限超過後は照合前に拒否します。

| 制限 | 値・対象 | binding |
|---|---|---|
| MCP / REST / 管理API | 発行トークン単位・管理者トークンは毎分60リクエスト | `API_RATE_LIMITER` |
| Bearer認証試行（失敗・未指定も含む） | IP単位で毎分120リクエスト、D1照合前に判定 | `AUTH_RATE_LIMITER` |
| ログイン試行（成功・失敗とも） | IP単位で毎分5回、パスワード照合前に判定 | `LOGIN_RATE_LIMITER` |
| D1へ書き込む変更ツールとトークン発行・失効 | ワークスペース全体で毎分12回 | `WRITE_RATE_LIMITER` |

値は `wrangler.jsonc` の `ratelimits` で変更します。namespace IDはCloudflareアカウント内で他の用途と重ならない値を指定してください。これらのカウンタはCloudflare拠点単位の近似的な制限です。世界全体での厳密な回数や分境界の滑らかな制御は保証しません。

毎分60回は主に読み取り用で、D1変更には別の毎分12回の予算があります。通常のファイル変更は、filesの更新・履歴挿入・古い履歴削除とそのインデックスを含め最大約5行の書き込みを見込み、1拠点で毎分12回を継続した場合は1日約86,400行です（D1 Freeの日次上限100,000行に対する目安）。複数拠点からの利用や将来のスキーマ変更で増えるため、実際の使用量はD1ダッシュボードで確認してください。D1側の日次上限も適用されます。失敗する変更リクエストも予算を消費します。画像アップロードとPNGキャッシュはR2を使うため、このD1予算の対象外です。

トークンの失効は次のリクエストから有効です。ローカルでも設定済みのbindingをWranglerが用意します。カウンタ移行用の `0002_remove_d1_rate_limits.sql` をD1へ適用してください。

## Grok Botへの接続

Grok側のカスタムMCPコネクタ設定で、サーバーURLに `https://<workerのホスト>/mcp`、認証にBearer、値に発行したBot用トークンを設定します。Streamable HTTPのstatelessモードで、各POSTに `Authorization: Bearer ...` が必要です。`Accept: application/json, text/event-stream` を送ります。OAuthとSSE専用の旧トランスポートはありません。

Grok側のプランやバージョンがBearer付きStreamable HTTPのカスタムコネクタに対応している必要があります。実際のGrokアカウントへの登録は所有者が行ってください。MCP SDKを使ったinitialize・tools/list・tools/callはローカルで検証しています。

Botへの指示例:

> Canvas NoteにReNoteファイルとHomeページを作成。390×844のモバイルと1440×900のPCフレームを作り、ブランド色トークン、見出し、カードを追加。render_frameで両方のPNGを確認し、修正後に再描画してください。

## MCPツール・API

各ツールと同名の開発用REST API `POST /api/tools/<tool名>` も利用できます（Bearer必須、JSON引数は同一）。閲覧セッションでは書き込みできません。

| ツール | 引数 | 結果 |
|---|---|---|
| `list_files` | `{}` | ファイル一覧と版番号 |
| `create_file` | `name` | `file`, `version` |
| `get_file` | `fileId` | ファイル全体と版番号 |
| `create_page` | `fileId`, `name` | `page`, `version` |
| `create_frame` | `fileId`, `pageId`, `frame:{name,width,height,background?}` | `frame`, `version` |
| `create_nodes` | `fileId`, `frameId`, `nodes`（最大200） | 作成ノードと版番号 |
| `update_nodes` | `fileId`, `frameId`, `nodes:[{id,...変更プロパティ}]` | 版番号 |
| `delete_nodes` | `fileId`, `frameId`, `nodeIds` | 子孫も削除、版番号 |
| `set_tokens` | `fileId`, `tokens` | トークン全体を置換、版番号 |
| `get_tokens` | `fileId` | トークンと版番号 |
| `get_frame_tree` | `fileId`, `frameId` | ネストした構造・トークン・版番号 |
| `render_frame` | `fileId`, `frameId` | MCP image content（PNG） |
| `upload_image` | `data`（base64）, `mimeType` | `imageId` |
| `list_revisions` | `fileId` | 直近20版の一覧 |
| `restore_revision` | `fileId`, `revision`, `expectedVersion` | 復元したファイルと新しい版番号 |

変更ツールでは `expectedVersion` を指定できます。競合時は409となり、再取得してから再試行します。各変更はファイル単位で原子的です。失敗したバッチは保存されません。復元も新しい版として記録されます。

### データモデルと例

File → Page → Frame → Node。Nodeはフレーム内の配列で保存し、`parentId` でgroupに所属させます。座標は親group基準、配列順が描画順（後が前面）。親は同一フレームのgroupのみ、循環参照は禁止です。groupの大きさは子を自動配置せず、子はフレーム境界で切り取られます。

```json
{
  "fileId": "取得したファイルID",
  "tokens": {
    "colors": {"brand":"#235d46","ink":"#172a20"},
    "radii": {"card":16},
    "spacing": {"thin":1},
    "textStyles": {"title":{"font":"sans","size":28,"weight":"bold","lineHeight":1.4,"color":{"token":"ink"},"align":"left"}}
  }
}
```

`create_nodes` の例:

```json
{
  "fileId":"取得したファイルID",
  "frameId":"取得したフレームID",
  "nodes":[
    {"id":"card","type":"rect","x":20,"y":20,"w":350,"h":200,"fill":{"token":"brand"},"radius":{"token":"card"}},
    {"id":"heading","type":"text","x":40,"y":50,"w":300,"h":80,"fill":"#00000000","text":"今日のアイデア","textStyle":{"token":"title"}}
  ]
}
```

共通: `id`（省略でUUID）, `name`, `type`, `parentId`, `x,y,w,h`, `fill`, `stroke`, `strokeWidth`, `radius`, `opacity`, `shadow:{x,y,blur,color}|null`。画像は `imageId`、テキストは `text`, `textStyle`。フォントは `sans/serif/mono`、太さは `normal/bold`。日本語は同梱Noto Sans JPで表示します。行間は倍率。塗り・線・文字色は `colors`、角丸は `radii`、線幅は `spacing`、文字スタイルは `textStyles` の `{token:"名前"}` で参照できます。x/y/w/hにも `spacing` トークンを参照できます。自動レイアウトはありません。

色は `#RRGGBB` / `#RRGGBBAA`。画像はPNG/JPEG/WebP・2MBまで、外部URL・SVGは不可。画像は領域にcoverで表示します。1ファイル1MB、100ページ、1ページ100フレーム、1フレーム1000ノード、最大4096px・800万画素。1回のバッチは最大200ノードです。

## ビューア（PR #3のマージ後）

このバックエンドPRには閲覧データAPI、認証、プレビュー生成のみ含まれます。以下の操作UIはPR #3が必要です。

閲覧パスワードでログインし、ファイル → ページ → フレームと進みます。同じページ内のモバイル/PC画面はセレクトで切り替えられます。「画面に合わせる」、10〜200%のズーム、スクロールに対応。10秒ごとに変更を確認し、手動更新もできます。24時間有効の署名付きHttpOnly/SameSite Cookieを使い、本番HTTPSではSecure属性が付きます。パスワード変更時、既存セッションも破棄するには `SESSION_SECRET` をローテーションしてください。

## テスト・CI

ローカルにはChromiumが必要です。実行パスを `CHROMIUM_PATH` で指定できます（既定 `/usr/bin/chromium`）。CIではChromeをインストールし、実行可能ファイルの存在を検証したうえで `CHROMIUM_PATH` に設定します。HTTPSでのCookie削除と、失敗した認証試行でD1へ書き込まないことも検証します。

```sh
npm run check    # ESLint + TypeScript + Vitest
npm run build    # デプロイせずWorkerをバンドル
```

テストでは実際のD1/R2エミュレータとChromiumを使い、MCP経由のモバイル/PC作成、PNG寸法・変更反映、キャッシュ、認証、失効、レート制限、原子性、履歴復元を検証します。Cloudflareのリモートブラウザ起動のみローカルChromiumに置き換えます。CIにはGitleaksによるシークレット検出もあります。

本番Cloudflareの無料枠・Grokへの登録・スマホ実機の表示は別途所有者による確認が必要です。自動テストは本番接続の代わりにはなりません。

## フォント

`public/fonts/NotoSansJP.ttf`: Noto Sans JP / SIL Open Font License 1.1。ライセンス全文は同ディレクトリの `OFL.txt`。Figmaの名称・ロゴ・UI資産は使用していません。

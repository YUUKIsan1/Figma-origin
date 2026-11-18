# Grok Botへの接続とトークンのローテーション

Issue #4の運用手順です。所有者が本番デプロイ後に実行します。MVPのPR #2・#3がmainへ入り、HTTPSの本番URL、管理者トークン、閲覧パスワードを所有者が用意してから使用してください。Grokアカウントへの登録・本番設定・マージはこの手順で自動実行しません。

Grok Bot側に **Bearer付きStreamable HTTPのリモートMCP** を登録できる機能が必要です。実アカウントの登録画面・プランは未確認です。設定画面の呼称は利用環境により異なるため、以下では登録する設定値と確認操作を示します。OAuth専用、旧SSE専用、ローカルstdio専用の設定では接続できません。

## 接続設定

| 項目 | 設定値 |
|---|---|
| 名前 | Canvas Note（任意） |
| サーバーURL | `https://<所有するWorkerのホスト>/mcp` |
| 接続方式 | Remote MCP / Streamable HTTP |
| 認証方式 | Bearer token |
| 認証の値 | `/admin/tokens` で発行したBot用トークン。管理者トークンや閲覧パスワードを使わない |
| HTTP Authorization | `Bearer <発行したトークン>`。Bearer認証欄がある場合はトークン本体のみ入力し、プレフィックスを二重にしない |
| HTTP Accept | `application/json, text/event-stream` |
| HTTP Content-Type | `application/json` |

Authorizationはinitializeを含むすべてのMCPリクエストに必要です。Accept / Content-Type / プロトコルのバージョン交渉は通常MCPクライアントが送信します。カスタムヘッダの設定が必要な実装では上表に合わせてください。独自のOriginヘッダは設定しません。

## 1. Bot用トークンを発行する

シークレットやトークン実値は **Git、Issue、PR、チャット、画面の共有画像、作業ログに残さないでください**。管理者トークンは所有者だけが保持し、Botへ渡すのは発行トークンだけです。以下はBashとNode.js 24以上を使い、入力は環境変数に保持します。ファイルへの保存やトークンの表示は行いません。

### 入力

リポジトリで `npm ci` を済ませたターミナルで実行します。URLはダミーなので、自分の本番originへ置き換えます。秘密値をコマンド行に直接書かず、非表示入力で読み込んでください。

```bash
set +x
export CANVAS_BASE_URL='https://example.invalid' # ダミー。実際のWorkerのoriginへ置き換える
read -r -s -p '管理者トークン: ' ADMIN_TOKEN
printf '\n'
export ADMIN_TOKEN
```

### 発行

`POST /admin/tokens` を呼び、返されたJSONを環境変数に受け取ります。トークンの平文が返るのは発行時だけです。

```bash
issue_canvas_token() {
local issued_json
issued_json="$(node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const base = new URL(process.env.CANVAS_BASE_URL);
assert(base.protocol === 'https:' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, '本番origin URLを指定してください');
assert(process.env.ADMIN_TOKEN?.length >= 32, '管理者トークンを設定してください');
const response = await fetch(new URL('/admin/tokens', base), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `Grok Bot ${new Date().toISOString()}` }),
});
assert(response.status === 201, `トークン発行に失敗しました: HTTP ${response.status}`);
const issued = await response.json();
assert(typeof issued.token === 'string' && typeof issued.id === 'string', '発行レスポンスが不正です');
process.stdout.write(JSON.stringify(issued));
NODE
)" || return 1
CANVAS_MCP_TOKEN="$(CANVAS_ISSUED_JSON="$issued_json" node -e 'process.stdout.write(JSON.parse(process.env.CANVAS_ISSUED_JSON).token)')" || return 1
CANVAS_NEW_TOKEN_ID="$(CANVAS_ISSUED_JSON="$issued_json" node -e 'process.stdout.write(JSON.parse(process.env.CANVAS_ISSUED_JSON).id)')" || return 1
export CANVAS_MCP_TOKEN CANVAS_NEW_TOKEN_ID
}
issue_canvas_token
unset -f issue_canvas_token
```

エラーになった場合は先へ進まないでください。HTTP 401/403は管理者認証、429は毎分の制限、503はWorkerのシークレット・binding設定を確認します。リダイレクト先へシークレットを送らないよう、各リクエストはリダイレクトを拒否します。

## 2. Grok Botへ登録する

1. 所有者のGrok Bot管理画面で、MCP・カスタムコネクタの管理画面を開く。
2. 新しいリモートMCP接続を追加し、上表のURL・Streamable HTTP・Bearer認証を指定する。
3. `CANVAS_MCP_TOKEN` の値を認証欄へ直接渡す。チャットへの貼り付けやBotへの自然文での送信はしない。
4. 保存し、画面に接続確認・ツール再読み込みの操作があれば実行する。
5. `list_files`、`create_file`、`create_page`、`create_frame`、`create_nodes`、`update_nodes`、`delete_nodes`、`set_tokens`、`get_tokens`、`get_file`、`get_frame_tree`、`render_frame`、`upload_image`、`list_revisions`、`restore_revision` が取得できることを確認する。

環境変数から認証欄へ値を渡す際、ローカルのパスワード管理ツールを使うか、次の例でクリップボードへ直接送れます。どちらも値をターミナルには表示しません。使ったクリップボードは登録後に消去してください。画面共有は停止して作業します。

```bash
# macOS（Linuxの場合は下の例を代わりに使う）
printf '%s' "$CANVAS_MCP_TOKEN" | pbcopy
# 設定画面の認証欄へ貼り付けた後
printf '' | pbcopy
```

```bash
# Linux / Wayland。wl-clipboardが導入済みの場合
printf '%s' "$CANVAS_MCP_TOKEN" | wl-copy
# 設定画面の認証欄へ貼り付けた後
wl-copy --clear
```

必要な登録機能が存在しない場合は、URLや認証情報の受け渡し方法をGrok Botの管理者に確認します。OAuthやSSEへ切り替えて動作するものとして扱わないでください。

## 3. 接続を確認する

まず、発行トークンで公式MCP SDKから読み取りだけを試せます。この確認はデザインを書き換えません。

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
assert(process.env.CANVAS_MCP_TOKEN, 'Bot用トークンを設定してください');
const base = new URL(process.env.CANVAS_BASE_URL);
assert(base.protocol === 'https:' && !base.username && !base.password, 'HTTPS URLを指定してください');
const client = new Client({ name: 'canvas-connection-check', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.CANVAS_MCP_TOKEN}` }, redirect: 'error' },
  }));
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'list_files'), 'list_filesがありません');
  const result = await client.callTool({ name: 'list_files', arguments: {} });
  assert(!result.isError, 'list_filesが失敗しました');
  console.log('MCP接続・ツール取得・list_files: OK');
} finally { await client.close(); }
NODE
```

SDKの確認後、**Grok側からも** `list_files` を呼べることを確認します。SDKの成功だけでは、Grokの登録が成功したことにはなりません。

次にGrokへ、認証情報を含まない指示を送ります。

> Canvas Noteに接続確認専用の新しいファイルとページを作ってください。390×844のモバイルと1440×900のPCフレームを追加し、色トークンを参照するカードと日本語見出しを描いてください。render_frameで両方のPNGを返し、作成したファイルIDとフレームIDを教えてください。その後update_nodesで見出しを「接続確認済み」に直し、再描画してください。

この操作はテスト用デザインを作成・変更し、実行後も残します。既存ファイルを指定しないでください。APIはトークンごと毎分60回、D1変更はワークスペース全体で毎分12回です。429になった場合は待って再開し、連続再試行は避けます。

## 4. トークンのローテーション

順序は **新トークン発行 → コネクタ更新 → 動作確認 → 旧トークン失効** です。新しい接続が確認できる前に旧トークンを失効しないでください。

1. 旧トークンの **ID** を所有者の秘密管理記録または管理APIの一覧で確認する。IDはトークン本体とは別です。
2. 上の発行手順でもう一つトークンを作る。`CANVAS_MCP_TOKEN` と `CANVAS_NEW_TOKEN_ID` を新しい値へ差し替える。D1には新旧両方のハッシュが一時的に存在する。
3. Grokコネクタの認証値を新トークンへ更新し、保存する。接続がキャッシュされる実装なら再接続・再読み込みする。
4. SDKでの確認に加え、Grokから `list_files` を実行する。必要に応じて接続確認用ファイルを作成しPNGまで確認する。
5. 新しい接続に問題があれば、失効操作はせず旧トークンへ戻して調査する。
6. 成功後に、**旧ID** を指定して `DELETE /admin/tokens/<旧ID>` を実行する。
7. 旧トークンでのリクエストが401になること、新しいGrok接続は引き続き使えることを確認する。429の場合は制限解除後にやり直し、失効確認の代わりにはしない。
8. 新しいID・発行日時・利用先を秘密管理記録で更新し、旧トークン本体を破棄する。

### 旧IDの確認

以下はトークン本体やハッシュを表示せず、ID・名前・失効状態を取得します。共有画面や作業ログに認証情報を含めないでください。

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const base = new URL(process.env.CANVAS_BASE_URL);
assert(base.protocol === 'https:' && !base.username && !base.password, 'HTTPS URLを指定してください');
const response = await fetch(new URL('/admin/tokens', base), {
  redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
assert(response.ok, `一覧取得失敗: HTTP ${response.status}`);
console.table(await response.json());
NODE
```

### 旧トークンの失効

旧IDは値を確認して入力します。新IDと一致した場合は誤失効を防ぐため中止します。

```bash
read -r -p '失効する旧トークンID: ' CANVAS_OLD_TOKEN_ID
export CANVAS_OLD_TOKEN_ID
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
assert(/^[a-zA-Z0-9_-]{1,80}$/.test(process.env.CANVAS_OLD_TOKEN_ID || ''), '旧IDが不正です');
assert(process.env.CANVAS_NEW_TOKEN_ID && process.env.CANVAS_OLD_TOKEN_ID !== process.env.CANVAS_NEW_TOKEN_ID, '新トークンを失効しようとしています');
const base = new URL(process.env.CANVAS_BASE_URL);
assert(base.protocol === 'https:' && !base.username && !base.password, 'HTTPS URLを指定してください');
const response = await fetch(new URL(`/admin/tokens/${process.env.CANVAS_OLD_TOKEN_ID}`, base), {
  method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
assert(response.ok, `失効失敗: HTTP ${response.status}`);
console.log('旧トークン失効: OK');
NODE
```

旧トークンが手元にある場合、非表示入力で `CANVAS_OLD_TOKEN` へ読み込み、データを表示しない読み取りAPIで失効を確認できます。

```bash
read -r -s -p '失効を確認する旧トークン: ' CANVAS_OLD_TOKEN
printf '\n'
export CANVAS_OLD_TOKEN
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const base = new URL(process.env.CANVAS_BASE_URL);
assert(base.protocol === 'https:' && !base.username && !base.password, 'HTTPS URLを指定してください');
const response = await fetch(new URL('/api/tools/list_files', base), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${process.env.CANVAS_OLD_TOKEN}`, 'Content-Type': 'application/json' },
  body: '{}',
});
assert(response.status === 401, `失効を確認できません: HTTP ${response.status}`);
console.log('旧トークンは拒否されました: OK');
NODE
unset CANVAS_OLD_TOKEN
```

作業後はシェルの秘密値を破棄します。必要なトークンは先に所有者の秘密管理ツールへ安全に移してください。

```bash
unset ADMIN_TOKEN CANVAS_MCP_TOKEN CANVAS_NEW_TOKEN_ID CANVAS_OLD_TOKEN_ID CANVAS_BASE_URL
```

## 本番デプロイ後のチェックリスト

- [ ] PR #2・#3をマージし、所有者が本番URLとシークレットを設定した。
- [ ] Bot用トークンを発行し、管理者トークンと分けて保管した。
- [ ] Grokコネクタへ `/mcp`・Streamable HTTP・Bearerを登録した。
- [ ] Grokから `list_files` とツール一覧を確認した。
- [ ] MCPだけでモバイルとPCの2画面を作成した。
- [ ] 両画面の `render_frame` でPNGを取得し、日本語を確認した。
- [ ] スマホのビューアにログインし、同じファイルの2画面を確認した。
- [ ] `update_nodes` とトークン変更が、PNGとスマホの両方へ反映された。
- [ ] 新トークン発行→コネクタ更新→確認→旧トークン失効を完了した。
- [ ] 旧トークンの401と、新しいGrok接続の継続利用を確認した。
- [ ] 秘密値をチャット・Git・Issue・PR・ログに残していない。

確認記録には日付・デプロイしたコミット・成功/失敗・作成ファイルIDだけを残します。未確認のGrok操作やスマホ実機を確認済みとしないでください。PR #8マージ後は `npm run smoke` も補助に使えますが、実アカウントとスマホでの確認は別途必要です。

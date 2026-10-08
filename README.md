# pi-understanding

コードを書いているPiとは別に、既存ソフトウェアのモデルを理解するための会話を開きます。概念・ルール・境界・状態と振る舞い・判断理由を説明し、予測し、変更の影響を判断することが目的です。コードとテストは必要な根拠として読みます。変更のないrepository全体やmodule、機能への疑問、実装済み変更、これからの変更案のどこからでも始められます。通常チャットの履歴は読みません。

学習AIにはコード変更用のツールも、通常チャットの履歴も渡しません。学習会話を実装AIへ自動送信することもありません。ただし、Pi extensionはPiと同じOS権限で動きます。この設計はOS sandboxではなく、拡張内の読取・会話分離の契約です。信頼できるソースだけを読み込んでください。

## 起動

開発checkoutから、その実行だけで読み込めます。設定ファイルを変更する必要はありません。

```sh
cd ~/ghq/github.com/See2et/pi-understanding
pi -e "$PWD"
```

GitHubのprivate repositoryへアクセスできるユーザーなら、通常のPi packageとしても利用できます。

```sh
pi install 'git:github.com/See2et/pi-understanding@COMMIT_SHA'
```

`pi install`は通常のPi設定を変更します。Nix管理ではこの方法を使わず、git-pinned flake inputのraw sourceを既存wrapperの`-e /nix/store/…-source`に追加します。`package.json`の`pi.extensions`が`src/extension.ts`を指定しているため、成果物のコンパイルやnpm installは不要です。PiがTypeScriptとホスト提供packageを読み込みます。GitとghをwrapperのPATHに追加してください。Gitは`--no-lazy-fetch`対応版が必要です。読み取り時の暗黙fetchを禁止し、非対応版では安全のためscopeの読み取りを失敗させます。private inputの取得には既存のSSH認証が必要です。鍵やtokenをrepository・Nix Storeへ追加しないでください。

Nix側のrevision更新はルートflake.lockで行います。Piの認証・設定をStoreへ移すことはせず、既存の書込み可能な`~/.pi/agent`を維持します。`nix run /etc/nixos#pi`で新wrapperを試す場合もOS activationは不要です。NixOSの`test`・`switch`とDarwin activationは実機ユーザーが手動で行います。

## まず使う

```text
/u                         # 対象未選択なら確認付き選択、選択済みなら開く
/u scope repository        # 変更なしでも学習可能
/u model                   # モデル全体像を明示生成
/u select CLAIM_ID         # 主張を選ぶ（推論なし）
/u evidence 1              # 選択主張の固定引用を開く（推論なし）
/u overview                # 全体へ（推論なし）
/u diagram                 # 現在モデルの相互作用図をlocal browserで開く
/u diagram preview         # 明示的にtailnet HTTPS URLを取得（コード引用を共有）
/u diagram stop            # このextensionが所有するpreviewを停止
/u proposal 変更案の内容    # 仮説として相談。現状の事実や実装承認ではない
```

`/u`は`/understand`のaliasです。通常editorではAlt+Sで学習を開けます。Ctrl+Alt+Uも互換として残しています。空の`/u`はモデル生成を勝手に開始せず、未生成なら`model`を案内します。対象を選ぶだけでも推論を呼びません。

学習表示では↑↓でモデル本文を読み、Shift+↑↓でモデルのページを送ります。Tab／Shift+Tabで主張や操作を選び、入力欄が空ならEnterで開きます。本文が長い主張や操作のない主張も、途中を含めて最後まで読めます。←で根拠から主張へ、Ctrl+Oで全体へ戻ります。PgUp／PgDnは会話側だけをスクロールします。fullscreenのホイールはポインター下のモデル・会話をそれぞれスクロールし、regularのホイールはターミナル本来のスクロールバックに任せます。通常入力と学習入力の未送信draftはAlt+Sで切り替えても保持されます。

### コード注釈とNeovim

新しい`model`生成では、責任・意味のある分岐・不変条件を短いAI注釈として根拠のコードchunkに付けます。原文の`quote`へコメントを挿入するのではなく、元の行範囲を持つ別データです。引用の実在照合と注釈の意味の正しさは別で、表示にも「AI解釈」と明記します。旧モデルに注釈を捏造しません。既存モデルへ追加したい場合は`/u model`で明示的に作り直してください。

根拠表示のCtrl+Alt+A、または`/u annotations on|off|toggle`で注釈を切り替えます。原文の全行と元の行番号は残り、↑↓・Shift+↑↓で読めます。狭いペインでは各注釈を最大3表示行に省略し、全文はNeovimで読めます。Tab／Shift+Tabは従来どおりsignature→tests→evidenceを巡回します。Ctrl+Alt+Nは入力中のdraftを送信せず、選択根拠をNeovimへ渡す明示操作です。`/u nvim`も同じ操作です。

Neovimには選択した根拠の**固定file全体**と同じ注釈を渡すため、根拠外の前後のコードも読めます。学習会話は渡しません。`pinnedFile`で全体を取得できない旧snapshot・未捕捉file・削除済みsnapshotでは失敗し、live worktreeへfallbackしません。注釈の自動追記、同期、Neovim側のAI呼出しはありません。

#### 設定なしで今のterminalに開く（既定）

対話TUIで`/u nvim`、またはペインのCtrl+Alt+Nを実行すると、PiのTUIを一時停止して、今のterminalをインストール済みの`nvim`に渡します。server、socket、環境変数の設定は不要です。新規起動では左右分割を追加せず、起動時のウィンドウに該当コードだけを表示します。`:qa`で終了するとPiへ戻り、選択根拠・表示位置・入力focusと通常／学習入力の未送信draftを保持します。起動失敗・異常終了でもTUIを再開し、エラーを通知します。同時に複数のterminal受渡しは行いません。

`nvim`がPATHにない場合は明示エラーです。RPC・print・TTYのない実行では不可視のinteractive processを起動しません。`/u nvim export`、または以下の明示server／別terminal設定を使えます。DISPLAYやWAYLANDの存在からGUIを自動起動することはありません。

Neovimは通常のユーザーconfig（`init.lua`／`init.vim`）とruntime pluginを読み込み、その初期化後の`-c` commandで同梱Luaを読み、固定根拠bufferを選択します。起動引数の`-i NONE -n`で、このviewer起動のShaDa読書きとswap作成は無効にします。Neovim 0.10以降の標準Lua APIだけを使う薄いpluginを`lua/`と`plugin/`に同梱しており、外部pluginのinstallやglobal configの編集は不要です。ユーザーconfig／pluginは信頼するコードとして実行します。任意の設定との互換性や副作用の隔離を保証するものではなく、pluginやLSPの追加・強制有効化も行いません。

#### 既存Neovim serverへ開く（任意）

下記の`PACKAGE`はこのcheckoutまたはPiが読み込むraw package directoryです。

別terminalでNeovimを明示起動します。pluginのruntimepath追加はその実行だけに適用します。

```sh
PACKAGE="$HOME/ghq/github.com/See2et/pi-understanding"
# 私有directory内のsocketを使用。既存socketは再利用/上書きしないでください。
SOCKET_DIR=$(mktemp -d)
PI_UNDERSTANDING_NVIM_PACKAGE="$PACKAGE" nvim --listen "$SOCKET_DIR/nvim.sock" \
  --cmd 'lua vim.opt.runtimepath:prepend(vim.env.PI_UNDERSTANDING_NVIM_PACKAGE)'
```

Piを起動する別terminalには、上で出力/確認したsocketのabsolute pathを明示します。

```sh
export PI_UNDERSTANDING_NVIM_SERVER=/absolute/private-directory/nvim.sock
pi -e "$HOME/ghq/github.com/See2et/pi-understanding"
```

Piで`/u select ID`、`/u evidence N`、`/u nvim`を実行します。すでに動いているNeovimにも、`:lua vim.opt.runtimepath:prepend('/absolute/package/path')`でそのsessionだけpluginを読込めます。`:echo v:servername`でserver addressを確認してください。server側にpluginがない、接続できない、`nvim`がPATHにない場合は明示エラーです。`PI_UNDERSTANDING_NVIM_BINARY`で別の実行binaryを指定できます。serverへの操作は新しいsplitを作り、現在のbuffer・未保存draftを置き換えたり保存したりしません。

#### 新しい別terminalで起動する

今のterminalの代わりに、別terminalを使う任意設定です。ユーザーがすでに利用しているterminal launcherのargvをJSON配列で指定した場合だけ、別terminalで新しいNeovimを起動します。shell commandではありません。server設定がある場合はserverが優先します。

```sh
# 例: インストール済みxtermを使う場合。extensionはinstallしません。
export PI_UNDERSTANDING_NVIM_TERMINAL='["xterm","-e"]'
# 例: インストール済みkittyの場合は ["kitty","--"]
pi -e "$HOME/ghq/github.com/See2et/pi-understanding"
```

新しいNeovimも通常のユーザーconfigとruntime pluginを読み込み、初期化後の`-c` commandで、その実行だけ同梱Luaを読み、固定根拠bufferを選択します。今のterminalでの起動と同じく、`-i NONE -n`でShaDa読書きとswap作成は無効にします。Piへの成功通知はlauncherの開始までを確認します。開始後のterminalやNeovimのエラーは別terminalで確認してください。visible terminalを作るlauncherを指定する責任はユーザー側にあります。この設定がなければ、対話TUIでは今のterminalで開きます。

#### 手動のfile受渡し

`/u nvim export`はNeovimを起動せずprivate JSONのabsolute pathとplugin rootを通知します。Neovimで一度runtimepathを追加した後、次のように読みます。`UnderstandingOpen` commandを使う場合はplugin fileもその実行だけ読込みます。

```vim
:lua vim.opt.runtimepath:prepend('/absolute/package/path')
:runtime plugin/pi_understanding.lua
:UnderstandingOpen /absolute/private-directory/evidence.json
" または、引数をLua stringとして渡すAPI
:lua require('pi_understanding').open('/absolute/private-directory/evidence.json')
```

bufferはsource fileそのものではない`nofile` scratchです。readonly／nonmodifiableで、通常のwrite・appendも拒否します。元の行番号、選択範囲のhighlightと別のvirtual linesにAI注釈を表示します。`ga`で注釈toggle、`]a`／`[a`でannotated chunkへ、`]e`／`[e`で選択根拠の先頭・末尾へ移動します。`gi`でpath/ref、scope、repository、snapshot、全digestを確認できます。ほかのfileの注釈や会話の取得はしません。

受渡しfileはOS temporary directoryの専用0700 directory内に0600で作り、1fileのsourceは既存captureと同じ1MB、JSON全体は6.2MBを上限にします。全sourceのSHA-256、引用のexact一致、元の範囲、注釈の個数・text・範囲とfileのowner／permissionをNeovimでも検証してから開きます。注釈textは実行しません。shell展開や受渡しデータのLua評価もありません。

このdirectoryにはprivate source全文が残ります。自動削除は行わないので、Neovimで開き終えた不要な受渡しは通知された専用directoryごと手動削除してください。socket directoryもserverを終了してから手動削除できます。session exportとは別のlocal copyであり、共有するとsource・注釈・identityが共有されます。readonlyとwrite拒否はOS sandboxではありません。自分でoptions/autocmdを無効化したり任意Luaを実行するユーザーを制限するものではなく、新規起動・既存serverのどちらでもユーザーconfig／pluginの挙動を隔離しません。

### モデルのbackend契約

モデル全体像は`claims`と`modelSummary`で保持します。主張は安定ID、単一のstatement、任意のdetail、種類（concept/rule/boundary/behavior/rationale）、現状の主張`fact`か解釈`inferred`、exact根拠、実在する他の主張への関係を持ちます。signatureとtestsも同じexact引用検証を通します。各根拠の任意`annotations`は`{start,end,text}`の配列で、元の引用範囲内の昇順・非重複chunkに限定します。最大6件、textは改行・control文字なしでUTF-8 480bytesまで、根拠あたり1440bytes・モデル全参照のtext合計12KBまでです。同じpath/ref/range/quoteが複数回現れる場合、注釈の省略は共有し、矛盾する注釈はモデルごと拒否します。v1/v2の注釈なし根拠は引き続き読めます。引用の実在は検証しますが、モデルの意味や理由の解釈が正しいという保証ではありません。`model`だけがモデル全体像を置き換え、自由質問・proposal・移動は置き換えません。旧M番号mapの生成・navigation・表示は廃止しました。`map`と`dive`は明示的な廃止通知だけを返し、自由質問や推論へ流しません。旧保存payloadはそのまま保持し、新しいモデルとして再解釈しません。

`select ID`、`evidence N`、`back`、`overview`、`quiet`、`questions on|off`、`skip`、`proposal clear`は学習入力からも実行できる決定的操作です。`back`は根拠→主張→全体、`overview`は選択解除です。evidenceの番号はsignature、tests、一般evidenceの順です。`reference`は選択主張の最初の固定根拠、または明示path/rangeを読みます。普通の質問は選択主張を文脈に含みます。問いは任意で、quiet/off/skipでも不利益はありません。現状の理解と仕様への意見を区別し、点数・承認・自動handoffは行いません。`proposal TEXT`は未実装の仮説として別フィールドに残り、`proposal clear`で解除します。

学習モデルには引き続き`tools: []`を渡します。不足する根拠の`need`（path/ref/元の行範囲/理由）やliteral `search`をJSONで受け、拡張が範囲・path・refを検証して読み取ります。最大2取得ラウンド＋最終回答、1ラウンド最大6要求、追加送信24KB、検索120file/50hit、質問全体180秒（取得を含む）です。要求は実行命令ではなくデータです。shell、任意Git引数、live worktree再読込はありません。各応答に送信したpath/ref/range/digest、取得・除外・未捕捉・利用不可・予算超過の結果と、各native呼出しのusageを記録します。失敗や上限超過を自動retryしません。

初回contextでは実装source、選択根拠、質問に関連する内容を優先します。大きいfileは先頭60行を送るだけで、捕捉済みの後半は追加要求で取得できます。partial sourceの元の行番号を保ち、未送信の内容を引用した回答は採用しません。領域目録はmetadataで、分析済みsourceとは区別します。

Piの現在有効なskill一覧（公開`pi.getCommands()`の`source=skill`）に`skill:yomiyasu`があるときだけ、その登録済み本文を読み取り、学習モデルのcontextへ渡します。個人treeの走査や固定absolute pathへの依存はありません。Piが選んだuser/project/package/custom agentDirの有効リソースを使い、無効・不在なら通常の学習を続けます。本文64KB、同じskill内の明示されたMarkdown参照は最大6件・合計96KBまでの浅い読込です。不在/上限/安全境界による未読込を使用済みとは表示しません。`styleSkill=yomiyasu-instructions-sent`は指示を送った記録であり、文章品質の保証ではありません。自然な日本語のreply・説明文・問いに限って適用し、意味と確実性を保持します。JSON、引用原文、path/ID/signature/codeは改変しません。リライト専用見出しの強制やPython/lintの実行はなく、学習の安全境界が優先します。

### 相互作用viewのbackend契約

明示的な`model`生成は、主張と同じcommitで任意の`interactions`を保持します。`entities`はmodule/function/data-store/externalを型として持ち、`interactions`はfrom/to、calls/reads/writes/sends/receives/depends、意味のあるlabel、fact/inferredと根拠linkを持ちます。これは概念的なclaim関係を呼出し関係へ変換したものではありません。網羅的な静的解析でもありません。

最大24実体・48相互作用、IDは最大64文字のASCII識別子、labelは実体120文字・相互作用160文字、detailは1200文字です。すべての実体・相互作用に1〜6件の`{claim, evidence}`を要求します。evidenceは当該claimのsignature→tests→一般evidenceを並べた1-based番号で、既存のexact quoteを参照し、コピーしません。未知のID・範囲外番号・重複・不正なkind/statusはモデル生成ごと拒否します。主張と図の片方だけを置き換えません。

根拠が足りず有用な図を作れない場合は`interactions`を省略できます。図を持たない現行モデルとmap-onlyの旧sessionも復元できますが、`diagram`は「未記録、modelで明示再生成」を返します。開くときにgraphを捏造したり、GPTや追加source取得を呼んだり、serverを立てたりしません。保存graphは同じbounded reference検証を通し、不正なら元payloadを保持したまま図を利用不可にします。保存済み引用だけで表示でき、local snapshotの消失からlive worktreeへfallbackしません。

Ctrl+Alt+UはPiの`/hotkeys`、ステータスとペイン下部にも表示します。対象未選択時は`/understand scope`を案内し、下書きを消したり勝手に対象を選んだりしません。fullscreen・regularのどちらでも、Ctrl+Alt+Uで「表示して学習入力」と「隠して通常入力」を切り替えます。Esc・Ctrl+G・Ctrl+D・`close`も隠す操作です。次に開いたとき、学習側の未送信draftと通常editorのdraftはそのまま残ります。旧sidebar・background・wideの区別と、露出したeditorへのclick切替は廃止しました。独自renderer、mouse tracking、通常editorの置換やmouse handlerのwrapperは使いません。

### 操作

| コマンド | 動作 |
| --- | --- |
| `/understand open` / `focus` / `wide` | ほぼ全画面の学習表示・入力（互換alias） |
| `/understand toggle` / `close` | 表示と入力を切替 / draftを保持して隠す |
| `/understand scope` | 未commit分・ローカルbranch・最近のcommit・PRなどを一覧から選択し、固定範囲を確認 |
| `/understand scope changes` | HEADとindex・worktreeの未commit分を固定 |
| `/understand scope branch REF [BASE]` | branch全体、またはBASEとのmerge-base以降の変更を固定 |
| `/understand targets` | AIに相談するためのローカル候補情報（PR取得なし） |
| `/understand scopes` | 現在のsession branchに保存されたscopeを選択 |
| `/understand focus src/handler.ts:submit` | 学習の焦点だけを変更。scopeは変えない |
| `/understand ask ここで失敗した場合は？` | 独立した学習会話へ質問 |
| `/u model` | 主張と任意の相互作用viewを明示生成・置換 |
| `/u overview` | モデル全体へ（推論なし） |
| `/understand reference` | 選択主張の最初の固定根拠を行番号付きsnippetで表示 |
| `/understand reference src/handler.ts head` | 選択根拠に一致する範囲、なければ先頭40行。base・indexも指定可 |
| `/understand reference src/handler.ts head 10-30` / `all` | 明示行範囲 / ファイル全体。live worktreeは読まない |
| `/understand check` | 明示的に鮮度を確認 |
| `/understand refresh` | 同じ種類のscopeを現在の情報から取り直す |
| `/understand questions on` / `off` | milestoneでの任意の理解確認。新しいscopeではon。保存済み設定は保持 |
| `/understand handoff` | 送る内容を編集し、確認してから通常チャットへfollow-up送信 |
| `/u diagram` | 現在モデルの根拠付き相互作用図を静的HTML/SVGに保存し、local browserで開く |
| `/understand diagram preview` | 明示的に既存home-preview経由でtailnet HTTPS URLを取得 |
| `/understand diagram stop` | このextensionが所有するpreview登録とserverだけを停止 |
| `/understand reset` | 確認後に現在scopeの会話・モデル・旧マップを消去。固定根拠は保持 |
| `/understand forget` | 確認後に現在scopeを削除 |
| `/understand help` | 操作一覧 |

ペイン内のCtrl+Tで、いつでも対象選択を開けます。通常の学習対話は固定根拠だけを見るので、最新のbranchやPRを勝手に調べて対象を切り替えません。

実装側のAIには「今の未commit分を理解したい」「どのcommitか覚えていないので候補を調べて」と相談できます。`understanding_targets`で現在branch・変更ファイル・ローカルbranch・最近のcommitの候補を調べ、必要ならユーザーに質問します。PR一覧はユーザーが求めた場合だけ取得します。`select_understanding_scope`で提案を受けても、固定した対象・base/head・snapshotを確認してから選択します。学習会話はこれらのtoolに渡しません。対象の確認中は、既存の学習Overlayを一時的に隠して確認内容を読めるようにします。拒否・キャンセルでは理解対象を変更しません。

ペイン内ではCtrl+Cが学習呼出しだけを中止します。通常チャットのagentを中止しません。PgUp/PgDnで本文の根拠・会話をスクロールします。新しい質問は会話末尾へ移動しますが、モデル側の読書位置は独立しています。Ctrl+Oで一操作で全体図へ戻れます。12行未満の端末ではペインを表示しません。幅や高さが変わってもnative Inputのcursor・paste・undo stateを保持し、通常editorは変更しません。

## スコープと固定根拠

```text
/understand scope changes
/understand scope branch feature
/understand scope branch feature main
/understand scope repository
/understand scope module src/payments
/understand scope commit HEAD HEAD^1
/understand scope pr 123
```

- **changes**はHEADに対する未commit分です。stagedとunstagedが違う場合は`index`と`worktree`を別の固定根拠として保持し、削除はbaseの内容、非ignoreの未追跡sourceはworktreeの内容を収集します。除外対象やsymlinkは読みません。`reference PATH index`で収集済みのstaged内容を参照できます。index・worktree・HEADは変更しません。
- **branch**はローカルbranchのtipを固定します。比較元を指定しなければbranch全体の内容、指定すればmerge-baseからの変更が対象です。tipや比較元の移動は`check`で検出し、`refresh`で明示更新します。
- **repository / module**はtracked worktreeから内容をコピーして保持します。module pathはrepository-relativeです。未追跡ファイル・除外ファイルは収集しません。Git HEAD、内容digest、repository rootとcommon git directoryのidentityでscopeを識別します。会話中に編集されても過去の根拠を書き換えません。
- **commit**は指定commitと、明示した直近の親を比較します。merge commitは`HEAD^1`・`HEAD^2`などで親を選びます。親のないroot commitは現versionでは対象外です。
- **PR**はそのrepositoryで`gh pr view NUMBER --json baseRefOid,headRefOid,url`を実行します。GitHubのbase/head OIDとmerge-baseを固定し、merge-baseからheadを比較します。必要なobjectがlocalにない場合は取得を拒否し、ユーザー側でのfetchが必要です。拡張はGit object/refを追加せず、HEAD・branch・index・worktreeも変更しません。metadata取得の認証は既存ghに委ねます。

ヘッダではkind・root・base/head・snapshot・scope IDを表示し、焦点は本文で分けます。`scope`実行時の通知には完全なscope IDとOIDを出します。`publish_understanding`へ渡すscope IDにはその完全な値を使います。

worktreeは`check`と通常agentのsettled時に内容fingerprintを比較してstaleを表示します。監視watcherはありません。reload後は鮮度未確認になります。PR/commitは固定履歴としてcurrentを表示します。PRの新しい先端を見るには`refresh`が必要です。refresh後にidentityが変われば別会話を開始し、過去のscopeは`scopes`から戻れます。

### 収集範囲

- listingは最大2000 path、local captureは512 source・合計8MB、1 fileは1MBまで。captureとモデルへの送信予算は別です。省略・除外・利用不可・予算超過をmetadataに記録します。
- モデルに送る番号付きコードは約45KBまで。最大150 pathのlistingは「未分析」と明記します。
- `.env*`、認証・設定・秘密鍵に典型的なpath、生成物、binaryなどを除外し、symlinkやrepository外へのpathを拒否します。これはsecret scannerではありません。通常のsourceに埋め込まれた秘密は判定できません。送信前にrepositoryの内容を確認してください。
- worktree captureの前後が変わった場合は失敗して手動retryを求めます。ファイルシステムのatomic snapshotではありません。
- 新captureの許可されたworktree/index本文は拡張専用private local snapshotに固定します。初回に未送信でも、その同じbytesを後から読みます。未捕捉file、旧v1の未収集file、削除済みsnapshotは後から昔の状態として読めません。手動refreshまたは小さいmodule scopeにしてください。
- commit/PR/branchの追加referenceは固定base/headからのみ取得します。モデルに送るのは検証した固定sourceだけです。保存scopeの内容がGit replaceで別物にならないようGit replaceを無効化します。
- exact引用は機械検証しますが、説明の意味やテストの十分性を機械保証するものではありません。modelの未検証回答・構造違反・範囲外引用はnoticeとし、モデルには採用しません。

## 実装との受渡し

実装AIの`publish_understanding` toolは、**合意済み**の要件・変更内容・テスト状況・焦点と、任意の理解質問を学習側へ渡す片方向の入口です。toolは選択中の完全な`scope_id`を要求し、違うIDを拒否します。学習会話の読出しやモデル呼出しはしません。実装AIの主張はコードの検証済み根拠と区別します。

`questions on`のときだけ、同じ`milestone_id`とpre/postの組に一度、任意の理解確認を表示します。上限100組です。毎editの質問や、製品要件の判断を強制する質問には使いません。回答・skipはいずれも学習側で完結します。

学習側からの引渡しは`handoff`だけです。scope identityだけを入れた下書きを編集し、送信前に全文を確認します。学習会話やモデルを自動添付しません。必要な内容をユーザーが明示的に書いて渡します。確認しなければ通常チャットには何も送りません。

## 保存・モデル・diagram

学習状態はPiの`appendEntry` custom entry v2に保存します。通常モデルのcontextには入りません。sessionにはscope metadata、会話、モデル、引用、local snapshot参照が残り、質問ごとに全source本文を複製しません。本文は`~/.local/share/pi-understanding/snapshots`のcontent-addressed JSON（0600、専用directoryは0700）に保存し、repository/root/snapshot/digestを照合します。Git objects、refs、index、HEADには書き込みません。これはOS sandboxでもatomic filesystem snapshotでもありません。

v1は元entryを変更せず読み込み、次の保存で捕捉済みbytesだけをprivate snapshotへ移します。旧worktreeの未捕捉fileは補完しません。旧map・mapSummary・selectedPointは非表示の歴史payloadとして保持します。生成・移動・通常の学習contextには使いません。会話・焦点・問い設定と現行claimsを維持し、新モデルや相互作用図を捏造しません。旧版へ戻すと最新v1だけが見え、v2の新しい内容は見えません。

`/u storage`で保存先と注意を表示します。snapshotを必要とする保存stateを失わないよう、自動evictionは行いません。capture単位はboundedですが、disk全体は蓄積します。不要になったsnapshotはユーザーが同directoryの対応する`ID.json`を手動削除できます。そのsnapshotを参照するscopeは追加根拠を読めなくなります。`forget`はlocal本文や過去のsession entryを物理削除しません。

sessionをexport/share/同期すると会話と引用が共有され、v1 entryには全sourceも残っています。snapshot directoryのコピーにもsource本文が含まれます。参照だけを共有しても別の環境からlocal本文を読めるとは限りません。private repositoryにいるだけで共有を防げるわけではありません。

restoreは`sessionManager.getBranch()`から行い、放棄したbranchの状態を混ぜません。session clone/fork/reload後もそのbranchに含まれるscopeと会話を再構築します。repository identityが異なる状態は利用しません。scope・branch・session変更とshutdownで呼出しをabortし、古い結果が新しいsessionに保存されないよう世代を検証します。

保存は最大6 scope、各scopeは最新40件・約6万文字に制限し、省略をnoticeにします。モデルに送る会話はさらに最新16件・1.6万文字です。custom entryはappend-onlyなので、Pi session file全体の容量は蓄積します。`forget`も古いentryを物理削除しません。

モデル呼出しは現在選択中のGPTを`ctx.modelRegistry.streamSimple`で呼びます。認証はPiのnative経路だけを使います。API keyの読出し・別CLI・自動model/provider変更・Claudeへのfallbackはありません。非GPTでは明示エラーにします。usage、provider/model、stop reason、native failureを学習側に記録します。失敗・中止は自動retryしません。結果を受け取れないshutdown時のusageは未確定と表示します。学習のusageはcustom stateに保存され、Piの通常session統計へは自動加算されません。

`diagram`は現在モデルの相互作用データとcanonical claim根拠からescaped HTML/SVGを組み立てます。有向の一行一相互作用で、実体の型・名前、矢印と意味のあるlabelを表示します。重なったedgeを解くため同じ実体を複数行に表示し、実体anchorからその入出力一覧へ進めます。label→相互作用detail→固定引用→canonical claim、図へ戻るanchorで移動できます。scope identity・鮮度・推論の注意も表示します。JavaScriptや外部assetは不要で、CSPでもscriptを禁止します。学習会話は含みません。local版はtemporary directoryに0600で保存し、Linuxは`xdg-open`、Darwinは`open`を引数配列で呼びます。起動失敗時もHTMLは残り、local temporary fileは自動削除しません。

`diagram preview`だけがremote公開を開始します。固定HTML一枚だけを`127.0.0.1`の専用serverで配信し、推測困難なdocument URL以外（directoryやfilesystem pathを含む）は404です。既存の`home-preview add NAME PORT`と`url NAME`をshellなし・15秒timeoutで実行し、tailnet限定のTailscale Serve HTTPS URLを通知します。Funnelは使いません。source引用がtailnetから読めることを確認してから実行してください。model/ask/open/diagramでは自動公開しません。ブラウザにWeb chatはありません。公開中にモデルが変わってもHTMLは固定です。最新HTMLへの置換は再度`diagram preview`を実行します。

既存helper・HTTPS certificate・Tailscale operator権限が必要です。extensionはインストール・認証・OS設定変更やsudoを行いません。`diagram stop`、scope/branch/session変更、shutdownでこのextensionのuniqueな登録だけを`remove NAME`し、serverを閉じます。他のServe登録は変更しません。開始失敗もcleanupし、cleanup失敗は通知します。serverは停止したまま、残った所有登録の削除を`diagram stop`でretryできます。

## 開発・検証

runtime dependenciesはありません。Pi提供の`pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`はpeerDependenciesだけに宣言します。開発時は実機Piと同じversionを**明示**してlocalに入れます。peerの`*`を未指定のままinstallすると別versionになる可能性があります。

```sh
npm install --ignore-scripts --no-save --package-lock=false \
  @earendil-works/pi-coding-agent@1.0.4 \
  @earendil-works/pi-ai@1.0.4 @earendil-works/pi-tui@1.0.4 \
  typebox@1.3.27 @xterm/headless@6.0.0
npm run typecheck
npm test
# 同梱pluginのreal headless Neovim integrationにはnvimが必要（開発実機: v0.12.4）
node --experimental-strip-types --test tests/annotations.test.ts tests/pane.test.ts tests/neovim.test.ts
python3 tests/neovim-pty.py  # 接続設定なし・隔離ユーザーconfigで実Pi→Neovim→Pi往復
PI_UNDERSTANDING_TUI_MODE=regular python3 tests/neovim-pty.py
python3 tests/native-qa.py
node tests/render-captures.mjs
PI_UNDERSTANDING_TUI_MODE=regular python3 tests/native-qa.py
node tests/render-captures.mjs regular
python3 tests/screenshots.py  # Firefoxの隔離profileで両modeのPNGを作り、summaryへ列挙
```

`native-qa.py`のbinary既定値は開発時のNix Pi 1.0.4です。他のbinaryでは`PI_UNDERSTANDING_BINARY=/path/to/pi`を指定します。専用config directoryとfixture repositoryを`.evidence/native-qa`に作り、個人のauth/settingsを開かず、明示ロードしたdeterministic providerだけを使います。実際の有料推論やnetwork inferenceは行いません。QA providerはpackage manifestに含めません。

model/snapshotのbackend契約testsは、変更なしrepositoryのモデル生成、signature/testも含むexact照合、partial rangeの元行番号、追加固定読込、v1移行とsource-free v2保存、Git object/index/ref非変更、skillの有効登録からnative contextへの送信、proposalと現状の分離、世代cancelをdeterministic providerで確認します。注釈のrange/text/count/persistence検証、旧保存state、両modeの120/80/40列のTUI表示・toggle・draft保持・根拠移動、real isolated headless Neovimの全文・実extmark・range移動・toggle・write拒否、malformed/private file拒否、実serverへのpublic `/u nvim` command、引用外のコード・既存未保存buffer保持・injection境界も検証します。結果は`.evidence/neovim`のtext/JSONへ残します。terminal所有権と復帰・世代変更・二重起動拒否はpublic commandの制御テストでも検証します。`neovim-pty.py`は隔離設定とdeterministic providerで、設定なしのpublic command／pane shortcutから実Pi→Neovim→Piを往復し、固定file全文・実注釈・選択範囲・未送信draftの保持と異常終了からの復帰を確認します。ユーザーの実configは読まず、HOME・XDG directory・Neovimの初期化環境変数を隔離し、fixtureの`init.lua`とlocal runtime plugin、option・mappingの読込み／利用も確認します。本番の起動argvによるheadless確認と明示terminal経路のheadless launcher確認は`.evidence/neovim-user-config/headless`と`explicit-terminal`、PTYの結果は`.evidence/neovim-user-config/fullscreen`と`regular`に残します。GUI terminal launcherの実表示や任意の個人pluginとの互換性はこれらのtestには含みません。新しいTUIの両mode/サイズ・mouse/Tab/戻るの受入れは別のrender QAが必要です。Ghostty→mosh→herdrの実接続、物理IME、有料推論の品質・学習効果は未検証です。

既存の検証は本番のscope、runner、pane、extensionを使います。未commit分のindex/worktree/削除/未追跡source、branchの固定・移動、AI選択の確認境界、scope isolation、引用のexact一致、path traversal、symlink、HTML escape、active branch restore、会話分離、native failure/usage/cancellation、publication/handoffをテストします。実Pi RPCでnode_modulesのないraw sourceのloaderを確認し、PTYのfullscreen/regular両方で`focus`・互換`wide`の入力所有、Ctrl+Alt+Uの往復と両方の下書き保持（120/80/160列）、Ctrl+D後のdraft再開、sessionに保存された質問の通常/学習振分け、非表示時の通常入力、日本語paste/cursor marker、ほぼ全画面の表示、claim選択・引用・一操作の全体復帰、通常chat、resize、cancel、failure、reloadを確認します。previewテストは実loopback HTTPと注入したhome-preview adapterでroute・method・停止・開始失敗・cleanup失敗・世代競合を検証し、実Tailscale登録は実行しません。

`.evidence/native-qa`にANSI stream、RPC記録、viewport別text/HTML、render-checks、source hashが残ります。`render-captures.mjs`のHTMLはANSIをxtermへreplayしたterminal gridです。Firefoxのheadless screenshotなどでPNGにできます。物理IMEのcandidate popup位置・mosh実接続・macOS実機・実GitHub PR fetch・有料native GPT response品質・live Tailscale Serve/remote HTTPS・tailnet policyはこのdeterministic QAだけでは確認できません。release受入れには独立reviewとホスト側Nix eval/buildを別途行います。

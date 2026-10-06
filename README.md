# pi-understanding

コードを書いているPiとは別に、固定したコードの責任・重要な関数・契約・テストを理解するための会話を開きます。学習ペインは右側への重ね表示です。通常チャットの幅を変更するsplit viewではありません。

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

`pi install`は通常のPi設定を変更します。Nix管理ではこの方法を使わず、git-pinned flake inputのraw sourceを既存wrapperの`-e /nix/store/…-source`に追加します。`package.json`の`pi.extensions`が`src/extension.ts`を指定しているため、成果物のコンパイルやnpm installは不要です。PiがTypeScriptとホスト提供packageを読み込みます。GitとghをwrapperのPATHに追加してください。private inputの取得には既存のSSH認証が必要です。鍵やtokenをrepository・Nix Storeへ追加しないでください。

Nix側のrevision更新はルートflake.lockで行います。Piの認証・設定をStoreへ移すことはせず、既存の書込み可能な`~/.pi/agent`を維持します。`nix run /etc/nixos#pi`で新wrapperを試す場合もOS activationは不要です。NixOSの`test`・`switch`とDarwin activationは実機ユーザーが手動で行います。

## まず使う

```text
/understand scope
/understand map
/understand focus
```

1. 理解対象を一覧から選びます。まずは「未commit分」が便利です。branch、最近のcommit、open PRも名前・件名で選べるので、REFやPR番号を覚える必要はありません。`/understand`だけなら初回は選択画面を開きます。
2. `map`で利用者フローから責任、重要な関数、契約、テストへの小さいマップを作ります。各項目の根拠は固定ref・path・行番号・正確な引用で検証します。全関数の自動graphではありません。
3. `focus`で学習ペインに入力します。日本語入力はPiのInputとcursor markerを使います。Enterで送信します。
4. Ctrl+Alt+Uで通常入力と学習入力を行き来できます。どちらの未送信の下書きも保持します。EscまたはCtrl+Gでも通常チャットに戻れます。学習AIが回答中でも実装チャットは動作します。

`/understand`・`open`は入力を奪わない背景表示です。入力先を変えるには`/understand focus`、`wide`、またはCtrl+Alt+Uを使ってください。Ctrl+Alt+UはPiの`/hotkeys`、ステータスとペイン下部にも表示します。対象未選択時は`/understand scope`を案内し、下書きを消したり勝手に対象を選んだりしません。

fullscreenでは学習ペイン内の左クリックで学習入力へ、ペインに隠れていない通常入力欄の左クリックで通常入力へ戻れます。両方の下書きを保持し、通常入力に戻るとペインは背景表示になります。狭幅では背景ペインを隠すため、学習へ戻るにはCtrl+Alt+Uを使います。Piのnative mouse APIだけを使い、regular modeではmouse trackingを有効にしません。regular modeでも同じCtrl+Alt+U・Esc・Ctrl+Gが使えます。

Pi 1.0.4は通常editorへのクリック後もoverlayの入力復帰予約を保持します。このversionへの互換処理として、ペイン表示中だけ既存editorの`handleMouse`を包み、完了した左クリックが入力focusを要求した場合にoverlay handleを明示的に`unfocus({ target: editor })`します。通常editorの元の結果とcursor操作はそのままPiへ返します。close・reload・geometry再mount時にwrapperを解除し、独自editorやrendererは作りません。

### 操作

| コマンド | 動作 |
| --- | --- |
| `/understand open` | 入力を奪わず背景表示 |
| `/understand toggle` / `close` | 一時的に表示切替 / 閉じる |
| `/understand focus` | 学習側に入力先を切替 |
| `/understand wide` | 広表示に切替して学習側に入力 |
| `/understand scope` | 未commit分・ローカルbranch・最近のcommit・PRなどを一覧から選択し、固定範囲を確認 |
| `/understand scope changes` | HEADとindex・worktreeの未commit分を固定 |
| `/understand scope branch REF [BASE]` | branch全体、またはBASEとのmerge-base以降の変更を固定 |
| `/understand targets` | AIに相談するためのローカル候補情報（PR取得なし） |
| `/understand scopes` | 現在のsession branchに保存されたscopeを選択 |
| `/understand focus src/handler.ts:submit` | 学習の焦点だけを変更。scopeは変えない |
| `/understand ask ここで失敗した場合は？` | 独立した学習会話へ質問 |
| `/understand map` | 根拠付きマップを生成 |
| `/understand reference src/handler.ts head` | 固定コードを行番号付きで学習側へ表示 |
| `/understand reference src/handler.ts base` | 比較元の固定コードを表示 |
| `/understand check` | 明示的に鮮度を確認 |
| `/understand refresh` | 同じ種類のscopeを現在の情報から取り直す |
| `/understand questions on` / `off` | milestoneでの任意の理解確認。新しいscopeではon。保存済み設定は保持 |
| `/understand handoff` | 送る内容を編集し、確認してから通常チャットへfollow-up送信 |
| `/understand diagram` | マップと根拠だけの静的HTML/SVGを保存し、ブラウザで開く |
| `/understand reset` | 確認後に現在scopeの会話・マップを消去。固定根拠は保持 |
| `/understand forget` | 確認後に現在scopeを削除 |
| `/understand help` | 操作一覧 |

ペイン内のCtrl+Tで、いつでも対象選択を開けます。通常の学習対話は固定根拠だけを見るので、最新のbranchやPRを勝手に調べて対象を切り替えません。

実装側のAIには「今の未commit分を理解したい」「どのcommitか覚えていないので候補を調べて」と相談できます。`understanding_targets`で現在branch・変更ファイル・ローカルbranch・最近のcommitの候補を調べ、必要ならユーザーに質問します。PR一覧はユーザーが求めた場合だけ取得します。`select_understanding_scope`で提案を受けても、固定した対象・base/head・snapshotを確認してから選択します。学習会話はこれらのtoolに渡しません。対象の確認中は、既存の学習Overlayを一時的に隠して確認内容を読めるようにします。拒否・キャンセルでは理解対象を変更しません。

ペイン内ではCtrl+Cが学習呼出しだけを中止します。通常チャットのagentを中止しません。Ctrl+Dで閉じ、Ctrl+Oで広表示を切り替え、PgUp/PgDnでマップ・根拠・会話をスクロールします。新しい質問は会話末尾へ移動します。マップを見るにはPgUpを使います。

110列未満では背景ペインを隠します。`focus`で横幅94%のfallbackを開きます。12行未満の端末ではペインを表示しません。Escで通常入力へ戻れます。geometryの変更時にも未送信の入力を保持します。Pi 1.0.4のcustom overlayOptions関数は実装上、表示時に一度だけ評価されるため、広表示・狭幅fallbackではcustom interactionを再mountします。独自のterminal rendererは作りません。

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
- **PR**はそのrepositoryで`gh pr view NUMBER --json baseRefOid,headRefOid,url`を実行します。GitHubのbase/head OIDとmerge-baseを固定し、merge-baseからheadを比較します。必要なobjectがなければ検証したGitHub URLとOIDを`git fetch --no-tags --no-write-fetch-head`で取得します。HEAD・branch・index・worktreeをcheckout変更しません。ただしGit object databaseには追加します。取得の認証は既存Git/ghに委ねます。

ヘッダではkind・root・base/head・snapshot・scope IDを表示し、焦点は本文で分けます。`scope`実行時の通知には完全なscope IDとOIDを出します。`publish_understanding`へ渡すscope IDにはその完全な値を使います。

worktreeは`check`と通常agentのsettled時に内容fingerprintを比較してstaleを表示します。監視watcherはありません。reload後は鮮度未確認になります。PR/commitは固定履歴としてcurrentを表示します。PRの新しい先端を見るには`refresh`が必要です。refresh後にidentityが変われば別会話を開始し、過去のscopeは`scopes`から戻れます。

### 収集範囲

- listingは最大2000 path、収集は120 source・合計300KB、1 fileは24KBまで。
- モデルに送る番号付きコードは約45KBまで。最大150 pathのlistingは「未分析」と明記します。
- `.env*`、認証・設定・秘密鍵に典型的なpath、生成物、binaryなどを除外し、symlinkやrepository外へのpathを拒否します。これはsecret scannerではありません。通常のsourceに埋め込まれた秘密は判定できません。送信前にrepositoryの内容を確認してください。
- worktree captureの前後が変わった場合は失敗して手動retryを求めます。ファイルシステムのatomic snapshotではありません。
- worktree / indexの未収集fileを後から昔の状態として読むことはできません。手動refreshまたは小さいmodule scopeにしてください。
- commit/PR/branchの追加referenceは固定base/headからのみ取得します。モデルに送るのは検証した固定sourceだけです。保存scopeの内容がGit replaceで別物にならないようGit replaceを無効化します。
- exact引用は機械検証しますが、説明の意味やテストの十分性を機械保証するものではありません。modelの未検証回答・構造違反・範囲外引用はnoticeとし、マップには採用しません。

## 実装との受渡し

実装AIの`publish_understanding` toolは、**合意済み**の要件・変更内容・テスト状況・焦点と、任意の理解質問を学習側へ渡す片方向の入口です。toolは選択中の完全な`scope_id`を要求し、違うIDを拒否します。学習会話の読出しやモデル呼出しはしません。実装AIの主張はコードの検証済み根拠と区別します。

`questions on`のときだけ、同じ`milestone_id`とpre/postの組に一度、任意の理解確認を表示します。上限100組です。毎editの質問や、製品要件の判断を強制する質問には使いません。回答・skipはいずれも学習側で完結します。

学習側からの引渡しは`handoff`だけです。scope identityだけを入れた下書きを編集し、送信前に全文を確認します。学習会話やマップを自動添付しません。必要な内容をユーザーが明示的に書いて渡します。確認しなければ通常チャットには何も送りません。

## 保存・モデル・diagram

学習状態はPiの`appendEntry` custom entryに保存します。通常モデルのcontextには入りません。ただしPi session fileには学習会話と固定sourceが保存されるため、そのファイルをexport・share・同期する場合は内容を確認してください。private repositoryにいるだけでsessionの共有を防げるわけではありません。

restoreは`sessionManager.getBranch()`から行い、放棄したbranchの状態を混ぜません。session clone/fork/reload後もそのbranchに含まれるscopeと会話を再構築します。repository identityが異なる状態は利用しません。scope・branch・session変更とshutdownで呼出しをabortし、古い結果が新しいsessionに保存されないよう世代を検証します。

保存は最大6 scope、各scopeは最新40件・約6万文字に制限し、省略をnoticeにします。モデルに送る会話はさらに最新16件・1.6万文字です。custom entryはappend-onlyなので、Pi session file全体の容量は蓄積します。`forget`も古いentryを物理削除しません。

モデル呼出しは現在選択中のGPTを`ctx.modelRegistry.streamSimple`で呼びます。認証はPiのnative経路だけを使います。API keyの読出し・別CLI・自動model/provider変更・Claudeへのfallbackはありません。非GPTでは明示エラーにします。usage、provider/model、stop reason、native failureを学習側に記録します。失敗・中止は自動retryしません。結果を受け取れないshutdown時のusageは未確定と表示します。学習のusageはcustom stateに保存され、Piの通常session統計へは自動加算されません。

`diagram`はモデルに別のJavaScriptを生成させず、検証済みマップからescaped HTML/SVGを組み立てます。source引用は含みますが学習会話は含みません。CSPでscriptを禁止し、temporary directoryに0600で保存します。Linuxは`xdg-open`、Darwinは`open`を引数配列で呼びます。保存先は通知します。起動失敗時もHTMLは残り、temporary fileは自動削除しません。

## 開発・検証

runtime dependenciesはありません。Pi提供の`pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`はpeerDependenciesだけに宣言します。開発時は実機Piと同じversionを**明示**してlocalに入れます。peerの`*`を未指定のままinstallすると別versionになる可能性があります。

```sh
npm install --ignore-scripts --no-save --package-lock=false \
  @earendil-works/pi-coding-agent@1.0.4 \
  @earendil-works/pi-ai@1.0.4 @earendil-works/pi-tui@1.0.4 \
  typebox@1.3.27 @xterm/headless@6.0.0
npm run typecheck
npm test
python3 tests/native-qa.py
node tests/render-captures.mjs
PI_UNDERSTANDING_TUI_MODE=regular python3 tests/native-qa.py
node tests/render-captures.mjs regular
python3 tests/screenshots.py  # Firefoxの隔離profileで両modeのPNGを作り、summaryへ列挙
```

`native-qa.py`のbinary既定値は開発時のNix Pi 1.0.4です。他のbinaryでは`PI_UNDERSTANDING_BINARY=/path/to/pi`を指定します。専用config directoryとfixture repositoryを`.evidence/native-qa`に作り、個人のauth/settingsを開かず、明示ロードしたdeterministic providerだけを使います。実際の有料推論やnetwork inferenceは行いません。QA providerはpackage manifestに含めません。

検証は本番のscope、runner、pane、extensionを使います。未commit分のindex/worktree/削除/未追跡source、branchの固定・移動、AI選択の確認境界、scope isolation、引用のexact一致、path traversal、symlink、HTML escape、active branch restore、会話分離、native failure/usage/cancellation、publication/handoffをテストします。実Pi RPCでnode_modulesのないraw sourceのloaderを確認し、PTYのfullscreen/regular両方で`focus`・初回`wide`送信後の入力所有、Ctrl+Alt+Uの往復と両方の下書き保持（120/80/160列）、fullscreenの左右入力先への完了したクリックと下書き保持（side・wide・narrow）、sessionに保存された質問の通常/学習振分け、背景入力、日本語paste/cursor marker、根拠付きマップ、通常chat、狭幅fallback、resize、cancel、failure、reloadを確認します。

`.evidence/native-qa`にANSI stream、RPC記録、viewport別text/HTML、render-checks、source hashが残ります。`render-captures.mjs`のHTMLはANSIをxtermへreplayしたterminal gridです。Firefoxのheadless screenshotなどでPNGにできます。物理IMEのcandidate popup位置・macOS実機・実GitHub PR fetch・有料native GPT response品質はこのdeterministic QAだけでは確認できません。release受入れには独立reviewとホスト側Nix eval/buildを別途行います。

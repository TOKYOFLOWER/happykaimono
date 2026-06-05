# 中央区ハッピー買物券2026 取扱店マップ

中央区共通買物券（ハッピー買物券2026）の取扱店約1,800件をスマートフォンで検索・地図表示するシステムです。

## 構成

```
happykaimono/
├── stores.csv          ← マスターデータ（全店舗）
├── errors.csv          ← 住所不特定等のエラー行（要手動確認）
├── extract_stores.py   ← PDFからCSVを生成するスクリプト
├── gas/
│   └── Code.gs         ← Google Apps Script（ジオコーディング＋API）
└── docs/               ← GitHub Pages 公開フォルダ
    ├── index.html
    ├── css/style.css
    ├── js/
    │   ├── config.js   ← GAS URL 設定ファイル
    │   └── app.js
    └── data/
        └── stores.json ← フォールバック用（座標なし）
```

---

## 手順1: スプレッドシートへの CSV インポート

1. [Google スプレッドシート](https://sheets.google.com) で新規ファイルを作成
2. シート名（左下タブ）を **`stores`** に変更
3. メニュー「ファイル」→「インポート」→「アップロード」で **`stores.csv`** を選択
4. 以下の設定でインポート:
   - 区切り文字: **カンマ**
   - 既存のシート: **置き換える**
   - テキストを数値・日付に変換: **しない**（チェックを外す）
5. 1行目にヘッダ（name, address, tel …）が入っていることを確認

---

## 手順2: GAS 貼り付けとジオコーディング

### 2-1. Apps Script へのコード貼り付け

1. スプレッドシートのメニュー「拡張機能」→「Apps Script」を開く
2. 最初から書かれているコード（`function myFunction()`）を**全て削除**
3. `gas/Code.gs` の内容を**全てコピー**して貼り付け
4. 保存（Ctrl+S）

### 2-2. ヘッダ列の追加（初回のみ）

1. Apps Script エディタで関数「`setupHeaders`」を選択
2. 実行ボタン（▶）をクリック
3. 権限の確認ダイアログが出たら「許可」→ Google アカウントで承認
4. シートに `lat` / `lng` / `geocode_status` 列が追加されたことを確認

### 2-3. ジオコーディング実行

> **⚠️ クォータ制限について**
> Google の Geocoding API（GAS 内蔵）は **1日あたり約1,000件** が無料上限です。  
> 本データは約1,800件あるため、**最低2日** かかります。

**推奨スケジュール:**

| 日 | 操作 | 処理件数 |
|---|---|---|
| 1日目 | `geocodeAll()` を3回実行 | 最大1,350件 |
| 2日目 | `geocodeAll()` を2回実行 | 残り約500件 |

**実行方法（毎回同じ手順）:**

1. Apps Script で関数「`geocodeAll`」を選択して実行
2. 完了後に「今回: XX件処理, 残り: XX件」のポップアップが表示される
3. 残りが0件になったら完了

**途中確認:**  
シートの `geocode_status` 列を見て `OK` / `FAILED` の件数を確認してください。  
`FAILED` の行は `geocode_address` を手動修正して `geocode_status` を空白にすると、次回の `geocodeAll()` で再処理されます。

### 2-4. ウェブアプリとしてデプロイ

1. Apps Script エディタ右上「**デプロイ**」→「**新しいデプロイ**」
2. 歯車アイコン →「**ウェブアプリ**」を選択
3. 設定:
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員（匿名ユーザーを含む）**
4. 「デプロイ」をクリック → 表示された **ウェブアプリの URL をコピー**

---

## 手順3: config.js に URL を設定

`docs/js/config.js` を開き、コピーした URL を貼り付けます:

```javascript
const GAS_API_URL = 'https://script.google.com/macros/s/AKfy.../exec';
//                   ↑ ここにコピーした URL を貼り付け
```

---

## 手順4: GitHub Pages への公開

1. GitHub で新規リポジトリを作成（例: `happykaimono`）
2. ローカルで以下を実行:
   ```bash
   git remote add origin https://github.com/あなたのID/happykaimono.git
   git push -u origin master
   ```
3. GitHub リポジトリの「Settings」→「Pages」を開く
4. Source: **Deploy from a branch**、Branch: **master**、フォルダ: **`/docs`** を選択
5. 「Save」→ 数分後に `https://あなたのID.github.io/happykaimono/` で公開される

---

## 手順5: データ更新時の運用フロー

```
スプレッドシート編集
    ↓ (最大15分でフロントに自動反映)
GitHub Pages 上のマップが更新
```

### 店舗情報の変更（電話番号・住所など）

1. スプレッドシートの該当行を直接編集
2. 15分後（キャッシュ期限切れ後）に地図に反映

### 新規店舗の追加

1. スプレッドシートに新行を追加（`geocode_status` は空白のまま）
2. `geocodeAll()` を実行してジオコーディング
3. 15分後に地図に反映

### 店舗の削除

- 該当行を削除、または `lat`/`lng` を空白にする（地図から消える）

---

## errors.csv について

以下の3件は住所が特定できないため、手動で確認が必要です:

| 店舗名 | 問題 | 対処 |
|---|---|---|
| Ａｒｃ ｔｈｅ ｂｏｄｙ | 住所が「築地7」（丁目のみ）＋メール連絡 | 正確な住所を調べて stores.csv に追加 |
| Ｓａｌｏｎ ＥＲＩＭＥＳ | 住所が「銀座」のみ | 正確な住所を調べて追加 |
| Ｈｅａｌｉｎｇ ｈｅａｒｔ ｇｒａｃｅ | 住所が「銀座3」（丁目のみ） | 正確な住所を調べて追加 |

正確な住所が判明したら stores.csv に追加し、スプレッドシートにも反映してください。

---

## Google Maps API キーを持っている場合

`docs/js/app.js` 冒頭の `initMap()` 内タイルレイヤーを以下に差し替えます:

```javascript
// OSM の代わりに Google Maps を使う場合
// ※ Maps JavaScript API の有効化と課金設定が必要
```

`docs/index.html` に Google Maps の script タグを追加し、Leaflet の `TileLayer` を Google Maps プロバイダ（`leaflet-google-mutant` 等）に差し替えることで対応できます。地図レイヤーは `initMap()` に集約されているため、他のコードの変更は不要です。

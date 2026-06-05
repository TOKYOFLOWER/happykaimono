/**
 * 中央区ハッピー買物券2026 取扱店マップ - Google Apps Script
 *
 * ─────────────────────────────────────────────────────────
 * [stores.csv インポート手順]
 * 1. Google スプレッドシートを新規作成し、シート名を「stores」に変更する
 * 2. メニュー「ファイル」→「インポート」→「アップロード」で stores.csv を選択
 *    - 区切り文字: カンマ
 *    - 既存のシートを置き換える
 *    - テキストを数値/日付に変換しない（チェックを外す）
 * 3. シート名が「stores」であることを確認する
 *
 * [ジオコーディング手順]
 * 1. メニュー「拡張機能」→「Apps Script」でこのコードを全て貼り付ける
 * 2. setupHeaders() を一度だけ実行して lat/lng/geocode_status 列を追加する
 * 3. geocodeAll() を繰り返し実行する（1回あたり最大450件 or 5分で自動停止）
 *
 *    ★ Maps.newGeocoder() の無料クォータは1日約1,000件です。
 *    ★ 1,783件を処理するには最低2日かかります。運用例:
 *       1日目: geocodeAll() を 2〜3回実行（計 900〜1,350件）
 *       2日目: geocodeAll() を 2回実行（残りを処理）
 *    ★ geocode_status が「OK」または「FAILED」の行は再実行時にスキップ
 *       されるため、何度実行しても安全です（冪等）。
 *    ★ FAILED の行を再試行するには geocode_status セルを空白にしてください。
 *
 * [ウェブアプリ デプロイ手順]
 * 1. Apps Script エディタ右上「デプロイ」→「新しいデプロイ」
 * 2. 歯車アイコン → 種類: ウェブアプリ を選択
 * 3. 次のユーザーとして実行: 自分
 * 4. アクセスできるユーザー: 全員（匿名ユーザーを含む）
 * 5. 「デプロイ」ボタンを押し、表示された URL をコピー
 * 6. docs/js/config.js の GAS_API_URL に貼り付ける
 *
 * [データ更新時の運用]
 * - スプレッドシートを直接編集後、最大15分でフロントに反映されます
 *   （doGet のキャッシュが自動で切れるため）
 * - 新規店舗追加時は geocode_status を空白にして geocodeAll() を実行
 * ─────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────
//  シート列定義 (1-indexed)
// ──────────────────────────────────────
var COL = {
  NAME:            1,   // A: name
  ADDRESS:         2,   // B: address
  TEL:             3,   // C: tel
  CATEGORY_NO:     4,   // D: category_no
  CATEGORY:        5,   // E: category
  GENRE:           6,   // F: genre
  TICKET_TYPE:     7,   // G: ticket_type
  GEOCODE_ADDRESS: 8,   // H: geocode_address
  NOTE:            9,   // I: note
  CONTACT:        10,   // J: contact
  LAT:            11,   // K: lat
  LNG:            12,   // L: lng
  GEOCODE_STATUS: 13,   // M: geocode_status
};

var SHEET_NAME  = 'stores';
var MAX_PER_RUN = 450;          // 1実行あたりの最大処理件数
var SLEEP_MS    = 200;          // Geocoding API 呼び出し間隔 (ms)
var MAX_MS      = 5 * 60 * 1000; // 実行時間上限 5分 (ms)


// ──────────────────────────────────────
//  setupHeaders: 初回実行用ヘッダ追加
//  ※ データ行への書き込みは一切しない
// ──────────────────────────────────────
function setupHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('シート「' + SHEET_NAME + '」が見つかりません。\nシート名を確認してください。');
    return;
  }

  // 1行で3セルをまとめて書き込む（個別 setValue を避けてタイムアウト防止）
  sheet.getRange(1, COL.LAT, 1, 3).setValues([['lat', 'lng', 'geocode_status']]);

  SpreadsheetApp.getUi().alert(
    'K1: lat / L1: lng / M1: geocode_status を追加しました。\n' +
    '次に geocodeAll() を実行してください。\n' +
    '（geocode_status が空欄の行を未処理として扱います）'
  );
}


// ──────────────────────────────────────
//  geocodeAll: ジオコーディング実行
//  ─ 全データ一括読み込み → メモリ処理 → 範囲一括書き込み
//  ─ 停止条件: 450件処理 OR 5分経過（先に来た方）
//  ─ geocode_status が空欄の行のみ処理（OK / FAILED はスキップ）
// ──────────────────────────────────────
function geocodeAll() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('シート「' + SHEET_NAME + '」が見つかりません。');
    return;
  }

  var lastRow     = sheet.getLastRow();
  var numDataRows = lastRow - 1; // ヘッダ除く
  if (numDataRows <= 0) {
    SpreadsheetApp.getUi().alert('データ行がありません。');
    return;
  }

  // ① 全データを一括読み込み（Sheets API 呼び出し: 1回）
  var allData = sheet.getRange(2, 1, numDataRows, COL.GEOCODE_STATUS).getValues();
  // allData[i][j] は 0-indexed。列 COL.XXX に対応する値は allData[i][COL.XXX - 1]

  // 事前に未処理件数をカウント
  var totalPending = 0;
  for (var i = 0; i < allData.length; i++) {
    var s = String(allData[i][COL.GEOCODE_STATUS - 1]).trim();
    if (s !== 'OK' && s !== 'FAILED') totalPending++;
  }
  Logger.log('実行開始 — 未処理件数: ' + totalPending);

  if (totalPending === 0) {
    SpreadsheetApp.getUi().alert('未処理行がありません。ジオコーディングは既に完了しています。');
    return;
  }

  // ② メモリ上で処理し、更新内容を蓄積
  var startTime  = new Date().getTime();
  var processed  = 0, okCount = 0, failCount = 0;
  // updates: {dataRowIndex: [lat, lng, status]} (データ行の 0-based インデックス)
  var updates    = {};
  var minUpdIdx  = numDataRows; // 更新行の最小インデックス（書き込み範囲計算用）
  var maxUpdIdx  = -1;          // 更新行の最大インデックス

  for (var i = 0; i < allData.length; i++) {
    var status = String(allData[i][COL.GEOCODE_STATUS - 1]).trim();

    // OK / FAILED はスキップ（冪等性の確保）
    if (status === 'OK' || status === 'FAILED') continue;

    // ── 停止判定（件数 or 時間） ──
    var elapsed = new Date().getTime() - startTime;
    if (processed >= MAX_PER_RUN || elapsed >= MAX_MS) {
      Logger.log('停止: processed=' + processed + '件, elapsed=' +
                 Math.round(elapsed / 1000) + '秒');
      break;
    }

    var geocodeAddr = String(allData[i][COL.GEOCODE_ADDRESS - 1]).trim();
    var newLat = '', newLng = '', newStatus = 'FAILED';

    if (!geocodeAddr) {
      // geocode_address が空 → FAILED
      newStatus = 'FAILED';
      failCount++;
    } else {
      try {
        var result = Maps.newGeocoder()
                         .setLanguage('ja')
                         .setRegion('JP')
                         .geocode(geocodeAddr);

        if (result.status === 'OK' && result.results && result.results.length > 0) {
          var loc = result.results[0].geometry.location;
          newLat    = loc.lat;
          newLng    = loc.lng;
          newStatus = 'OK';
          okCount++;
        } else {
          Logger.log('FAILED dataRow=' + i + ' status=' + result.status +
                     ' addr=' + geocodeAddr);
          newStatus = 'FAILED';
          failCount++;
        }
      } catch (e) {
        Logger.log('ERROR dataRow=' + i + ': ' + e.message);
        newStatus = 'FAILED';
        failCount++;
      }
    }

    // 更新内容をメモリに蓄積（まだシートに書かない）
    updates[i] = [newLat, newLng, newStatus];
    if (i < minUpdIdx) minUpdIdx = i;
    if (i > maxUpdIdx) maxUpdIdx = i;

    processed++;
    Utilities.sleep(SLEEP_MS);
  }

  // ③ 処理結果をシートへ一括書き込み（Sheets API 呼び出し: 最大2回）
  if (maxUpdIdx >= 0) {
    var writeStartRow = minUpdIdx + 2;           // シート上の開始行（ヘッダ=1行目分 +1）
    var rangeHeight   = maxUpdIdx - minUpdIdx + 1;

    // 対象範囲の現在値を読み込み（未処理行を上書きしないため）
    // Sheets API 呼び出し: 1回
    var existing = sheet
      .getRange(writeStartRow, COL.LAT, rangeHeight, 3)
      .getValues();

    // メモリ上で更新を適用
    for (var i = minUpdIdx; i <= maxUpdIdx; i++) {
      if (updates[i]) {
        var rel = i - minUpdIdx;
        existing[rel][0] = updates[i][0]; // lat
        existing[rel][1] = updates[i][1]; // lng
        existing[rel][2] = updates[i][2]; // geocode_status
      }
    }

    // 一括書き込み: Sheets API 呼び出し 1回のみ
    sheet.getRange(writeStartRow, COL.LAT, rangeHeight, 3).setValues(existing);
    Logger.log('書き込み完了: シート行 ' + writeStartRow +
               ' 〜 ' + (writeStartRow + rangeHeight - 1) +
               ' (' + rangeHeight + '行の範囲に setValues)');
  }

  // ④ 残り件数を算出（一括取得の数 - 今回処理数）
  var remaining = totalPending - processed;
  var elapsedSec = Math.round((new Date().getTime() - startTime) / 1000);

  var msg = [
    '━━ 実行結果 ━━',
    '今回処理: ' + processed + ' 件',
    '  OK    : ' + okCount + ' 件',
    '  FAILED: ' + failCount + ' 件',
    '経過時間: ' + elapsedSec + ' 秒',
    '残り未処理: ' + remaining + ' 件',
    '',
    remaining > 0
      ? '▶ 残りがあります。再度 geocodeAll() を実行してください。'
      : '✓ 全行のジオコーディングが完了しました！'
  ].join('\n');

  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}


// ──────────────────────────────────────
//  doGet: JSON API エンドポイント
//  ─ lat/lng がある行のみ返す
//  ─ 15分キャッシュ
// ──────────────────────────────────────
function doGet(e) {
  var cache    = CacheService.getScriptCache();
  var cacheKey = 'stores_v2';
  var cached   = cache.get(cacheKey);

  if (cached) {
    return ContentService
      .createTextOutput(cached)
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService
      .createTextOutput(JSON.stringify({ stores: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 全データを一括取得（Sheets API 呼び出し: 1回）
  var allData = sheet.getRange(2, 1, lastRow - 1, COL.GEOCODE_STATUS).getValues();
  var stores  = [];

  for (var i = 0; i < allData.length; i++) {
    var row = allData[i];
    var lat = row[COL.LAT - 1];
    var lng = row[COL.LNG - 1];
    if (!lat || !lng) continue; // 座標なし行を除外

    stores.push({
      name:        row[COL.NAME        - 1],
      address:     row[COL.ADDRESS     - 1],
      tel:         row[COL.TEL         - 1],
      contact:     row[COL.CONTACT     - 1] || '',
      category_no: Number(row[COL.CATEGORY_NO - 1]),
      genre:       row[COL.GENRE       - 1],
      ticket_type: row[COL.TICKET_TYPE - 1],
      lat:         lat,
      lng:         lng,
    });
  }

  var json = JSON.stringify({ stores: stores });

  // 15分キャッシュ（100KB超の場合は無視してキャッシュしない）
  try { cache.put(cacheKey, json, 900); } catch (ex) { /* キャッシュ容量超過は許容 */ }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

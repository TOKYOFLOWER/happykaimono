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
 * 2. setupHeaders() を一度実行して lat/lng/geocode_status 列を追加する
 * 3. geocodeAll() を実行する（1回あたり最大450件処理）
 *
 *    ★ Maps.newGeocoder() の無料クォータは1日約1,000件です。
 *    ★ 1,783件を処理するには最低2日かかります。運用例:
 *       1日目: geocodeAll() を 2〜3回実行（計 900〜1,350件）
 *       2日目: geocodeAll() を 2回実行（残りを処理）
 *    ★ geocode_status が「OK」または「FAILED」の行は再実行時にスキップ
 *       されるため、何度実行しても安全です（冪等）。
 *    ★ FAILED になった行は geocode_address を手動修正して
 *       geocode_status を空白にすると次回の実行対象になります。
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
var MAX_PER_RUN = 450;    // 1実行あたりの最大処理件数（6分制限対策）
var SLEEP_MS    = 200;    // API 呼び出し間隔 (ms)


// ──────────────────────────────────────
//  setupHeaders: 初回実行用ヘッダ追加
// ──────────────────────────────────────
function setupHeaders() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('シート「' + SHEET_NAME + '」が見つかりません。');
    return;
  }
  sheet.getRange(1, COL.LAT).setValue('lat');
  sheet.getRange(1, COL.LNG).setValue('lng');
  sheet.getRange(1, COL.GEOCODE_STATUS).setValue('geocode_status');
  SpreadsheetApp.getUi().alert('lat / lng / geocode_status 列を追加しました。次に geocodeAll() を実行してください。');
}


// ──────────────────────────────────────
//  geocodeAll: ジオコーディング実行
// ──────────────────────────────────────
function geocodeAll() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }

  // geocode_status 列が無ければ作成
  if (!sheet.getRange(1, COL.GEOCODE_STATUS).getValue()) {
    sheet.getRange(1, COL.LAT).setValue('lat');
    sheet.getRange(1, COL.LNG).setValue('lng');
    sheet.getRange(1, COL.GEOCODE_STATUS).setValue('geocode_status');
  }

  var lastRow   = sheet.getLastRow();
  var processed = 0;
  var okCount   = 0;
  var failCount = 0;

  // 全ステータスを一括取得して行処理を高速化
  var statusCol  = sheet.getRange(2, COL.GEOCODE_STATUS, lastRow - 1, 1).getValues();
  var geocodeCol = sheet.getRange(2, COL.GEOCODE_ADDRESS, lastRow - 1, 1).getValues();

  for (var i = 0; i < statusCol.length; i++) {
    var row    = i + 2;  // 実際の行番号 (1行目はヘッダ)
    var status = String(statusCol[i][0]).trim();

    // OK / FAILED はスキップ（冪等）
    if (status === 'OK' || status === 'FAILED') continue;

    // 上限チェック
    if (processed >= MAX_PER_RUN) {
      Logger.log('上限 ' + MAX_PER_RUN + ' 件に達しました。続きは次回実行してください。');
      break;
    }

    var geocodeAddr = String(geocodeCol[i][0]).trim();
    if (!geocodeAddr) {
      sheet.getRange(row, COL.GEOCODE_STATUS).setValue('FAILED');
      failCount++;
      processed++;
      continue;
    }

    try {
      var result = Maps.newGeocoder()
                       .setLanguage('ja')
                       .setRegion('JP')
                       .geocode(geocodeAddr);

      if (result.status === 'OK' && result.results && result.results.length > 0) {
        var loc = result.results[0].geometry.location;
        sheet.getRange(row, COL.LAT).setValue(loc.lat);
        sheet.getRange(row, COL.LNG).setValue(loc.lng);
        sheet.getRange(row, COL.GEOCODE_STATUS).setValue('OK');
        okCount++;
      } else {
        Logger.log('Row ' + row + ': geocode status=' + result.status + ', addr=' + geocodeAddr);
        sheet.getRange(row, COL.GEOCODE_STATUS).setValue('FAILED');
        failCount++;
      }
    } catch (e) {
      Logger.log('Row ' + row + ' exception: ' + e.message);
      sheet.getRange(row, COL.GEOCODE_STATUS).setValue('FAILED');
      failCount++;
    }

    processed++;
    Utilities.sleep(SLEEP_MS);
  }

  // 残り件数を集計
  var remaining = 0;
  var updatedStatus = sheet.getRange(2, COL.GEOCODE_STATUS, lastRow - 1, 1).getValues();
  for (var j = 0; j < updatedStatus.length; j++) {
    var s = String(updatedStatus[j][0]).trim();
    if (s !== 'OK' && s !== 'FAILED') remaining++;
  }

  var msg = [
    '今回処理: ' + processed + ' 件',
    '  OK     : ' + okCount + ' 件',
    '  FAILED : ' + failCount + ' 件',
    '残り未処理: ' + remaining + ' 件',
    remaining > 0 ? '\n残りがあります。再度 geocodeAll() を実行してください。' : '\nジオコーディング完了！'
  ].join('\n');
  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}


// ──────────────────────────────────────
//  doGet: JSON API エンドポイント
// ──────────────────────────────────────
function doGet(e) {
  // CORS ヘッダ対応（GAS は自動で付与するが念のため）
  var cache    = CacheService.getScriptCache();
  var cacheKey = 'stores_v2';
  var cached   = cache.get(cacheKey);

  if (cached) {
    return ContentService
      .createTextOutput(cached)
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
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

  // 全データを一括取得（API呼び出し最小化）
  var data = sheet.getRange(2, 1, lastRow - 1, COL.GEOCODE_STATUS).getValues();
  var stores = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var lat = row[COL.LAT - 1];
    var lng = row[COL.LNG - 1];

    // 座標が無い行は除外
    if (!lat || !lng) continue;

    // フロント表示に必要なフィールドのみ返す（容量削減）
    stores.push({
      name:        row[COL.NAME - 1],
      address:     row[COL.ADDRESS - 1],
      tel:         row[COL.TEL - 1],
      contact:     row[COL.CONTACT - 1] || '',
      category_no: Number(row[COL.CATEGORY_NO - 1]),
      genre:       row[COL.GENRE - 1],
      ticket_type: row[COL.TICKET_TYPE - 1],
      lat:         lat,
      lng:         lng,
    });
  }

  var json = JSON.stringify({ stores: stores });
  // 15分キャッシュ（900秒）
  try { cache.put(cacheKey, json, 900); } catch (ex) { /* キャッシュサイズ超過時は無視 */ }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

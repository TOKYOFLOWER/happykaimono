#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中央区ハッピー買物券2026 取扱店PDFデータ抽出スクリプト
tempo_260601.pdf (中小小売店, カテゴリ1-25) と
daiten_260601.pdf (大規模小売店, カテゴリ26) を処理して
stores.csv / errors.csv を生成する。
"""

import pdfplumber
import csv
import re
import sys
from collections import Counter

# ────────────────────────────────────────
#  定数
# ────────────────────────────────────────

TEMPO_PDF  = "tempo_260601.pdf"
DAITEN_PDF = "daiten_260601.pdf"
STORES_CSV = "stores.csv"
ERRORS_CSV = "errors.csv"

# x 座標によるカラム境界 (pt 単位)
#   tempo:  name(<245) | addr(245-422) | tel(422-490) | genre(490+)
#   daiten: name(<240) | addr(240-403) | tel(403-455) | genre(455+)
THRESHOLDS = {
    "tempo":  {"name_end": 245, "tel_start": 422, "genre_start": 490},
    "daiten": {"name_end": 240, "tel_start": 403, "genre_start": 455},
}

# 行グループ化の y 許容幅 (同一行とみなす最大 y 差)
Y_GAP = 6

# カテゴリ見出し正規表現: "1.コンビニ、雑貨" など
CAT_RE = re.compile(r"^(\d+)[．.。]\s*(.+)$")

# 電話番号パターン (正規化済み半角) : 0XX-XXXX-XXXX 形式
PHONE_RE = re.compile(
    r"^0\d{1,4}-\d{2,4}-\d{3,4}$"      # 一般固定/携帯
    r"|^0\d{8,10}$"                      # ハイフンなし
    r"|^0[57]0-\d{4}-\d{4}$"            # 050/070
)

# スキップすべきヘッダ文字列 (部分一致)
SKIP_FRAGMENTS = [
    "中央区内共通買物券（ハッピー買物券2026）取扱店一覧",
    "令和８年度　区内共通買物",
    "令和８年度 区内共通買物",
    "令和８年度",
    "令和8年6月1日現在",
    "更、取り消しが発生する場合",
    "ご利用いただけます。",
    "取扱店について予告なく変",
    "予めご了承ください",
]
# 完全一致でスキップするもの
SKIP_EXACT = {"店舗名", "住", "所", "電話番号", "業", "種", "ページ",
              "【中小小売店】", "令和8年6月1日現在"}

GEO_PREFIX = "東京都中央区"


# ────────────────────────────────────────
#  ユーティリティ
# ────────────────────────────────────────

def fw2hw(text: str) -> str:
    """全角英数を半角に変換"""
    result = []
    for ch in text:
        cp = ord(ch)
        if 0xFF01 <= cp <= 0xFF5E:
            result.append(chr(cp - 0xFEE0))
        elif ch == "　":
            result.append(" ")
        else:
            result.append(ch)
    return "".join(result)


def normalize_phone(raw: str) -> str:
    """電話番号の表記揺れを正規化 (ダッシュ・全角数字)"""
    t = raw.strip()
    # 各種ダッシュ → ハイフン
    for dash in ["ー", "－", "ｰ", "‐", "—", "–"]:
        t = t.replace(dash, "-")
    t = fw2hw(t)
    return t


def is_valid_phone(raw: str) -> bool:
    return bool(PHONE_RE.match(normalize_phone(raw)))


def should_skip_word(text: str) -> bool:
    """ヘッダ・ページ番号等の不要テキストかどうか"""
    if text in SKIP_EXACT:
        return True
    if re.match(r"^\d+\s*/\s*\d+$", text):  # "1 / 31" 等
        return True
    for frag in SKIP_FRAGMENTS:
        if frag in text:
            return True
    return False


def make_geocode_addr(main_addr: str) -> str:
    """geocode_address を生成: 東京都中央区 + 主住所 (ビル名除去済)"""
    addr = fw2hw(main_addr).strip()
    # 末尾の "先" "付近" "番地先" を除去
    addr = re.sub(r"(番地)?先$", "", addr)
    addr = re.sub(r"付近$", "", addr)
    return GEO_PREFIX + addr if addr else ""


# ────────────────────────────────────────
#  行グループ化
# ────────────────────────────────────────

def group_by_row(words: list, gap: float = Y_GAP) -> list:
    """
    y 座標が近いワードを同一行にまとめる。
    各行はワードリスト (x 順ソート済み)。
    """
    if not words:
        return []
    by_y = sorted(words, key=lambda w: w["top"])
    rows = []
    cur = [by_y[0]]
    ref_y = by_y[0]["top"]

    for w in by_y[1:]:
        if w["top"] - ref_y <= gap:
            cur.append(w)
        else:
            rows.append(sorted(cur, key=lambda w: w["x0"]))
            cur = [w]
            ref_y = w["top"]

    if cur:
        rows.append(sorted(cur, key=lambda w: w["x0"]))
    return rows


# ────────────────────────────────────────
#  行分類
# ────────────────────────────────────────

def classify_row(row: list, thr: dict) -> str:
    """
    行タイプを返す:
      'header'     - ヘッダ行 (スキップ)
      'page_num'   - ページ番号行 (スキップ)
      'category'   - カテゴリ見出し行
      'note'       - ※注記のみ行 (スキップ)
      'name_only'  - 店舗名のみ行 (次行のプレフィックスになる)
      'store'      - 通常店舗行
      'skip'       - その他スキップ
    """
    if not row:
        return "skip"

    y = row[0]["top"]
    # ページ上端 (ヘッダ領域) または下端 (ページ番号)
    if y > 810 or y < 15:
        return "page_num"

    # すべてのワードがスキップ対象かどうか確認
    texts = [w["text"] for w in row]
    if all(should_skip_word(t) for t in texts):
        return "header"

    # カラム別に分類
    name_ws  = [w for w in row if w["x0"] < thr["name_end"]]
    addr_ws  = [w for w in row if thr["name_end"] <= w["x0"] < thr["tel_start"]]
    tel_ws   = [w for w in row if thr["tel_start"] <= w["x0"] < thr["genre_start"]]
    genre_ws = [w for w in row if w["x0"] >= thr["genre_start"]]

    has_useful = bool(addr_ws or tel_ws or genre_ws)

    # カテゴリ見出し: 単一ワードで "N." パターン かつ x > 100 (中央付近)
    if len(row) == 1:
        w = row[0]
        if CAT_RE.match(w["text"]) and w["x0"] > 100:
            return "category"

    # 注記行: name 列のみ、かつ ※ で始まるワードを含む
    if not has_useful and name_ws:
        if any(w["text"].startswith("※") for w in name_ws):
            return "note"

    # 店舗名のみ行: name 列にワードあり、それ以外なし
    if not has_useful and name_ws:
        # ヘッダ断片が含まれている場合はスキップ
        if any(should_skip_word(w["text"]) for w in name_ws):
            return "header"
        return "name_only"

    # 通常店舗行: tel または genre 列にワードあり
    if tel_ws or genre_ws:
        return "store"

    # addr のみあり tel/genre なし: 不明 → スキップ扱い
    return "skip"


# ────────────────────────────────────────
#  店舗データ抽出
# ────────────────────────────────────────

def extract_store(row: list, thr: dict) -> dict:
    """
    店舗行を解析して辞書を返す。
    address = PDF の住所そのまま (主住所+ビル名を結合)
    geocode_address = 東京都中央区 + 主住所 (ビル名除去)
    """
    name_parts  = []
    addr_parts  = []   # addr列の全ワード
    tel_parts   = []
    genre_parts = []

    for w in row:
        x, t = w["x0"], w["text"]
        if x < thr["name_end"]:
            if not t.startswith("※"):
                name_parts.append(t)
        elif x < thr["tel_start"]:
            addr_parts.append(t)
        elif x < thr["genre_start"]:
            tel_parts.append(t)
        else:
            genre_parts.append(t)

    main_addr = addr_parts[0] if addr_parts else ""
    building  = " ".join(addr_parts[1:]) if len(addr_parts) > 1 else ""
    full_addr = (main_addr + ("　" + building if building else "")).strip()

    tel   = normalize_phone(" ".join(tel_parts))
    genre = " ".join(genre_parts).strip()

    geocode = make_geocode_addr(main_addr)

    return {
        "name":            " ".join(name_parts).strip(),
        "address":         full_addr,
        "_main_addr":      main_addr,   # エラー判定用 (CSV出力しない)
        "_building":       building,    # エラー判定用
        "tel":             tel,
        "genre":           genre,
        "geocode_address": geocode,
    }


# ────────────────────────────────────────
#  エラー判定
# ────────────────────────────────────────

def check_errors(data: dict) -> list:
    """エラー理由のリストを返す (空リストなら正常)"""
    errs = []
    tel     = data["tel"]
    addr    = data["_main_addr"]
    bldg    = data["_building"]

    # ─ 電話番号エラー ─
    if "@" in tel:
        errs.append("電話番号がメールアドレス")
    elif not tel:
        errs.append("電話番号なし")
    elif not is_valid_phone(tel):
        if "メール" in tel or "予約" in tel or tel.startswith("http"):
            errs.append("電話番号が無効")
        else:
            errs.append(f"電話番号が不正: {tel}")

    # ─ 住所エラー ─
    # ビル列にメールアドレスがある場合
    if "@" in bldg and "電話番号がメールアドレス" not in errs:
        errs.append("電話番号がメールアドレス")

    # 「先」付き住所
    if re.search(r"\d先$", addr):
        errs.append("住所に「先」を含む特殊表記")

    # ※詳細は〜 が住所または建物欄にある
    if "※詳細は" in addr or "※詳細は" in bldg:
        errs.append("住所が「詳細はお問合せ」表記")

    # 住所に数字がなく町名だけ (例: 「銀座」「銀座3」)
    if addr and not re.search(r"[\d０-９]", addr):
        errs.append("住所に番地なし")
    elif addr and not re.search(r"[-\d丁目番地号]", addr):
        errs.append("住所が不完全")

    return errs


# ────────────────────────────────────────
#  PDF 処理
# ────────────────────────────────────────

def process_pdf(pdf_path: str, ticket_type: str, source_key: str) -> tuple:
    """
    PDFを処理し (stores_list, errors_list) を返す。
    stores_list / errors_list は各々辞書のリスト。
    """
    thr = THRESHOLDS[source_key]
    stores = []
    errors = []

    current_cat_no = 0
    current_cat    = ""
    pending_name   = ""      # 名前折り返し1行目

    with pdfplumber.open(pdf_path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(keep_blank_chars=False)
            if not words:
                continue

            rows = group_by_row(words)

            for row in rows:
                rtype = classify_row(row, thr)

                if rtype in ("skip", "header", "page_num"):
                    continue

                if rtype == "category":
                    m = CAT_RE.match(row[0]["text"])
                    if m:
                        current_cat_no = int(m.group(1))
                        current_cat    = m.group(2).strip()
                    pending_name = ""
                    continue

                if rtype == "note":
                    # ※注記行はスキップ (pending_name はクリアしない)
                    continue

                if rtype == "name_only":
                    parts = [w["text"] for w in row
                             if w["x0"] < thr["name_end"] and not w["text"].startswith("※")]
                    pending_name = (" ".join(parts)).strip()
                    continue

                if rtype == "store":
                    data = extract_store(row, thr)

                    # 名前折り返し結合
                    if pending_name:
                        data["name"] = (pending_name + " " + data["name"]).strip()
                        pending_name = ""

                    if not data["name"]:
                        continue

                    data["category_no"] = current_cat_no
                    data["category"]    = current_cat
                    data["ticket_type"] = ticket_type
                    data["_source"]     = pdf_path
                    data["_page"]       = page_no

                    errs = check_errors(data)
                    if errs:
                        data["error_reason"] = "; ".join(errs)
                        errors.append(data)
                    else:
                        stores.append(data)

    return stores, errors


# ────────────────────────────────────────
#  CSV 書き出し
# ────────────────────────────────────────

STORES_FIELDS = [
    "name", "address", "tel", "category_no", "category",
    "genre", "ticket_type", "geocode_address",
]

ERRORS_FIELDS = [
    "name", "address", "tel", "category_no", "category",
    "genre", "ticket_type", "geocode_address",
    "error_reason", "_source", "_page",
]


def write_csv(path: str, rows: list, fieldnames: list):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


# ────────────────────────────────────────
#  メイン
# ────────────────────────────────────────

def main():
    sys.stdout.reconfigure(encoding="utf-8")

    all_stores, all_errors = [], []

    print("=== tempo_260601.pdf (中小小売店) 処理中 ===")
    t_stores, t_errors = process_pdf(TEMPO_PDF, "all", "tempo")
    all_stores.extend(t_stores)
    all_errors.extend(t_errors)
    print(f"  正常: {len(t_stores)} 件   エラー: {len(t_errors)} 件")

    print("\n=== daiten_260601.pdf (大規模小売店) 処理中 ===")
    d_stores, d_errors = process_pdf(DAITEN_PDF, "purple_only", "daiten")
    all_stores.extend(d_stores)
    all_errors.extend(d_errors)
    print(f"  正常: {len(d_stores)} 件   エラー: {len(d_errors)} 件")

    write_csv(STORES_CSV, all_stores, STORES_FIELDS)
    write_csv(ERRORS_CSV, all_errors, ERRORS_FIELDS)

    total = len(all_stores) + len(all_errors)
    print(f"\n=== サマリ ===")
    print(f"合計処理件数 : {total}")
    print(f"  stores.csv : {len(all_stores)} 件")
    print(f"  errors.csv : {len(all_errors)} 件")

    # カテゴリ別件数
    cat_stores = Counter((s["category_no"], s["category"]) for s in all_stores)
    cat_errors = Counter((s["category_no"], s["category"]) for s in all_errors)

    print("\n--- カテゴリ別件数 (stores.csv) ---")
    for (no, cat), cnt in sorted(cat_stores.items()):
        mark = f" [エラー {cat_errors.get((no,cat),0)}件]" if cat_errors.get((no,cat)) else ""
        print(f"  {no:2d}. {cat}: {cnt}{mark}")

    if all_errors:
        print("\n--- エラー行サンプル ---")
        for row in all_errors[:10]:
            print(f"  [{row['_source']} p{row['_page']}] {row['name']!r} / {row.get('error_reason','')}")
        if len(all_errors) > 10:
            print(f"  ...他 {len(all_errors)-10} 件 (errors.csv 参照)")


if __name__ == "__main__":
    main()

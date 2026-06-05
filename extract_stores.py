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

THRESHOLDS = {
    "tempo":  {"name_end": 245, "tel_start": 422, "genre_start": 490},
    "daiten": {"name_end": 240, "tel_start": 403, "genre_start": 455},
}

Y_GAP = 6
CAT_RE = re.compile(r"^(\d+)[．.。]\s*(.+)$")

PHONE_RE = re.compile(
    r"^0\d{1,4}-\d{2,4}-\d{3,4}$"
    r"|^0\d{8,10}$"
    r"|^0[57]0-\d{4}-\d{4}$"
)

SKIP_FRAGMENTS = [
    "中央区内共通買物券（ハッピー買物券2026）取扱店一覧",
    "令和８年度　区内共通買物", "令和８年度 区内共通買物", "令和８年度",
    "令和8年6月1日現在", "更、取り消しが発生する場合",
    "ご利用いただけます。", "取扱店について予告なく変", "予めご了承ください",
]
SKIP_EXACT = {"店舗名", "住", "所", "電話番号", "業", "種", "ページ",
              "【中小小売店】", "令和8年6月1日現在"}

# メールアドレス / URL 抽出パターン
CONTACT_RE = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"  # email
    r"|https?://\S+"                                         # URL
)

GEO_PREFIX = "東京都中央区"


# ────────────────────────────────────────
#  ユーティリティ
# ────────────────────────────────────────

def fw2hw(text: str) -> str:
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
    t = raw.strip()
    for dash in ["ー", "－", "ｰ", "‐", "—", "–", "−"]:
        t = t.replace(dash, "-")
    t = fw2hw(t)
    return t


def is_valid_phone(raw: str) -> bool:
    return bool(PHONE_RE.match(normalize_phone(raw)))


def should_skip_word(text: str) -> bool:
    if text in SKIP_EXACT:
        return True
    if re.match(r"^\d+\s*/\s*\d+$", text):
        return True
    for frag in SKIP_FRAGMENTS:
        if frag in text:
            return True
    return False


def make_geocode_addr(main_addr: str) -> str:
    """geocode_address を生成。ビル名除去済・「先」除去済。"""
    addr = fw2hw(main_addr).strip()
    # 全角/半角ダッシュを正規化
    for dash in ["－", "−", "ｰ"]:
        addr = addr.replace(dash, "-")
    # 末尾の「先」「付近」「番地先」を除去
    addr = re.sub(r"(番地)?先$", "", addr)
    addr = re.sub(r"付近$", "", addr)
    return GEO_PREFIX + addr if addr else ""


def extract_contact(text: str) -> str:
    """テキストからメールアドレスまたは URL を抽出する"""
    m = CONTACT_RE.search(text)
    return m.group(0) if m else ""


# ────────────────────────────────────────
#  行グループ化
# ────────────────────────────────────────

def group_by_row(words: list, gap: float = Y_GAP) -> list:
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
    if not row:
        return "skip"
    y = row[0]["top"]
    if y > 810 or y < 15:
        return "page_num"
    texts = [w["text"] for w in row]
    if all(should_skip_word(t) for t in texts):
        return "header"
    name_ws  = [w for w in row if w["x0"] < thr["name_end"]]
    addr_ws  = [w for w in row if thr["name_end"] <= w["x0"] < thr["tel_start"]]
    tel_ws   = [w for w in row if thr["tel_start"] <= w["x0"] < thr["genre_start"]]
    genre_ws = [w for w in row if w["x0"] >= thr["genre_start"]]
    has_useful = bool(addr_ws or tel_ws or genre_ws)
    if len(row) == 1:
        w = row[0]
        if CAT_RE.match(w["text"]) and w["x0"] > 100:
            return "category"
    if not has_useful and name_ws:
        if any(w["text"].startswith("※") for w in name_ws):
            return "note"
    if not has_useful and name_ws:
        if any(should_skip_word(w["text"]) for w in name_ws):
            return "header"
        return "name_only"
    if tel_ws or genre_ws:
        return "store"
    return "skip"


# ────────────────────────────────────────
#  店舗データ抽出
# ────────────────────────────────────────

def extract_store(row: list, thr: dict) -> dict:
    name_parts  = []
    addr_parts  = []
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
        "_main_addr":      main_addr,
        "_building":       building,
        "tel":             tel,
        "genre":           genre,
        "geocode_address": geocode,
    }


# ────────────────────────────────────────
#  エントリ分類 (修正版)
# ────────────────────────────────────────

def classify_entry(data: dict) -> tuple:
    """
    stores.csv (store) か errors.csv (error) かを判定し、
    note / contact フィールドを付与する。

    ルール:
    - 住所に「先」付き → stores + note="address_approx"
    - 電話番号がメール/URL → contact に移動、tel=""、stores
    - ビル欄にメール/URL → contact 列に移動、stores
    - 「詳細はお問合せ」かつ丁目のみ/番地なし → errors
    """
    tel  = data["tel"]
    addr = data["_main_addr"]
    bldg = data["_building"]

    # ── メール/URL を contact 列へ抽出 ──────────────────────────────
    contact = ""

    # tel 欄がメール/URL の場合
    if "@" in tel or re.search(r"https?://", tel):
        contact = tel.strip()
        data["tel"] = ""

    # ビル欄 (または addr 欄) にメール/URL がある場合
    if not contact:
        contact = extract_contact(bldg) or extract_contact(addr)

    data["contact"] = contact

    # ── 「先」付き住所 ───────────────────────────────────────────────
    note = ""
    if re.search(r"\d先", addr):
        note = "address_approx"
        # make_geocode_addr は既に「先」を除去済み
    data["note"] = note

    # ── エラー判定 ───────────────────────────────────────────────────
    # 丁目のみ = ブロック-ロット番号 (N-M形式) が存在しない
    has_block_lot = bool(re.search(r"\d+[-－−]\d+|\d+番\d+号?", addr))
    is_town_only  = not has_block_lot and bool(addr)

    # 「詳細はお問合せ」表記があるか
    has_detail_note = "詳細は" in addr or "詳細は" in bldg

    # 住所に数字がそもそも無い
    has_any_digit = bool(re.search(r"\d", addr))

    if is_town_only and (has_detail_note or not has_any_digit):
        reasons = []
        if not has_any_digit:
            reasons.append("住所に番地なし（地域名のみ）")
        else:
            reasons.append("住所が丁目のみで特定不可")
        if has_detail_note:
            reasons.append("「詳細はお問合せ」表記")
        data["error_reason"] = "; ".join(reasons)
        return "error", data

    return "store", data


# ────────────────────────────────────────
#  PDF 処理
# ────────────────────────────────────────

def process_pdf(pdf_path: str, ticket_type: str, source_key: str) -> tuple:
    thr = THRESHOLDS[source_key]
    stores = []
    errors = []
    current_cat_no = 0
    current_cat    = ""
    pending_name   = ""

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
                    continue
                if rtype == "name_only":
                    parts = [w["text"] for w in row
                             if w["x0"] < thr["name_end"] and not w["text"].startswith("※")]
                    pending_name = " ".join(parts).strip()
                    continue
                if rtype == "store":
                    data = extract_store(row, thr)
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

                    kind, data = classify_entry(data)
                    if kind == "error":
                        errors.append(data)
                    else:
                        stores.append(data)

    return stores, errors


# ────────────────────────────────────────
#  CSV 書き出し
# ────────────────────────────────────────

STORES_FIELDS = [
    "name", "address", "tel", "category_no", "category",
    "genre", "ticket_type", "geocode_address", "note", "contact",
]

ERRORS_FIELDS = [
    "name", "address", "tel", "category_no", "category",
    "genre", "ticket_type", "geocode_address", "note", "contact",
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

    # stores.json 再生成
    import json, os
    os.makedirs("docs/data", exist_ok=True)
    stores_json = []
    for row in all_stores:
        stores_json.append({
            "name":            row["name"],
            "address":         row["address"],
            "tel":             row["tel"],
            "contact":         row["contact"],
            "category_no":     int(row["category_no"]),
            "category":        row["category"],
            "genre":           row["genre"],
            "ticket_type":     row["ticket_type"],
            "geocode_address": row["geocode_address"],
            "note":            row["note"],
            "lat":             None,
            "lng":             None,
        })
    with open("docs/data/stores.json", "w", encoding="utf-8") as f:
        json.dump({"stores": stores_json}, f, ensure_ascii=False, separators=(",", ":"))

    total = len(all_stores) + len(all_errors)
    print(f"\n=== サマリ ===")
    print(f"合計処理件数 : {total}")
    print(f"  stores.csv : {len(all_stores)} 件")
    print(f"  errors.csv : {len(all_errors)} 件")

    # カテゴリ別件数
    cat_stores = Counter((s["category_no"], s["category"]) for s in all_stores)
    cat_errors = Counter((e["category_no"], e["category"]) for e in all_errors)

    print("\n--- カテゴリ別件数 (stores.csv) ---")
    for (no, cat), cnt in sorted(cat_stores.items()):
        print(f"  {no:2d}. {cat}: {cnt}")

    if all_errors:
        print(f"\n--- errors.csv ({len(all_errors)}件) ---")
        for row in all_errors:
            print(f"  [{row['_source']} p{row['_page']}] {row['name']!r}")
            print(f"    addr={row['address']!r}")
            print(f"    reason: {row.get('error_reason','')}")

    # note 付き件数
    note_count = sum(1 for s in all_stores if s.get("note"))
    contact_count = sum(1 for s in all_stores if s.get("contact"))
    print(f"\nnote='address_approx' : {note_count} 件")
    print(f"contact 列に連絡先あり: {contact_count} 件")


if __name__ == "__main__":
    main()

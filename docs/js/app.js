/* ════════════════════════════════════════
   中央区ハッピー買物券2026 取扱店マップ
   ════════════════════════════════════════ */

// ──────────────────────────────────────
//  カテゴリグループ定義
// ──────────────────────────────────────
const GROUPS = [
  { id: 'all',     label: '全て',          cats: null },
  { id: 'food',    label: '飲食',          cats: [12, 13, 14, 15] },
  { id: 'shop',    label: '食品・買い物',  cats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'beauty',  label: '美容・健康',    cats: [16, 19, 23] },
  { id: 'medical', label: '医療',          cats: [17, 18] },
  { id: 'service', label: 'サービス',      cats: [20, 21, 22, 24, 25] },
  { id: 'purple',  label: 'むらさき色の券', cats: [26], isPurple: true },
];

// カテゴリ番号 → カテゴリ名ルックアップ（表示用）
const CAT_LABELS = {
  1:'コンビニ・雑貨', 2:'衣類・身の回り品', 3:'菓子・パン', 4:'飲料品',
  5:'スーパー・食品', 6:'肉・魚・青果・米', 7:'その他の食品',
  8:'自転車・自動車', 9:'家具・家電', 10:'ガソリンスタンド',
  11:'その他の小売業', 12:'寿司', 13:'和食・日本料理', 14:'中華・焼肉',
  15:'その他飲食店', 16:'薬局・ドラッグストア', 17:'病院・診療所',
  18:'歯科診療所', 19:'はり・鍼灸・接骨院', 20:'介護関連',
  21:'ホテル・旅行', 22:'クリーニング', 23:'理美容',
  24:'その他サービス業', 25:'その他', 26:'大規模小売店（むらさき色の券）',
};

// ──────────────────────────────────────
//  状態
// ──────────────────────────────────────
let map, clusterGroup;
let allStores  = [];   // 全店舗データ
let allMarkers = [];   // 対応 L.Marker
let activeGroupId = 'all';       // 大分類チップ選択状態
let activeCatSet  = null;        // 詳細モーダルで選択したカテゴリ (null=未使用)
let searchQuery   = '';
let searchTimer   = null;

// ──────────────────────────────────────
//  マーカーアイコン
// ──────────────────────────────────────
const ICON_BLUE = L.divIcon({
  html: '<div class="marker-blue"></div>',
  className: '', iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -9],
});
const ICON_PURPLE = L.divIcon({
  html: '<div class="marker-purple"></div>',
  className: '', iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -9],
});

// ──────────────────────────────────────
//  起動時の初期座標を現在地から取得
//  取得失敗 or タイムアウト(5秒) → 中央区デフォルト
// ──────────────────────────────────────
function getInitialPosition() {
  const DEFAULT = { lat: 35.6762, lng: 139.7649, zoom: 13 };
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(DEFAULT); return; }
    const timer = setTimeout(() => resolve(DEFAULT), 5000);
    navigator.geolocation.getCurrentPosition(
      pos => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, zoom: 15 });
      },
      () => { clearTimeout(timer); resolve(DEFAULT); },
      { timeout: 5000, maximumAge: 60000 }
    );
  });
}

// ──────────────────────────────────────
//  初期化
// ──────────────────────────────────────
async function init() {
  buildChips();
  buildModal();
  setupSearch();

  // 現在地取得完了(or タイムアウト)してから地図を初期化
  const pos = await getInitialPosition();
  initMap(pos.lat, pos.lng, pos.zoom);
  setupGeolocation();

  const data = await loadData();
  const withCoords = data.stores.filter(s => s.lat && s.lng);

  if (withCoords.length === 0 && data.stores.length > 0) {
    showMessage('📍 座標データが未取得です。GAS で geocodeAll() を実行してください。');
  } else if (data.stores.length === 0) {
    showError('データを読み込めませんでした。');
  }

  allStores  = withCoords;
  allMarkers = withCoords.map(s => {
    const icon   = s.ticket_type === 'purple_only' ? ICON_PURPLE : ICON_BLUE;
    const marker = L.marker([s.lat, s.lng], { icon });
    marker._store = s;
    marker.on('click', () => openSheet(s));
    return marker;
  });

  // chunkedLoading で全マーカーを一括追加
  clusterGroup.addLayers(allMarkers);
  updateCount(allMarkers.length);
  hideLoading();
}

// ──────────────────────────────────────
//  地図初期化
// ──────────────────────────────────────
function initMap(lat, lng, zoom) {
  map = L.map('map', {
    center: [lat, lng],
    zoom: zoom,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  clusterGroup = L.markerClusterGroup({
    chunkedLoading:      true,
    chunkInterval:       150,
    chunkDelay:          50,
    maxClusterRadius:    60,
    spiderfyOnMaxZoom:   true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 18,
  });
  map.addLayer(clusterGroup);

  // 地図クリックでボトムシートを閉じる
  map.on('click', closeSheet);
}

// ──────────────────────────────────────
//  データ読み込み
// ──────────────────────────────────────
async function loadData() {
  // GAS API を試す
  const isPlaceholder = !GAS_API_URL || GAS_API_URL.startsWith('YOUR_');
  if (!isPlaceholder) {
    try {
      const res = await fetch(GAS_API_URL, { mode: 'cors' });
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn('GAS API fetch failed, falling back to stores.json:', e);
    }
  }
  // フォールバック: ローカル stores.json
  try {
    const res = await fetch('./data/stores.json');
    if (res.ok) return await res.json();
  } catch (e) {
    console.error('stores.json fetch failed:', e);
  }
  return { stores: [] };
}

// ──────────────────────────────────────
//  フィルタ適用
// ──────────────────────────────────────
function applyFilter() {
  const q = searchQuery.toLowerCase();

  const visible = allMarkers.filter(m => {
    const s = m._store;

    // カテゴリフィルタ
    if (activeCatSet !== null) {
      // 詳細モーダルによる選択
      if (!activeCatSet.has(s.category_no)) return false;
    } else if (activeGroupId !== 'all') {
      const grp = GROUPS.find(g => g.id === activeGroupId);
      if (grp && grp.cats && !grp.cats.includes(s.category_no)) return false;
    }

    // 検索フィルタ
    if (q) {
      const hit = s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  });

  clusterGroup.clearLayers();
  clusterGroup.addLayers(visible);
  updateCount(visible.length);
}

// ──────────────────────────────────────
//  チップ (大分類)
// ──────────────────────────────────────
function buildChips() {
  const row = document.getElementById('chip-row');
  GROUPS.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (g.isPurple ? ' purple-chip' : '') + (g.id === 'all' ? ' active' : '');
    btn.textContent = g.label;
    btn.dataset.gid = g.id;
    btn.addEventListener('click', () => {
      activeGroupId = g.id;
      activeCatSet  = null;  // 詳細選択をリセット
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      applyFilter();
    });
    row.appendChild(btn);
  });

  // 詳細選択ボタン
  const btnDetail = document.getElementById('btn-detail');
  btnDetail.addEventListener('click', openModal);
}

// ──────────────────────────────────────
//  詳細カテゴリモーダル
// ──────────────────────────────────────
let modalCatChecked = new Set();

function buildModal() {
  const grid = document.getElementById('modal-cat-grid');
  Object.entries(CAT_LABELS).forEach(([no, label]) => {
    const n = Number(no);
    const item = document.createElement('label');
    item.className = 'modal-cat-item';
    item.innerHTML = `<input type="checkbox" data-cat="${n}"> ${label}`;
    item.addEventListener('click', e => {
      e.preventDefault();
      const checkbox = item.querySelector('input');
      if (modalCatChecked.has(n)) {
        modalCatChecked.delete(n);
        item.classList.remove('checked');
        checkbox.checked = false;
      } else {
        modalCatChecked.add(n);
        item.classList.add('checked');
        checkbox.checked = true;
      }
    });
    grid.appendChild(item);
  });

  document.getElementById('btn-modal-reset').addEventListener('click', () => {
    modalCatChecked.clear();
    document.querySelectorAll('.modal-cat-item').forEach(el => el.classList.remove('checked'));
  });

  document.getElementById('btn-modal-apply').addEventListener('click', () => {
    closeModal();
    if (modalCatChecked.size === 0) {
      // 何も選択されていなければ「全て」に戻す
      activeGroupId = 'all';
      activeCatSet  = null;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      document.querySelector('.chip[data-gid="all"]').classList.add('active');
    } else {
      activeCatSet  = new Set(modalCatChecked);
      activeGroupId = '__detail__';
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      document.getElementById('btn-detail').textContent = `詳細(${activeCatSet.size})`;
    }
    applyFilter();
  });

  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
}

function openModal() {
  // 現在の activeCatSet をモーダルに反映
  modalCatChecked = activeCatSet ? new Set(activeCatSet) : new Set();
  document.querySelectorAll('.modal-cat-item').forEach(el => {
    const n = Number(el.querySelector('input').dataset.cat);
    if (modalCatChecked.has(n)) el.classList.add('checked');
    else el.classList.remove('checked');
  });
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ──────────────────────────────────────
//  検索
// ──────────────────────────────────────
function setupSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = input.value.trim();
      applyFilter();
    }, 300);
  });
  // クリアボタン
  input.addEventListener('search', () => {
    searchQuery = '';
    applyFilter();
  });
}

// ──────────────────────────────────────
//  現在地ボタン
// ──────────────────────────────────────
function setupGeolocation() {
  const btn = document.getElementById('btn-location');
  let locMarker = null;

  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('このブラウザでは位置情報が使用できません。');
      return;
    }
    btn.classList.add('locating');
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.classList.remove('locating');
        const { latitude: lat, longitude: lng } = pos.coords;
        if (locMarker) map.removeLayer(locMarker);
        locMarker = L.circleMarker([lat, lng], {
          radius: 8, color: '#fff', weight: 2,
          fillColor: '#1976D2', fillOpacity: 1,
        }).addTo(map).bindPopup('現在地').openPopup();
        map.setView([lat, lng], 16);
      },
      () => {
        btn.classList.remove('locating');
        alert('位置情報を取得できませんでした。\n（HTTPS 環境、および位置情報の許可が必要です）');
      }
    );
  });
}

// ──────────────────────────────────────
//  ボトムシート
// ──────────────────────────────────────
function openSheet(store) {
  document.getElementById('store-name').textContent = store.name;

  const badge = document.getElementById('store-badge');
  badge.style.display = store.ticket_type === 'purple_only' ? '' : 'none';

  document.getElementById('store-genre').textContent =
    store.genre || CAT_LABELS[store.category_no] || '';

  document.getElementById('store-address').textContent = store.address || '';

  // 電話リンク
  const telEl = document.getElementById('store-tel-row');
  const telAction = document.getElementById('btn-tel-action');
  if (store.tel) {
    telEl.style.display = '';
    telAction.style.display = '';
    const telHref = 'tel:' + store.tel.replace(/[^\d+]/g, '');
    document.getElementById('store-tel-link').href = telHref;
    document.getElementById('store-tel-link').textContent = store.tel;
    telAction.href = telHref;
  } else {
    telEl.style.display = 'none';
    telAction.style.display = 'none';
  }

  // 連絡先 (URL/メール)
  const contactRow = document.getElementById('store-contact-row');
  if (store.contact) {
    contactRow.style.display = '';
    const contactLink = document.getElementById('store-contact-link');
    const isEmail = store.contact.includes('@');
    contactLink.href = isEmail ? 'mailto:' + store.contact : store.contact;
    contactLink.textContent = isEmail ? store.contact : 'お問合せページ';
  } else {
    contactRow.style.display = 'none';
  }

  // Googleマップ経路ボタン
  const dirBtn = document.getElementById('btn-directions');
  dirBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}`;

  document.getElementById('sheet-overlay').classList.add('open');
  document.getElementById('bottom-sheet').classList.add('open');
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  document.getElementById('bottom-sheet').classList.remove('open');
  document.getElementById('sheet-overlay').classList.remove('open');
  document.body.classList.remove('sheet-open');
}

// ──────────────────────────────────────
//  UI ユーティリティ
// ──────────────────────────────────────
function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}
function showError(msg) {
  hideLoading();
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}
function showMessage(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.color = '#1565C0';
  el.style.background = '#e3f2fd';
  el.style.borderColor = '#90caf9';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}
function updateCount(n) {
  document.getElementById('store-count').textContent = `${n.toLocaleString()}件`;
}

// ──────────────────────────────────────
//  起動
// ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

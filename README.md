# Web 影片剪輯器

純瀏覽器端的影片剪輯工具，使用 **WebCodecs + mp4box.js + mp4-muxer** 實作。所有影片都在你的裝置本地處理，**不會上傳到任何伺服器**。

## 功能

- 上傳多段 MP4 / MOV（H.264 或 H.265/HEVC + AAC）影片
- 時間軸上調整影片順序：**桌機拖曳**、**手機長按拖曳**，或點每段的 **◀ ▶** 按鈕
- 移動播放頭，以「**保留播放頭以前 / 保留播放頭以後**」裁剪每段影片
- 預覽播放，確認影片內容與裁剪結果
- 選擇**基準影片**決定輸出解析度與比例
- 解析度縮放 **100% / 80% / 50%**（依基準影片等比縮放，維持原始長寬比）
- 壓縮品質 **高 / 中 / 低**
- 合併所有片段為單一 **MP4**，並可預覽與下載；iOS 另提供「**儲存／分享**」按钮（Web Share）

## 系統需求

- 支援 WebCodecs 的瀏覽器：**Google Chrome / Microsoft Edge**（最新版，桌機與 Android 皆可），**iOS Safari 17+**
- **手機**（Android Chrome、iOS Safari 17+）操作已最佳化：單欄版面、觸控排序與 seek、加大觸控目標；偵測到手機時預設 50% + 低品質以利效能
- 需透過 **HTTP 伺服器**開啟（WebCodecs 與 `<video>` 不支援直接以 `file://` 開啟）
- **手機匯出小技巧**：匯出期間請保持頁面在前台、勿鎖定螢幕（手機瀏覽器會終止背景分頁）；偵測到手機時輸出長邊自動上限 1920px，並使用較低記憶體佇列以避免記憶體不足崩潰

## 本地執行

本專案為純靜態網站，用任何靜態伺服器開啟根目錄即可。

使用內附腳本（PowerShell）：

```powershell
./serve.ps1
```

或使用 Python：

```powershell
python -m http.server 8000
```

或 Node.js：

```powershell
npx http-server -p 8000 -c-1 .
```

然後用瀏覽器開啟 `http://localhost:8000/`（或腳本指示的埠號）。

## 部署到 GitHub Pages

1. 將本 repo 推上 GitHub
2. 到 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`（根目錄）
3. 開啟 Pages 提供網址即可給第三方使用

> `.nojekyll` 已附於根目錄，避免 Jekyll 處理時忽略底線開頭檔案。

## 匯出說明

- 輸出容器一律為 **MP4**
- 視訊優先使用 **H.264 (avc)**，環境不支援時自動退回 **VP9**
- 音訊優先使用 **AAC**，不支援時退回 **Opus**
- 解析度以選定的「基準影片」解析度乘以縮放比例，並自動取偶數（編碼要求）
- 非基準尺寸的片段會等比縮放並置中，四周以黑邊補齊（letterbox）
- 品質高低對應到不同的目標位元率

## 專案結構

```
index.html            主頁面
css/style.css         樣式
js/
  app.js              狀態管理與 UI 整合
  library.js          檔案剖析、mp4box header 解析、縮圖、能力偵測
  decoder.js          mp4box demux + VideoDecoder 解碼管線
  audio.js            音訊解碼/重編碼
  exporter.js         匯出：編碼 + mp4-muxer 封裝
  timeline.js         時間軸、拖曳排序、播放頭
  preview.js          預覽播放器
vendor/
  mp4box.all.min.js   第三方：MP4 解析
  mp4-muxer.min.js    第三方：MP4 封裝
```

## 已知限制

- 輸入支援 **H.264** 與 **H.265/HEVC** 視訊軌；HEVC 解碼依賴瀏覽器／裝置的平台解碼器（Windows 上的 Chrome/Edge 通常可用；若環境缺少 HEVC 解碼能力，上傳時會明確提示，可改裝 HEVC 擴充或改用 H.264 檔案）
- 需以 HTTP 伺服器執行，不支援直接雙擊 `index.html`（`file://`）
- 裁剪精度受限於源影片的金鑰框（keyframe）間距

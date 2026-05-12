'use client'

import { ChangeEvent, DragEvent, KeyboardEvent, ReactNode, useMemo, useRef, useState } from 'react'
import { saveAs } from 'file-saver'
import { detectFileRole } from '@/lib/fileRoles'
import { makeKintoneCsvBlob, makeNeCsvBlob, makeNyukoXlsxBlob, makeZipBlob } from '@/lib/formatter'
import { runNyukoProcess } from '@/lib/process'
import type { ExtractedRow, MatchWarning, ProcessResult, ProductHubSettings, SelectedFiles } from '@/lib/types'

type PreviewTab = 'extracted' | 'ne' | 'kintone' | 'nyuko'

const assetBasePath = process.env.NODE_ENV === 'production' ? '/nyuko-ikkatsu' : ''
const PRODUCT_HUB_API_URL_STORAGE_KEY = 'nyuko-ikkatsu.productHub.apiUrl'
const PRODUCT_HUB_API_KEY_STORAGE_KEY = 'nyuko-ikkatsu.productHub.apiKey'

const emptyFiles: SelectedFiles = {
  packingFiles: [],
}

function loadProductHubSettings(): ProductHubSettings {
  if (typeof window === 'undefined') return { apiUrl: '', apiKey: '' }
  return {
    apiUrl: window.localStorage.getItem(PRODUCT_HUB_API_URL_STORAGE_KEY) ?? '',
    apiKey: window.localStorage.getItem(PRODUCT_HUB_API_KEY_STORAGE_KEY) ?? '',
  }
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`
  return `${(file.size / 1024 / 1024).toFixed(1)} MB`
}

function mergeFiles(current: SelectedFiles, incomingFiles: File[]): SelectedFiles {
  const next: SelectedFiles = {
    packingFiles: [...current.packingFiles],
  }

  for (const file of incomingFiles) {
    const role = detectFileRole(file)
    if (role === 'packing') {
      const duplicated = next.packingFiles.some((currentFile) => currentFile.name === file.name && currentFile.size === file.size)
      if (!duplicated) next.packingFiles.push(file)
    }
  }

  return next
}

function ProductHubSettingsPanel({
  settings,
  onChange,
}: {
  settings: ProductHubSettings
  onChange: (settings: ProductHubSettings) => void
}) {
  const isReady = Boolean(settings.apiUrl.trim() && settings.apiKey.trim())

  function updateSetting(key: keyof ProductHubSettings, value: string) {
    const next = { ...settings, [key]: value }
    onChange(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PRODUCT_HUB_API_URL_STORAGE_KEY, next.apiUrl)
      window.localStorage.setItem(PRODUCT_HUB_API_KEY_STORAGE_KEY, next.apiKey)
    }
  }

  return (
    <div className="product-hub-settings" role="region" aria-label="商品DB連携設定">
      <div className="product-hub-settings-head">
        <div>
          <p className="eyebrow">PRODUCT DB</p>
          <h2>商品DB連携</h2>
          <p>配送依頼書の商品コードだけを product-data-hub から取得します。</p>
        </div>
        <span className={`status-badge ${isReady ? 'status-badge--good' : 'status-badge--warn'}`}>{isReady ? '設定済み' : '未設定'}</span>
      </div>

      <div className="settings-grid settings-grid--header">
        <label className="setting-field">
          <span>商品DB API URL</span>
          <input
            type="url"
            value={settings.apiUrl}
            onChange={(event) => updateSetting('apiUrl', event.target.value)}
            placeholder="https://PROJECT_REF.supabase.co/functions/v1/get-products"
          />
        </label>
        <label className="setting-field">
          <span>READ API KEY</span>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) => updateSetting('apiKey', event.target.value)}
            placeholder="PRODUCT_READ_API_KEY"
          />
        </label>
      </div>

      <p className="settings-note settings-note--compact">API URLとREAD API KEYだけ保存します。商品情報・オーダー状況は処理時にだけ取得します。</p>
    </div>
  )
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'danger' }) {
  return <span className={`pill pill--${tone}`}>{children}</span>
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="empty-text">{children}</p>
}

function WarningList({ warnings }: { warnings: MatchWarning[] }) {
  const noProduct = warnings.filter((warning) => warning.type === 'no_product')
  const noKey = warnings.filter((warning) => warning.type === 'no_key')
  const quantityMismatch = warnings.filter((warning) => warning.type === 'quantity_mismatch')

  if (warnings.length === 0) {
    return (
      <section className="notice notice--good">
        <strong>警告なし</strong>
        <span>すべての入庫データをproduct-data-hubのオーダー状況と照合できました。</span>
      </section>
    )
  }

  return (
    <section className="warnings">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">CHECK</p>
          <h2>警告</h2>
        </div>
        <Pill tone="warn">{warnings.length}件</Pill>
      </div>

      {noProduct.length > 0 && (
        <details className="warning-group warning-group--danger" open>
          <summary>商品DB未登録商品 {noProduct.length}件</summary>
          <div className="warning-list">
            {noProduct.map((warning, index) => (
              <div className="warning-item" key={`${warning.productCode}-${index}`}>
                <strong>{warning.productCode}</strong>
                <span>届いたキー: {warning.deliveredKeys.join(' / ')}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {quantityMismatch.length > 0 && (
        <details className="warning-group warning-group--warn" open>
          <summary>数量不一致 {quantityMismatch.length}件</summary>
          <div className="warning-list">
            {quantityMismatch.map((warning, index) => (
              <div className="warning-item" key={`${warning.productCode}-${warning.key}-qty-${index}`}>
                <strong>{warning.productCode}</strong>
                <span>読み取りキー: {warning.key}</span>
                <span>読み取り数量: {warning.expectedQuantity ?? '-'}</span>
                <span>梱包数: {warning.packingQuantities?.length ? warning.packingQuantities.join(' / ') : '未取得'}</span>
                {warning.sourceFile && <span>元ファイル: {warning.sourceFile}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      {noKey.length > 0 && (
        <details className="warning-group warning-group--warn" open>
          <summary>キー未一致 {noKey.length}件</summary>
          <div className="warning-list">
            {noKey.map((warning, index) => (
              <div className="warning-item" key={`${warning.productCode}-${warning.key}-${index}`}>
                <strong>{warning.productCode}</strong>
                <span>探したキー: {warning.key}</span>
                <span>現在のオーダー: {warning.currentOrders?.length ? warning.currentOrders.join(' / ') : 'なし'}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <EmptyText>表示するデータがありません。</EmptyText>
  const headers = Object.keys(rows[0])
  const visibleRows = rows.slice(0, 200)
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {headers.map((header) => (
                <td key={header}>{String(row[header] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > visibleRows.length && <p className="table-note">先頭{visibleRows.length}件のみ表示しています。</p>}
    </div>
  )
}

function toExtractedPreview(rows: ExtractedRow[]) {
  return rows.map((row) => ({
    商品コード: row.productCode,
    MMDD: row.mmdd,
    数量: row.quantity,
    消し込みキー: row.key,
    梱包数: row.packingQuantities.length ? row.packingQuantities.join(' / ') : '',
    数量判定: row.quantityMismatch ? '数量不一致' : 'OK',
    元ファイル: row.sourceFile,
    箱詰め備考: row.sourceNote,
  }))
}

function tabCount(result: ProcessResult | null, tab: PreviewTab) {
  if (!result) return 0
  if (tab === 'extracted') return result.extracted.length
  if (tab === 'ne') return result.neRows.length
  if (tab === 'kintone') return result.kintoneRows.length
  return result.nyukoRows.length
}

export default function NyukoApp() {
  const [files, setFiles] = useState<SelectedFiles>(emptyFiles)
  const [unknownFiles, setUnknownFiles] = useState<File[]>([])
  const [productHubSettings, setProductHubSettings] = useState<ProductHubSettings>(loadProductHubSettings)
  const [isDragging, setIsDragging] = useState(false)
  const [isProductHubPanelOpen, setIsProductHubPanelOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ProcessResult | null>(null)
  const [activeTab, setActiveTab] = useState<PreviewTab>('extracted')
  const bulkInputRef = useRef<HTMLInputElement>(null)

  const productHubReady = Boolean(productHubSettings.apiUrl.trim() && productHubSettings.apiKey.trim())
  const canRun = files.packingFiles.length > 0 && productHubReady && !isProcessing
  const selectedFileCount = files.packingFiles.length

  const summary = useMemo(() => {
    if (!result) return null
    const noProduct = result.matchResult.warnings.filter((warning) => warning.type === 'no_product').length
    const noKey = result.matchResult.warnings.filter((warning) => warning.type === 'no_key').length
    const quantityMismatch = result.matchResult.warnings.filter((warning) => warning.type === 'quantity_mismatch').length
    return {
      extracted: result.extracted.length,
      ne: result.neRows.length,
      kintone: result.kintoneRows.length,
      nyuko: result.nyukoRows.length,
      warnings: result.matchResult.warnings.length,
      noProduct,
      noKey,
      quantityMismatch,
    }
  }, [result])

  function openBulkFilePicker() {
    bulkInputRef.current?.click()
  }

  function handleDropZoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openBulkFilePicker()
    }
  }

  function handleDragLeaveInside(event: DragEvent<HTMLElement>, onLeave: () => void) {
    const nextTarget = event.relatedTarget as Node | null
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      onLeave()
    }
  }

  function handleDropZoneDragLeave(event: DragEvent<HTMLDivElement>) {
    handleDragLeaveInside(event, () => setIsDragging(false))
  }

  function acceptFiles(incoming: File[]) {
    setError(null)
    setResult(null)
    setFiles((current) => mergeFiles(current, incoming))
    const unknown = incoming.filter((file) => detectFileRole(file) === 'unknown')
    if (unknown.length > 0) {
      setUnknownFiles((current) => [...current, ...unknown])
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    acceptFiles(Array.from(event.dataTransfer.files))
  }

  function handleBulkInput(event: ChangeEvent<HTMLInputElement>) {
    acceptFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  function removePackingFile(targetIndex: number) {
    setError(null)
    setResult(null)
    setFiles((current) => ({
      packingFiles: current.packingFiles.filter((_, index) => index !== targetIndex),
    }))
  }

  function removeUnknownFile(targetIndex: number) {
    setUnknownFiles((current) => current.filter((_, index) => index !== targetIndex))
  }

  async function handleRun() {
    setIsProcessing(true)
    setError(null)
    setResult(null)
    try {
      const processResult = await runNyukoProcess(files, productHubSettings)
      setResult(processResult)
      setActiveTab('extracted')
    } catch (err) {
      setError(err instanceof Error ? err.message : '処理中にエラーが発生しました。')
    } finally {
      setIsProcessing(false)
    }
  }

  function clearAll() {
    setFiles(emptyFiles)
    setUnknownFiles([])
    setError(null)
    setResult(null)
  }

  function downloadNe() {
    if (!result) return
    saveAs(makeNeCsvBlob(result.neRows), 'NE更新.csv')
  }

  function downloadKintone() {
    if (!result) return
    saveAs(makeKintoneCsvBlob(result.kintoneRows), 'kintone更新.csv')
  }

  function downloadNyuko() {
    if (!result) return
    saveAs(makeNyukoXlsxBlob(result.nyukoRows), '入庫リスト.xlsx')
  }

  async function downloadZip() {
    if (!result) return
    const blob = await makeZipBlob(result)
    saveAs(blob, '入庫一括_出力.zip')
  }

  const previewRows: Record<string, unknown>[] = useMemo(() => {
    if (!result) return []
    if (activeTab === 'extracted') return toExtractedPreview(result.extracted)
    if (activeTab === 'ne') return result.neRows as unknown as Record<string, unknown>[]
    if (activeTab === 'kintone') return result.kintoneRows as unknown as Record<string, unknown>[]
    return result.nyukoRows as unknown as Record<string, unknown>[]
  }, [activeTab, result])

  return (
    <main className="page-shell">
      <header className="app-header" aria-label="入庫一括">
        <div className="app-header-inner">
          <div className="app-header-brand">
            <img className="app-symbol" src={`${assetBasePath}/symbol.png`} alt="入庫一括" />
          </div>

          <div className="app-header-actions">
            <button
              className={`product-hub-toggle ${productHubReady ? 'product-hub-toggle--ready' : 'product-hub-toggle--unset'}`}
              type="button"
              onClick={() => setIsProductHubPanelOpen((current) => !current)}
              aria-expanded={isProductHubPanelOpen}
            >
              <span className="product-hub-toggle-dot" />
              <span className="product-hub-toggle-label">商品DB</span>
              <strong>{productHubReady ? '接続済み' : '未設定'}</strong>
            </button>
          </div>

          {isProductHubPanelOpen && (
            <ProductHubSettingsPanel settings={productHubSettings} onChange={setProductHubSettings} />
          )}
        </div>
      </header>

      <section
        className={`drop-zone ${isDragging ? 'is-dragging' : ''} ${selectedFileCount > 0 ? 'has-files' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="ラクマート配送依頼書を選択またはドロップ"
        onClick={openBulkFilePicker}
        onKeyDown={handleDropZoneKeyDown}
        onDragEnter={() => setIsDragging(true)}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={handleDropZoneDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={bulkInputRef}
          className="drop-zone-input"
          type="file"
          multiple
          accept=".xlsx"
          onClick={(event) => event.stopPropagation()}
          onChange={handleBulkInput}
        />
        <div className="drop-zone-main">
          <div className="drop-visual" aria-hidden="true">
            <span className="drop-visual-ring" />
            <span className="drop-icon">↓</span>
          </div>
          <div className="drop-copy">
            <p className="eyebrow">UPLOAD</p>
            <h2>{isDragging ? 'ここにドロップして追加' : 'ラクマート配送依頼書をドロップor選択'}</h2>
            <div className="drop-hints" aria-hidden="true">
              <span>P~.xlsx 複数可</span>
              <span>商品情報は自動取得</span>
              <span>オーダー状況も自動取得</span>
            </div>
          </div>
        </div>
        <div className="drop-zone-side">
          <span className="drop-selected-count">{selectedFileCount > 0 ? `${selectedFileCount}ファイル選択中` : '未選択'}</span>
          <span className="upload-button upload-button--fake">ファイルを選択</span>
        </div>
      </section>

      {files.packingFiles.length > 0 && (
        <section className="selected-files-panel">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">SELECTED</p>
              <h2>選択中の配送依頼書</h2>
            </div>
            <Pill tone="good">{files.packingFiles.length}ファイル</Pill>
          </div>
          <ul className="file-list file-list--selected">
            {files.packingFiles.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <div className="file-row-main">
                  <span>{file.name}</span>
                  <small>{formatFileSize(file)}</small>
                </div>
                <button className="file-remove-button" type="button" onClick={() => removePackingFile(index)} aria-label={`${file.name}を削除`}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unknownFiles.length > 0 && (
        <section className="notice notice--warn">
          <strong>未判定ファイルがあります</strong>
          <span>現在読み込めるのはラクマート配送依頼書の .xlsx のみです。商品情報CSV・オーダー状況CSVは不要です。</span>
          <ul className="unknown-file-list">
            {unknownFiles.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <span>{file.name}</span>
                <button className="file-remove-button file-remove-button--light" type="button" onClick={() => removeUnknownFile(index)}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="action-panel">
        <div>
          <p className="eyebrow">RUN</p>
          <h2>入庫処理を実行</h2>
          <p>配送依頼書と商品DB連携が揃うと処理できます。商品情報・オーダー状況は処理時にproduct-data-hubから取得します。</p>
        </div>
        <div className="action-buttons">
          <button className="secondary-button" type="button" onClick={clearAll}>クリア</button>
          <button className="primary-button" type="button" onClick={handleRun} disabled={!canRun}>
            {isProcessing ? '商品DB取得中…' : '処理実行'}
          </button>
        </div>
      </section>

      {!productHubReady && (
        <section className="notice notice--warn">
          <strong>商品DB連携が未設定です</strong>
          <span>ヘッダー右側の「商品DB」から API URL と READ API KEY を入力すると処理できます。</span>
        </section>
      )}

      {error && (
        <section className="notice notice--danger">
          <strong>エラー</strong>
          <span>{error}</span>
        </section>
      )}

      {summary && (
        <section className="summary-grid">
          <div><span>抽出</span><strong>{summary.extracted}</strong></div>
          <div><span>NE更新</span><strong>{summary.ne}</strong></div>
          <div><span>kintone更新</span><strong>{summary.kintone}</strong></div>
          <div><span>入庫リスト</span><strong>{summary.nyuko}</strong></div>
          <div className={summary.warnings ? 'summary-warn' : 'summary-good'}><span>警告</span><strong>{summary.warnings}</strong></div>
        </section>
      )}

      {result && <WarningList warnings={result.matchResult.warnings} />}

      {result && (
        <section className="download-panel">
          <div>
            <p className="eyebrow">DOWNLOAD</p>
            <h2>出力ファイル</h2>
          </div>
          <div className="download-buttons">
            <button type="button" onClick={downloadNe}>NE更新.csv</button>
            <button type="button" onClick={downloadKintone}>kintone更新.csv</button>
            <button type="button" onClick={downloadNyuko}>入庫リスト.xlsx</button>
            <button type="button" className="zip-button" onClick={downloadZip}>ZIP一括</button>
          </div>
        </section>
      )}

      {result && (
        <section className="preview-panel">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">PREVIEW</p>
              <h2>プレビュー</h2>
            </div>
          </div>
          <div className="tab-row">
            {([
              ['extracted', '抽出結果'],
              ['ne', 'NE更新'],
              ['kintone', 'kintone更新'],
              ['nyuko', '入庫リスト'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className={activeTab === tab ? 'active' : ''}
                onClick={() => setActiveTab(tab)}
              >
                {label}<span>{tabCount(result, tab)}</span>
              </button>
            ))}
          </div>
          <PreviewTable rows={previewRows} />
        </section>
      )}
    </main>
  )
}

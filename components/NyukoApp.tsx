'use client'

import { ChangeEvent, DragEvent, ReactNode, useMemo, useState } from 'react'
import { saveAs } from 'file-saver'
import { detectFileRole, fileRoleLabel } from '@/lib/fileRoles'
import { makeKintoneCsvBlob, makeNeCsvBlob, makeNyukoXlsxBlob, makeZipBlob } from '@/lib/formatter'
import { runNyukoProcess } from '@/lib/process'
import type { ExtractedRow, MatchWarning, ProcessResult, SelectedFiles } from '@/lib/types'

type PreviewTab = 'extracted' | 'ne' | 'kintone' | 'nyuko'

const emptyFiles: SelectedFiles = {
  packingFiles: [],
  orderFile: null,
  masterFile: null,
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`
  return `${(file.size / 1024 / 1024).toFixed(1)} MB`
}

function mergeFiles(current: SelectedFiles, incomingFiles: File[]): SelectedFiles {
  const next: SelectedFiles = {
    packingFiles: [...current.packingFiles],
    orderFile: current.orderFile,
    masterFile: current.masterFile,
  }

  for (const file of incomingFiles) {
    const role = detectFileRole(file)
    if (role === 'packing') {
      const duplicated = next.packingFiles.some((currentFile) => currentFile.name === file.name && currentFile.size === file.size)
      if (!duplicated) next.packingFiles.push(file)
    }
    if (role === 'orders') next.orderFile = file
    if (role === 'master') next.masterFile = file
  }

  return next
}

function FileCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="file-card">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </section>
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

  if (warnings.length === 0) {
    return (
      <section className="notice notice--good">
        <strong>警告なし</strong>
        <span>すべての入庫データをオーダー状況CSVと照合できました。</span>
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
          <summary>kintone未登録商品 {noProduct.length}件</summary>
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
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ProcessResult | null>(null)
  const [activeTab, setActiveTab] = useState<PreviewTab>('extracted')

  const canRun = files.packingFiles.length > 0 && files.orderFile && files.masterFile && !isProcessing

  const summary = useMemo(() => {
    if (!result) return null
    const noProduct = result.matchResult.warnings.filter((warning) => warning.type === 'no_product').length
    const noKey = result.matchResult.warnings.filter((warning) => warning.type === 'no_key').length
    return {
      extracted: result.extracted.length,
      ne: result.neRows.length,
      kintone: result.kintoneRows.length,
      nyuko: result.nyukoRows.length,
      warnings: result.matchResult.warnings.length,
      noProduct,
      noKey,
    }
  }, [result])

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

  function handleSpecificInput(role: 'packing' | 'orders' | 'master', event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? [])
    if (selected.length === 0) return
    setError(null)
    setResult(null)
    setFiles((current) => {
      if (role === 'packing') return { ...current, packingFiles: selected }
      if (role === 'orders') return { ...current, orderFile: selected[0] }
      return { ...current, masterFile: selected[0] }
    })
    event.target.value = ''
  }

  function removePackingFile(targetIndex: number) {
    setError(null)
    setResult(null)
    setFiles((current) => ({
      ...current,
      packingFiles: current.packingFiles.filter((_, index) => index !== targetIndex),
    }))
  }

  function removeSingleFile(role: 'orders' | 'master') {
    setError(null)
    setResult(null)
    setFiles((current) => {
      if (role === 'orders') return { ...current, orderFile: null }
      return { ...current, masterFile: null }
    })
  }

  function removeUnknownFile(targetIndex: number) {
    setUnknownFiles((current) => current.filter((_, index) => index !== targetIndex))
  }

  async function handleRun() {
    setIsProcessing(true)
    setError(null)
    setResult(null)
    try {
      const processResult = await runNyukoProcess(files)
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
      <section className="hero">
        <div className="hero-brand">
          <img className="hero-logo" src="./symbol.png" alt="入庫一括ロゴ" />
          <div>
            <p className="eyebrow">nyuko-ikkatsu</p>
            <h1>入庫一括</h1>
            <p className="hero-lead">
              ラクマート配送依頼書から到着商品を抽出し、NE在庫反映・kintoneオーダー消し込み・倉庫用入庫リストをまとめて生成します。
            </p>
          </div>
        </div>
        <div className="hero-metrics">
          <div>
            <span>処理方式</span>
            <strong>ブラウザ内完結</strong>
          </div>
          <div>
            <span>出力</span>
            <strong>CSV / XLSX / ZIP</strong>
          </div>
        </div>
      </section>

      <section
        className={`drop-zone ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <div>
          <h2>ファイルをまとめてドロップ</h2>
          <p>P~.xlsxは複数可。CSVはファイル名から自動判定します。</p>
        </div>
        <label className="upload-button">
          ファイルを選択
          <input type="file" multiple accept=".xlsx,.csv" onChange={handleBulkInput} />
        </label>
      </section>

      <section className="file-grid">
        <FileCard title="1. ラクマート配送依頼書" description="P~.xlsx / 複数可 / 梱包リストシートを使用">
          <label className="mini-upload">
            選び直す
            <input type="file" multiple accept=".xlsx" onChange={(event) => handleSpecificInput('packing', event)} />
          </label>
          {files.packingFiles.length === 0 ? (
            <EmptyText>未選択</EmptyText>
          ) : (
            <ul className="file-list">
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
          )}
        </FileCard>

        <FileCard title="2. オーダー状況CSV" description="kintoneビューからDLしたCSV。オーダー1〜5 / RM1〜5を使用">
          <label className="mini-upload">
            選ぶ
            <input type="file" accept=".csv" onChange={(event) => handleSpecificInput('orders', event)} />
          </label>
          {files.orderFile ? (
            <ul className="file-list">
              <li>
                <div className="file-row-main">
                  <span>{files.orderFile.name}</span>
                  <small>{formatFileSize(files.orderFile)}</small>
                </div>
                <button className="file-remove-button" type="button" onClick={() => removeSingleFile('orders')} aria-label={`${files.orderFile.name}を削除`}>
                  削除
                </button>
              </li>
            </ul>
          ) : (
            <EmptyText>未選択</EmptyText>
          )}
        </FileCard>

        <FileCard title="3. 商品情報.csv" description="商品番号 / 出荷時商品名 / 階数を使用">
          <label className="mini-upload">
            選ぶ
            <input type="file" accept=".csv" onChange={(event) => handleSpecificInput('master', event)} />
          </label>
          {files.masterFile ? (
            <ul className="file-list">
              <li>
                <div className="file-row-main">
                  <span>{files.masterFile.name}</span>
                  <small>{formatFileSize(files.masterFile)}</small>
                </div>
                <button className="file-remove-button" type="button" onClick={() => removeSingleFile('master')} aria-label={`${files.masterFile.name}を削除`}>
                  削除
                </button>
              </li>
            </ul>
          ) : (
            <EmptyText>未選択</EmptyText>
          )}
        </FileCard>
      </section>

      {unknownFiles.length > 0 && (
        <section className="notice notice--warn">
          <strong>未判定ファイルがあります</strong>
          <ul className="unknown-file-list">
            {unknownFiles.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <span>{file.name}（{fileRoleLabel(detectFileRole(file))}）</span>
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
          <p>3種類の入力ファイルが揃うと処理できます。ファイルはサーバーに送信されません。</p>
        </div>
        <div className="action-buttons">
          <button className="secondary-button" type="button" onClick={clearAll}>クリア</button>
          <button className="primary-button" type="button" onClick={handleRun} disabled={!canRun}>
            {isProcessing ? '処理中…' : '処理実行'}
          </button>
        </div>
      </section>

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

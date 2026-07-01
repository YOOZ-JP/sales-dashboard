'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Loader2,
  Clock,
  ChevronDown,
  ChevronUp,
  X,
  Info,
  Tag,
  Download,
} from 'lucide-react';
import { supabase, upsertDailySales } from '@/lib/supabase';
import { useApp } from '@/context/AppContext';
import type { UploadLog } from '@/types';
import {
  ParsedRow,
  DetectedFormat,
  UploadStatus,
  UploadResult,
  ValidationWarning,
  guessPlatformFromFileName,
  detectFormat,
  detectSubSource,
  parseCSVSokuhochi,
  parsePiccomaKPI,
  parseCmoaSokuhochi,
  parseCmoaExcel,
  parseWeeklyReport,
  parseCSVWeeklyReport,
  parseSokuhochiExcel,
  parseRuikeiMetadata,
  parseRentaSokuhochi,
  parseEbookjapanSokuhochi,
  parseLineMangaSokuhochi,
  parseDmmSokuhochi,
} from '@/utils/upload';
import ExcelJS from 'exceljs';

const GLASS_CARD = {
  background: 'var(--color-glass)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--color-glass-border)',
  borderRadius: '16px',
} as const;

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.03 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

// ============================================================
// Toast Component
// ============================================================

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium"
      style={{
        background: type === 'success' ? 'rgba(34, 197, 94, 0.9)' : 'rgba(239, 68, 68, 0.9)',
        color: 'white',
        backdropFilter: 'blur(8px)',
      }}
    >
      {type === 'success' ? <CheckCircle size={16} /> : <X size={16} />}
      {message}
    </motion.div>
  );
}

// ============================================================
// Confirm Dialog
// ============================================================

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="rounded-2xl p-6 max-w-sm w-full mx-4"
        style={{ background: 'var(--color-card-bg)', border: '1px solid var(--color-glass-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-primary)' }}>{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-xs font-medium cursor-pointer"
            style={{ background: 'var(--color-input-bg)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-input-border)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer"
            style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}
          >
            OK
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ============================================================
// Main Component
// ============================================================

export default function DataUploadPage() {
  const { t, formatCurrency } = useApp();

  const [status, setStatus] = useState<UploadStatus>('idle');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [detectedFormat, setDetectedFormat] = useState<DetectedFormat | null>(null);
  // When platform couldn't be auto-detected, allow manual override
  const [manualPlatform, setManualPlatform] = useState<string>('');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [dedupMessage, setDedupMessage] = useState<{ action: string; count: number } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLogs, setUploadLogs] = useState<UploadLog[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentFileRef = useRef<File | null>(null);
  const [lastUploadTime, setLastUploadTime] = useState<string | null>(null);

  // New title detection
  const [knownTitles, setKnownTitles] = useState<Set<string>>(new Set());
  const [newTitles, setNewTitles] = useState<string[]>([]);

  // Validation warnings
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);

  // Upload log detail
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Toast & Confirm
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Known platforms (for validation + manual selection dropdown)
  const [knownPlatforms, setKnownPlatforms] = useState<string[]>([]);

  // 디버그 로그: upload_logs 테이블 + Storage(가능하면) 저장
  const saveDebugLog = useCallback(async (meta: {
    status: string;
    errorMessage?: string;
    uploadType?: string;
    platform?: string;
    rowCount?: number;
    detectedLabel?: string;
  }) => {
    const file = currentFileRef.current;
    try {
      // 1. upload_logs에 직접 기록 (항상 성공해야 함)
      await supabase.from('upload_logs').insert({
        upload_type: meta.uploadType || 'sokuhochi',
        source_file: file?.name || 'unknown',
        row_count: meta.rowCount ?? 0,
        status: meta.status === 'success' ? 'completed' : meta.status === 'preview' ? 'processing' : 'failed',
        error_message: meta.errorMessage
          ? `[${meta.detectedLabel || '?'}] ${meta.errorMessage}`
          : meta.detectedLabel ? `[${meta.detectedLabel}] ${meta.status}` : null,
        platforms: meta.platform ? [meta.platform] : null,
      });

      // 2. Storage에 원본 파일 직접 업로드 (Vercel 4.5MB 제한 우회)
      if (file) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          // Storage 경로는 ASCII만 허용 (일본어 파일명 업로드 실패 방지)
          // 원본 파일명은 upload_logs.source_file에 보존됨
          const ext = file.name.match(/\.[^.]+$/)?.[0] ?? '';
          const asciiBase = file.name.replace(ext, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
          const path = `uploads/${timestamp}_${asciiBase || 'upload'}${ext}`;
          const buf = await file.arrayBuffer();
          await supabase.storage.from('upload-debug').upload(path, buf, {
            contentType: file.type || 'application/octet-stream',
            upsert: false,
          });
        } catch { /* Storage 실패 무시 */ }
      }
    } catch {
      // 로그 실패는 무시
    }
  }, []);

  useEffect(() => {
    fetch('/api/sales/platforms')
      .then((res) => res.json())
      .then((data: Array<Record<string, unknown>>) => {
        if (data && Array.isArray(data)) {
          // platforms 테이블: code, name_jp, name_kr 등
          const names = data.map((d) => String(d.code || d.channel_name || d.name_jp || d.name || '')).filter(Boolean);
          // code 외에 name_jp도 추가 (중복 제거)
          const nameSet = new Set(names);
          data.forEach((d) => {
            if (d.name_jp) nameSet.add(String(d.name_jp));
          });
          setKnownPlatforms(Array.from(nameSet));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // title_master + 기존 매출 데이터 양쪽에서 기존 작품명 수집
    Promise.all([
      fetch('/api/sales/title-master').then(r => r.json()).catch(() => []),
      fetch('/api/sales/title-summaries').then(r => r.json()).catch(() => []),
    ]).then(([masterData, salesData]) => {
      const set = new Set<string>();
      if (Array.isArray(masterData)) masterData.forEach((d: Record<string, unknown>) => { if (d.title_jp) set.add(String(d.title_jp)); });
      if (Array.isArray(salesData)) salesData.forEach((d: Record<string, unknown>) => { if (d.title_jp) set.add(String(d.title_jp)); });
      setKnownTitles(set);
    });
  }, []);

  useEffect(() => {
    supabase
      .from('upload_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) setUploadLogs(data as UploadLog[]);
      });
  }, [status]);

  // Detect new titles from parsed rows
  const detectNewTitles = useCallback(
    (rows: ParsedRow[]) => {
      if (knownTitles.size === 0) return [];
      const uniqueTitles = new Set(rows.map((r) => r.title_jp));
      return Array.from(uniqueTitles).filter((title) => !knownTitles.has(title));
    },
    [knownTitles],
  );

  // Validate parsed rows
  const validateRows = useCallback(
    (rows: ParsedRow[], platforms: string[]): ValidationWarning[] => {
      const warns: ValidationWarning[] = [];
      const amounts = rows.map((r) => r.sales_amount);
      const avgAmount = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;

      rows.forEach((row, idx) => {
        const channelLower = (row.channel || '').toLowerCase();
        if (platforms.length > 0 && row.channel && !platforms.some(p => p.toLowerCase() === channelLower)) {
          warns.push({
            rowIndex: idx,
            type: 'platform',
            severity: 'warning',
            message: t(`알 수 없는 플랫폼: ${row.channel}`, `不明なプラットフォーム: ${row.channel}`),
          });
        }
        if (row.sales_amount < 0) {
          warns.push({
            rowIndex: idx,
            type: 'amount',
            severity: 'error',
            message: t(`음수 매출: ¥${row.sales_amount.toLocaleString()}`, `マイナス売上: ¥${row.sales_amount.toLocaleString()}`),
          });
        }
        if (avgAmount > 0 && row.sales_amount > avgAmount * 10) {
          warns.push({
            rowIndex: idx,
            type: 'amount',
            severity: 'warning',
            message: t(
              `비정상 매출 (평균의 ${Math.round(row.sales_amount / avgAmount)}배)`,
              `異常な売上 (平均の${Math.round(row.sales_amount / avgAmount)}倍)`,
            ),
          });
        }
        if (!row.sale_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.sale_date)) {
          warns.push({
            rowIndex: idx,
            type: 'date',
            severity: 'error',
            message: t(`날짜 형식 오류: ${row.sale_date || '(empty)'}`, `日付形式エラー: ${row.sale_date || '(空)'}`),
          });
        }
      });

      return warns;
    },
    [t],
  );

  const finalizeParsed = useCallback(
    (rows: ParsedRow[], fmt: DetectedFormat) => {
      if (rows.length === 0) {
        const errMsg = t('데이터를 찾을 수 없습니다. 파일 형식을 확인해주세요.', 'データが見つかりませんでした。ファイル形式を確認してください。');
        saveDebugLog({ status: 'failed', errorMessage: `0 rows parsed. Detected: ${fmt.label} (${fmt.type})`, detectedLabel: fmt.label });
        setStatus('error');
        setErrorMessage(
          errMsg,
        );
        return;
      }
      setParsedRows(rows);
      setDetectedFormat(fmt);
      const detected = detectNewTitles(rows);
      setNewTitles(detected);
      const warns = validateRows(rows, knownPlatforms);
      setWarnings(warns);
      if (warns.length > 0) setShowWarnings(true);
      setStatus('preview');
      // 프리뷰 도달 로그
      saveDebugLog({ status: 'preview', detectedLabel: fmt.label, platform: fmt.platform, rowCount: rows.length });
    },
    [detectNewTitles, validateRows, knownPlatforms, saveDebugLog, t],
  );

  // 단일 파일 파싱 (내부용)
  const parseOneFile = useCallback(
    async (file: File): Promise<{ rows: ParsedRow[]; fmt: DetectedFormat }> => {
      const buffer = await file.arrayBuffer();

        // 1단계: Excel 여부 판별 (매직 바이트)
        const magic = new Uint8Array(buffer.slice(0, 4));
        const isZip = magic[0] === 0x50 && magic[1] === 0x4B;
        const isOle = magic[0] === 0xD0 && magic[1] === 0xCF;
        const isExcel = isZip || isOle;

        // 2단계: 텍스트 파일이면 디코딩 (UTF-8 먼저, 실패 시 Shift-JIS)
        let textContent = '';
        let headerSample = '';
        if (!isExcel) {
          // UTF-8 BOM(EF BB BF) 또는 ASCII 범위 확인으로 인코딩 추측
          const firstBytes = new Uint8Array(buffer.slice(0, 3));
          const hasBOM = firstBytes[0] === 0xEF && firstBytes[1] === 0xBB && firstBytes[2] === 0xBF;
          if (hasBOM) {
            textContent = new TextDecoder('utf-8').decode(buffer);
          } else {
            // Shift-JIS 특유의 바이트 패턴 감지 (0x80-0x9F 범위의 첫 바이트)
            const sample = new Uint8Array(buffer.slice(0, 100));
            const hasShiftJIS = sample.some(b => (b >= 0x80 && b <= 0x9F) || (b >= 0xE0 && b <= 0xEF));
            if (hasShiftJIS) {
              textContent = new TextDecoder('shift_jis').decode(buffer);
            } else {
              textContent = new TextDecoder('utf-8').decode(buffer);
            }
          }
          headerSample = textContent.slice(0, 500);
        }

        // 3단계: Excel이면 시트 헤더로 포맷 추가 판별
        let excelHeaderHint = '';
        if (isExcel) {
          try {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buffer);
            // 시트명과 첫 행에서 힌트 추출
            for (const ws of wb.worksheets) {
              if (ws.name.includes('売上') || ws.name.includes('DL')) {
                excelHeaderHint = 'cmoa_excel';
                break;
              }
            }
            if (!excelHeaderHint) {
              const firstSheet = wb.worksheets[0];
              if (firstSheet) {
                const row1 = firstSheet.getRow(1).values as (string | null | undefined)[];
                const row1Str = row1.filter(Boolean).join(' ');
                if (row1Str.includes('タイトル名') && row1Str.includes('日')) excelHeaderHint = 'cmoa_excel';
                else if (row1Str.includes('Title') || row1Str.includes('Channel')) excelHeaderHint = 'weekly_report';
              }
            }
          } catch { /* Excel 읽기 실패 — 아래에서 처리 */ }
        }

        // 4단계: 포맷 감지
        let fmt = detectFormat(file.name, headerSample, isExcel);

        // 추가 감지: 텍스트 내용으로 (detectFormat에서 못 잡은 경우)
        if (fmt.type === 'unknown' && textContent) {
          if (textContent.includes('日付') && textContent.includes('ブック名') && textContent.includes('購入ポイント数')) {
            Object.assign(fmt, { type: 'piccoma_sokuhochi', platform: guessPlatformFromFileName(file.name), isPreliminary: true, confidence: 'medium', label: '속보치 CSV', subSource: detectSubSource(file.name) });
          } else if (textContent.includes('作品名') && textContent.includes('Total売上')) {
            Object.assign(fmt, { type: 'piccoma_kpi', platform: guessPlatformFromFileName(file.name) || 'Piccoma', isPreliminary: true, confidence: 'medium', label: 'KPI 속보치', subSource: 'sokuhochi_kpi' });
          } else if (textContent.includes('コンテンツID') && textContent.includes('タイトル名')) {
            Object.assign(fmt, { type: 'cmoa_sokuhochi', platform: 'cmoa', isPreliminary: true, confidence: 'medium', label: 'cmoa 속보치', subSource: 'sokuhochi_cmoa' });
          } else if (textContent.includes('Title') && textContent.includes('Channel') && textContent.includes('Date')) {
            Object.assign(fmt, { type: 'weekly_report', platform: '', isPreliminary: false, confidence: 'medium', label: 'Weekly Report CSV', subSource: 'weekly_report' });
          }
        }

        // Excel 시트 기반 감지 — 시트명에 '売上'/'DL'이 있으면 cmoa로 확정 (Weekly Report보다 우선)
        if (isExcel && excelHeaderHint === 'cmoa_excel' && fmt.type !== 'cmoa_sokuhochi' && fmt.type !== 'cmoa_excel') {
          fmt = { type: 'cmoa_excel', platform: 'cmoa', isPreliminary: true, confidence: 'high', label: 'cmoa 속보치 Excel', subSource: 'sokuhochi_cmoa_excel' };
        }
        if (fmt.type === 'unknown' && isExcel) {
          Object.assign(fmt, { type: 'weekly_report', platform: '', isPreliminary: false, confidence: 'low', label: 'Excel', subSource: 'weekly_report' });
        }

        if (fmt.type === 'unknown') {
          throw new Error(`${file.name}: 형식을 인식할 수 없습니다`);
        }

        let rows: ParsedRow[] = [];

        if (fmt.type === 'piccoma_sokuhochi') {
          if (isExcel) {
            rows = await parseSokuhochiExcel(buffer);
            rows = rows.map((r) => ({ ...r, channel: fmt.platform }));
          } else {
            const isKan = file.name.toLowerCase().includes('kan_daily');
            rows = parseCSVSokuhochi(textContent, fmt.platform, false, isKan);
          }
        } else if (fmt.type === 'piccoma_kpi') {
          rows = parsePiccomaKPI(textContent, fmt.platform, file.name);
        } else if (fmt.type === 'cmoa_sokuhochi') {
          if (isExcel) {
            rows = await parseCmoaExcel(buffer, file.name);
          } else {
            rows = parseCmoaSokuhochi(textContent);
          }
        } else if (fmt.type === 'cmoa_excel') {
          rows = await parseCmoaExcel(buffer, file.name);
        } else if (fmt.type === 'weekly_report') {
          if (isExcel) {
            rows = await parseWeeklyReport(buffer);
          } else {
            rows = parseCSVWeeklyReport(textContent);
          }
        } else if (fmt.type === 'ruikei_metadata') {
          rows = await parseRuikeiMetadata(buffer);
        } else if (fmt.type === 'renta_sokuhochi') {
          rows = parseRentaSokuhochi(textContent);
        } else if (fmt.type === 'ebookjapan_sokuhochi') {
          rows = parseEbookjapanSokuhochi(textContent);
        } else if (fmt.type === 'linemanga_sokuhochi') {
          rows = parseLineMangaSokuhochi(textContent);
        } else if (fmt.type === 'dmm_sokuhochi') {
          rows = parseDmmSokuhochi(textContent);
        }

      return { rows, fmt };
    },
    [],
  );

  // 여러 파일 처리 (합산 지원)
  const handleFiles = useCallback(
    async (files: File[]) => {
      setStatus('parsing');
      setFileName(files.map(f => f.name).join(', '));
      setErrorMessage('');
      setUploadResult(null);
      setWarnings([]);
      setNewTitles([]);
      setManualPlatform('');
      setDetectedFormat(null);
      currentFileRef.current = files[0]; // 디버그용 첫 파일

      try {
        // 중복 파일 체크: 이미 업로드된 파일명이면 경고
        const alreadyUploaded = files.filter(f =>
          uploadLogs.some(log => log.source_file === f.name && (log.status === 'completed' || log.status === 'success'))
        );
        if (alreadyUploaded.length > 0) {
          const names = alreadyUploaded.map(f => f.name).join(', ');
          const proceed = confirm(
            t(
              `이미 업로드된 파일이 포함되어 있습니다:\n${names}\n\n계속하면 기존 데이터를 덮어씁니다. 계속하시겠습니까?`,
              `既にアップロード済みのファイルが含まれています:\n${names}\n\n続行すると既存データが上書きされます。続行しますか？`,
            ),
          );
          if (!proceed) { setStatus('idle'); return; }
        }

        let allRows: ParsedRow[] = [];
        let lastFmt: DetectedFormat | null = null;
        const fileNames: string[] = [];

        for (const file of files) {
          const result = await parseOneFile(file);
          if (result) {
            allRows = allRows.concat(result.rows);
            lastFmt = result.fmt;
            fileNames.push(file.name);
          }
        }

        if (!lastFmt) {
          setStatus('error');
          setErrorMessage(t('파일을 분석할 수 없습니다', 'ファイルを解析できません'));
          return;
        }

        // 여러 파일일 경우: 같은 (title_jp, channel, sale_date)를 합산
        if (files.length > 1) {
          const mergeMap = new Map<string, ParsedRow>();
          for (const row of allRows) {
            const key = `${row.title_jp}|${row.channel}|${row.sale_date}`;
            const existing = mergeMap.get(key);
            if (existing) {
              existing.sales_amount += row.sales_amount;
              if (row.sales_amount_gross && existing.sales_amount_gross) {
                existing.sales_amount_gross += row.sales_amount_gross;
              }
            } else {
              mergeMap.set(key, { ...row });
            }
          }
          allRows = Array.from(mergeMap.values());
        }

        // 파일명 표시 업데이트
        setFileName(files.length > 1 ? `${fileNames.length}개 파일 (${fileNames[0]} 외 ${fileNames.length - 1}개)` : fileNames[0] || '');
        if (files.length > 1 && lastFmt) {
          lastFmt = { ...lastFmt, label: `${lastFmt.label} (${files.length}개 파일 합산)`, subSource: 'sokuhochi' };
        }

        finalizeParsed(allRows, lastFmt);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : t('파일 분석에 실패했습니다', 'ファイルの解析に失敗しました');
        saveDebugLog({ status: 'failed', errorMessage: errMsg });
        setStatus('error');
        setErrorMessage(errMsg);
      }
    },
    [parseOneFile, finalizeParsed, saveDebugLog, t, uploadLogs],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFiles(files);
      }
    },
    [handleFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length > 0) handleFiles(files);
    },
    [handleFiles],
  );

  // Determine the effective platform at upload time
  const effectivePlatform = useMemo(() => {
    if (detectedFormat?.platform) return detectedFormat.platform;
    return manualPlatform;
  }, [detectedFormat, manualPlatform]);

  const handleUpload = async () => {
    if (!detectedFormat) return;

    setStatus('uploading');
    setUploadProgress(0);

    // subSource를 data_source로 전달 (파일 종류별 구분)
    const fileType = detectedFormat.subSource || (detectedFormat.type === 'weekly_report' ? 'weekly_report' : 'sokuhochi');
    const isPreliminary = detectedFormat.isPreliminary;

    // If platform was not auto-detected, apply manual platform to rows
    const rowsToUpload =
      effectivePlatform && !detectedFormat.platform
        ? parsedRows.map((r) => ({ ...r, channel: effectivePlatform }))
        : parsedRows;

    try {
      // 대용량 데이터의 경우 큰 배치로 (호출 수 감소)
      const batchSize = rowsToUpload.length > 10000 ? 5000 : 2000;
      let totalInserted = 0;
      let totalUpdated = 0;
      let dedupInfo: { action: string; count: number } | null = null;
      for (let i = 0; i < rowsToUpload.length; i += batchSize) {
        const batch = rowsToUpload.slice(i, i + batchSize);
        const isFirstBatch = i === 0;
        const isLastBatch = i + batchSize >= rowsToUpload.length;
        const result = await upsertDailySales(batch, fileType, isPreliminary, isLastBatch, isFirstBatch);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        if (result.dedup) dedupInfo = result.dedup;
        setUploadProgress(Math.round(Math.min(100, ((i + batchSize) / rowsToUpload.length) * 100)));
      }
      const now = new Date().toISOString();
      setLastUploadTime(now);
      setUploadResult({ inserted: totalInserted, updated: totalUpdated, errors: 0 });
      if (dedupInfo) setDedupMessage(dedupInfo);
      setStatus('success');
      saveDebugLog({
        status: 'success',
        uploadType: fileType,
        platform: effectivePlatform,
        rowCount: rowsToUpload.length,
        detectedLabel: detectedFormat?.label,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t('업로드에 실패했습니다', 'アップロードに失敗しました');
      saveDebugLog({ status: 'failed', errorMessage: errMsg, uploadType: fileType, platform: effectivePlatform });
      setStatus('error');
      setErrorMessage(errMsg);
    }
  };

  const reset = () => {
    setStatus('idle');
    setParsedRows([]);
    setFileName('');
    setDetectedFormat(null);
    setManualPlatform('');
    setUploadResult(null);
    setDedupMessage(null);
    setErrorMessage('');
    setUploadProgress(0);
    setWarnings([]);
    setShowWarnings(false);
    setLastUploadTime(null);
    setNewTitles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUndoUpload = () => {
    if (!lastUploadTime || parsedRows.length === 0) return;
    const dates = parsedRows.map((r) => r.sale_date).filter(Boolean).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    const dataSource = detectedFormat?.type === 'weekly_report' ? 'weekly_report' : 'sokuhochi';
    setConfirmDialog({
      message: t('방금 업로드한 데이터를 모두 삭제하시겠습니까?', '直前のアップロードデータを全て削除しますか？'),
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch('/api/manage/sales/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate, endDate, dataSource }),
          });
          if (!res.ok) throw new Error('Undo failed');
          setToast({ message: t('업로드 취소 완료', 'アップロード取り消し完了'), type: 'success' });
          setLastUploadTime(null);
          reset();
        } catch {
          setToast({ message: t('취소 실패', '取り消しに失敗しました'), type: 'error' });
        }
      },
    });
  };

  const handleCancelLog = (log: UploadLog) => {
    setConfirmDialog({
      message: t(
        `"${log.source_file}" 업로드 건을 삭제하시겠습니까?`,
        `「${log.source_file}」のアップロード分を削除しますか？`,
      ),
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          const res = await fetch('/api/manage/sales/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataSource: log.upload_type }),
          });
          if (!res.ok) throw new Error('Cancel failed');
          setToast({ message: t('삭제 완료', '削除しました'), type: 'success' });
          const { data } = await supabase
            .from('upload_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);
          if (data) setUploadLogs(data as UploadLog[]);
        } catch {
          setToast({ message: t('삭제 실패', '削除に失敗しました'), type: 'error' });
        }
      },
    });
  };

  // ── Derived stats for preview summary ──────────────────────
  const previewStats = useMemo(() => {
    if (parsedRows.length === 0) return null;
    const dates = parsedRows.map((r) => r.sale_date).filter(Boolean).sort();
    const minDate = dates[0] ?? '';
    const maxDate = dates[dates.length - 1] ?? '';
    const uniqueTitles = new Set(parsedRows.map((r) => r.title_jp)).size;
    const totalAmount = parsedRows.reduce((sum, r) => sum + r.sales_amount, 0);
    return { minDate, maxDate, uniqueTitles, totalAmount };
  }, [parsedRows]);

  const warningCount = useMemo(() => warnings.filter((w) => w.severity === 'warning').length, [warnings]);
  const errorCount = useMemo(() => warnings.filter((w) => w.severity === 'error').length, [warnings]);

  const rowWarnings = useMemo(() => {
    const map = new Map<number, ValidationWarning[]>();
    warnings.forEach((w) => {
      const list = map.get(w.rowIndex) || [];
      list.push(w);
      map.set(w.rowIndex, list);
    });
    return map;
  }, [warnings]);

  // ── Render ──────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>

      {/* Confirm Dialog */}
      <AnimatePresence>
        {confirmDialog && (
          <ConfirmDialog
            message={confirmDialog.message}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </AnimatePresence>

      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center page-icon-glow">
          <Upload size={20} color="white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {t('데이터 업로드', 'データアップロード')}
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {t('엑셀/CSV 파일로 데이터 업로드', 'Excel/CSVファイルからデータをアップロード')}
          </p>
        </div>
      </div>

      <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">
        <motion.div variants={cardVariants}>
          <AnimatePresence mode="wait">

            {/* ── IDLE: Dropzone ─────────────────────────────────────── */}
            {status === 'idle' && (
              <motion.div
                key="dropzone"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-2xl p-12 flex flex-col items-center justify-center cursor-pointer transition-all"
                style={{
                  ...GLASS_CARD,
                  border: dragOver ? '2px dashed rgba(26, 43, 94, 0.5)' : '2px dashed var(--color-glass-border)',
                  background: dragOver ? 'rgba(26, 43, 94, 0.06)' : 'var(--color-glass)',
                  minHeight: 240,
                }}
              >
                <motion.div
                  animate={{ y: dragOver ? -8 : 0 }}
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{ background: 'rgba(26, 43, 94, 0.12)', border: '1px solid rgba(26, 43, 94, 0.2)' }}
                >
                  <FileSpreadsheet size={32} color="#1A2B5E" />
                </motion.div>
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
                  {t('파일을 드래그 앤 드롭', 'ファイルをドラッグ＆ドロップ')}
                </p>
                <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
                  {t('또는 클릭하여 파일 선택', 'またはクリックしてファイルを選択')}
                </p>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t('파일을 올리면 자동 분석합니다. 여러 파일을 한번에 올리면 합산됩니다.', 'ファイルをドロップすると自動分析します。複数ファイルは合算されます。')}
                </p>
                <input ref={fileInputRef} type="file" multiple onChange={handleFileInput} className="hidden" />
              </motion.div>
            )}

            {/* ── PARSING: Spinner ──────────────────────────────────────── */}
            {status === 'parsing' && (
              <motion.div
                key="parsing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl p-12 flex flex-col items-center justify-center"
                style={{ ...GLASS_CARD, minHeight: 240 }}
              >
                <Loader2 size={40} color="#1A2B5E" className="animate-spin mb-4" />
                <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                  {t('파일 분석 중...', 'ファイル解析中...')}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>{fileName}</p>
              </motion.div>
            )}

            {/* ── PREVIEW ───────────────────────────────────────────────── */}
            {status === 'preview' && detectedFormat && previewStats && (
              <motion.div
                key="preview"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl p-6 space-y-5"
                style={GLASS_CARD}
              >
                {/* Summary card */}
                <div
                  className="rounded-xl p-4"
                  style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-input-border)' }}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    {/* Left: Format + File info */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-xs font-semibold px-2.5 py-1 rounded-lg"
                          style={{ background: '#1A2B5E', color: 'white' }}
                        >
                          {detectedFormat.label}
                        </span>
{/* 속보치 뱃지 제거 */}
                        {detectedFormat.confidence !== 'high' && (
                          <span
                            className="text-xs font-medium px-2 py-0.5 rounded-lg flex items-center gap-1"
                            style={{ background: 'rgba(156,163,175,0.15)', color: '#9ca3af', border: '1px solid rgba(156,163,175,0.3)' }}
                          >
                            <Info size={10} />
                            {t('자동 추정', '自動推定')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>{t('파일', 'ファイル')}: </span>
                        {fileName}
                      </p>
                      {detectedFormat.platform && (
                        <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                          <span style={{ color: 'var(--color-text-muted)' }}>{t('플랫폼', 'プラットフォーム')}: </span>
                          {detectedFormat.platform}
                        </p>
                      )}
                    </div>

                    {/* Right: Stats grid */}
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
                      <div style={{ color: 'var(--color-text-muted)' }}>{t('기간', '期間')}</div>
                      <div className="font-mono font-medium" style={{ color: 'var(--color-text-primary)' }}>
                        {previewStats.minDate === previewStats.maxDate
                          ? previewStats.minDate
                          : `${previewStats.minDate} ~ ${previewStats.maxDate}`}
                      </div>

                      <div style={{ color: 'var(--color-text-muted)' }}>{t('전체 행', '総行数')}</div>
                      <div className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
                        {parsedRows.length.toLocaleString()}
                        {t('행', '行')}
                      </div>

                      <div style={{ color: 'var(--color-text-muted)' }}>{t('작품 수', 'タイトル数')}</div>
                      <div className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
                        {previewStats.uniqueTitles.toLocaleString()}
                        {t('개', '件')}
                        {newTitles.length > 0 && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                            style={{ background: 'rgba(251,191,36,0.2)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.35)' }}
                          >
                            +{newTitles.length} {t('신규', '新規')}
                          </span>
                        )}
                      </div>

                      <div style={{ color: 'var(--color-text-muted)' }}>{t('총 매출', '総売上')}</div>
                      <div className="font-semibold font-mono" style={{ color: 'var(--color-text-primary)' }}>
                        {formatCurrency(previewStats.totalAmount)}
                      </div>
                    </div>
                  </div>

                  {/* Platform manual override — 멀티 플랫폼 포맷은 각 행에 channel이 있으므로 숨김 */}
                  {!detectedFormat.platform && detectedFormat.type !== 'weekly_report' && detectedFormat.type !== 'ruikei_metadata' && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-input-border)' }}>
                      <label className="block text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                        {t('플랫폼 선택 (필수)', 'プラットフォーム選択（必須）')}
                      </label>
                      <select
                        value={manualPlatform}
                        onChange={(e) => setManualPlatform(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl text-sm cursor-pointer"
                        style={{
                          background: 'var(--color-glass)',
                          color: 'var(--color-text-primary)',
                          border: '1px solid var(--color-input-border)',
                          outline: 'none',
                        }}
                      >
                        <option value="">{t('-- 플랫폼을 선택하세요 --', '-- プラットフォームを選択 --')}</option>
                        {knownPlatforms.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* New titles warning */}
                {newTitles.length > 0 && (
                  <div
                    className="rounded-xl px-4 py-3"
                    style={{ background: 'rgba(251, 191, 36, 0.06)', border: '1px solid rgba(251, 191, 36, 0.25)' }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Tag size={14} color="#fbbf24" />
                      <span className="text-xs font-semibold" style={{ color: '#fbbf24' }}>
                        {t(
                          `${newTitles.length}개의 신규 작품이 발견되었습니다`,
                          `${newTitles.length}件の新規タイトルが見つかりました`,
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {newTitles.slice(0, 10).map((title) => (
                        <span
                          key={title}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', border: '1px solid rgba(251, 191, 36, 0.3)' }}
                        >
                          {title}
                        </span>
                      ))}
                      {newTitles.length > 10 && (
                        <span className="text-[11px] px-2 py-0.5" style={{ color: 'var(--color-text-muted)' }}>
                          ... {t('외', '他')} {newTitles.length - 10}{t('개', '件')}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Warnings section */}
                {warnings.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowWarnings(!showWarnings)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium cursor-pointer"
                      style={{
                        background: errorCount > 0 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(251, 191, 36, 0.1)',
                        border: `1px solid ${errorCount > 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(251, 191, 36, 0.3)'}`,
                        color: errorCount > 0 ? '#f87171' : '#fbbf24',
                      }}
                    >
                      <AlertCircle size={14} />
                      {warningCount > 0 && <span>{warningCount}{t('건 경고', '件の警告')}</span>}
                      {errorCount > 0 && <span>{errorCount}{t('건 오류', '件のエラー')}</span>}
                      {showWarnings ? <ChevronUp size={12} className="ml-auto" /> : <ChevronDown size={12} className="ml-auto" />}
                    </button>
                    <AnimatePresence>
                      {showWarnings && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="mt-2 max-h-40 overflow-y-auto rounded-xl px-3 py-2 space-y-1"
                          style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-input-border)' }}
                        >
                          {warnings.map((w, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                              <span style={{ color: w.severity === 'error' ? '#f87171' : '#fbbf24' }}>
                                {w.severity === 'error' ? '\u2715' : '\u26A0'}
                              </span>
                              <span style={{ color: 'var(--color-text-muted)' }}>#{w.rowIndex + 1}</span>
                              <span style={{ color: 'var(--color-text-secondary)' }}>{w.message}</span>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Data preview table */}
                <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--color-table-border)' }}>
                  <table className="w-full text-xs min-w-[600px]">
                    <thead>
                      <tr style={{ background: 'var(--color-glass)', borderBottom: '1px solid var(--color-table-border)' }}>
                        <th className="py-2.5 px-3 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>#</th>
                        <th className="py-2.5 px-3 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                          {t('작품(JP)', 'タイトル(JP)')}
                        </th>
                        <th className="py-2.5 px-3 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                          {t('플랫폼', 'チャンネル')}
                        </th>
                        <th className="py-2.5 px-3 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                          {t('날짜', '日付')}
                        </th>
                        <th className="py-2.5 px-3 text-right font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                          {t('매출', '売上')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedRows.slice(0, 30).map((row, idx) => {
                        const rowWarns = rowWarnings.get(idx);
                        const hasError = rowWarns?.some((w) => w.severity === 'error');
                        const hasWarning = rowWarns?.some((w) => w.severity === 'warning');

                        return (
                          <tr
                            key={idx}
                            style={{
                              borderBottom: '1px solid var(--color-table-border-subtle)',
                              background: hasError
                                ? 'rgba(239, 68, 68, 0.08)'
                                : hasWarning
                                  ? 'rgba(251, 191, 36, 0.08)'
                                  : undefined,
                            }}
                          >
                            <td className="py-2.5 px-3" style={{ color: 'var(--color-text-muted)' }}>
                              {hasError && <span className="mr-1" style={{ color: '#f87171' }}>{'\u2715'}</span>}
                              {!hasError && hasWarning && <span className="mr-1" style={{ color: '#fbbf24' }}>{'\u26A0'}</span>}
                              {idx + 1}
                            </td>
                            <td className="py-2.5 px-3 max-w-[220px]" style={{ color: 'var(--color-text-primary)' }}>
                              <span className="truncate block">{row.title_jp}</span>
                              {newTitles.includes(row.title_jp) && (
                                <span
                                  className="inline-block text-[10px] px-1.5 py-0 rounded-full font-medium mt-0.5"
                                  style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24', border: '1px solid rgba(251, 191, 36, 0.3)' }}
                                >
                                  {t('신규', '新規')}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3" style={{ color: 'var(--color-text-secondary)' }}>{row.channel}</td>
                            <td className="py-2.5 px-3 font-mono" style={{ color: 'var(--color-text-secondary)' }}>{row.sale_date}</td>
                            <td className="py-2.5 px-3 text-right font-mono font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                              {formatCurrency(row.sales_amount)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {parsedRows.length > 30 && (
                    <div
                      className="py-2 text-center text-xs"
                      style={{ color: 'var(--color-text-muted)', background: 'var(--color-glass)' }}
                    >
                      ... {t('외', '他')} {(parsedRows.length - 30).toLocaleString()} {t('행', '行')}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-between pt-1">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={reset}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer"
                    style={{ background: 'var(--color-input-bg)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-input-border)' }}
                  >
                    <X size={15} />
                    {t('취소', 'キャンセル')}
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleUpload}
                    disabled={
                      detectedFormat.type !== 'ruikei_metadata' &&
                      detectedFormat.type !== 'weekly_report' &&
                      !detectedFormat.platform && !manualPlatform
                    }
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
                    style={{
                      background: '#1A2B5E',
                      color: 'white',
                      opacity: detectedFormat.type !== 'ruikei_metadata' && detectedFormat.type !== 'weekly_report' && !detectedFormat.platform && !manualPlatform ? 0.4 : 1,
                      cursor: detectedFormat.type !== 'ruikei_metadata' && detectedFormat.type !== 'weekly_report' && !detectedFormat.platform && !manualPlatform ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Upload size={15} />
                    {t('DB에 저장', 'DBに保存')}
                    <span
                      className="text-xs font-normal px-1.5 py-0.5 rounded-md ml-1"
                      style={{ background: 'rgba(255,255,255,0.15)' }}
                    >
                      {parsedRows.length.toLocaleString()}{t('행', '行')}
                    </span>
                  </motion.button>
                </div>
              </motion.div>
            )}

            {/* ── UPLOADING: Progress ───────────────────────────────────── */}
            {status === 'uploading' && (
              <motion.div
                key="uploading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl p-12 flex flex-col items-center justify-center"
                style={{ ...GLASS_CARD, minHeight: 240 }}
              >
                <Loader2 size={40} color="#1A2B5E" className="animate-spin mb-4" />
                <p className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
                  {t('업로드 중...', 'アップロード中...')}
                </p>
                <div className="w-56 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-glass-border)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: '#1A2B5E' }}
                    initial={{ width: 0 }}
                    animate={{ width: `${uploadProgress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>{uploadProgress}%</p>
              </motion.div>
            )}

            {/* ── SUCCESS ───────────────────────────────────────────────── */}
            {status === 'success' && uploadResult && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl p-12 flex flex-col items-center justify-center"
                style={{ ...GLASS_CARD, minHeight: 240 }}
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 12 }}
                >
                  <CheckCircle size={48} color="#22c55e" />
                </motion.div>
                <p className="text-lg font-bold mt-4 mb-4" style={{ color: 'var(--color-text-primary)' }}>
                  {t('업로드 완료', 'アップロード完了')}
                </p>

                <div className="flex gap-4 mb-6">
                  <div
                    className="text-center px-4 py-3 rounded-xl"
                    style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)' }}
                  >
                    <p className="text-2xl font-bold" style={{ color: '#22c55e' }}>{uploadResult.inserted}</p>
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{t('신규 추가', '新規追加')}</p>
                  </div>
                  <div
                    className="text-center px-4 py-3 rounded-xl"
                    style={{ background: 'rgba(26, 43, 94, 0.1)', border: '1px solid rgba(26, 43, 94, 0.25)' }}
                  >
                    <p className="text-2xl font-bold" style={{ color: '#1A2B5E' }}>{uploadResult.updated}</p>
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{t('업데이트', '更新')}</p>
                  </div>
                  {uploadResult.errors > 0 && (
                    <div
                      className="text-center px-4 py-3 rounded-xl"
                      style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                    >
                      <p className="text-2xl font-bold" style={{ color: '#f87171' }}>{uploadResult.errors}</p>
                      <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{t('에러', 'エラー')}</p>
                    </div>
                  )}
                </div>

                {uploadResult.errorRows && uploadResult.errorRows.length > 0 && (
                  <div
                    className="w-full max-w-md mb-4 rounded-xl p-3 max-h-32 overflow-y-auto"
                    style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                  >
                    {uploadResult.errorRows.map((er, i) => (
                      <div key={i} className="text-xs py-0.5 flex gap-2" style={{ color: '#f87171' }}>
                        <span>#{er.row}</span>
                        <span>{er.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {dedupMessage && (
                  <div
                    className="w-full max-w-md mb-4 rounded-xl p-3 text-center"
                    style={{ background: 'rgba(59, 111, 246, 0.08)', border: '1px solid rgba(59, 111, 246, 0.2)' }}
                  >
                    <p className="text-sm font-medium" style={{ color: '#3B6FF6' }}>
                      {dedupMessage.action === 'replaced_sokuhochi'
                        ? t(
                            `확정 데이터 업로드로 기존 속보치 ${dedupMessage.count}건이 대체되었습니다.`,
                            `確定データアップロードにより、既存速報値${dedupMessage.count}件が置換されました。`,
                          )
                        : t(
                            `이미 확정 데이터(Weekly Report)가 있는 ${dedupMessage.count}건은 건너뛰었습니다.`,
                            `既に確定データ(Weekly Report)がある${dedupMessage.count}件はスキップしました。`,
                          )}
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  {lastUploadTime && (
                    <motion.button
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.96 }}
                      onClick={handleUndoUpload}
                      className="px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
                      style={{ background: 'transparent', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.4)' }}
                    >
                      {t('업로드 취소', 'アップロード取消')}
                    </motion.button>
                  )}
                  <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={reset}
                    className="px-6 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
                    style={{ background: 'var(--color-glass-border)', color: 'var(--color-text-primary)', border: '1px solid var(--color-glass-border)' }}
                  >
                    {t('새로 업로드', '新規アップロード')}
                  </motion.button>
                </div>
              </motion.div>
            )}

            {/* ── ERROR ─────────────────────────────────────────────────── */}
            {status === 'error' && (
              <motion.div
                key="error"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl p-12 flex flex-col items-center justify-center"
                style={{ ...GLASS_CARD, minHeight: 240 }}
              >
                <AlertCircle size={48} color="#ef4444" />
                <p className="text-lg font-bold mt-4 mb-2" style={{ color: 'var(--color-text-primary)' }}>
                  {t('오류', 'エラー')}
                </p>
                <p className="text-sm text-center max-w-md" style={{ color: 'var(--color-text-secondary)' }}>
                  {errorMessage}
                </p>
                <motion.button
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={reset}
                  className="mt-4 px-6 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
                  style={{ background: 'var(--color-glass-border)', color: 'var(--color-text-primary)', border: '1px solid var(--color-glass-border)' }}
                >
                  {t('다시 시도', 'やり直す')}
                </motion.button>
              </motion.div>
            )}

          </AnimatePresence>
        </motion.div>

        {/* ── Upload History ──────────────────────────────────────────── */}
        <motion.div variants={cardVariants} className="rounded-2xl p-6" style={GLASS_CARD}>
          <div className="flex items-center gap-3 mb-4">
            <Clock size={16} color="var(--color-text-secondary)" />
            <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {t('업로드 이력', 'アップロード履歴')}
            </h2>
            {uploadLogs.length > 0 && (
              <button
                onClick={async () => {
                  const pw = prompt(t('삭제 비밀번호를 입력하세요', '削除パスワードを入力'));
                  if (pw !== 'CLINK') { if (pw !== null) alert(t('비밀번호가 일치하지 않습니다', 'パスワードが一致しません')); return; }
                  if (!confirm(t('업로드 이력을 전체 삭제하시겠습니까?', 'アップロード履歴を全削除しますか？'))) return;
                  await supabase.from('upload_logs').delete().gte('created_at', '2000-01-01');
                  setUploadLogs([]);
                  setToast({ message: t('이력 삭제 완료', '履歴を削除しました'), type: 'success' });
                }}
                className="ml-auto text-[12px] px-3 py-1 rounded-lg cursor-pointer transition-all"
                style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.15)' }}
              >
                {t('전체 삭제', '全削除')}
              </button>
            )}
          </div>
          {uploadLogs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-table-border)' }}>
                    <th className="py-2.5 px-2 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('일시', '日時')}
                    </th>
                    <th className="py-2.5 px-2 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('타입', 'タイプ')}
                    </th>
                    <th className="py-2.5 px-2 text-left font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('파일', 'ファイル')}
                    </th>
                    <th className="py-2.5 px-2 text-right font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('행수', '行数')}
                    </th>
                    <th className="py-2.5 px-2 text-center font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('상태', 'ステータス')}
                    </th>
                    <th className="py-2.5 px-2 text-center font-medium" style={{ color: 'var(--color-text-secondary)' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {uploadLogs.map((log) => (
                    <>
                      <tr key={log.id} style={{ borderBottom: '1px solid var(--color-table-border-subtle)' }}>
                        <td className="py-2.5 px-2 font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                          {new Date(log.created_at).toLocaleString(t('ko-KR', 'ja-JP'), {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="py-2.5 px-2">
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                            style={{
                              background: 'rgba(26,43,94,0.10)',
                              color: '#1A2B5E',
                            }}
                          >
                            {log.upload_type === 'weekly_report' ? 'WR' : t('속보', '速報')}
                          </span>
                        </td>
                        <td
                          className="py-2.5 px-2 text-xs truncate max-w-[200px]"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {log.source_file ?? '-'}
                        </td>
                        <td
                          className="py-2.5 px-2 text-right font-mono text-xs"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {log.row_count.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-2 text-center">
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                            style={{
                              background:
                                (log.status === 'success' || log.status === 'completed')
                                  ? 'rgba(34,197,94,0.15)'
                                  : log.status === 'processing'
                                    ? 'rgba(59,111,246,0.15)'
                                    : (log.status === 'cancelled' || log.status === 'superseded')
                                      ? 'rgba(156,163,175,0.15)'
                                      : 'rgba(239,68,68,0.15)',
                              color:
                                (log.status === 'success' || log.status === 'completed')
                                  ? '#22c55e'
                                  : log.status === 'processing'
                                    ? '#3B6FF6'
                                    : (log.status === 'cancelled' || log.status === 'superseded')
                                      ? '#9ca3af'
                                      : '#ef4444',
                            }}
                          >
                            {(log.status === 'success' || log.status === 'completed')
                              ? t('성공', '成功')
                              : log.status === 'processing'
                                ? t('분석완료', '分析済')
                                : (log.status === 'cancelled' || log.status === 'superseded')
                                  ? t('취소됨', 'キャンセル済')
                                  : t('오류', 'エラー')}
                          </span>
                          {log.error_message && log.status === 'failed' && (
                            <div className="text-[10px] mt-1 max-w-[150px] truncate" style={{ color: '#dc2626' }} title={log.error_message}>
                              {log.error_message.replace(/^\[.*?\]\s*/, '').slice(0, 40)}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-2 text-center">
                          <div className="flex items-center gap-1 justify-center">
                            <button
                              onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                              className="text-[10px] px-2 py-1 rounded-full cursor-pointer"
                              style={{ background: 'rgba(26, 43, 94, 0.1)', color: '#1A2B5E', border: '1px solid rgba(26, 43, 94, 0.2)' }}
                            >
                              {t('상세', '詳細')}
                            </button>
                            {log.status === 'success' && (
                              <button
                                onClick={() => handleCancelLog(log)}
                                className="text-[10px] px-2 py-1 rounded-full cursor-pointer"
                                style={{ background: 'transparent', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}
                              >
                                {t('취소', '取消')}
                              </button>
                            )}
                            <button
                              onClick={() => {
                                const pw = prompt(t('삭제 비밀번호를 입력하세요', '削除パスワードを入力'));
                                if (pw !== 'CLINK') {
                                  if (pw !== null)
                                    alert(t('비밀번호가 일치하지 않습니다', 'パスワードが一致しません'));
                                  return;
                                }
                                fetch(`/api/sales/upload-logs?id=${log.id}`, { method: 'DELETE' })
                                  .then((r) => {
                                    if (r.ok) setUploadLogs((prev) => prev.filter((l) => l.id !== log.id));
                                    else alert(t('삭제 실패', '削除失敗'));
                                  })
                                  .catch(() => alert(t('삭제 실패', '削除失敗')));
                              }}
                              className="text-[10px] px-2 py-1 rounded-full cursor-pointer"
                              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid rgba(156,163,175,0.3)' }}
                            >
                              {t('삭제', '削除')}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {expandedLogId === log.id && (
                        <tr key={`${log.id}-detail`}>
                          <td colSpan={6} className="px-4 py-3">
                            <div
                              className="text-xs space-y-1 rounded-xl p-3"
                              style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-input-border)' }}
                            >
                              <div style={{ color: 'var(--color-text-secondary)' }}>
                                <span className="font-medium">{t('파일', 'ファイル')}:</span> {log.source_file ?? '-'}
                              </div>
                              <div style={{ color: 'var(--color-text-secondary)' }}>
                                <span className="font-medium">{t('업로드 일시', 'アップロード日時')}:</span>{' '}
                                {new Date(log.created_at).toLocaleString(t('ko-KR', 'ja-JP'))}
                              </div>
                              <div style={{ color: 'var(--color-text-secondary)' }}>
                                <span className="font-medium">{t('행수', '行数')}:</span>{' '}
                                {log.row_count.toLocaleString()}{t('행', '行')}
                              </div>
                              <div style={{ color: 'var(--color-text-secondary)' }}>
                                <span className="font-medium">{t('타입', 'タイプ')}:</span>{' '}
                                {log.upload_type === 'weekly_report' ? 'Weekly Report' : t('속보치', '速報値')}
                              </div>
                              {log.error_message && (
                                <div style={{ color: log.status === 'failed' ? '#dc2626' : 'var(--color-text-muted)' }}>
                                  <span className="font-medium">
                                    {log.status === 'failed' ? t('실패 사유', '失敗理由') : t('메모', 'メモ')}:
                                  </span>{' '}
                                  {log.error_message}
                                </div>
                              )}
                              {/* 원본 파일 다운로드 */}
                              <button
                                onClick={async () => {
                                  try {
                                    const safeName = (log.source_file ?? '').replace(/[^a-zA-Z0-9가-힣ぁ-んァ-ヶ一-龠._-]/g, '_');
                                    if (!safeName) { alert(t('파일명 정보가 없습니다', 'ファイル名情報がありません')); return; }
                                    // Storage에서 파일명으로 검색
                                    const { data: files } = await supabase.storage.from('upload-debug').list('uploads', {
                                      search: safeName,
                                      limit: 5,
                                      sortBy: { column: 'created_at', order: 'desc' },
                                    });
                                    if (files && files.length > 0) {
                                      const { data: urlData } = await supabase.storage.from('upload-debug').createSignedUrl(`uploads/${files[0].name}`, 3600);
                                      if (urlData?.signedUrl) { window.open(urlData.signedUrl, '_blank'); return; }
                                    }
                                    alert(t('파일을 찾을 수 없습니다 (Storage에 저장된 파일이 없을 수 있습니다)', 'ファイルが見つかりません'));
                                  } catch {
                                    alert(t('다운로드에 실패했습니다', 'ダウンロードに失敗しました'));
                                  }
                                }}
                                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all"
                                style={{ background: 'rgba(26, 43, 94, 0.08)', color: '#1A2B5E', border: '1px solid rgba(26, 43, 94, 0.15)' }}
                              >
                                <Download size={12} />
                                {t('원본 파일 다운로드', '元ファイルをダウンロード')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-center py-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {t('업로드 이력이 없습니다', 'アップロード履歴がありません')}
            </p>
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
